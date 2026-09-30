// The JOIN POINT on the host (docs/remote-sessions.md 4c): once two humans have mutually approved
// each other, the bridged peer becomes a FIRST-CLASS CorePlatform client of this core.
//
// There is very little code here on purpose. The platform is multi-client (a client is a webContents
// OR a UiSink in a peer registry), and Stages 1-3 wrote presence, the canvas reflector and terminal
// co-attach against CorePlatform. So the whole of "a remote desktop opens as a project tab" reduces
// to: mint one ClientId, register one sink, join presence, and route the encrypted tunnel into
// `dispatch` / `cast`. Everything else just works (src/main/peer-integration.test.ts proved it
// against a fake sink; this module supplies the socket).
//
// THE SEAM. Everything shell-specific — minting the ClientId, the peer registry, the presence join,
// the platform's dispatch/cast and where a mutual approval is pinned — arrives through `PeerAttach`
// and `PinStore`, so the desktop's Team Access (src/main/remote/relay-host.ts) and the Server
// Edition's hosted team relay (docs/hosted-team-relay.md) run this ONE handshake + tunnel. The
// optional `RelayHostHooks` let a host that serves several roles answer, refuse, narrow or filter
// per session; a host that passes none (the desktop) takes exactly the unhooked path.
//
// It is the relay twin of `src/server/ws.ts`, and it deliberately mirrors that file's shape: attach
// the sink, join the hub, req → dispatch → respond, cast → cast, and on close run the ONE teardown
// (leave → dropClient → prune). Divergence between the two remote surfaces is a bug.
//
// SECURITY — nothing is served before MUTUAL approval. The peer is registered (and therefore able to
// reach any channel the shell registered on the platform) only from the trust gate's `onOpen`, i.e.
// after BOTH humans compared the same SAS and pressed Confirm. The E2EE handshake completing
// (`onReady`) proves only that SOMEONE holds the pairing token — a pre-approval request is answered
// with E_UNAUTHORIZED and never touches a handler. Between mutual approval and `onOpen` (the pin
// write is in flight) the peer's frames are HELD, not refused, and served at open through the same
// checks as live ones — still nothing before it (see HELD_FRAMES_MAX). A pairing grants shell
// access; the SAS is the only thing between a relay MITM and that shell.
//
// SCOPE: this is the DESKTOP-peer vocabulary (the invited peer is fully trusted, as the invite copy
// states). The standing PHONE host keeps its existing legacy vocabulary in `host-service.ts` — with
// its deny-by-default fs jail — and is deliberately NOT routed through this dispatch path.
import { connectRelay, type RelayTransport } from './relay-socket'
import {
  createTrustGate,
  deniedFrame,
  parseDenied,
  type PinStore,
  type TrustDeniedReason,
  type TrustGate
} from './relay-trust'
import type { KeyPair } from './e2ee'
import type { UiSink } from '../ui-sink-registry'
import {
  E_UNAUTHORIZED,
  parseRpcMessage,
  type RpcCast,
  type RpcErr,
  type RpcOk,
  type RpcRequest
} from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { scopeWorkspaceToProject } from '../../shared/relay-workspace-scope'
import { outOfProjectScope } from './relay-project-scope'
import { HOST_ONLY_REFUSAL, isHostOnlyChannel } from '../../shared/host-control'
import type { Workspace } from '../../shared/types'

/**
 * How a mutually-approved peer joins the shell's core, and how it leaves. The shell owns every step
 * (ClientId allocation, the peer registry, presence, the platform's dispatch table); this module
 * only decides WHEN.
 */
