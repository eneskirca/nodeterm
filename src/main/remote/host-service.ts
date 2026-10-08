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
import { validHistoryQuery, type HistorySearch } from '../../core/terminal-history'
import { HistoryScrollView } from '../../core/history-scroll-view'
import type { NativeScrollResult } from '../../shared/history-scroll'
import { COMPOSED_INPUT_UNCERTAIN, COMPOSED_INPUT_UNSUPPORTED, parseComposedInput, type ComposedInput, type ComposedInputResult } from '../../shared/composed-input'
import type { CanvasMutation, CanvasState, DirEntry, KanbanColumn, KanbanLabel, PtyCreateOptions } from '../../shared/types'
import type { AgentId } from '../../shared/agents/config'
import { PtyManager, type DetachedSinks, type RelayAttachPrep } from '../../core/pty-manager'
import * as fsOps from '../../core/fs-ops'
import { TITLE_MAX, type RemoteNodeInput } from '../../core/project-node-append'
import { parseCardLabelEdit, type CardLabelEdit } from '../../core/project-kanban-write'
import { isValidPendingId, type PendingAnswerResult } from '../../core/agents/pending-approvals'
import { GROK_AMBIGUOUS_SESSION_MESSAGE, isGrokAmbiguousSessionError, normalizeChatPage } from '../../shared/chat-page'
import {
  CHAT_SEND_TEXT_MAX,
  sanitizeChatText,
  type ChatPage,
  type ChatSendOutcome,
  type ChatStatus
} from '../../shared/mobile-chat'
import { getStoredEntitlement, isPremium } from '../../core/license'
import { publicKeyToB64, type KeyPair } from './e2ee'
import { loadOrCreateHostKeyPair, HostKeyLockedError } from './host-identity'
import { OP, type Frame } from './framing'
import { encodeOffer } from './pairing'
import { sanitizeClientMutation } from './canvas-sync'
import { connectRelay, type RelaySocket, type RpcRequest } from './relay-socket'
import { initHostCanvasHub, currentCanvas, subscribeCanvas } from './host-canvas-hub'
import { createPhonePresence, type PhonePresence } from './phone-presence'
import type { HostLanReport } from './host-lan-report'
import { createRelayPairingProof, type LegacyRelayPairings } from './relay-pairing-proof'
import { RELAY_PAIRING_CHALLENGE_METHOD, RELAY_PAIRING_PROOF_METHOD } from '../../shared/relay-pairing-proof'
import { registerPeerSessionKiller } from './peer-revoke'

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
  /** Mode-aware movement on this exact attached viewer; absent means no safe wheel route. */
  scrollAttached?(clientId: number | null, sessionId: string, up: boolean, lines: number,
    capture: boolean, current: () => boolean): Promise<NativeScrollResult>
  /** Explicit composer action on this exact attached viewer. Absent on older implementations. */
  submitComposed?(sessionId: string, input: ComposedInput, current: () => boolean): Promise<ComposedInputResult>
  /** Search all retained output of this attached generation. Absent on older hosts. */
  historySearch?(sessionId: string, query: string): Promise<HistorySearch>
  createDetached(options: PtyCreateOptions, sinks: DetachedSinks): string
  /** Attach a relay-served PTY to the EXISTING tmux session for a node id (create if absent). */
  attachDetached(
    persistKey: string,
    sinks: DetachedSinks,
    options?: Omit<PtyCreateOptions, 'persistKey'>
  ): string
  /** Resolve bounded project settings before the phone can deliver its cold launch line.
   * The commit stays synchronous: no input may fall between SnapshotEnd and live attachment. */
  prepareDetachedAttach?(
    persistKey: string,
    options: Omit<PtyCreateOptions, 'persistKey'>
  ): Promise<{ readonly fresh: boolean; attach(sinks: DetachedSinks): string }>
  /** Current visible screen of a node's tmux session, for the attach snapshot. */
  captureSnapshot(persistKey: string): Promise<string>
  /** Does a tmux session for this node id exist RIGHT NOW? Asked before `attachDetached`, which
   *  CREATES one when it doesn't — so the client can tell a warm join from a cold start. */
  /** Decide where (and with what env) a relay attach for a node id runs, from this machine's own
   *  records — see `PtyManager.prepareRelayAttach`. Replaces the bare local `attachDetached`, which
   *  created a LOCAL session for a remote node. */
  prepareRelayAttach?(
    nodeId: string,
    size: { cols: number; rows: number },
    hint?: { projectId?: string; create?: Pick<PtyCreateOptions, 'cwd' | 'accountId' | 'agentId' | 'ownerProjectId'> }
  ): Promise<RelayAttachPrep>
  /** Does a session for this node id exist RIGHT NOW? (The destroy path's outcome check.) */
  sessionExists(persistKey: string): Promise<boolean>
  /** `sessionExists` / `captureSnapshot` for a node on an SSH project's host (see HostRemoteNodes).
   *  Optional: absent ⇒ remote nodes are refused rather than attached locally. */
  sessionExistsOver?(persistKey: string, sshRemote: NonNullable<PtyCreateOptions['sshRemote']>): Promise<boolean>
  captureSnapshotOver?(persistKey: string, sshRemote: NonNullable<PtyCreateOptions['sshRemote']>): Promise<string>
  /** `node.sendKeys` for a node on an SSH project's host: type the keys into its REMOTE pane over
   *  the master. Optional: absent ⇒ such a node answers `sent:false`, never a local write. */
  backgroundWriteOver?(
    persistKey: string,
    data: string,
    sshRemote: NonNullable<PtyCreateOptions['sshRemote']>
  ): Promise<boolean>
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

/**
 * Renderer-nudge node actions the phone's session-LIST long-press menu invokes (`node.wake` /
 * `node.refresh` / `node.rename`). Each forwards to the host renderer and returns whether it was
 * DELIVERED to a live window — never whether the action "worked": all three are nudges in the
 * `agent:wake` shape (the renderer re-reads its own state and no-ops for a node it cannot
 * resolve), which is exactly why they may take a client-sent node id where the session-scoped
 * RPCs must not — the worst a hostile id buys is a no-op nudge, and `pty.attach` already accepts
 * a client-chosen node id for a far stronger capability. Absent ⇒ the verbs answer an honest
 * "not served" (a pre-feature host, and every pre-feature test fake).
 */
export interface HostNodeActions {
  /** Ask the renderer to wake a hibernated node (same `agent:wake` channel the attach path uses). */
  wake(nodeId: string): boolean
  /** Ask the renderer to reload the node's terminal view in place (`respawnNonce` bump). */
  refresh(nodeId: string): boolean
  /** Rename a node through the renderer's `renameSession` funnel (title pre-sanitized here). */
  rename(nodeId: string, title: string): boolean
  /**
   * Type a short quick answer (`node.sendKeys`) into the node's session without attaching a new
   * client. Resolves whether it was delivered. Optional: absent ⇒ "not served", and the phone falls
   * back to its old attach-and-write. LOCAL nodes only: a node `HostRemoteNodes` places on an SSH
   * host is typed over its master (`HostPtyManager.backgroundWriteOver`) and never reaches this.
   */
  sendKeys?(nodeId: string, keys: string): Promise<boolean>
}

/**
 * What `node.sendKeys` accepts: a SHORT quick answer — a digit or a few printable characters, ESC,
 * Enter. It exists for the Inbox's question/approval shortcuts, not as a general input channel
 * (`pty.attach` is that), so anything longer or carrying other control bytes is refused.
 */
// eslint-disable-next-line no-control-regex -- the allowed controls are exactly ESC and CR
export const SEND_KEYS_RE = /^[\x1b\r\x20-\x7e]{1,16}$/

