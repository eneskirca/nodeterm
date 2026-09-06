// Host service — serve local PTYs over the relay (main process).
//
// On "host mode" the app: (1) gates on a valid Pro entitlement, (2) mints a single-use
// pairing token from our API with the stored entitlement, (3) connects to the relay as the
// HOST (so it becomes the pending host the client later joins to trigger the bridge), and
// (4) returns the pairing OFFER string for the user to hand to a client.
//
// While connected, the host maps the client's E2EE RPC/frames onto the existing pty-manager:
//   - RPC `pty.create {cols, rows, cwd?, shell?, persistKey?, agentId?}` -> `createDetached`,
//     returning `{ streamId }`. The PTY's output is piped into `OP.Output` frames; its exit
//     into an `OP.Error` frame (then the stream is dropped).
//   - `OP.Input`  frame -> `write(sessionId, <utf-8 payload>)`
//   - `OP.Resize` frame -> `resize(sessionId, cols, rows)` (payload = 2x uint16 LE)
//   - RPC `pty.kill {streamId}` -> `kill(null, sessionId)` (null = the relay owns this pty; it has
//     no UI subscribers, so dropping its sinks releases it — the tmux session keeps running)
//   - RPC `pty.destroy {streamId}` -> the injected `destroyNode` (the phone's "End session"):
//     permanently ends the stream's tmux session and takes the node off its canvas — the same two
//     steps the desktop × performs. The target is resolved from the stream, never client params.
// Output backpressure: when `sendFrame` returns false the host pauses the PTY via `setFlow`
// and resumes it on the next successful send.
//
// This file is glue over already-tested units (relay-socket, framing, pairing, pty-manager).
// The pure RPC/frame -> pty-manager mapping lives in `createHostHandlers` so it is unit-
// testable with fakes; `initRemoteHost` wires it to IPC, the license gate, and the API call.

import { randomUUID } from 'crypto'
import path from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import { REF_MAX_LEN } from '../../shared/presence'
import type { CanvasMutation, CanvasState, DirEntry, PtyCreateOptions } from '../../shared/types'
import type { AgentId } from '../../shared/agents/config'
import { PtyManager, type DetachedSinks } from '../../core/pty-manager'
import * as fsOps from '../../core/fs-ops'
import type { RemoteNodeInput } from '../../core/project-node-append'
import { getStoredEntitlement, isPremium } from '../../core/license'
import { publicKeyToB64, type KeyPair } from './e2ee'
import { loadOrCreateHostKeyPair, HostKeyLockedError } from './host-identity'
import { OP, type Frame } from './framing'
import { encodeOffer } from './pairing'
import { sanitizeClientMutation } from './canvas-sync'
import { connectRelay, type RelaySocket, type RpcRequest } from './relay-socket'
import { initHostCanvasHub, currentCanvas, subscribeCanvas } from './host-canvas-hub'
import { createPhonePresence, type PhonePresence } from './phone-presence'

// Default relay endpoint; `NODETERM_RELAY_URL` overrides it (mirrors license.ts's API_BASE /
// CHECKOUT_URL env-override pattern — used both as the dev gate and for local testing).
export const RELAY_URL = process.env.NODETERM_RELAY_URL || 'wss://relay.nodeterm.dev'

export const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** How long `pty.attach` waits for the `fresh` probe before answering "warm" and moving on. A
 *  local `tmux has-session` is ~10 ms; this only bounds the pathological case, because the probe
 *  now precedes the attach response and its own timeout is 6 s. */
const FRESH_PROBE_BUDGET_MS = 750

// --- pure host handlers (RPC/frame <-> pty-manager) -------------------------

// The slice of pty-manager the host needs. PtyManager satisfies this; tests pass a fake.
export interface HostPtyManager {
  createDetached(options: PtyCreateOptions, sinks: DetachedSinks): string
  /** Attach a relay-served PTY to the EXISTING tmux session for a node id (create if absent). */
  attachDetached(
    persistKey: string,
    sinks: DetachedSinks,
    options?: Omit<PtyCreateOptions, 'persistKey'>
  ): string
  /** Current visible screen of a node's tmux session, for the attach snapshot. */
  captureSnapshot(persistKey: string): Promise<string>
  /** Does a tmux session for this node id exist RIGHT NOW? Asked before `attachDetached`, which
   *  CREATES one when it doesn't — so the client can tell a warm join from a cold start. */
  sessionExists(persistKey: string): Promise<boolean>
  /** `clientId` identifies WHO typed (the bridged phone's presence peer), so the keystroke can be
   *  attributed to it — null when this session has no peer, which just means it is not badged. */
  write(clientId: number | null, sessionId: string, data: string): void
  /** `clientId` is null for a relay-served (detached) pty — see `kill` below. */
  resize(
    clientId: number | null,
    sessionId: string,
    cols: number | null,
    rows: number | null
  ): void
  /** `clientId` is null for a relay-served (detached) pty: the pause is owed by the host's sink,
   *  which returns it on drain — see PtyManager.setFlow / Session.pausedBy. */
  setFlow(clientId: number | null, sessionId: string, resume: boolean): void
  /** `clientId` is null for a relay-served (detached) pty: the sinks ARE its only subscriber. */
  kill(clientId: number | null, sessionId: string): void
}

// The slice of RelaySocket the host needs to answer the client.
export interface HostRelaySocket {
  respond(id: string, ok: boolean, body: unknown): void
  sendFrame(op: number, streamId: number, seq: number, payload: Uint8Array): boolean
}

export interface HostHandlers {
  onRpc(req: RpcRequest): void
  onFrame(frame: Frame): void
  /** Kill every live PTY this host opened (called on disconnect / stop). */
  closeAll(): void
}

