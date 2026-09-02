// The JOIN POINT on the host (docs/remote-sessions.md 4c): once two humans have mutually approved
// each other, the bridged peer becomes a FIRST-CLASS CorePlatform client of this desktop's core.
//
// There is very little code here on purpose. 4b already made `electronPlatform` multi-client (a
// client is a webContents OR a UiSink in the peer registry), and Stages 1-3 wrote presence, the
// canvas reflector and terminal co-attach against CorePlatform. So the whole of "a remote desktop
// opens as a project tab" reduces to: mint one ClientId, register one sink, join presence, and route
// the encrypted tunnel into `platform.dispatch` / `platform.cast`. Everything else just works
// (src/main/peer-integration.test.ts proved it against a fake sink; this module supplies the socket).
//
// It is the electron-side twin of `src/server/ws.ts`, and it deliberately mirrors that file's shape:
// attach the sink, join the hub, req → dispatch → respond, cast → cast, and on close run the ONE
// teardown (leave → dropClient → prune). Divergence between the two remote surfaces is a bug.
//
// SECURITY — nothing is served before MUTUAL approval. The peer is registered (and therefore able to
// reach any channel the shell registered on the platform) only from the trust gate's `onOpen`, i.e.
// after BOTH humans compared the same SAS and pressed Confirm. The E2EE handshake completing
// (`onReady`) proves only that SOMEONE holds the pairing token — a pre-approval request is answered
// with E_UNAUTHORIZED and never touches a handler. A pairing grants shell access; the SAS is the
// only thing between a relay MITM and that shell.
//
// SCOPE: this is the DESKTOP-peer vocabulary (the invited peer is fully trusted, as the invite copy
// states). The standing PHONE host keeps its existing legacy vocabulary in `host-service.ts` — with
// its deny-by-default fs jail — and is deliberately NOT routed through this dispatch path.
import { connectRelay, type RelayTransport } from './relay-socket'
import { createTrustGate, type TrustGate } from './relay-trust'
import type { KeyPair } from './e2ee'
import type { ElectronPlatform } from '../platform-electron'
import { registerPeerSink, unregisterPeerSink } from '../peer-registry'
import { allocateRelayClientId, presenceHub } from '../../core/presence/hub'
import { E_UNAUTHORIZED, parseRpcMessage, type RpcErr, type RpcOk } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { scopeWorkspaceToProject } from '../../shared/relay-workspace-scope'
import type { Workspace } from '../../shared/types'

export interface RelayHostSession {
  /** The peer's presence/platform ClientId once it is open, else null. */
  clientId(): number | null
  /** The 6-digit SAS both humans compare, or null before the key is derived. */
  sas(): string | null
  /** The peer's stable box public key (base64), or null before the handshake learned it. */
  peerKeyB64(): string | null
  /** The single project this hosting session shares with the peer, or undefined if unscoped. */
  sharedProjectId(): string | undefined
  /** This human confirmed the SAS (from the approve dialog). */
  confirm(): void
  /** Tear down: unregister the sink (leave + dropClient + prune), close the socket. Idempotent. */
  close(): void
}

export interface ConnectRelayHostOptions {
  url: string
  token: string
  ourKeys: KeyPair
  platform: ElectronPlatform
  /** TEST ONLY: an in-process RelayTransport. Production opens a real ws (relay-socket.ts). */
  transport?: RelayTransport
  /** The single project this hosting session shares with the peer. Undefined → unscoped (legacy
   *  behaviour: the peer sees the whole workspace). Held on the session for Task 2's scoped serve. */
  sharedProjectId?: string
  /** The SAS is known — ask the human to compare it. */
  onPeerPending(session: RelayHostSession): void
  /** Mutually approved: the peer is a CorePlatform client of this core now. */
  onOpen(session: RelayHostSession): void
  /** The relay socket dropped (the peer is already torn down when this fires). */
  onClose(): void
}

/** Live bridged peers, for revocation: unpinning a key refuses the NEXT handshake, but the OPEN
 *  socket keeps full shell access until it is cut (see revocation.ts). */
const live = new Set<RelayHostSession>()