/**
 * The kanban board writes the phone may ask this host to make on its behalf (`projects.ensureBoard`
 * / `projects.setCardColumn`). Both land in `WorkspaceStore`, which owns the read-modify-write and
 * the save-chain ordering; nothing here touches a file.
 *
 * Two things the phone cannot do for itself, and this is why the verbs exist rather than more SSH:
 * an SSH project's `.nodeterm/project.json` lives on a THIRD machine that the phone has no
 * credentials for (only this desktop mirrors it), and the phone's direct-SSH write inlines the
 * whole file into one argv string, so it silently stops working past Linux's `MAX_ARG_STRLEN`.
 * Over these verbs the request is a few hundred bytes whatever the canvas weighs.
 *
 * Absent ⇒ the verbs answer an honest "not served" (a pre-feature host, and every pre-feature test
 * fake), which the phone shows to the user instead of doing nothing.
 */
export interface HostKanbanOps {
  /** Seed the default board on a project that has none; returns the board's columns either way,
   *  or null when this project can have no board written. IDEMPOTENT. */
  ensureBoard(projectId: string): Promise<KanbanColumn[] | null>
  /** Move a card to a column (null = the virtual Ungrouped column). False = nothing was written. */
  setCardColumn(projectId: string, nodeId: string, columnId: string | null): Promise<boolean>
  /** Add / remove / create board labels on one card (`projects.editCardLabels`) — the phone's
   *  long-press label sheet. Answers the palette + the card's label ids as they now stand, or null
   *  when the project has no writable file. Optional so a host (or test fake) built before the verb
   *  answers an honest "not served" instead of failing to compile. */
  editCardLabels?(
    projectId: string,
    nodeId: string,
    edit: CardLabelEdit
  ): Promise<{ edited: boolean; labels: KanbanLabel[]; cardLabelIds: string[] } | null>
}

/**
 * The phone's Inbox actions that need the DESKTOP rather than the pane (`approvals.answer` /
 * `inbox.ack`). A phone on direct SSH does both by writing files on the host (the hook-reply
 * `~/.nodeterm/pending/<id>.answer`, the `~/.nodeterm/acks/<nodeId>.seen` read-ack); a phone on the
 * relay cannot — `fs.*` is jailed to the project roots, and rightly so — so without these verbs a
 * relay-only phone (every Windows host, and any phone off the LAN) could neither answer a held
 * approval nor tell the desktop it read a finished session. Typing `1` instead is NOT a substitute:
 * while the hook holds the request the prompt is not on screen yet, so the keystroke would land in
 * the agent's composer.
 *
 * Both land on the SAME functions the desktop's own surfaces use (the canvas Approve/Deny button's
 * `agent:answer-permission` handler; the ack sweeper's `ackDone` + unread-clear), so a relay answer
 * cannot drift from a local one. Absent ⇒ the verbs answer an honest "not served".
 */
export interface HostInboxOps {
  /**
   * Answer a held permission hook. `sent` = the answer reached a hold that still exists; `gone` =
   * the hold had already ended (the hook timed out, or another surface answered) so nothing was
   * written; `failed` = the write could not happen. See `PendingAnswerResult`.
   */
  answerPermission(nodeId: string, pendingId: string, decision: 'allow' | 'deny' | 'allow-always', suggestionIndex?: number): Promise<PendingAnswerResult>
  /** v2 held AskUserQuestion: indexes for every question, validated against the live request. */
  answerQuestion?(nodeId: string, pendingId: string, selections: number[][]): Promise<PendingAnswerResult>
  /** The phone READ a finished session: resolve its done event(s) and clear the desktop unread. */
  ackRead(nodeId: string): void
}

/**
 * Nodes of the desktop's SSH projects live on ANOTHER machine: their tmux session is on that host,
 * reached over the project's ControlMaster. A relay `pty.attach` used to attach them to the
 * desktop's LOCAL tmux, which created an empty phantom `nt-<id>` here and had the phone offer to
 * resume the agent on the wrong machine (audit A09) — against the rule that a remote node is never
 * spawned locally. With this injected, such a node is attached over its master or refused.
 */
export interface HostRemoteNodes {
  /**
   * `null` = a local node. Otherwise the node's host (`user@host`, for the refusal text) and, when
   * the project's ControlMaster is connected and its setup finished, the `sshRemote` to attach over.
   */
  resolve(nodeId: string): { where: string; sshRemote?: NonNullable<PtyCreateOptions['sshRemote']> } | null
}

/**
 * Where a session the PHONE starts is created (audit A33). `pty.attach` of a fresh node id creates
 * its tmux session; the phone could only steer it through the launch line (`cd '<dir>' &&`,
 * `CLAUDE_CONFIG_DIR=…`), which is POSIX shell — on a Windows host the session started in the home
 * folder and silently dropped the account. The phone now names the project (and account/agent) on
 * the attach, and the HOST resolves them from its own registry and settings, applied only when the
 * attach creates the session. Everything is validated here; anything unknown is simply not applied.
 *
 * The agent id is what gives the created session its agent-specific hook env, and
 * `ownerProjectId` — the index entry id, resolved by the host, never the phone's string unchecked —
 * records the pane's owner the way a canvas-started spawn does (audit A72). Production:
 * `createHostNewSessions` (host-new-sessions.ts).
 */
export interface HostNewSessions {
  resolve(req: {
    projectId: string
    accountId?: string
    agentId?: string
  }): Pick<PtyCreateOptions, 'cwd' | 'accountId' | 'agentId' | 'ownerProjectId'> | null
  /** Saved host facts win over create hints. Undefined means unknown; null means known but
   * ineligible, so a caller cannot replace that node's owner with a different project hint. */
  resolveNode?(nodeId: string): ReturnType<HostNewSessions['resolve']> | undefined
}

/**
 * The phone's Chat screen (docs/mobile-chat-view.md §3.2): `chat.page` / `chat.status` /
 * `chat.send` / `agent.answer`. The phone sends ONLY a node id (plus paging / text / answer);
 * everything about the node — cwd, account, agent, session id, transcript path, SSH routing — is
 * resolved host-side inside the ops from the desktop's own registry, because node ids are
 * attacker-controllable and a phone-supplied path must never be trusted. Absent ⇒ every verb
 * answers an honest "not served" (a pre-feature host, and every pre-feature test fake).
 */