// The slice of fs-ops the host serves over `fs.*` RPC. Defaults to the real fs-ops; tests inject
// a fake (or just point it at a temp dir). Mirrors the renderer's `FsApi` contract exactly so a
// remote Explorer/Editor behaves the same as a local one.
export interface HostFsOps {
  listDir(dirPath: string): Promise<DirEntry[]>
  readText(filePath: string): Promise<string>
  readBinary(filePath: string): Promise<string>
  writeText(filePath: string, content: string): Promise<boolean>
}

// The slice of GitService the host serves over `git.*` RPC — the jailed core bridge that lets a
// relay-only phone (no direct SSH) run the source-control sheet in ONE round trip per operation
// instead of N ssh execs. Strictly TYPED verbs: a free-form `git.run` would be remote command
// execution. Same cwd jail as `fs.*` (isWithinRoots); no injected instance ⇒ not served at all.
export interface HostGitOps {
  status(cwd: string): Promise<unknown>
  diff(cwd: string, path: string, staged: boolean, untracked: boolean): Promise<string>
  stage(cwd: string, paths: string[]): Promise<unknown>
  unstage(cwd: string, paths: string[]): Promise<unknown>
  commit(cwd: string, message: string): Promise<unknown>
  push(cwd: string): Promise<unknown>
  pull(cwd: string): Promise<unknown>
  history(cwd: string): Promise<unknown>
}