export interface PeerAttach {
  /** Register the sink AND join presence as a 'desktop' peer. Returns the peer's ClientId. */
  attach(sink: UiSink): number
  /** The ONE teardown (presence leave → dropClient → registry prune). */
  detach(id: number): void
  /** Answer the peer's request. May REJECT (or throw): the host answers that request `E_HANDLER`
   *  and the session keeps serving — a failed dispatch never goes unanswered or unhandled. */
  dispatch(id: number, req: RpcRequest): Promise<RpcOk | RpcErr>
  /** Deliver the peer's cast. Must NOT throw: the tunnel cast path and the teardown's board-log
   *  unsubscribe replay call it unguarded (a cast has no reply channel — isolate and log inside,
   *  as both platforms' `cast` already do). */
  cast(id: number, method: string, args: unknown[]): void
}

/** A per-request verdict. `args` (when present) replaces the peer's args for everything downstream. */
export type AccessDecision = { allow: true; args?: unknown[] } | { allow: false; message: string }

/**
 * Optional per-session policy. Absent (the desktop) = the unhooked path, byte for byte.
 *
 * A hook that THROWS never reaches the socket (a throw there escapes into the WebSocket's own
 * synchronous message emit, which then delivers nothing more and never closes: the peer hangs and
 * stays attached). Instead: `interceptReq` / `access` on a req → the request is answered
 * `E_HANDLER`; `access` on a cast → the cast is dropped and logged; `narrowResponse` → `E_HANDLER`,
 * never the un-narrowed result; `wrapSink` → the session FAILS CLOSED (see `open`).
 *
 * `access` FAILS CLOSED on a malformed answer too: anything but a well-formed `AccessDecision`
 * (`undefined`, `null`, `{}`, non-array `args`, a refusal without a `message`) DENIES — `E_ROLE`
 * for a req, dropped and logged for a cast. Only an ABSENT `access` hook means allow-all.
 */
export interface RelayHostHooks {
  /**
   * Answer a request here instead of dispatching it. `null` = not intercepted.
   *
   * An intercepted request BYPASSES `access` and every project-scope jail below: nothing else looks
   * at it. An interceptor therefore enforces its own role and scope checks. The hosted team's do
   * (src/core/relay/hosted-service.ts): only `relay:hosted:self` is open to any team member (and to a
   * session whose own approval could not be pinned, served as the lowest role); approve, deny,
   * invite-code and pending are owner-only, judged from the CALLER's own session key in the team
   * store — never from anything the request carries.
   */
  interceptReq?(s: RelayHostSession, method: string, args: unknown[]): Promise<unknown> | null
  /** Allow (optionally rewriting args) or refuse a request/cast before any scope check or dispatch. */
  access?(s: RelayHostSession, kind: 'req' | 'cast', method: string, args: unknown[]): AccessDecision
  /** Filter what reaches the peer. Keep `bufferedAmount` pointing at the base sink's (obligation 2). */
  wrapSink?(s: RelayHostSession, sink: UiSink): UiSink
  /** Narrow a SUCCESSFUL dispatch result before it goes back over the tunnel. */
  narrowResponse?(s: RelayHostSession, method: string, result: unknown): unknown
}

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
  /** Refuse the peer: tell it WHY over the encrypted tunnel, then close. Idempotent. */
  deny(reason: TrustDeniedReason): void
  /** Tear down: detach the peer (leave + dropClient + prune), close the socket. Idempotent. */
  close(): void
}