export interface HostChatOps {
  /** One page of the node's transcript. `null` ⇒ the host does not know this node; `'unsupported'`
   *  ⇒ its agent has no chat view. Rejects when the read failed (never an empty page standing in
   *  for a failure). */
  page(nodeId: string, rawPage: unknown): Promise<ChatPage | null | 'unsupported'>
  /** The node's agent state + held request. `null` ⇒ unknown node. Rejects when the desktop
   *  window did not answer — never a guessed state. `catalog` (the phone asked for it) adds the
   *  composer's `/` catalog; a failure to build it drops the field, never the status. */
  status(nodeId: string, opts?: { catalog?: boolean }): Promise<ChatStatus | null>
  /** Type `text` (already stripped of control chars) into the node's pane through the desktop's
   *  own send gate. Only `'sent'` means Enter was confirmed. */
  send(nodeId: string, text: string): Promise<ChatSendOutcome | 'unknown-node'>
  /** Answer the node's held request (`answerHeldPermission`: validated against the pending
   *  request file, structured-ticket gated). `false` = nothing was written. */
  answer(nodeId: string, pendingId: string, answer: unknown): Promise<boolean>
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
  history: HistoryScrollView
  scrollTail: Promise<void>
  pendingScroll: number
  /** Exact-stream input held only while the remote attach commit is still in flight. */
  pendingInput: Array<{ clientId: number | null; data: string }>
  pendingInputBytes: number
  pendingSize?: { cols: number; rows: number }
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
  remoteViewer?: { attached(nodeId: string): void; detached(nodeId: string): void },
  // Renderer-nudge node actions for the phone's session-list long-press menu (`node.wake` /
  // `node.refresh` / `node.rename`). Absent ⇒ the verbs answer an honest "not served".
  nodeActions?: HostNodeActions,
  // Kanban board writes on the phone's behalf (`projects.ensureBoard` / `projects.setCardColumn`).
  // Absent ⇒ the verbs answer an honest "not served".
  kanban?: HostKanbanOps,
  // Inbox actions (`approvals.answer` / `inbox.ack`). Absent ⇒ the verbs answer "not served".
  inbox?: HostInboxOps,
  // Which nodes belong to an SSH project, and how to reach their host (see HostRemoteNodes).
  // Absent ⇒ every node is attached locally, as before (the Server Edition has no SSH projects).
  remoteNodes?: HostRemoteNodes,
  // Where a phone-started session is created (see HostNewSessions). Absent ⇒ `{cols, rows}` only.
  newSessions?: HostNewSessions,
  // This computer's current LAN address and SSH host keys, sent as `lan` next to every `projects.list`
  // answer (audit A74-refresh, host-lan-report.ts): the phone refreshes the LAN leg it dials from a
  // relay-authenticated answer. Absent, or answering null ⇒ no `lan` field, the reply as before.
  lanReport?: () => Promise<HostLanReport | null>,
  // The phone's Chat screen (`chat.page` / `chat.status` / `chat.send` / `agent.answer`).
  // Absent ⇒ the verbs answer an honest "not served".
  chat?: HostChatOps
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
      stream.history.clear()
      stream.pendingInput = []
      stream.pendingInputBytes = 0
      stream.pendingSize = undefined
      try {
        remoteViewer?.detached(stream.persistKey)
      } catch {
        /* viewer bookkeeping must never break the stream teardown */
      }
    }
  }

  // Build the output/exit sinks for a new stream: pipe PTY output into OP.Output frames (with
  // relay backpressure -> setFlow pause/resume) and PTY exit into an OP.Error frame.
  //
  // `resizedFrames` is the client saying it renders `OP.Resized` — the size the shared pty really
  // runs at, same payload layout as `OP.Resize` (2x uint16 LE cols, rows). Only a session-host
  // session ever sends one (issue #914: it follows its most recently active viewer, which may be a
  // desktop node). The frame is sent either way — a client that does not know it drops it — but
  // a client that did NOT opt in is treated as unable to adapt, so the session never grows past
  // its screen: output wider than the phone would wrap into garbage there rather than clip.
  function makeSinks(streamId: number, stream: Stream, resizedFrames: boolean): DetachedSinks {
    return {
      adaptsToSize: resizedFrames,
      onSize: (size) => {
        const payload = new Uint8Array(4)
        const view = new DataView(payload.buffer)
        view.setUint16(0, Math.min(0xffff, Math.max(1, size.cols)), true)
        view.setUint16(2, Math.min(0xffff, Math.max(1, size.rows)), true)
        socket.sendFrame(OP.Resized, streamId, stream.seq++, payload)
      },
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
   * (so the client paints it before any live output), then start streaming live output. Falls
   * back to create semantics when no session exists yet (the attach creates one, with the env the
   * desktop would give that node; the snapshot is empty) — which is exactly what `fresh` reports,
   * so the client can run its cold restore instead of sitting in a bare login shell. A node whose
   * session lives on a remote host with no live master is REFUSED (`{message, reason}`), never
   * started locally.
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

    // A node of an SSH project: attach it over that project's ControlMaster, or refuse — never a
    // local session (audit A09). Resolved before a stream is reserved, so a refusal leaves nothing.
    let remote: NonNullable<PtyCreateOptions['sshRemote']> | undefined
    let owner: ReturnType<HostRemoteNodes['resolve']> = null
    try {
      owner = remoteNodes?.resolve(nodeId) ?? null
    } catch {
      owner = null
    }
    if (owner) {
      if (!owner.sshRemote || !pty.sessionExistsOver || !pty.captureSnapshotOver) {
        socket.respond(req.id, false, {
          message:
            `This session runs on ${owner.where}, and your computer is not connected to it right now. ` +
            'Open that project in nodeterm on the computer, then try again.'
        })
        return
      }
      remote = owner.sshRemote
    }

    // A phone starting a NEW session names its project (and account/agent): the host resolves the
    // folder, account, agent and pane owner itself (A33, A72). Resolved now, applied only if this
    // attach creates the session — `created` below, from this machine's own `sessionExists` probe,
    // which fails toward "exists". That gate is what keeps a JOIN from claiming a pane's ownership
    // (`agents/pane-ownership.ts`: ownership is recorded on a genuine fresh spawn only).
    let create: Pick<PtyCreateOptions, 'cwd' | 'accountId' | 'agentId' | 'ownerProjectId'> | null = null
    const projectId = str(p.projectId)
    if (!remote && newSessions) {
      try {
        const saved = newSessions.resolveNode?.(nodeId)
        create = saved === undefined
          ? projectId && projectId.length <= REF_MAX_LEN
            ? newSessions.resolve({ projectId, accountId: str(p.accountId), agentId: str(p.agentId) })
            : null
          : saved
      } catch {
        create = null
      }
    }
    const streamId = ++streamCounter
    const stream: Stream = { sessionId: '', persistKey: nodeId, seq: 0, paused: false,
      history: new HistoryScrollView(), scrollTail: Promise.resolve(), pendingScroll: 0,
      pendingInput: [], pendingInputBytes: 0 }
    const sinks = makeSinks(streamId, stream, p.resizedFrames === true)

    // Reserve while the capture/settings preparation is async. Respond, snapshot and live attach
    // commit together afterwards, so the client cannot send its launch into an unready session.
    streams.set(streamId, stream)
    // A phone viewer is now watching this node's session (reported at RESERVE time, balanced by
    // `dropStream`): the desktop wakes a hibernated node for it and shields it from Eco.
    try {
      remoteViewer?.attached(nodeId)
    } catch {
      /* viewer bookkeeping must never break the attach */
    }

    // Core resolves saved local/SSH records. Only the host's validated creation fallback may
    // supply facts for an unregistered local node; saved facts and remote refusal always win.
    void (async () => {
      let prep: RelayAttachPrep
      try {
        if (pty.prepareRelayAttach) {
          prep = await pty.prepareRelayAttach(nodeId, { cols, rows }, {
            projectId: str(p.projectId), ...(create ? { create } : {})
          })
        } else {
          // Compatibility for older managers: retain Android's bounded preparation and explicit
          // remote-only routing, with no unchecked phone paths or launch facts.
          const existed = await Promise.race([
            (remote ? pty.sessionExistsOver!(nodeId, remote) : pty.sessionExists(nodeId)).catch(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(true), FRESH_PROBE_BUDGET_MS))
          ])
          const options = remote
            ? { cols, rows, sshRemote: remote, requireRemote: true }
            : { cols, rows, ...((pty.prepareDetachedAttach || !existed) && create ? create : {}) }
          const prepared = pty.prepareDetachedAttach
            ? await pty.prepareDetachedAttach(nodeId, options)
            : { fresh: !existed, attach: (s: DetachedSinks) => pty.attachDetached(nodeId, s, options) }
          prep = {
            kind: 'ready', remote: !!remote,
            get fresh() { return prepared.fresh },
            sessionExists: () => remote ? pty.sessionExistsOver!(nodeId, remote) : pty.sessionExists(nodeId),
            snapshot: () => remote ? pty.captureSnapshotOver!(nodeId, remote) : pty.captureSnapshot(nodeId),
            attach: async (s) => prepared.attach(s)
          }
        }
      } catch {
        prep = { kind: 'refused', reason: 'not-connected', message: 'Could not prepare this session.' }
      }
      if (streams.get(streamId) !== stream) return
      if (prep.kind === 'refused') {
        dropStream(streamId)
        socket.respond(req.id, false, { message: prep.message, reason: prep.reason })
        return
      }
      const existed = await Promise.race([
        prep.sessionExists().catch(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(true), FRESH_PROBE_BUDGET_MS))
      ])
      const snapshot = await prep.snapshot().catch(() => '')
      if (streams.get(streamId) !== stream) return
      socket.respond(req.id, true, { streamId, fresh: prep.fresh ?? !existed,
        ...(pty.scrollAttached ? { scrollV1: true } : {}) })
      sendSnapshot(streamId, stream, snapshot)
      try {
        const sessionId = await prep.attach(sinks)
        if (streams.get(streamId) !== stream) {
          // A closed stream cannot adopt a client whose remote spawn was still in flight.
          pty.kill(null, sessionId)
          return
        }
        stream.sessionId = sessionId
        const size = stream.pendingSize
        stream.pendingSize = undefined
        if (size) pty.resize(null, sessionId, size.cols, size.rows)
        const input = stream.pendingInput
        stream.pendingInput = []
        stream.pendingInputBytes = 0
        for (const item of input) {
          if (streams.get(streamId) !== stream) break
          pty.write(item.clientId, sessionId, item.data)
        }
      } catch {
        if (stream.sessionId) pty.kill(null, stream.sessionId)
        socket.sendFrame(OP.Error, streamId, stream.seq++,
          textEncoder.encode(JSON.stringify({ exitCode: 1 })))
        dropStream(streamId)
      }
    })().catch(() => {
      if (streams.get(streamId) !== stream) return
      socket.respond(req.id, false, { message: 'Could not prepare this session.' })
      dropStream(streamId)
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

  /** One FIFO per captured viewer. A mixed scroll may write input, so it is never replayed. */
  function queueScroll(req: RpcRequest, stream: Stream, work: () => Promise<void>): void {
    if (stream.pendingScroll >= 32) {
      socket.respond(req.id, true, { status: 'refused', message: 'Terminal scrolling is busy. Try again.' })
      return
    }
    stream.pendingScroll++
    const turn = stream.scrollTail.then(work)
    stream.scrollTail = turn.catch(() => {}).then(() => { stream.pendingScroll-- })
    void turn.catch(() => {
      stream.history.clear()
      socket.respond(req.id, true, {
        status: 'uncertain', message: 'The scrolling result is unknown. It was not retried.'
      })
    })
  }

  // Compatibility RPC: only a positively resolved tmux viewer may receive the old SGR wheels.
  // Native retained history needs the negotiated page response; never inject wheels when off.
  function handleScroll(req: RpcRequest): void {
    const p = asRecord(req.params)
    const streamId = num(p.streamId, -1), stream = streams.get(streamId)
    if (!stream) { socket.respond(req.id, true, {}); return }
    if (!stream.sessionId || !pty.scrollAttached) {
      socket.respond(req.id, false, { message: 'Safe scrolling is not served on this attached terminal.' }); return
    }
    const sessionId = stream.sessionId
    const current = (): boolean => streams.get(streamId) === stream && stream.sessionId === sessionId
    const up = str(p.dir) !== 'down', notches = Math.min(20, Math.max(1, Math.floor(num(p.lines, 1))))
    queueScroll(req, stream, async () => {
      if (!current()) { socket.respond(req.id, false, { message: 'This terminal is no longer attached.' }); return }
      const result = await pty.scrollAttached!(getClientId(), sessionId, up, notches, false, current)
      if (result.status === 'input') { stream.history.clear(); socket.respond(req.id, true, {}); return }
      socket.respond(req.id, false, { message: result.status === 'history'
        ? 'Update the phone app to browse this terminal’s retained history.' : result.message })
    })
  }

  function handleScrollV1(req: RpcRequest): void {
    const p = asRecord(req.params)
    const streamId = num(p.streamId, -1), stream = streams.get(streamId)
    const refuse = (message: string): void => socket.respond(req.id, true, { status: 'refused', message })
    if (!Number.isInteger(streamId) || !stream?.sessionId) { refuse('This terminal is no longer attached.'); return }
    if (!pty.scrollAttached) { refuse('Update nodeterm on the computer to browse terminal history.'); return }
    if ((p.dir !== 'up' && p.dir !== 'down') || !Number.isInteger(p.lines) ||
        (p.lines as number) < 1 || (p.lines as number) > 20 ||
        (p.viewId !== undefined && (typeof p.viewId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.viewId)))) {
      refuse('Invalid terminal history movement.'); return
    }
    const up = p.dir === 'up', notches = p.lines as number, viewId = p.viewId as string | undefined
    const sessionId = stream.sessionId
    const current = (): boolean => streams.get(streamId) === stream && stream.sessionId === sessionId
    queueScroll(req, stream, async () => {
      if (!current()) { refuse('This terminal is no longer attached.'); return }
      let capture: boolean
      try { capture = stream.history.needsCapture(viewId) }
      catch (error) { refuse(error instanceof Error ? error.message : 'This history view expired.'); return }
      // Once history is open it is an inert, immutable view. Application output enabling mouse
      // reporting underneath it must not redirect these gestures into foreground input.
      if (!capture) {
        try { socket.respond(req.id, true, stream.history.page(up, notches)) }
        catch (error) {
          stream.history.clear()
          refuse(error instanceof Error ? error.message : 'Terminal history could not be read.')
        }
        return
      }
      const result = await pty.scrollAttached!(getClientId(), sessionId, up, notches, capture, current)
      if (result.status === 'input') { stream.history.clear(); socket.respond(req.id, true, result); return }
      if (result.status !== 'history') { stream.history.clear(); socket.respond(req.id, true, result); return }
      if (!current()) { refuse('The terminal detached while its history was read.'); return }
      try {
        if (capture) {
          if (!result.capture) throw new Error('The computer did not return terminal history.')
          stream.history.install(result.capture)
        }
        socket.respond(req.id, true, stream.history.page(up, notches))
      } catch (error) {
        stream.history.clear()
        refuse(error instanceof Error ? error.message : 'Terminal history could not be read.')
      }
    })
  }

  function handleHistorySearch(req: RpcRequest): void {
    const p = asRecord(req.params)
    const streamId = num(p.streamId, -1)
    const stream = streams.get(streamId)
    if (!stream?.sessionId) { socket.respond(req.id, false, { message: 'This terminal is no longer attached.' }); return }
    if (!pty.historySearch) { socket.respond(req.id, false, { message: 'History search is not served on this host. Update nodeterm on the computer.' }); return }
    if (!validHistoryQuery(p.query)) { socket.respond(req.id, false, { message: 'Enter a single-line search of 1–256 characters.' }); return }
    void pty.historySearch(stream.sessionId, p.query).then((result) => {
      if (streams.get(streamId) !== stream) throw new Error('The terminal detached while its history was searched.')
      socket.respond(req.id, true, result)
    }).catch((error: unknown) => socket.respond(req.id, false, { message: error instanceof Error ? error.message : 'History search failed.' }))
  }

  function handleSubmitComposed(req: RpcRequest): void {
    const p = asRecord(req.params)
    const streamId = num(p.streamId, -1)
    const stream = streams.get(streamId)
    const input = parseComposedInput(p.input)
    if (!input) { socket.respond(req.id, false, { message: 'Invalid composed terminal input.' }); return }
    if (!stream?.sessionId) { socket.respond(req.id, false, { message: 'This terminal is no longer attached.' }); return }
    if (!pty.submitComposed) { socket.respond(req.id, false, { message: COMPOSED_INPUT_UNSUPPORTED }); return }
    const current = (): boolean => streams.get(streamId) === stream
    void pty.submitComposed(stream.sessionId, input, current).then((result) => {
      // Once dispatched, a detached viewer can still have received input. Never turn that into a
      // proven refusal or retry; the client also binds completion to its own presentation ticket.
      socket.respond(req.id, true, result)
    }).catch(() => socket.respond(req.id, true, { status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN }))
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

  /**
   * The two kanban board verbs, which exist because the phone's own SSH write cannot cover either
   * of the cases they serve (see `HostKanbanOps`).
   *
   * `projects.ensureBoard { projectId }` → `{ columns }`: seed the default board on a project that
   * has none, or hand back the board it already has. Idempotent, so the phone may call it on every
   * Board tap without ever being the thing that replaces a board someone built.
   *
   * `projects.setCardColumn { projectId, nodeId, columnId | null }` → `{ moved }`: move one card.
   *
   * `projects.editCardLabels { projectId, nodeId, add?, remove?, create? }` →
   * `{ edited, labels, cardLabelIds }`: the phone's long-press label sheet, writing the SAME board
   * labels the canvas node's "+ Label" row and the kanban card edit (`@shared/kanban-labels`).
   * `labels: null` = this project has no writable file; `edited: false` with a palette = nothing
   * changed (a retry, or an `add` naming a label the phone's stale copy still had).
   *
   * Validation lives in the store's pure transforms (`project-kanban-write.ts`), which refuse
   * anything they cannot do rather than inventing a board or a column — and a refusal is an
   * `ok:{...false}` ANSWER, not a protocol error, because the phone must be able to tell the user
   * "that didn't happen" instead of leaving the optimistic card where it dropped it.
   *
   * No jail is needed and none is faked: the client sends a projectId and NOTHING path-shaped, and
   * the file path is always derived by the store from its own index — the same rule the board-log
   * handlers state. A projectId this host does not have is simply not found.
   */
  function handleKanban(req: RpcRequest): void {
    if (!kanban) {
      socket.respond(req.id, false, { message: `${req.method} is not served on this host.` })
      return
    }
    const p = asRecord(req.params)
    const projectId = str(p.projectId)
    if (!projectId) {
      socket.respond(req.id, false, { message: `${req.method} requires a projectId.` })
      return
    }
    if (req.method === 'projects.ensureBoard') {
      void kanban
        .ensureBoard(projectId)
        .then((columns) => socket.respond(req.id, true, { columns: columns ?? null }))
        .catch(() => socket.respond(req.id, true, { columns: null }))
      return
    }
    const nodeId = str(p.nodeId)
    if (!nodeId) {
      socket.respond(req.id, false, { message: `${req.method} requires a nodeId.` })
      return
    }
    if (req.method === 'projects.editCardLabels') {
      if (!kanban.editCardLabels) {
        socket.respond(req.id, false, { message: `${req.method} is not served on this host.` })
        return
      }
      // Validated HERE, at the write site, before the store is touched: the params are client-sent
      // and end up in a git-shared, hand-editable file every collaborator's canvas renders. A
      // malformed edit is a protocol error (the phone sent something it should never send), unlike
      // a stale label id, which is an `edited:false` answer carrying the current palette.
      const edit = parseCardLabelEdit({ add: p.add, remove: p.remove, create: p.create })
      if (!edit) {
        socket.respond(req.id, false, {
          message:
            'projects.editCardLabels requires add/remove (label ids) and/or create ' +
            '({name, color}) with at least one entry; names must be 1–60 characters without ' +
            'control characters and colors one of the board palette.'
        })
        return
      }
      void kanban
        .editCardLabels(projectId, nodeId, edit)
        .then((res) =>
          socket.respond(
            req.id,
            true,
            res ?? { edited: false, labels: null, cardLabelIds: null }
          )
        )
        .catch(() => socket.respond(req.id, true, { edited: false, labels: null, cardLabelIds: null }))
      return
    }
    // `null` is a REAL value here (the virtual Ungrouped column), so it must be told apart from a
    // missing/garbage key — which is refused rather than silently read as "unassign".
    const raw = p.columnId
    if (raw !== null && typeof raw !== 'string') {
      socket.respond(req.id, false, {
        message: 'projects.setCardColumn requires columnId: a column id, or null for Ungrouped.'
      })
      return
    }
    void kanban
      .setCardColumn(projectId, nodeId, raw)
      .then((moved) => socket.respond(req.id, true, { moved }))
      .catch(() => socket.respond(req.id, true, { moved: false }))
  }

  /**
   * `approvals.answer {nodeId, pendingId, decision}` → `{answered}` and `inbox.ack {nodeId}` → `{}`
   * (see `HostInboxOps`). Every field is client-sent and validated here before it reaches a path: the
   * pendingId with the SAME rule the answer writer applies (`isValidPendingId` — it becomes a file
   * name), the node id with the rule `node.*` applies. `answered:false` is an ANSWER, not a protocol
   * error, and it carries WHY in `reason`: `gone` (the hook's hold already ended — its request file is
   * gone, so the interactive prompt is on screen now or someone else answered) or `failed` (the host
   * could not write). `reason` is additive: a phone that predates it reads only `answered`.
   */
  function handleInbox(req: RpcRequest): void {
    if (!inbox) {
      socket.respond(req.id, false, { message: `${req.method} is not served on this host.` })
      return
    }
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId)
    // eslint-disable-next-line no-control-regex -- refusing control chars is the point
    if (!nodeId || nodeId.length > REF_MAX_LEN || /[\x00-\x1f\x7f-\x9f]/.test(nodeId)) {
      socket.respond(req.id, false, { message: 'Invalid node id.' })
      return
    }
    if (req.method === 'inbox.ack') {
      try {
        inbox.ackRead(nodeId)
      } catch {
        /* best-effort, exactly like the file-drop sweep it mirrors */
      }
      socket.respond(req.id, true, {})
      return
    }
    const pendingId = str(p.pendingId) ?? ''
    if (req.method === 'questions.answer') {
      if (!isValidPendingId(pendingId) || !Array.isArray(p.selections) || p.selections.length < 1 || p.selections.length > 4 ||
          p.selections.some(row => !Array.isArray(row) || row.length < 1 || row.length > 4 || row.some(n => !Number.isInteger(n) || n < 0 || n > 3))) {
        socket.respond(req.id, false, { message: 'questions.answer requires a live ticket and bounded option indexes.' })
        return
      }
      if (!inbox.answerQuestion) {
        socket.respond(req.id, false, { message: 'questions.answer is not served on this host.' })
        return
      }
      void inbox.answerQuestion(nodeId, pendingId, p.selections as number[][])
        .then(result => socket.respond(req.id, true, result === 'sent' ? { answered: true } : { answered: false, reason: result }))
        .catch(() => socket.respond(req.id, true, { answered: false, reason: 'failed' }))
      return
    }
    const decision = p.decision
    const suggestionIndex = typeof p.suggestionIndex === 'number' ? p.suggestionIndex : undefined
    if (!isValidPendingId(pendingId) || (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-always') ||
        (decision === 'allow-always' && (!Number.isInteger(suggestionIndex) || suggestionIndex! < 0 || suggestionIndex! > 31))) {
      socket.respond(req.id, false, {
        message: 'approvals.answer requires a pendingId and a decision of allow or deny.'
      })
      return
    }
    const operation = decision === 'allow-always'
      ? inbox.answerPermission(nodeId, pendingId, decision, suggestionIndex)
      : inbox.answerPermission(nodeId, pendingId, decision)
    void operation
      .then((result) =>
        socket.respond(req.id, true, result === 'sent' ? { answered: true } : { answered: false, reason: result })
      )
      .catch(() => socket.respond(req.id, true, { answered: false, reason: 'failed' }))
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

  /**
   * `node.wake` / `node.refresh` / `node.rename {nodeId, title?}` — the session-list long-press
   * actions. Unlike the session-scoped RPCs these take a client-sent `nodeId`, deliberately:
   * they fire from the LIST, where no stream exists, and each is a renderer NUDGE that no-ops
   * for a node the canvas cannot resolve (the same trust envelope as `pty.attach`'s
   * client-chosen node id, for a much weaker capability). Validation still applies — the id is
   * length-capped and control-char-refused, and a rename title is sanitized here (control chars
   * out, `TITLE_MAX` clamp) BEFORE it rides toward a `/rename` command line. The answer means
   * "delivered to a live desktop window", never "the action happened" — that contract is in the
   * verb docs the iOS client mirrors.
   */
  /**
   * `node.sendKeys {nodeId, keys}` → `{sent}`. The phone's Inbox answers used to attach a throwaway
   * 80x24 tmux client, write, and kill it at once: an Input that beat the async attach was dropped
   * (no session yet), and one that did not could die with the client before tmux read it — a lone
   * ESC (Deny) nearly always, inside tmux's escape-time (audit A12). This types through the node's
   * existing session instead. `sent:false` is an ANSWER (not delivered: open the session).
   *
   * A node of one of the desktop's SSH projects is typed into on ITS host, over the project's
   * ControlMaster (`pty.backgroundWriteOver`); it used to answer `sent:false` outright, which sent
   * the phone to open the session for what is meant to be a one-tap answer. The master being down
   * (or still running its connect setup) is still `sent:false`, and so is a node the host does not
   * have — the remote target is exact, so a miss never lands in another node's session.
   */
  function handleSendKeys(req: RpcRequest): void {
    if (!nodeActions?.sendKeys) {
      socket.respond(req.id, false, { message: `${req.method} is not served on this host.` })
      return
    }
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId)
    // eslint-disable-next-line no-control-regex -- refusing control chars is the point
    if (!nodeId || nodeId.length > REF_MAX_LEN || /[\x00-\x1f\x7f-\x9f]/.test(nodeId)) {
      socket.respond(req.id, false, { message: 'Invalid node id.' })
      return
    }
    const keys = str(p.keys) ?? ''
    if (!SEND_KEYS_RE.test(keys)) {
      socket.respond(req.id, false, { message: 'node.sendKeys takes a short answer: up to 16 printable characters, Esc or Enter.' })
      return
    }
    // A writer that throws (synchronously or not) delivered nothing: `sent:false`, never a dropped reply.
    const answer = (deliver: () => Promise<boolean>): void => {
      void Promise.resolve()
        .then(deliver)
        .then((sent) => socket.respond(req.id, true, { sent: sent === true }))
        .catch(() => socket.respond(req.id, true, { sent: false }))
    }
    // A node of an SSH project: its tmux is on THAT host. Type over the project's ControlMaster —
    // the same resolver `pty.attach` uses for such a node (audit A09) — or answer `sent:false`,
    // which the phone reads as "open the session". Never the local socket: an `nt-<id>` there is at
    // best nothing and at worst a phantom left by an old attach. A resolver that throws has not
    // said the node is local, so that is `sent:false` too, not a guess.
    let owner: ReturnType<HostRemoteNodes['resolve']>
    try {
      owner = remoteNodes?.resolve(nodeId) ?? null
    } catch {
      socket.respond(req.id, true, { sent: false })
      return
    }
    if (owner) {
      if (!owner.sshRemote || !pty.backgroundWriteOver) {
        socket.respond(req.id, true, { sent: false })
        return
      }
      const { sshRemote } = owner
      const over = pty.backgroundWriteOver.bind(pty)
      answer(() => over(nodeId, keys, sshRemote))
      return
    }
    const local = nodeActions.sendKeys.bind(nodeActions)
    answer(() => local(nodeId, keys))
  }

  function handleNodeAction(req: RpcRequest): void {
    if (!nodeActions) {
      socket.respond(req.id, false, { message: `${req.method} is not served on this host.` })
      return
    }
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId)
    // eslint-disable-next-line no-control-regex -- refusing control chars is the point
    if (!nodeId || nodeId.length > REF_MAX_LEN || /[\x00-\x1f\x7f-\x9f]/.test(nodeId)) {
      socket.respond(req.id, false, { message: 'Invalid node id.' })
      return
    }
    let delivered = false
    if (req.method === 'node.rename') {
      // Strip C0/C1 control chars (ESC/CSI included — the paste-injection rule: a payload must
      // not be able to become structure) and collapse the leftovers; clamp to the registrar's
      // TITLE_MAX so a rename can never persist a title registration would have refused.
      const raw = str(p.title) ?? ''
      const title = raw
        // eslint-disable-next-line no-control-regex -- stripping control chars is the point
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TITLE_MAX)
      if (!title) {
        socket.respond(req.id, false, { message: 'node.rename requires a non-empty title.' })
        return
      }
      delivered = nodeActions.rename(nodeId, title)
    } else {
      delivered = req.method === 'node.wake' ? nodeActions.wake(nodeId) : nodeActions.refresh(nodeId)
    }
    if (!delivered) {
      // The desktop window is gone (quitting / crashed) — an honest refusal, not a silent "ok"
      // over a nudge that reached nothing.
      socket.respond(req.id, false, { message: 'The desktop window is not available.' })
      return
    }
    socket.respond(req.id, true, {})
  }

  /**
   * The phone Chat verbs. Same node-id envelope as `handleNodeAction` (REF_MAX_LEN, no control
   * chars) — the id is the ONLY thing about the node the phone supplies. Each op resolves the node
   * itself and answers "unknown" for a node the host has not got, which is refused here rather than
   * answered with an empty success.
   */
  function handleChat(req: RpcRequest): void {
    const fail = (message: string): void => socket.respond(req.id, false, { message })
    if (!chat) {
      fail(`${req.method} is not served on this host.`)
      return
    }
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId)
    // eslint-disable-next-line no-control-regex -- refusing control chars is the point
    if (!nodeId || nodeId.length > REF_MAX_LEN || /[\x00-\x1f\x7f-\x9f]/.test(nodeId)) {
      fail('Invalid node id.')
      return
    }
    switch (req.method) {
      case 'chat.page': {
        // Only the two paging fields cross; validated HERE (normalizeChatPage throws on a bad
        // `before`, which reaches a remote shell line on the SSH leg) so a refusal never costs a read.
        const rawPage = { ...(p.before !== undefined ? { before: p.before } : {}), ...(p.maxBytes !== undefined ? { maxBytes: p.maxBytes } : {}) }
        try {
          normalizeChatPage(rawPage)
        } catch {
          fail('Invalid page.')
          return
        }
        void chat
          .page(nodeId, rawPage)
          .then((page) =>
            page === 'unsupported'
              ? fail('Chat is not available for this agent.')
              : page
                ? socket.respond(req.id, true, { page })
                : fail('Unknown node.')
          )
          // An id naming two host grok sessions is its own sentence: "could not read" would
          // promise a retry that can never help. Every other failure stays generic.
          .catch((e: unknown) =>
            fail(isGrokAmbiguousSessionError(e) ? GROK_AMBIGUOUS_SESSION_MESSAGE : 'Could not read the transcript.')
          )
        return
      }
      case 'chat.status':
        void chat
          // Opt-in (`catalog: true`): an older phone sends no such param and gets the old shape.
          .status(nodeId, p.catalog === true ? { catalog: true } : undefined)
          .then((status) => (status ? socket.respond(req.id, true, { status }) : fail('Unknown node.')))
          .catch(() => fail('The desktop window is not available.'))
        return
      case 'chat.send': {
        const raw = str(p.text) ?? ''
        // The cap is on the RAW text (what crossed the wire), in UTF-16 units like every text cap.
        if (raw.length > CHAT_SEND_TEXT_MAX) {
          fail('Text too long.')
          return
        }
        // ESC + C0/C1 stripped (\n and \t kept): a payload must never become a control sequence.
        const text = sanitizeChatText(raw)
        if (!text.trim()) {
          fail('chat.send requires non-empty text.')
          return
        }
        void chat
          .send(nodeId, text)
          .then((out) =>
            out === 'unknown-node'
              ? fail('Unknown node.')
              : socket.respond(req.id, true, { result: out.result, ...(out.reason ? { reason: out.reason } : {}) })
          )
          // A send that threw is a refusal, never "sent": the phone keeps the draft.
          .catch(() => socket.respond(req.id, true, { result: 'refused', reason: 'unavailable' }))
        return
      }
      case 'agent.answer': {
        const pendingId = str(p.pendingId)
        if (!pendingId || !isValidPendingId(pendingId)) {
          fail('Invalid pending id.')
          return
        }
        void chat
          .answer(nodeId, pendingId, p.answer)
          .then((ok) => socket.respond(req.id, true, { ok: ok === true }))
          .catch(() => socket.respond(req.id, true, { ok: false }))
        return
      }
    }
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
        case 'pty.scrollV1':
          handleScrollV1(req)
          break
        case 'pty.historySearch':
          handleHistorySearch(req)
          break
        case 'pty.submitComposed':
          handleSubmitComposed(req)
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
        case 'projects.ensureBoard':
        case 'projects.setCardColumn':
        case 'projects.editCardLabels':
          handleKanban(req)
          break
        case 'chat.page':
        case 'chat.status':
        case 'chat.send':
        case 'agent.answer':
          handleChat(req)
          break
        case 'node.wake':
        case 'node.refresh':
        case 'node.rename':
          handleNodeAction(req)
          break
        case 'node.sendKeys':
          handleSendKeys(req)
          break
        case 'approvals.answer':
        case 'questions.answer':
        case 'inbox.ack':
          handleInbox(req)
          break
        case 'projects.list':
          // Read-only enumeration of the host's projects/sessions/agent-status (no client params —
          // nothing to jail). Gated by the same pre-handler approval check in connectHostSession, so
          // an unapproved device never reaches here. Always respond ok; degrade to an empty blob.
          // `lan` (additive, A74-refresh) rides beside the blob, never inside it: the blob is the
          // shape a phone on direct SSH reads off the host itself, and the address and keys must
          // reach the phone only over this authenticated channel. A failed read leaves it out.
          void Promise.all([
            listProjects().catch(() => ''),
            Promise.resolve()
              .then(() => lanReport?.() ?? null)
              .catch(() => null)
          ]).then(([output, lan]) => socket.respond(req.id, true, { output, ...(lan ? { lan } : {}) }))
          break
        default:
          socket.respond(req.id, false, { message: `Unknown method: ${req.method}` })
      }
    },
    onFrame(frame) {
      const stream = streams.get(frame.streamId)
      if (!stream) return
      if (frame.op === OP.Input) {
        const data = textDecoder.decode(frame.payload)
        if (!stream.sessionId) {
          // The attach reply must precede snapshot frames for the phone to register the stream.
          // Its first input can arrive while a remote master is still pacing the async commit.
          // Keep only this stream's bounded input; close/refusal/overflow can never replay it.
          if (stream.pendingInput.length >= 32 || stream.pendingInputBytes + frame.payload.length > 64 * 1024) {
            socket.sendFrame(OP.Error, frame.streamId, stream.seq++,
              textEncoder.encode(JSON.stringify({ exitCode: 1 })))
            dropStream(frame.streamId)
            return
          }
          stream.pendingInput.push({ clientId: getClientId(), data })
          stream.pendingInputBytes += frame.payload.length
        } else {
          pty.write(getClientId(), stream.sessionId, data)
        }
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
          const size = { cols: view.getUint16(0, true), rows: view.getUint16(2, true) }
          if (!stream.sessionId) stream.pendingSize = size
          else pty.resize(null, stream.sessionId, size.cols, size.rows)
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
        stream.history.clear()
        stream.pendingInput = []
        stream.pendingInputBytes = 0
        stream.pendingSize = undefined
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
 * The longest a freshly bridged peer's requests are held while an async `onPeerReady` decides
 * without the human (connectHostSession). The decision is a few local disk reads and at most one
 * pin write (whose rename retries add up to about 0.3 s on Windows), so this is generous; a
 * decision stuck past it (a hung disk) degrades to the answer every request got before holding
 * existed, "Awaiting host approval.". Far under the phone's own request timeout (30 s on Android).
 */
export const PEER_DECISION_HOLD_MS = 5_000
/** Requests beyond this many, while holding, are answered at once (a peer flooding the hold). */
export const PEER_DECISION_HOLD_MAX = 32

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
  /** Optional on the standing phone host only; approved retained-SSH association, never approval. */
  legacyRelayPairings?: LegacyRelayPairings
  /** Relay wss URL. */
  url: string
  /** Single-use pairing token gating entry at the relay. */
  token: string
  /** The long-lived host NaCl keypair. */
  ourKeys: KeyPair
  /** The pty-manager whose tmux sessions the peer attaches to: the real PtyManager in both hosts.
   *  Typed as the slice the session uses (it only hands it to createHostHandlers), so the Android
   *  interop fixture's fake is checked against exactly that, with no cast (audit A67). */
  pty: HostPtyManager
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
  /** Renderer-nudge node actions (`node.wake` / `node.refresh` / `node.rename`) for the phone's
   *  session-list long-press menu. Optional: absent ⇒ the verbs answer an honest "not served". */
  nodeActions?: HostNodeActions
  /** Kanban board writes for the phone's Board sheet (`projects.ensureBoard` /
   *  `projects.setCardColumn`). Optional: absent ⇒ the verbs answer an honest "not served". */
  kanban?: HostKanbanOps
  /** Inbox actions for a relay phone (`approvals.answer` / `inbox.ack`). Optional: absent ⇒ the
   *  verbs answer an honest "not served". */
  inbox?: HostInboxOps
  /** SSH-project nodes: attach over their master, never locally. Optional (see HostRemoteNodes). */
  remoteNodes?: HostRemoteNodes
  /** Where a phone-started session is created (see HostNewSessions). Optional. */
  newSessions?: HostNewSessions
  /** This computer's current LAN address and SSH host keys for the `projects.list` answer's `lan`
   *  field (audit A74-refresh). Optional: absent ⇒ no `lan` field. */
  lanReport?: () => Promise<HostLanReport | null>
  /** The phone's Chat screen verbs (`chat.*` / `agent.answer`). Optional: absent ⇒ "not served". */
  chat?: HostChatOps
  /** Extra fs/git jail roots beyond the shared canvas's node cwds — production passes the
   *  workspace's local project cwds: the phone browses EVERY project over `projects.list`, so a
   *  canvas-only jail denied whichever project the desktop didn't happen to have focused. */
  extraRoots?: () => string[]
  /**
   * A peer completed the E2EE handshake and awaits an approval decision. The caller inspects the
   * session (sas / peerPublicKeyB64) and either approves immediately (pin-once) or prompts the
   * host human, later calling `approve()`.
   *
   * May return a promise for a decision it makes WITHOUT the human (the standing host reads its pin
   * store and may pin a paired phone's key, all on disk): until it settles, or until `approve()`,
   * the peer's requests are HELD rather than refused (see PEER_DECISION_HOLD_MS). It settles once
   * the session is approved or handed to the human; a request held until then is answered as if it
   * had arrived then. A plain `void` (the interactive host) holds nothing.
   */
  onPeerReady(session: HostSession): void | Promise<void>
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
  let closed = false
  const pairingProof = opts.legacyRelayPairings ? createRelayPairingProof({
    hostKey: publicKeyToB64(opts.ourKeys.publicKey), peerKey: () => socket.peerPublicKeyB64(),
    current: () => approved && !closed, pairings: opts.legacyRelayPairings
  }) : null
  // Requests held while an async `onPeerReady` is still making its silent decision (review of
  // A07-late). The host fires onReady the moment it confirms the handshake, so the phone's first
  // request can arrive one relay round trip later, while the standing host is still reading its
  // pin store (and, for a paired phone it has not pinned yet, reading agent.json and writing the
  // pin). Answering that request "Awaiting host approval." told the phone a human had to approve
  // it: a background check (Android RelayConnector with requireApproved) gives up on the first such
  // answer and forgets that this computer approved it. Held instead, the request is answered once
  // the decision is in: served when it approved, "Awaiting host approval." when it went to the
  // human. Never held longer than PEER_DECISION_HOLD_MS or beyond PEER_DECISION_HOLD_MAX requests:
  // past either, the answer is the one this gave before.
  let deciding = false
  let held: RpcRequest[] = []
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  function stopHolding(): RpcRequest[] {
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    deciding = false
    const queue = held
    held = []
    return queue
  }
  /** The decision is in (approved, handed to the human, or out of time): answer what was held, in order. */
  function releaseHeld(): void {
    for (const req of stopHolding()) handleRpc(req)
  }
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
      if (closed) return
      approved = true
      // Flush the current canvas now that the device is trusted.
      pushCurrentCanvas()
      // Serve what the peer asked while the decision was being made, before anything it asks next.
      releaseHeld()
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
      closed = true
      pairingProof?.close()
      if (broadcastTimer) {
        clearTimeout(broadcastTimer)
        broadcastTimer = null
      }
      approved = false
      stopHolding() // nothing held is answered on a session being torn down
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
      if (closed) return
      // Bridge established. Require approval before serving ANYTHING — including canvas state
      // (which carries workspace metadata). Nothing is pushed until approve() flushes it.
      approved = false
      // Hold from before the call, so an approve() made synchronously inside it releases nothing
      // that is later held again.
      deciding = true
      let decision: unknown
      try {
        decision = opts.onPeerReady(session)
      } catch (err) {
        releaseHeld()
        throw err
      }
      if (!deciding) return // approve() already ran, inside the call
      if (decision instanceof Promise) {
        holdTimer = setTimeout(releaseHeld, PEER_DECISION_HOLD_MS)
        holdTimer.unref?.()
        decision.then(releaseHeld, releaseHeld) // a failed decision answers as one that went to the human
      } else {
        releaseHeld() // a synchronous decision: nothing to wait for
      }
    },
    onRpc: (req) => {
      if (deciding && held.length < PEER_DECISION_HOLD_MAX) {
        held.push(req)
        return
      }
      handleRpc(req)
    },
    onFrame: (frame) => {
      if (approved) handlers?.onFrame(frame)
    },
    onClose: () => {
      closed = true
      pairingProof?.close()
      approved = false
      stopHolding()
      handlers?.closeAll()
      opts.onClose()
    }
  })
  function handleRpc(req: RpcRequest): void {
    // Until approved, refuse every request — pty/fs RPCs, client mutations, AND canvas
    // snapshots (canvas:request). An unapproved device gets nothing but the approval prompt.
    if (!approved) {
      if (req.id) socket.respond(req.id, false, { message: 'Awaiting host approval.' })
      return
    }
    if (req.method === RELAY_PAIRING_CHALLENGE_METHOD || req.method === RELAY_PAIRING_PROOF_METHOD) {
      if (!req.id) return // notifications cannot allocate/consume a proof
      if (!pairingProof) { socket.respond(req.id, false, { message: 'Relay pairing proof is not served on this host.' }); return }
      const result = req.method === RELAY_PAIRING_CHALLENGE_METHOD ? pairingProof.challenge(req.params) : pairingProof.proof(req.params)
      void result.then(body => { if (!closed) socket.respond(req.id, true, body) }, () => {
        if (!closed) socket.respond(req.id, false, { message: 'The pairing identity could not be verified. Pair again to repair it.' })
      })
      return
    }
    // A client asking for a fresh canvas snapshot → re-push the current one (read-only).
    if (req.method === CANVAS_REQUEST_METHOD) {
      canvasSync?.broadcastCurrent()
      return
    }
    if (canvasSync?.handleRpc(req)) return
    handlers?.onRpc(req)
  }
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
    opts.remoteViewer,
    opts.nodeActions,
    opts.kanban,
    opts.inbox,
    opts.remoteNodes,
    opts.newSessions,
    opts.lanReport,
    opts.chat
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
  /** Renderer-nudge node actions for the phone's session-list long-press menu (`node.wake` /
   *  `node.refresh` / `node.rename`) — see main/index.ts's deliverers. */
  nodeActions?: HostNodeActions
  /** Kanban board writes for the phone's Board sheet — see main/index.ts's WorkspaceStore wiring. */
  kanban?: HostKanbanOps
  /** Inbox actions for a relay phone — the same answer writer / read-ack the desktop itself uses. */
  inbox?: HostInboxOps
  /** SSH-project nodes attach over their project's ControlMaster, or are refused (audit A09). */
  remoteNodes?: HostRemoteNodes
  /** A phone-started session is created in its project's folder, under its account (audit A33). */
  newSessions?: HostNewSessions
  /** The phone's Chat screen verbs — see main/remote/host-chat.ts and main/index.ts's wiring. */
  chat?: HostChatOps
  /** Workspace-level jail roots (local project cwds) merged with the canvas node cwds. */
  workspaceRoots?: () => string[]
  /** This computer's current LAN address and SSH host keys, beside every `projects.list` answer, so
   *  a relay phone can refresh the LAN leg it dials (audit A74-refresh, host-lan-report.ts). */
  lanReport?: () => Promise<HostLanReport | null>
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

  // Revocation (peer-revoke.ts): this session is never pinned, so an unpin alone would never reach
  // it — a revoke must be able to cut it by the key it authenticated (or is awaiting SAS for).
  registerPeerSessionKiller('phone', (match) => {
    const key = session?.peerPublicKeyB64()
    if (key && match(key)) endSession()
  })

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
      nodeActions: bridge.nodeActions,
      kanban: bridge.kanban,
      inbox: bridge.inbox,
      remoteNodes: bridge.remoteNodes,
      newSessions: bridge.newSessions,
      chat: bridge.chat,
      extraRoots: bridge.workspaceRoots,
      lanReport: bridge.lanReport,
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
      pendingApprovalId && msg?.id === pendingApprovalId &&
      (msg.pub === undefined || msg.pub === pendingApprovalPub)
    if (!matched) return
    pendingApprovalId = null
    pendingApprovalPub = null
    if (session && !session.isApproved()) session.approve()
  })
  // Host human rejected the pending device → drop the connection entirely (pending sessions only).
  ipcMain.on(IPC.remoteHostReject, (_e, msg: { id?: string; pub?: string } = {}) => {
    const matched =
      pendingApprovalId && msg?.id === pendingApprovalId &&
      (msg.pub === undefined || msg.pub === pendingApprovalPub)
    if (!matched) return
    pendingApprovalId = null
    pendingApprovalPub = null
    if (session && !session.isApproved()) endSession()
  })

  ipcMain.handle(IPC.remoteHostStop, () => {
    endSession()
  })
}