interface Stream {
  sessionId: string
  /** The node id (tmux persistKey) this stream attached to. The ONLY tmux target a client can
   *  reach: every session-scoped RPC resolves it from the streamId, never from client params. */
  persistKey: string
  /** Outbound OP.Output sequence counter. */
  seq: number
  /** True while the PTY is paused due to relay backpressure. */
  paused: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Build the RPC/frame router that maps a client's requests onto a pty-manager. Pure over its
 * two injected dependencies (no sockets, no Electron) so it can be unit-tested with fakes.
 *
 * `nextStreamId` lets tests assert deterministic ids; production uses a monotonic counter.
 */
/**
 * Lexically resolve `target` and confirm it sits inside one of `roots` (or equals a root). Uses
 * path.resolve so `..` traversal is normalized away — a remote client cannot reach `/etc/passwd`
 * or `~/.ssh` via `../../`. (Symlinks inside a shared root are not chased; the shared roots are
 * the user's own project directories.)
 */
function isWithinRoots(target: string, roots: string[]): boolean {
  if (!target) return false
  const resolved = path.resolve(target)
  for (const root of roots) {
    if (!root) continue
    const r = path.resolve(root)
    if (resolved === r || resolved.startsWith(r + path.sep)) return true
  }
  return false
}

export function createHostHandlers(
  pty: HostPtyManager,
  socket: HostRelaySocket,
  fs: HostFsOps = fsOps,
  // Directories the remote client may read/write within. Empty ⇒ no filesystem access is served
  // (deny-by-default). Production passes the cwds of the host's shared canvas nodes.
  getRoots: () => string[] = () => [],
  // Produce the marker-delimited "projects" blob for the `projects.list` RPC (workspace.json +
  // live tmux session names + agent-status.json — the same bytes the iOS SSH browse path reads).
  // Read-only, takes no client params. Default = empty so the 4-arg security tests still compile.
  listProjects: () => Promise<string> = async () => '',
  // The presence ClientId of the phone this host serves (null until it bridges / if it has no
  // presence slot). Read per frame, never captured: the slot is joined at onPeerReady, and the
  // session's PhonePresence outlives none of it. It makes the phone's keystrokes attributable —
  // the "X is typing" badge for a relay peer costs the iOS app exactly nothing, because the sender
  // is the identified HostSession, not something the client claims.
  getClientId: () => number | null = () => null,
  // Typed git bridge (jailed to the shared roots). Absent ⇒ `git.*` verbs are not served.
  git?: HostGitOps,
  // Registers a phone-started session as a project node (WorkspaceStore.appendRemoteNode).
  // Absent ⇒ `projects.registerNode` is not served.
  registerNode?: (projectId: string, node: RemoteNodeInput) => Promise<boolean>,
  // Permanently ends a node's session + removes the node from its canvas — the phone's
  // "End session" (`pty.destroy`), reaching the SAME path as the desktop ×
  // (`destroySession(…, {everySocket:true})` + node removal). Absent ⇒ `pty.destroy` is not
  // served, which is what an un-wired context (and every pre-feature test fake) should say.
  destroyNode?: (nodeId: string) => Promise<void>,
  // A relay stream attached to / detached from a node id — "a phone viewer is (no longer) watching
  // this session". Every stream drop funnels through `dropStream`, so attached/detached calls are
  // balanced per stream (kill, destroy, PTY exit, closeAll, an attach superseded mid-flight).
  // The desktop uses it to (a) wake a hibernated node someone just opened on their phone and
  // (b) keep Eco from hibernating a session a phone is actively watching. Absent ⇒ no tracking.
  remoteViewer?: { attached(nodeId: string): void; detached(nodeId: string): void }
): HostHandlers {
  // streamId -> Stream. PTY callbacks close over their own `streamId` directly, so no
  // reverse (sessionId -> streamId) index is needed.
  const streams = new Map<number, Stream>()
  let streamCounter = 0

  function dropStream(streamId: number): void {
    const stream = streams.get(streamId)
    streams.delete(streamId)
    // Report AFTER the delete: `detached` may consult the live viewer set via its own bookkeeping,
    // and a callback that throws must not leave the stream registered.
    if (stream) {
      try {
        remoteViewer?.detached(stream.persistKey)
      } catch {
        /* viewer bookkeeping must never break the stream teardown */
      }
    }
  }

  // Build the output/exit sinks for a new stream: pipe PTY output into OP.Output frames (with
  // relay backpressure -> setFlow pause/resume) and PTY exit into an OP.Error frame.
  function makeSinks(streamId: number, stream: Stream): DetachedSinks {
    return {
      onData: (data) => {
        const bytes = textEncoder.encode(data)
        const ok = socket.sendFrame(OP.Output, streamId, stream.seq++, bytes)
        if (!ok && !stream.paused) {
          // Relay buffer is full — pause the PTY so the OS pipe backpressures the producer.
          stream.paused = true
          pty.setFlow(null, stream.sessionId, false)
        } else if (ok && stream.paused) {
          stream.paused = false
          pty.setFlow(null, stream.sessionId, true)
        }
      },
      onExit: (exitCode) => {
        // Signal exit as an OP.Error frame carrying the code, then forget the stream.
        socket.sendFrame(
          OP.Error,
          streamId,
          stream.seq++,
          textEncoder.encode(JSON.stringify({ exitCode }))
        )
        dropStream(streamId)
      }
    }
  }

  // Reassembled snapshot is sent as one or more OP.SnapshotChunk frames between Start and End.
  // 256 KB keeps each chunk well under the relay's per-frame limits while a full-screen capture
  // (with colors) stays small in practice.
  const SNAPSHOT_CHUNK_BYTES = 256 * 1024

  function sendSnapshot(streamId: number, stream: Stream, text: string): void {
    socket.sendFrame(OP.SnapshotStart, streamId, stream.seq++, new Uint8Array(0))
    const bytes = textEncoder.encode(text)
    for (let i = 0; i < bytes.length; i += SNAPSHOT_CHUNK_BYTES) {
      socket.sendFrame(
        OP.SnapshotChunk,
        streamId,
        stream.seq++,
        bytes.subarray(i, i + SNAPSHOT_CHUNK_BYTES)
      )
    }
    socket.sendFrame(OP.SnapshotEnd, streamId, stream.seq++, new Uint8Array(0))
  }

  /**
   * Attach a mirrored terminal to the host's tmux session for `nodeId`: respond with the streamId
   * (and whether the session had to be CREATED — `fresh`), send a SNAPSHOT of the current screen
   * (so the client paints it before any live output), then start streaming live output via
   * `attachDetached`. Falls back to plain create semantics when no session exists yet
   * (attachDetached creates one; the snapshot is empty) — which is exactly what `fresh` reports,
   * so the client can run its cold restore instead of sitting in a bare login shell.
   */
  function handleAttach(req: RpcRequest): void {
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId) ?? str(p.persistKey)
    if (!nodeId) {
      socket.respond(req.id, false, { message: 'pty.attach requires a nodeId.' })
      return
    }
    const cols = Math.max(1, num(p.cols, 80))
    const rows = Math.max(1, num(p.rows, 24))

    const streamId = ++streamCounter
    const stream: Stream = { sessionId: '', persistKey: nodeId, seq: 0, paused: false }
    const sinks = makeSinks(streamId, stream)

    // Reserve the stream, then respond so the client can route Input/Resize frames; the snapshot
    // + live attach then proceed. Capturing the screen is async (a tmux side-call).
    streams.set(streamId, stream)
    // A phone viewer is now watching this node's session (reported at RESERVE time, balanced by
    // `dropStream`): the desktop wakes a hibernated node for it and shields it from Eco.
    try {
      remoteViewer?.attached(nodeId)
    } catch {
      /* viewer bookkeeping must never break the attach */
    }

    // `fresh` — did this attach CREATE the session, or join a live one? It has to be asked BEFORE
    // `attachDetached`, whose `tmux new-session -A` creates when the session is gone; afterwards
    // it always exists and the answer is meaningless. Without it a mirrored client could not tell
    // "I joined your running agent" from "I just made you an empty login shell in $HOME", which is
    // what put a bare `~ %` prompt under a Claude node's title on the phone once the host's tmux
    // server had died. The agent transport has reported this all along; the relay did not.
    //
    // Bounded, and fail-safe toward "warm": a probe that is slow or unprobeable answers `false`,
    // so a client that cold-restores on `fresh` types nothing into a session that may be live.
    // The bound matters because this now precedes the RPC response and `has-session` can sit on
    // the 6 s probe timeout when tmux itself is wedged.
    void (async () => {
      const existed = await Promise.race([
        pty.sessionExists(nodeId).catch(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(true), FRESH_PROBE_BUDGET_MS))
      ])
      socket.respond(req.id, true, { streamId, fresh: !existed })
      return pty.captureSnapshot(nodeId).catch(() => '')
    })()
      .then((snapshot) => {
        // The stream may have been killed/closed while the capture was in flight.
        if (!streams.has(streamId)) return
        // Snapshot first (current screen) — then live output begins on attach.
        sendSnapshot(streamId, stream, snapshot)
        try {
          stream.sessionId = pty.attachDetached(nodeId, sinks, { cols, rows })
        } catch {
          // Attach failed (e.g. tmux unavailable) — surface as an exit so the client tears down.
          socket.sendFrame(
            OP.Error,
            streamId,
            stream.seq++,
            textEncoder.encode(JSON.stringify({ exitCode: 1 }))
          )
          dropStream(streamId)
        }
      })
  }

  // Serve a `fs.*` RPC by calling the shared fs-ops on the host's real filesystem and responding
  // with the same shape the renderer's `FsApi` expects. fs-ops never throws (errors degrade to
  // empty/false), so this always responds ok with a result body.
  function handleFs(req: RpcRequest): void {
    const p = asRecord(req.params)
    const filePath = str(p.path) ?? ''
    const respond = (body: unknown): void => socket.respond(req.id, true, body)
    // Confine remote filesystem access to the shared project roots. A path outside them (or any
    // `../` traversal) is denied — degrade to the same empty/false shape fs-ops returns on error,
    // so the remote Explorer/Editor just sees "nothing there" rather than a thrown RPC.
    if (!isWithinRoots(filePath, getRoots())) {
      switch (req.method) {
        case 'fs.list':
          respond({ entries: [] })
          break
        case 'fs.readBinary':
          respond({ base64: '' })
          break
        case 'fs.write':
          respond({ ok: false })
          break
        default:
          respond({ content: '' })
      }
      return
    }
    switch (req.method) {
      case 'fs.list':
        void fs.listDir(filePath).then((entries) => respond({ entries }))
        break
      case 'fs.read':
        void fs.readText(filePath).then((content) => respond({ content }))
        break
      case 'fs.readBinary':
        void fs.readBinary(filePath).then((base64) => respond({ base64 }))
        break
      case 'fs.write':
        void fs.writeText(filePath, str(p.content) ?? '').then((ok) => respond({ ok }))
        break
    }
  }

  /**
   * Scroll a remote client's view of the session's tmux history.
   *
   * Scrolling belongs to tmux (its mouse is on and the pane lives on the alternate screen, so the
   * client's emulator has no scrollback of its own). This stream's pty IS a tmux client, so the
   * wheel is simply written into it as an SGR mouse event and tmux does the rest — no tmux command
   * channel, no copy-mode bookkeeping on our side. The phone drives this because it cannot deliver
   * the wheel itself: its own emulator would swallow the gesture.
   *
   * `lines` is untrusted (it arrives from a remote client) — clamp it, and address the wheel to
   * cell 1,1 so a hostile value cannot be interpolated anywhere interesting.
   */
  function handleScroll(req: RpcRequest): void {
    const p = asRecord(req.params)
    const stream = streams.get(num(p.streamId, -1))
    if (stream) {
      const up = str(p.dir) !== 'down'
      const notches = Math.min(20, Math.max(1, Math.floor(num(p.lines, 1))))
      const seq = `\x1b[<${up ? 64 : 65};1;1M`
      for (let i = 0; i < notches; i++) pty.write(getClientId(), stream.sessionId, seq)
    }
    socket.respond(req.id, true, {})
  }

  // Serve a typed `git.*` verb against the injected GitService slice, jailed to the shared roots
  // like `fs.*`. Unlike fs (silent empty degrade — the Explorer just shows nothing), a denied or
  // failed git op answers with an EXPLICIT error: the source-control sheet must say why.
  function handleGit(req: RpcRequest): void {
    if (!git) {
      socket.respond(req.id, false, { message: 'git is not served on this host.' })
      return
    }
    const p = asRecord(req.params)
    const cwd = str(p.cwd) ?? ''
    if (!isWithinRoots(cwd, getRoots())) {
      socket.respond(req.id, false, { message: 'cwd is outside the shared project roots.' })
      return
    }
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    const run = (): Promise<unknown> => {
      switch (req.method) {
        case 'git.status':
          return git.status(cwd)
        case 'git.diff':
          return git.diff(cwd, str(p.path) ?? '', p.staged === true, p.untracked === true)
        case 'git.stage':
          return git.stage(cwd, strings(p.paths))
        case 'git.unstage':
          return git.unstage(cwd, strings(p.paths))
        case 'git.commit':
          return git.commit(cwd, str(p.message) ?? '')
        case 'git.push':
          return git.push(cwd)
        case 'git.pull':
          return git.pull(cwd)
        case 'git.history':
          return git.history(cwd)
        default:
          return Promise.reject(new Error(`Unknown git verb: ${req.method}`))
      }
    }
    void run()
      .then((body) => socket.respond(req.id, true, body ?? {}))
      .catch((err: unknown) =>
        socket.respond(req.id, false, { message: (err as Error)?.message ?? 'git failed' })
      )
  }

  // Register a phone-started session as a project node. Validation (safe id shape, duplicate,
  // parsable local project file) lives in the registrar (WorkspaceStore.appendRemoteNode →
  // appendProjectNode); a refusal is an ok:{registered:false} answer, not a protocol error —
  // the phone opened its session either way and just stays unregistered.
  function handleRegisterNode(req: RpcRequest): void {
    if (!registerNode) {
      socket.respond(req.id, false, { message: 'projects.registerNode is not served on this host.' })
      return
    }
    const p = asRecord(req.params)
    const node = asRecord(p.node)
    const id = str(node.id)
    const projectId = str(p.projectId)
    if (!id || !projectId) {
      socket.respond(req.id, false, { message: 'projects.registerNode requires projectId and node.id.' })
      return
    }
    const input: RemoteNodeInput = { id }
    const title = str(node.title)
    if (title !== undefined) input.title = title
    const agentId = str(node.agentId)
    if (agentId !== undefined) input.agentId = agentId
    // The managed Claude account the phone launched this session under (its CLAUDE_CONFIG_DIR).
    // The direct-SSH registration path has always persisted it; this leg used to drop it on the
    // floor, so an off-LAN session under account X came back as the system account and every
    // account-scoped reader (transcript, context meter, find bar) then resolved against the wrong
    // root — and a cold restore resumed it as the wrong identity. Validated in the registrar
    // (appendProjectNode), which refuses the whole append rather than register a wrong identity.
    const accountId = str(node.accountId)
    if (accountId !== undefined) input.accountId = accountId
    void registerNode(projectId, input)
      .then((registered) => socket.respond(req.id, true, { registered }))
      .catch(() => socket.respond(req.id, true, { registered: false }))
  }

  function handleKill(req: RpcRequest): void {
    const streamId = num(asRecord(req.params).streamId, -1)
    const stream = streams.get(streamId)
    // An unknown streamId is an honest error, not a silent success: answering `true` here hid
    // every failure on this path from the client (issue #374) — the app had nothing to surface.
    if (!stream) {
      socket.respond(req.id, false, { message: 'Unknown streamId.' })
      return
    }
    pty.kill(null, stream.sessionId)
    dropStream(streamId)
    socket.respond(req.id, true, {})
  }

  /**
   * The phone's "End session": permanently end the stream's tmux session and remove its node from
   * the canvas, via the injected `destroyNode` — the same path the desktop × takes. Three rules:
   * - The target is the STREAM's `persistKey`, never a client-sent node id: a client can only
   *   destroy a session it has actually attached to (post-approval), the same envelope every
   *   other session-scoped RPC here lives in.
   * - The viewer is dropped in the SAME synchronous turn as the destroy begins (the R4 adjacency
   *   rule): a late Input frame must never be written into a session on its way out.
   * - The answer is honest. `destroyNode` absent, an unknown streamId, or a failed destroy all
   *   respond `ok:false` with a message the phone can show — never an unconditional success.
   * - The answer is VERIFIED (issue #581). The destroy chain deliberately swallows per-step
   *   failures ("session may not exist on this socket" is a normal case for its kill fan-out), so
   *   `destroyNode` resolving proves only that nothing threw — measured: with tmux unresolved the
   *   whole kill block is skipped and the verb answered success over a session still running. So
   *   the OUTCOME is probed: `sessionExists` after the destroy must say gone. Its fail-safe
   *   direction (unprobeable ⇒ exists) is exactly right here — a destructive verb must not report
   *   success on uncertainty (the `confirmedTmuxSessionExists` rule, applied one layer up).
   */
  function handleDestroy(req: RpcRequest): void {
    if (!destroyNode) {
      socket.respond(req.id, false, { message: 'pty.destroy is not served on this host.' })
      return
    }
    const streamId = num(asRecord(req.params).streamId, -1)
    const stream = streams.get(streamId)
    if (!stream) {
      socket.respond(req.id, false, { message: 'Unknown streamId.' })
      return
    }
    // Same cap the desktop wire applies to a client-supplied node id (endFromClient/REF_MAX_LEN):
    // the key was client-chosen at attach time and a destroy kills things — refuse, never truncate.
    if (stream.persistKey.length > REF_MAX_LEN) {
      socket.respond(req.id, false, { message: 'Invalid node id.' })
      return
    }
    const nodeId = stream.persistKey
    pty.kill(null, stream.sessionId)
    dropStream(streamId)
    void destroyNode(nodeId)
      .then(async () => {
        // Verify the user-visible outcome, not the chain's plumbing: is the session GONE?
        const stillThere = await pty.sessionExists(nodeId).catch(() => true)
        if (stillThere) {
          socket.respond(req.id, false, {
            message: 'The session is still running — the host could not end it.'
          })
          return
        }
        socket.respond(req.id, true, {})
      })
      .catch((err: unknown) =>
        socket.respond(req.id, false, {
          message: (err as Error)?.message ?? 'Could not end the session.'
        })
      )
  }

  return {
    onRpc(req) {
      switch (req.method) {
        case 'pty.create':
          // Reject: remote clients only ever attach to the host's existing tmux sessions
          // (`pty.attach`). `pty.create` would let a client spawn an arbitrary shell with a
          // client-chosen cwd — full remote command execution — so it is not served.
          socket.respond(req.id, false, { message: 'pty.create is not permitted for remote clients.' })
          break
        case 'pty.attach':
          handleAttach(req)
          break
        case 'pty.kill':
          handleKill(req)
          break
        case 'pty.destroy':
          handleDestroy(req)
          break
        case 'pty.scroll':
          handleScroll(req)
          break
        case 'fs.list':
        case 'fs.read':
        case 'fs.readBinary':
        case 'fs.write':
          handleFs(req)
          break
        case 'git.status':
        case 'git.diff':
        case 'git.stage':
        case 'git.unstage':
        case 'git.commit':
        case 'git.push':
        case 'git.pull':
        case 'git.history':
          handleGit(req)
          break
        case 'projects.registerNode':
          handleRegisterNode(req)
          break
        case 'projects.list':
          // Read-only enumeration of the host's projects/sessions/agent-status (no client params —
          // nothing to jail). Gated by the same pre-handler approval check in connectHostSession, so
          // an unapproved device never reaches here. Always respond ok; degrade to an empty blob.
          void listProjects()
            .then((output) => socket.respond(req.id, true, { output }))
            .catch(() => socket.respond(req.id, true, { output: '' }))
          break
        default:
          socket.respond(req.id, false, { message: `Unknown method: ${req.method}` })
      }
    },
    onFrame(frame) {
      const stream = streams.get(frame.streamId)
      if (!stream) return
      if (frame.op === OP.Input) {
        pty.write(getClientId(), stream.sessionId, textDecoder.decode(frame.payload))
        return
      }
      if (frame.op === OP.Resize) {
        // Payload is 2x uint16 LE: cols, rows.
        if (frame.payload.length >= 4) {
          const view = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength
          )
          // null clientId: this pty is relay-served (its sink is the only "subscriber"), so the
          // mirrored client's size is recorded against the sink rather than a UI client id.
          pty.resize(null, stream.sessionId, view.getUint16(0, true), view.getUint16(2, true))
        }
      }
    },
    closeAll() {
      // Kill every viewer first (the R4 adjacency the tests pin: `streams.clear()` in the same
      // synchronous turn), then report the departures — dropStream would interleave callbacks
      // between kills, and a callback must never widen that window.
      const closing = [...streams.values()]
      for (const stream of closing) {
        pty.kill(null, stream.sessionId)
      }
      streams.clear()
      for (const stream of closing) {
        try {
          remoteViewer?.detached(stream.persistKey)
        } catch {
          /* viewer bookkeeping must never break the teardown */
        }
      }
    }
  }
}