export interface ConnectRelayHostOptions {
  url: string
  token: string
  ourKeys: KeyPair
  /** How the approved peer joins (and leaves) the shell's core. */
  attach: PeerAttach
  /** TEST ONLY: an in-process RelayTransport. Production opens a real ws (relay-socket.ts). */
  transport?: RelayTransport
  /** The single project this hosting session shares with the peer. Undefined → unscoped (legacy
   *  behaviour: the peer sees the whole workspace). Held on the session for Task 2's scoped serve. */
  sharedProjectId?: string
  /** Where a mutual approval is pinned. Absent = pin nothing (the session still opens). */
  pins?: PinStore
  /**
   * Latch THIS end's confirm without a human, for a peer key this host already trusts. Asked once,
   * with the HANDSHAKE's peer key (the key whose shared secret produced the SAS), and it must answer
   * from the host's OWN pin store — never from anything the peer sent. It never touches the peer's
   * half: the peer must still confirm over the encrypted tunnel. An auto-approved peer raises no
   * `onPeerPending`.
   */
  autoApprove?: (peerKeyB64: string) => boolean
  /** Per-session policy (roles). Absent = the unhooked path. */
  hooks?: RelayHostHooks
  /** The SAS is known — ask the human to compare it. */
  onPeerPending(session: RelayHostSession): void
  /** Mutually approved: the peer is a CorePlatform client of this core now. */
  onOpen(session: RelayHostSession): void
  /**
   * The session ended without this shell asking: fires AT MOST ONCE, when the relay socket drops,
   * when a throwing `wrapSink` fails the session closed, when the session key is found swapped (the
   * key-swap self-close), or when the peer overflows the frames held between approval and open
   * (`HELD_FRAMES_MAX`). The peer is already torn down when it fires. `close()`, `deny()` and
   * `killRelayHostsByPeerKey` NEVER fire it — their caller already knows, and owes its own
   * bookkeeping for that end.
   */
  onClose(): void
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A well-formed `AccessDecision` — anything else from an `access` hook is a DENIAL (R12). */
function isAccessDecision(d: unknown): d is AccessDecision {
  if (typeof d !== 'object' || d === null) return false
  const o = d as { allow?: unknown; args?: unknown; message?: unknown }
  if (o.allow === true) return o.args === undefined || Array.isArray(o.args)
  if (o.allow === false) return typeof o.message === 'string'
  return false
}

/** The access hook's verdict: decided, threw, or answered something that is not a decision. */
type AccessVerdict =
  | { kind: 'decided'; decision: AccessDecision }
  | { kind: 'threw'; err: unknown }
  | { kind: 'malformed' }

/** The refusal a req gets when the access hook's answer is not a decision (never its raw value). */
const ACCESS_CHECK_FAILED = 'Access check failed.'

/**
 * How many req/cast frames a peer may send between mutual approval and `open` (while the pin write
 * is in flight) before the session is closed. Those frames are HELD, not refused: a client opens as
 * soon as it has the host's confirm, so the first thing a new teammate sends (`workspace:load` at
 * `onApproved`) routinely lands inside the host's pin write. Bounded, because nothing reads them
 * until the pin settles.
 */
export const HELD_FRAMES_MAX = 256

/** Live bridged peers, for revocation: unpinning a key refuses the NEXT handshake, but the OPEN
 *  socket keeps full shell access until it is cut (see revocation.ts). */
const live = new Set<RelayHostSession>()

/** Cut every live session with this peer key. The revoker's `onRevoke` (src/main/index.ts). With a
 *  reason, the peer is told why over the encrypted tunnel first (`deny`); without one it is closed. */
export function killRelayHostsByPeerKey(peerKeyB64: string, reason?: TrustDeniedReason): void {
  killRelayHostsWhere((key) => key === peerKeyB64, reason)
}

/** Cut every live session (bridged or still awaiting mutual approval) whose peer key satisfies
 *  `match`. A session whose key is not known yet is never matched. */
export function killRelayHostsWhere(match: (peerKeyB64: string) => boolean, reason?: TrustDeniedReason): void {
  for (const session of [...live]) {
    const key = session.peerKeyB64()
    if (!key || !match(key)) continue
    if (reason) session.deny(reason)
    else session.close()
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

  // Frames the peer sent after BOTH humans approved but before `open` (the pin write is in flight).
  // Served in arrival order at `open`, through the same path as live frames; dropped with the session.
  const held: Array<RpcRequest | RpcCast> = []

  /** The ONE teardown, mirroring src/server/ws.ts's close path exactly: `attach.detach` IS the three
   *  steps (presence leave → onPeerGone → PtyManager.dropClient → registry prune). Do NOT
   *  re-implement them here. */
  const detach = (): void => {
    if (clientId === null) return
    // Release any board-log watches this connection still holds — a dropped guest tab never sends the
    // balancing unsubscribe, so replay one per outstanding count before the client id is gone.
    for (const [projectId, count] of boardLogSubs) {
      for (let i = 0; i < count; i++) opts.attach.cast(clientId, IPC.boardLogUnsubscribe, [projectId])
    }
    boardLogSubs.clear()
    opts.attach.detach(clientId)
    clientId = null
  }

  const session: RelayHostSession = {
    clientId: () => clientId,
    sas: () => gate?.sas() ?? null,
    peerKeyB64: () => gate?.peerKeyB64() ?? null,
    sharedProjectId: () => opts.sharedProjectId,
    confirm: () => gate?.confirmHere(),
    deny(reason) {
      if (closed) return
      // Over the ENCRYPTED tunnel, so only the real peer can read it (and the relay cannot forge it).
      socket.sendTunnelText(deniedFrame(reason))
      session.close()
    },
    close() {
      if (closed) return
      closed = true
      held.length = 0
      live.delete(session)
      detach()
      socket.close()
    }
  }

  /** End the session on the core's own initiative (a swapped key, a throwing wrapSink, a flooded
   *  hold queue). A self-initiated close() never reaches the socket's onClose, and the shell did not
   *  ask for this one: tell it, at most once, and never for a session that was already closed. Its
   *  bookkeeping (a seat, a pending request, a standing listener counted as bridged) must hear every
   *  end. */
  const closeUnasked = (): void => {
    const wasLive = !closed
    session.close()
    if (wasLive) opts.onClose()
  }

  /** The socket's live peer key still matches the one bound into the gate/approval state. A false
   *  return means the session key was swapped under us — refuse everything and cut the session. */
  const peerKeyIntact = (): boolean => {
    if (keySwapped) return false
    if (sessionPeerKey !== null && socket.peerPublicKeyB64() === sessionPeerKey) return true
    keySwapped = true
    closeUnasked()
    return false
  }

  /** Both humans confirmed: the peer joins this core as a client. */
  const open = (): void => {
    if (closed || clientId !== null) return
    // The key that keyed this session must still be the original peer's (belt to layer-1's brace).
    if (!peerKeyIntact()) return
    // A DEAD socket must THROW (the registry evicts a sink after 2 consecutive throws and runs the
    // full teardown), and a healthy one must NOT (two throws in a row would kick a live peer out).
    // sendTunnel* returns false only when the channel is gone — turn exactly that into a throw.
    //
    // OBLIGATION 2. The number Stage 2's per-client backpressure AND the 8 MB WS_DROP_WATER
    // drop-and-redraw ceiling key on (src/core/ui-sink-registry.ts). `bufferedAmount` is OPTIONAL
    // on UiSink and defaults to 0, so a sink that omits it — or stubs it — typechecks, passes every
    // test, and silently disables the ceiling: a slow peer then queues pty output without bound,
    // nothing pauses the pty or drops its backlog, and the HOST'S MEMORY GROWS UNTIL THE PROCESS
    // DIES. RelaySocket.bufferedAmount() is honest (ws.bufferedAmount + the pre-open queue).
    // Never make this a constant.
    //
    // A `wrapSink` hook must keep its `bufferedAmount` pointing at `base.bufferedAmount`.
    //
    // A session this host already CLOSED is not a dead socket: it is being torn down right now, and
    // `detach` broadcasts on its way out — the presence hub's `leave` diff goes to every registered
    // sink, the leaver's own included, before the sink is unregistered. Delivering to a peer that is
    // gone loses nothing, so that send is dropped; throwing would log a false dead-socket strike on
    // every ordinary disconnect (measured on a real headless boot, src/server/hosted-e2e.test.ts).
    // Only a socket that dies while the session still counts as open throws, which is what the
    // registry's eviction is for.
    const base: UiSink = {
      sendText: (json) => {
        if (closed) return
        if (!socket.sendTunnelText(json)) throw new Error('relay socket is not connected')
      },
      sendBinary: (buf) => {
        if (closed) return
        if (!socket.sendTunnelBinary(buf)) throw new Error('relay socket is not connected')
      },
      bufferedAmount: () => socket.bufferedAmount()
    }
    let sink: UiSink = base
    if (opts.hooks?.wrapSink) {
      try {
        sink = opts.hooks.wrapSink(session, base)
      } catch (err) {
        // FAIL CLOSED. A wrapSink is a FILTER (a viewer's view of the host); falling back to the bare
        // base sink would hand the peer everything the filter exists to withhold. Attach nothing and
        // end the session, and tell the shell (closeUnasked).
        console.warn(`[relay-host] wrapSink threw; closing the session: ${errorMessage(err)}`)
        closeUnasked()
        return
      }
    }
    const id = opts.attach.attach(sink)
    clientId = id
    opts.onOpen(session)
    // What the peer sent while the pin was being written, in arrival order, exactly as if it had
    // arrived now. A frame that ends the session stops the rest.
    for (const m of held.splice(0)) {
      if (closed || clientId === null) break
      serve(m)
    }
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

  /** The hook's narrowing, for a SUCCESSFUL response only. No hook → the response untouched. */
  const narrowResponse = (method: string, res: RpcOk | RpcErr): RpcOk | RpcErr => {
    if (!opts.hooks?.narrowResponse || res.ok !== true) return res
    return { ...res, result: opts.hooks.narrowResponse(session, method, res.result) }
  }

  /** The answer to a request whose handler (a hook, or the shell's dispatch) threw or rejected. */
  const handlerError = (id: number, err: unknown): string =>
    JSON.stringify({ t: 'res', id, ok: false, error: { code: 'E_HANDLER', message: errorMessage(err) } })

  /** Ask the access hook, and never let it throw or mis-answer its way into the socket: a throw is
   *  `threw`, a malformed answer is `malformed` (both deny). Only an ABSENT hook allows all. */
  const checkAccess = (kind: 'req' | 'cast', method: string, args: unknown[]): AccessVerdict => {
    if (!opts.hooks?.access) return { kind: 'decided', decision: { allow: true } }
    let answer: unknown
    try {
      answer = opts.hooks.access(session, kind, method, args)
    } catch (err) {
      return { kind: 'threw', err }
    }
    return isAccessDecision(answer) ? { kind: 'decided', decision: answer } : { kind: 'malformed' }
  }

  /** Send the response `build` produces. If building or serialising it throws (a narrowResponse hook,
   *  an unserialisable result), answer `E_HANDLER` instead. Never throws: it runs inside a `.then`,
   *  where a throw would be an unhandled rejection and a request nobody ever answers. */
  const respond = (id: number, build: () => RpcOk | RpcErr): void => {
    let json: string
    try {
      json = JSON.stringify(build())
    } catch (err) {
      json = handlerError(id, err)
    }
    socket.sendTunnelText(json)
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

  /** SCOPE jail for every project-naming channel class (`relay-project-scope.ts`): a method in a
   *  scoped class that names another project — or that the table cannot read a projectId out of —
   *  is refused on a session bound to one project. Fail-closed by class, so a channel added to
   *  `githubIssues:*` / `board-log:*` / `projects.*` without a table row is refused, not waved on. */
  const projectOutOfScope = (method: string, args: unknown[]): boolean =>
    outOfProjectScope(opts.sharedProjectId, method, args)

  const projectScopeRefusal = (method: string, id: number): RpcErr => ({
    t: 'res',
    id,
    ok: false,
    error: {
      code: 'E_FORBIDDEN',
      message: method.startsWith('githubIssues:')
        ? 'GitHub Issues project is outside this relay session'
        : 'That project is outside this relay session'
    }
  })

  /** Serve one req/cast of an OPEN session: interceptor, access, scope jails, then dispatch/cast.
   *  Live frames and held ones (see `held`) both come through here, so they meet the same checks. */
  const serve = (m: RpcRequest | RpcCast): void => {
    if (clientId === null) return
    // HOST-ONLY channels (shared/host-control.ts) are refused to EVERY relay peer, before any hook
    // or dispatch — here, in core, so the Server Edition's hosted peers meet the same list the
    // desktop's platform dispatch already enforced (a hosted Editor passes every role check).
    if ((m.t === 'req' || m.t === 'cast') && isHostOnlyChannel(m.method)) {
      if (m.t === 'req') {
        socket.sendTunnelText(
          JSON.stringify({ t: 'res', id: m.id, ok: false, error: { code: 'E_FORBIDDEN', message: HOST_ONLY_REFUSAL } })
        )
      }
      return
    }
    if (m.t === 'req') {
      // A hook may answer the request itself — it then never reaches a scope check or the core.
      // Every hook call below is guarded: a throw is ANSWERED (E_HANDLER), never let into the
      // socket's message emit (see RelayHostHooks).
      let intercepted: Promise<unknown> | null
      try {
        intercepted = opts.hooks?.interceptReq?.(session, m.method, m.args) ?? null
      } catch (err) {
        socket.sendTunnelText(handlerError(m.id, err))
        return
      }
      if (intercepted) {
        void intercepted.then(
          (result) => respond(m.id, () => ({ t: 'res', id: m.id, ok: true, result: result ?? null })),
          (err) => socket.sendTunnelText(handlerError(m.id, err))
        )
        return
      }
      const verdict = checkAccess('req', m.method, m.args)
      if (verdict.kind === 'threw') {
        socket.sendTunnelText(handlerError(m.id, verdict.err))
        return
      }
      if (verdict.kind === 'malformed') {
        console.warn(`[relay-host] access returned a malformed decision on req ${m.method}; refused`)
        socket.sendTunnelText(JSON.stringify({ t: 'res', id: m.id, ok: false, error: { code: 'E_ROLE', message: ACCESS_CHECK_FAILED } }))
        return
      }
      const decision = verdict.decision
      if (!decision.allow) {
        socket.sendTunnelText(JSON.stringify({ t: 'res', id: m.id, ok: false, error: { code: 'E_ROLE', message: decision.message } }))
        return
      }
      const args = decision.args ?? m.args
      // Board-log read/append naming a project outside this session's scope: refuse WITHOUT
      // dispatching (the host router never resolves it), degrading exactly as an unknown project.
      // Checked before the generic jail so these two keep their established degraded shape.
      if (
        (m.method === IPC.boardLogAppend || m.method === IPC.boardLogRead) &&
        boardLogOutOfScope(args[0])
      ) {
        socket.sendTunnelText(JSON.stringify(boardLogRefusal(m.method, m.id)))
        return
      }
      if (projectOutOfScope(m.method, args)) {
        socket.sendTunnelText(JSON.stringify(projectScopeRefusal(m.method, m.id)))
        return
      }
      const id = clientId
      let pending: Promise<RpcOk | RpcErr>
      try {
        pending = opts.attach.dispatch(id, { ...m, args })
      } catch (err) {
        socket.sendTunnelText(handlerError(m.id, err))
        return
      }
      void pending.then(
        (res) => respond(m.id, () => narrowResponse(m.method, scopeResponse(m.method, res))),
        (err) => socket.sendTunnelText(handlerError(m.id, err))
      )
    } else if (m.t === 'cast') {
      // A cast has no reply channel: a policy that throws or cannot decide DROPS it — and says so,
      // because a silently dropped pty:write swallows keystrokes with nothing in any log (the same
      // reason both platforms log a throwing cast listener).
      const verdict = checkAccess('cast', m.method, m.args)
      if (verdict.kind === 'threw') {
        console.warn(`[relay-host] access threw on cast ${m.method}:`, errorMessage(verdict.err))
        return
      }
      if (verdict.kind === 'malformed') {
        console.warn(`[relay-host] access returned a malformed decision on cast ${m.method}; dropped`)
        return
      }
      const d = verdict.decision
      if (!d.allow) return
      const args = d.args ?? m.args
      if (projectOutOfScope(m.method, args)) return
      // Board-log subscribe/unsubscribe: scope-jail out-of-scope projects, and track this
      // connection's net per-project count so a dropped guest's watch is released in detach().
      if (m.method === IPC.boardLogSubscribe || m.method === IPC.boardLogUnsubscribe) {
        const projectId = args[0]
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
      opts.attach.cast(clientId, m.method, args)
    }
  }

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
      // Asked with the HANDSHAKE key, before the gate exists: a pinned peer skips the dialog. A
      // pin-store lookup that throws reads as "not pinned" — the human is asked instead.
      let auto = false
      try {
        auto = opts.autoApprove?.(peerKey) === true
      } catch (err) {
        console.warn(`[relay-host] autoApprove threw; asking the human instead: ${errorMessage(err)}`)
      }
      gate = createTrustGate({
        peerKeyB64: peerKey,
        sessionId: `${peerKey}:${Date.now()}`, // obligation (b): ONE state per pairing attempt
        sas: () => socket.sas(),
        sendConfirm: (json) => socket.sendTunnelText(json),
        onOpen: open,
        pins: opts.pins,
        // Never let the gate send its confirm while it is being built: see the deferral below.
        autoApprove: false
      })
      live.add(session)
      if (auto) {
        // The auto-confirm goes out AFTER the current turn, never inside onReady. Over an in-process
        // transport this onReady runs inside the PEER's connectRelay call — before the peer holds its
        // socket or its gate — so a confirm sent now is dropped on the floor and a pinned reconnect
        // never opens. Over a real WebSocket the microtask costs nothing.
        queueMicrotask(() => {
          if (!closed) gate?.confirmHere()
        })
      } else {
        opts.onPeerPending(session)
      }
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
      // A denial is the HOST's word to a peer, never the other way round: a peer that sends one is
      // ignored, and the frame never reaches the core (the gate does not consume it).
      if (parseDenied(json)) return
      // Trust frames are consumed BEFORE dispatch and never reach the core.
      if (gate?.onTunnelText(json)) return
      const m = parseRpcMessage(json)
      if (!m) return
      if (clientId === null) {
        // Mutually approved, not yet open (the pin write is in flight): HOLD, never refuse — the
        // client is already open and its first request would otherwise fail. Nothing is judged or
        // served before `open`; a peer that floods the hold is cut.
        if (gate?.isApproved() && (m.t === 'req' || m.t === 'cast')) {
          if (held.length >= HELD_FRAMES_MAX) {
            console.warn(`[relay-host] a peer sent more than ${HELD_FRAMES_MAX} frames before its session opened; closing it`)
            closeUnasked()
            return
          }
          held.push(m)
          return
        }
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
      // res/ev from a peer are ignored (mirrors src/server/ws.ts).
      if (m.t === 'req' || m.t === 'cast') serve(m)
    },
    onClose: () => {
      // The peer is GONE — the same state a closed browser tab leaves the core in. Mark the session
      // closed FIRST: a gate whose pin write is still in flight will call open() later, and open()
      // must then bail — never attach the peer to this dead socket, and never reach the wrapSink
      // fail-closed path that would fire onClose a second time (R13).
      closed = true
      held.length = 0
      live.delete(session)
      detach()
      opts.onClose()
    }
  })

  return session
}