/** Cut every live session with this peer key. The revoker's `onRevoke` (src/main/index.ts). */
export function killRelayHostsByPeerKey(peerKeyB64: string): void {
  for (const session of [...live]) {
    if (session.peerKeyB64() === peerKeyB64) session.close()
  }
}

export function connectRelayHost(opts: ConnectRelayHostOptions): RelayHostSession {
  let clientId: number | null = null
  let gate: TrustGate | null = null
  let closed = false
  // OBLIGATION (a) — defence in depth. The peer's ECDH public key at the moment the gate is created
  // (the same key `emptyMutualApproval` is seeded with, and whose shared secret produced the SAS the
  // humans compared). If the socket's live peer key ever diverges from this, the session key was
  // swapped under us (a mid-session re-key by a relay MITM) — we then refuse to advance approval,
  // dispatch peer traffic, or open the sink. relay-socket's layer-1 guard already prevents the swap;
  // this is the second, independent check so the property does not rest on that one guard.
  let sessionPeerKey: string | null = null
  // True once we have detected a key swap and cut the session, so we don't do it twice.
  let keySwapped = false

  // Board-log onChanged over the relay rides the core's per-project watch refcount
  // (registerBoardLogHandlers): the guest casts board-log:subscribe / :unsubscribe, which start/stop
  // the host watch. But a guest whose tab closes or whose socket drops sends no balancing unsubscribe,
  // so we track THIS connection's net per-project subscribe count and replay the unsubscribes on
  // teardown (see detach) — the host watch is released, and the shared local refcount is never touched
  // below this connection's own contribution (an unbalanced guest unsubscribe is ignored).
  const boardLogSubs = new Map<string, number>()

  /** The ONE teardown, mirroring src/server/ws.ts's close path exactly: `unregisterPeerSink` IS the
   *  three steps (presenceHub.leave → onPeerGone → PtyManager.dropClient → registry prune). Do NOT
   *  re-implement them here, and do NOT call `wirePeerRegistry` — it is wired once at boot. */
  const detach = (): void => {
    if (clientId === null) return
    // Release any board-log watches this connection still holds — a dropped guest tab never sends the
    // balancing unsubscribe, so replay one per outstanding count before the client id is gone.
    for (const [projectId, count] of boardLogSubs) {
      for (let i = 0; i < count; i++) opts.platform.cast(clientId, IPC.boardLogUnsubscribe, [projectId])
    }
    boardLogSubs.clear()
    unregisterPeerSink(clientId)
    clientId = null
  }

  const session: RelayHostSession = {
    clientId: () => clientId,
    sas: () => gate?.sas() ?? null,
    peerKeyB64: () => gate?.peerKeyB64() ?? null,
    sharedProjectId: () => opts.sharedProjectId,
    confirm: () => gate?.confirmHere(),
    close() {
      if (closed) return
      closed = true
      live.delete(session)
      detach()
      socket.close()
    }
  }

  /** The socket's live peer key still matches the one bound into the gate/approval state. A false
   *  return means the session key was swapped under us — refuse everything and cut the session. */
  const peerKeyIntact = (): boolean => {
    if (keySwapped) return false
    if (sessionPeerKey !== null && socket.peerPublicKeyB64() === sessionPeerKey) return true
    keySwapped = true
    session.close()
    return false
  }

  /** Both humans confirmed: the peer joins this core as a client. */
  const open = (): void => {
    if (closed || clientId !== null) return
    // The key that keyed this session must still be the original peer's (belt to layer-1's brace).
    if (!peerKeyIntact()) return
    const id = allocateRelayClientId()
    registerPeerSink(id, {
      // A DEAD socket must THROW (the registry evicts a sink after 2 consecutive throws and runs the
      // full teardown), and a healthy one must NOT (two throws in a row would kick a live peer out).
      // sendTunnel* returns false only when the channel is gone — turn exactly that into a throw.
      sendText: (json) => {
        if (!socket.sendTunnelText(json)) throw new Error('relay socket is not connected')
      },
      sendBinary: (buf) => {
        if (!socket.sendTunnelBinary(buf)) throw new Error('relay socket is not connected')
      },
      // OBLIGATION 2. The number Stage 2's per-client backpressure AND the 8 MB WS_DROP_WATER
      // drop-and-redraw ceiling key on (src/core/ui-sink-registry.ts). `bufferedAmount` is OPTIONAL
      // on UiSink and defaults to 0, so a sink that omits it — or stubs it — typechecks, passes every
      // test, and silently disables the ceiling: a slow peer then queues pty output without bound,
      // nothing pauses the pty or drops its backlog, and the HOST'S MEMORY GROWS UNTIL THE PROCESS
      // DIES. RelaySocket.bufferedAmount() is honest (ws.bufferedAmount + the pre-open queue).
      // Never make this a constant.
      bufferedAmount: () => socket.bufferedAmount()
    })
    // Join AFTER registering the sink, so the hub's `presence:sync` sendTo lands on a live sink (the
    // order src/server/ws.ts uses). A peer desktop is a 'desktop' peer, not a 'phone'.
    presenceHub.join(id, 'desktop')
    clientId = id
    opts.onOpen(session)
  }

  /** UX scope, NOT a trust boundary: for the ONE `workspace:load` method, when this hosting session
   *  is bound to a single project, narrow the successful response to that project (see
   *  scopeWorkspaceToProject). Every other method — and an error response, and an unscoped session —
   *  passes through byte-identical. This can only NARROW: it never exposes anything the core did not
   *  already return, and it never touches a non-`workspace:load` response. */
  const scopeResponse = (method: string, res: RpcOk | RpcErr): RpcOk | RpcErr => {
    if (!opts.sharedProjectId || method !== IPC.workspaceLoad || res.ok !== true) return res
    return { ...res, result: scopeWorkspaceToProject(res.result as Workspace, opts.sharedProjectId) }
  }

  /** SCOPE jail for the board log (beyond the host registry's own projectId jail): a session bound to
   *  one project must never let the guest reach ANOTHER project's board log. A board-log method naming
   *  a different projectId is out of scope. Unscoped sessions pass through — the registry is the only
   *  gate then, exactly as for the host's own renderer. The guest can never supply a filesystem path;
   *  only a projectId the host resolves through its own router. */
  const boardLogOutOfScope = (projectId: unknown): boolean =>
    !!opts.sharedProjectId && projectId !== opts.sharedProjectId

  /** The degraded response for an out-of-scope board-log request — the SAME shape the router gives an
   *  unknown project, produced WITHOUT dispatching (never resolving a path). Never throws. */
  const boardLogRefusal = (method: string, id: number): RpcOk =>
    method === IPC.boardLogRead
      ? { t: 'res', id, ok: true, result: { entries: [], unsupported: true } }
      : { t: 'res', id, ok: true, result: false }

  const githubIssuesProject = (method: string, args: unknown[]): {
    githubIssues: boolean
    projectId: unknown
  } => {
    switch (method) {
      case IPC.githubIssuesSubscribe:
      case IPC.githubIssuesQuery:
      case IPC.githubIssuesLookup:
      case IPC.githubIssuesSearch:
      case IPC.githubIssuesPullsForBranch:
      case IPC.githubIssuesMove:
        return {
          githubIssues: true,
          projectId: args[0] && typeof args[0] === 'object'
            ? (args[0] as { projectId?: unknown }).projectId
            : undefined
        }
      case IPC.githubIssuesRefresh:
      case IPC.githubIssuesCreateLabels:
      case IPC.githubIssuesClearCache:
      case IPC.githubIssuesUnsubscribe:
        return { githubIssues: true, projectId: args[0] }
      default:
        return { githubIssues: false, projectId: undefined }
    }
  }

  const githubIssuesOutOfScope = (method: string, args: unknown[]): boolean => {
    const target = githubIssuesProject(method, args)
    return !!opts.sharedProjectId && target.githubIssues && target.projectId !== opts.sharedProjectId
  }

  const githubIssuesRefusal = (id: number): RpcErr => ({
    t: 'res',
    id,
    ok: false,
    error: { code: 'E_FORBIDDEN', message: 'GitHub Issues project is outside this relay session' }
  })

  const socket = connectRelay({
    url: opts.url,
    token: opts.token,
    role: 'host',
    ourKeys: opts.ourKeys,
    transport: opts.transport,
    onReady: () => {
      // E2EE is up. This proves only that SOMEONE holds the pairing token — NOT that the human at
      // the other end is who we think. Serve nothing yet: build the gate and ask for the SAS.
      const peerKey = socket.peerPublicKeyB64()
      if (!peerKey || gate) return
      // Bind the session to THIS peer key. Every later approval/dispatch step re-asserts it.
      sessionPeerKey = peerKey
      gate = createTrustGate({
        peerKeyB64: peerKey,
        sessionId: `${peerKey}:${Date.now()}`, // obligation (b): ONE state per pairing attempt
        sas: () => socket.sas(),
        sendConfirm: (json) => socket.sendTunnelText(json),
        onOpen: open
      })
      live.add(session)
      opts.onPeerPending(session)
    },
    // The legacy phone dialect is not served here: nothing is wired to onRpc / onFrame.
    onRpc: () => {},
    onFrame: () => {},
    onTunnel: (kind, payload) => {
      // Binary peer→host frames are ignored: pty input rides JSON casts, exactly as on the WS.
      if (kind !== 'text') return
      // OBLIGATION (a) — before ANYTHING (advancing approval via the gate, or dispatching a peer
      // RPC/cast): the session key must still belong to the ORIGINAL peer. A tunnel frame that
      // decrypted under a swapped key must not advance confirmRemote or reach the core.
      if (!peerKeyIntact()) return
      const json = new TextDecoder().decode(payload)
      // Trust frames are consumed BEFORE dispatch and never reach the core.
      if (gate?.onTunnelText(json)) return
      const m = parseRpcMessage(json)
      if (!m) return
      if (clientId === null) {
        // Not mutually approved: refuse — but ANSWER, or the peer's `await` would hang forever.
        if (m.t === 'req') {
          socket.sendTunnelText(
            JSON.stringify({
              t: 'res',
              id: m.id,
              ok: false,
              error: { code: E_UNAUTHORIZED, message: 'Awaiting mutual approval.' }
            })
          )
        }
        return
      }
      if (m.t === 'req') {
        if (githubIssuesOutOfScope(m.method, m.args)) {
          socket.sendTunnelText(JSON.stringify(githubIssuesRefusal(m.id)))
          return
        }
        // Board-log read/append naming a project outside this session's scope: refuse WITHOUT
        // dispatching (the host router never resolves it), degrading exactly as an unknown project.
        if (
          (m.method === IPC.boardLogAppend || m.method === IPC.boardLogRead) &&
          boardLogOutOfScope(m.args[0])
        ) {
          socket.sendTunnelText(JSON.stringify(boardLogRefusal(m.method, m.id)))
          return
        }
        const id = clientId
        void opts.platform
          .dispatch(id, m)
          .then((res) => socket.sendTunnelText(JSON.stringify(scopeResponse(m.method, res))))
      } else if (m.t === 'cast') {
        if (githubIssuesOutOfScope(m.method, m.args)) return
        // Board-log subscribe/unsubscribe: scope-jail out-of-scope projects, and track this
        // connection's net per-project count so a dropped guest's watch is released in detach().
        if (m.method === IPC.boardLogSubscribe || m.method === IPC.boardLogUnsubscribe) {
          const projectId = m.args[0]
          if (typeof projectId !== 'string' || boardLogOutOfScope(projectId)) return
          if (m.method === IPC.boardLogSubscribe) {
            boardLogSubs.set(projectId, (boardLogSubs.get(projectId) ?? 0) + 1)
          } else {
            const cur = boardLogSubs.get(projectId) ?? 0
            if (cur <= 0) return // this connection holds no such watch — never decrement the shared count
            if (cur === 1) boardLogSubs.delete(projectId)
            else boardLogSubs.set(projectId, cur - 1)
          }
        }
        opts.platform.cast(clientId, m.method, m.args)
      }
      // res/ev from a peer are ignored (mirrors src/server/ws.ts).
    },
    onClose: () => {
      // The peer is GONE — the same state a closed browser tab leaves the core in.
      live.delete(session)
      detach()
      opts.onClose()
    }
  })

  return session
}