// --- pure canvas mirror sync (host renderer <-> relay) -----------------------

// The wire methods for the host-authoritative canvas mirror (host->client push of the
// full state, client->host one-way mutation command). Kept as constants so both sides agree.
export const CANVAS_STATE_METHOD = 'canvas:state'
export const CANVAS_MUTATE_METHOD = 'canvas:mutate'
// Client → host: "re-send me the current canvas now." Covers the case where the client mirror
// mounts/subscribes after the host's initial connect-time push (no replay otherwise).
export const CANVAS_REQUEST_METHOD = 'canvas:request'

// The slice of RelaySocket the canvas sync needs: a one-way host->client push.
export interface CanvasNotifySocket {
  notify(method: string, params?: unknown): boolean
}

export interface HostCanvasSync {
  /** Record the latest active-project canvas snapshot and broadcast it to the client. */
  setState(state: CanvasState): void
  /** Push the current known state now (e.g. on a fresh client connect). No-op if none yet. */
  broadcastCurrent(): void
  /** Route an inbound client RPC/notify; returns the mutation when it is a canvas:mutate. */
  handleRpc(req: RpcRequest): CanvasMutation | null
}

/**
 * Build the host-side canvas mirror router. Pure over its two injected dependencies (the relay
 * socket for host->client push + a sink the IPC layer forwards to the host renderer), so it is
 * unit-testable with fakes — no Electron, no real socket. The host's React Flow stays the single
 * writer: client mutations are surfaced via `onMutation` and applied there, which re-triggers the
 * renderer's debounced `setState` broadcast.
 */
export function createHostCanvasSync(
  socket: CanvasNotifySocket,
  onMutation: (mutation: CanvasMutation) => void
): HostCanvasSync {
  let current: CanvasState | null = null

  function broadcastCurrent(): void {
    if (current) socket.notify(CANVAS_STATE_METHOD, current)
  }

  return {
    setState(state) {
      current = state
      broadcastCurrent()
    },
    broadcastCurrent,
    handleRpc(req) {
      if (req.method !== CANVAS_MUTATE_METHOD) return null
      const mutation = req.params as CanvasMutation
      if (!mutation || typeof mutation !== 'object' || typeof (mutation as { op?: unknown }).op !== 'string') {
        return null
      }
      // R7: the wire mutation is CLIENT input — reduce it to layout/cosmetic changes on nodes
      // the host already has before it reaches the renderer (see sanitizeClientMutation).
      const safe = sanitizeClientMutation(mutation, current)
      if (!safe) return null
      onMutation(safe)
      return safe
    }
  }
}

// The directories a remote client may touch over fs.* = the cwds of the host's shared canvas
// nodes (each terminal node carries its project cwd). Empty when nothing is shared yet ⇒
// deny-by-default. Subdirectories are allowed via the prefix check in isWithinRoots.
function rootsFromCanvas(canvas: CanvasState | null): string[] {
  if (!canvas) return []
  const roots = new Set<string>()
  for (const node of canvas.nodes) if (node.cwd) roots.add(node.cwd)
  return [...roots]
}

// --- pairing-token mint ------------------------------------------------------

interface PairTokenResponse {
  pairingId: string
  pairingToken: string
  exp: number
}

// Mint a single-use pairing token from our API, proving entitlement with the stored token.
// Exported so the NEW interactive relay host (relay-host-service.ts) mints its offer token the same
// way (same `POST /v1/pair/token`, same entitlement proof) instead of duplicating the call.
export async function mintPairingToken(entitlement: string): Promise<PairTokenResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/v1/pair/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitlement }),
      signal: ctrl.signal
    })
  } catch {
    throw new Error('Could not reach the pairing server.')
  } finally {
    clearTimeout(timer)
  }
  const json = (await res.json().catch(() => ({}))) as Partial<PairTokenResponse> & { error?: string }
  if (!res.ok || !json.pairingToken) {
    throw new Error(json.error ? `Pairing failed: ${json.error}` : 'Pairing failed.')
  }
  return { pairingId: json.pairingId ?? '', pairingToken: json.pairingToken, exp: json.exp ?? 0 }
}

// --- persisted host keypair --------------------------------------------------

// The keypair now lives in host-identity.ts (same on-disk file + bytes: `remote-host-key.json`,
// public key plaintext base64, secret key safeStorage-encrypted or 0600 plaintext). The loader
// that used to be inlined here rotated the identity whenever the keyring happened to be locked at
// boot — it read `secretKeyEnc` only when `isEncryptionAvailable()`, missed both branches, and
// regenerated OVER the good encrypted key. host-identity refuses to write in that case
// (HostKeyLockedError) via key-file-codec's `'locked'` outcome.
//
// Re-exported under the old name so the standing (phone) host and the pairing service keep
// advertising the SAME host identity through their existing import.
export { loadOrCreateHostKeyPair as loadOrCreateKeyPair, HostKeyLockedError }

// --- dev gate ----------------------------------------------------------------

// Never hit the real relay/API from an unpackaged build unless a relay is explicitly targeted
// (mirrors license.ts's `allowed()` gate). Packaged builds are always allowed.
export function relayAllowed(): boolean {
  return app.isPackaged || !!process.env.NODETERM_RELAY_URL
}

// --- shared host session (interactive host + standing phone host) ------------

/**
 * A live host<->client relay session: the bridged relay socket plus its RPC/frame handlers and
 * canvas mirror, gated by an approval flag. Both the interactive remote host and the standing
 * phone host build one of these; they differ only in how a freshly-bridged peer is approved
 * (interactive SAS prompt vs. pin-once auto-approve).
 */
export interface HostSession {
  /** Approve the currently-bridged peer → begin serving its pty/fs RPCs + input frames. */
  approve(): void
  /** Currently approved? */
  isApproved(): boolean
  /** Channel SAS (for the approval prompt), or null before the handshake derives a key. */
  sas(): string | null
  /** The bridged peer's box public key (base64), or null before `e2ee_hello`. */
  peerPublicKeyB64(): string | null
  /** Tear down: kill served PTYs + close the relay socket. */
  close(): void
}

export interface HostSessionOptions {
  /** Relay wss URL. */
  url: string
  /** Single-use pairing token gating entry at the relay. */
  token: string
  /** The long-lived host NaCl keypair. */
  ourKeys: KeyPair
  /** The real pty-manager whose tmux sessions the peer attaches to. */
  pty: PtyManager
  /** The host renderer's latest active-project canvas snapshot (source of the mirror). */
  getLatestCanvas(): CanvasState | null
  /** Subscribe to canvas updates so the mirror re-broadcasts. Returns unsubscribe. */
  subscribeCanvas(cb: (state: CanvasState) => void): () => void
  /** Forward a (sanitized) client canvas mutation to the host renderer (the single writer). */
  applyMutation(mutation: CanvasMutation): void
  /**
   * Produce the marker-delimited projects blob for the `projects.list` RPC (see createHostHandlers).
   * Optional: omit for host sessions that don't serve project browse (defaults to an empty blob).
   */
  listProjects?: () => Promise<string>
  /**
   * The presence ClientId of the phone this session bridges (its PhonePresence slot), so its
   * keystrokes are attributed to it in the typing badge. Optional: a host session without a
   * presence slot serves input exactly as before, unbadged.
   */
  getClientId?: () => number | null
  /** Typed, jailed `git.*` bridge (see HostGitOps). Optional: absent ⇒ the verbs are not served. */
  git?: HostGitOps
  /** Registers a phone-started session as a project node (`projects.registerNode`). Optional. */
  registerNode?: (projectId: string, node: RemoteNodeInput) => Promise<boolean>
  /** Permanently ends a node's session + removes the node (`pty.destroy`). Optional: absent ⇒
   *  the verb answers with an honest "not served" error. */
  destroyNode?: (nodeId: string) => Promise<void>
  /** Relay-viewer presence per node (attach/detach, balanced per stream) — see createHostHandlers.
   *  Optional: absent ⇒ no tracking. */
  remoteViewer?: { attached(nodeId: string): void; detached(nodeId: string): void }
  /** Extra fs/git jail roots beyond the shared canvas's node cwds — production passes the
   *  workspace's local project cwds: the phone browses EVERY project over `projects.list`, so a
   *  canvas-only jail denied whichever project the desktop didn't happen to have focused. */
  extraRoots?: () => string[]
  /**
   * A peer completed the E2EE handshake and awaits an approval decision. The caller inspects the
   * session (sas / peerPublicKeyB64) and either approves immediately (pin-once) or prompts the
   * host human, later calling `approve()`.
   */
  onPeerReady(session: HostSession): void
  /** The relay socket dropped (client/relay gone). */
  onClose(): void
}

/**
 * Build a host relay session: connect as the host, wire the RPC/frame handlers + canvas mirror,
 * and gate everything behind an approval flag. Extracted so the interactive host (initRemoteHost)
 * and the standing phone host share one implementation.
 */
export function connectHostSession(opts: HostSessionOptions): HostSession {
  // Approval gate: a freshly-bridged peer serves NO pty/fs RPCs or input frames until approved,
  // so a leaked/guessed pairing cannot grant silent access. Reset on every (re)connect.
  let approved = false
  let handlers: HostHandlers | null = null
  let canvasSync: HostCanvasSync | null = null
  let unsubCanvas: (() => void) | null = null
  // Small main-side debounce to coalesce bursts of renderer canvas updates.
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null

  function pushCurrentCanvas(): void {
    // NEVER expose canvas state (node titles, project cwds, sticky text, editor file paths,
    // browser URLs, ssh user@host) before the human approves the device — a leaked/unapproved
    // client completing only the E2EE handshake must see nothing.
    if (!approved) return
    const state = opts.getLatestCanvas()
    if (state) canvasSync?.setState(state)
  }
  function scheduleBroadcast(): void {
    if (broadcastTimer) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      pushCurrentCanvas()
    }, 120)
    broadcastTimer.unref?.()
  }

  const session: HostSession = {
    approve() {
      approved = true
      // Flush the current canvas now that the device is trusted.
      pushCurrentCanvas()
    },
    isApproved() {
      return approved
    },
    sas() {
      return socket.sas()
    },
    peerPublicKeyB64() {
      return socket.peerPublicKeyB64()
    },
    close() {
      if (broadcastTimer) {
        clearTimeout(broadcastTimer)
        broadcastTimer = null
      }
      approved = false
      unsubCanvas?.()
      unsubCanvas = null
      handlers?.closeAll()
      handlers = null
      canvasSync = null
      socket.close()
    }
  }

  const socket: RelaySocket = connectRelay({
    url: opts.url,
    token: opts.token,
    role: 'host',
    ourKeys: opts.ourKeys,
    onReady: () => {
      // Bridge established. Require approval before serving ANYTHING — including canvas state
      // (which carries workspace metadata). Nothing is pushed until approve() flushes it.
      approved = false
      opts.onPeerReady(session)
    },
    onRpc: (req) => {
      // Until approved, refuse every request — pty/fs RPCs, client mutations, AND canvas
      // snapshots (canvas:request). An unapproved device gets nothing but the approval prompt.
      if (!approved) {
        if (req.id) socket.respond(req.id, false, { message: 'Awaiting host approval.' })
        return
      }
      // A client asking for a fresh canvas snapshot → re-push the current one (read-only).
      if (req.method === CANVAS_REQUEST_METHOD) {
        canvasSync?.broadcastCurrent()
        return
      }
      if (canvasSync?.handleRpc(req)) return
      handlers?.onRpc(req)
    },
    onFrame: (frame) => {
      if (approved) handlers?.onFrame(frame)
    },
    onClose: () => {
      approved = false
      handlers?.closeAll()
      opts.onClose()
    }
  })
  // Confine the client's fs.* access to the cwds of the host's currently-shared canvas nodes.
  handlers = createHostHandlers(
    opts.pty,
    socket,
    fsOps,
    () => [...rootsFromCanvas(opts.getLatestCanvas()), ...(opts.extraRoots?.() ?? [])],
    opts.listProjects ?? (async () => ''),
    opts.getClientId ?? (() => null),
    opts.git,
    opts.registerNode,
    opts.destroyNode,
    opts.remoteViewer
  )
  canvasSync = createHostCanvasSync(socket, opts.applyMutation)
  unsubCanvas = opts.subscribeCanvas(() => scheduleBroadcast())

  return session
}

// --- IPC wiring --------------------------------------------------------------

/**
 * Wire the host-mode IPC. `remote:host:start` gates on Pro, mints a pairing token, connects to
 * the relay as host, and returns the offer string. `remote:host:stop` closes the relay socket
 * (which kills the served PTYs and drops the client's access).
 */
/** The optional core-bridge deps both hosts thread into connectHostSession (jailed git verbs +
 *  phone node registration). One bag so the init signatures stop growing positionally. */
export interface HostBridgeDeps {
  git?: HostGitOps
  registerNode?: (projectId: string, node: { id: string; title?: string; agentId?: string }) => Promise<boolean>
  /** The phone's "End session" (`pty.destroy`): destroy the tmux session on every socket it could
   *  live on + take the node off its project's canvas — the desktop ×'s two steps. */
  destroyNode?: (nodeId: string) => Promise<void>
  /** Relay-viewer presence per node — wakes a hibernated node a phone just opened and shields a
   *  phone-watched session from Eco (see main/index.ts's counter). */
  remoteViewer?: { attached(nodeId: string): void; detached(nodeId: string): void }
  /** Workspace-level jail roots (local project cwds) merged with the canvas node cwds. */
  workspaceRoots?: () => string[]
}

export function initRemoteHost(
  win: BrowserWindow,
  ptyManager: PtyManager,
  listProjects: () => Promise<string> = async () => '',
  bridge: HostBridgeDeps = {}
): void {
  initHostCanvasHub()
  let session: HostSession | null = null
  // The live session's presence slot (the bridged phone's peer). Paired with `session` and replaced
  // with it, so a superseded session's late callbacks can never touch the new session's peer.
  let presence: PhonePresence | null = null
  // A fresh id per pending approval. The approve/reject IPC channels are SHARED with the standing
  // phone host, and a single "Approve" click broadcasts to both listeners — so each acts only on
  // an event carrying ITS OWN pending id, never on one meant for the other host.
  let pendingApprovalId: string | null = null
  let pendingApprovalPub: string | null = null

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // Tear the live session down. Used by EVERY intentional end path (stop, reject, and a `start`
  // that supersedes a live session): relay-socket treats close() as final and does NOT fire
  // onClose, so the presence leave has to happen here as well as in onClose. PhonePresence.leave()
  // is exactly-once, so whichever path runs second is a no-op and the peer never leaves twice.
  function endSession(): void {
    presence?.leave()
    presence = null
    session?.close()
    session = null
    pendingApprovalId = null
  }

  ipcMain.handle(IPC.remoteHostStart, async (): Promise<{ offer: string }> => {
    if (!isPremium()) {
      throw new Error('Remote access requires nodeterm Pro.')
    }
    if (!relayAllowed()) {
      throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
    }
    const entitlement = getStoredEntitlement()
    if (!entitlement) {
      throw new Error('No entitlement found — please re-activate nodeterm Pro.')
    }

    // Already hosting → tear the old session down before starting a fresh one.
    endSession()

    const keys = await loadOrCreateHostKeyPair()
    const { pairingToken } = await mintPairingToken(entitlement)

    // This session's presence slot, captured by its own callbacks (never read through `presence`,
    // which by then may belong to a newer session).
    const phone = createPhonePresence()
    presence = phone
    session = connectHostSession({
      url: RELAY_URL,
      token: pairingToken,
      ourKeys: keys,
      pty: ptyManager,
      getLatestCanvas: currentCanvas,
      subscribeCanvas,
      applyMutation: (mutation) => send(IPC.remoteHostApplyMutation, mutation),
      listProjects,
      git: bridge.git,
      registerNode: bridge.registerNode,
      destroyNode: bridge.destroyNode,
      remoteViewer: bridge.remoteViewer,
      extraRoots: bridge.workspaceRoots,
      // Typing attribution: this session's input frames are this phone's keystrokes.
      getClientId: () => phone.id(),
      // Interactive host: surface the SAS + a fresh pending id so the human can verify + approve.
      onPeerReady: (s) => {
        // Team presence: a bridged relay client is a peer. It has no mouse, so it stays cursorless
        // and appears in the facepile only — see docs/team-presence.md ("Peers may have no cursor").
        phone.join()
        pendingApprovalId = randomUUID()
        pendingApprovalPub = s.peerPublicKeyB64()
        send(IPC.remoteHostPeerPending, {
          sas: s.sas(),
          id: pendingApprovalId,
          pub: pendingApprovalPub
        })
      },
      onClose: () => {
        phone.leave()
        pendingApprovalId = null
        pendingApprovalPub = null
      }
    })

    return {
      offer: encodeOffer({
        relayEndpoint: RELAY_URL,
        pairingToken,
        hostPublicKeyB64: publicKeyToB64(keys.publicKey)
      })
    }
  })

  // Host human approved the pending device → start serving its pty/fs RPCs. Only act on a
  // still-pending session: the approve/reject channels are shared with the standing phone host,
  // so an event meant for the phone must not disturb an already-approved interactive session.
  ipcMain.on(IPC.remoteHostApprove, (_e, msg: { id?: string; pub?: string } = {}) => {
    const matched =
      (pendingApprovalId && msg?.id === pendingApprovalId) ||
      (pendingApprovalPub && msg?.pub === pendingApprovalPub)
    if (!matched) return
    pendingApprovalId = null
    pendingApprovalPub = null
    if (session && !session.isApproved()) session.approve()
  })
  // Host human rejected the pending device → drop the connection entirely (pending sessions only).
  ipcMain.on(IPC.remoteHostReject, (_e, msg: { id?: string; pub?: string } = {}) => {
    const matched =
      (pendingApprovalId && msg?.id === pendingApprovalId) ||
      (pendingApprovalPub && msg?.pub === pendingApprovalPub)
    if (!matched) return
    pendingApprovalId = null
    pendingApprovalPub = null
    if (session && !session.isApproved()) endSession()
  })

  ipcMain.handle(IPC.remoteHostStop, () => {
    endSession()
  })
}
