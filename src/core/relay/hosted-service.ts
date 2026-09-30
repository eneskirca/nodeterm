// Hosted team relay: the Server Edition side of docs/hosted-team-relay.md.
// Composes the host key, team store, standing-listener scheduler and access policy around the core
// relay host. All relay-peer traffic crosses relay-host.ts's hooks; hosted RPCs (relay:hosted:*)
// are INTERCEPTED there and never registered on the platform, so a Server Edition browser client
// (whose gate is the server password, not a team role) cannot call them.
//
// The rules the file rests on:
//  - The ROLE is read from the team store on every decision (access, sink filter, narrowing,
//    interceptors) and never cached on a session, so a removal or a promotion applies to the very
//    next message. A session whose key has NO team entry is served nothing at all — that is the
//    window between a removal's team write and its kill — except one whose own approval could not
//    be written (`pinFailed`), which keeps the lowest role. Removal also cuts the live session.
//  - Every hook derives the peer key from the SESSION it is handed, never from this file's own
//    record of it (which is only filled in once `connectRelayHost` returns).
//  - An interceptor bypasses `access` and the scope jails, so each one checks the CALLER's own
//    session key against the team store: `relay:hosted:self` is open to any member, approve / deny /
//    invite-code / pending to owners only.
//  - Pending requests are told to connected OWNERS only (never a broadcast: a viewer must not learn
//    who is knocking), and an owner who connects later is told the ones still open. At most one
//    request per device key, and at most PENDING_MAX at once.
//  - An approval is pinned only once both humans confirmed. A deny or an expiry that lands while
//    that pin is still being written wins: the write is skipped, or taken back. A peer that merely
//    drops meanwhile keeps its pin — both humans did approve. A key that already has an entry when
//    the pin is written (a racing `team add-owner`) keeps it: the approval writes nothing.
//  - A relay peer never saves the host's workspace (`workspace:save` is refused for every role): the
//    host's canvas authority writes shared projects' content from canvas ops alone, and the share
//    set it governs is read through `sharedProjectIds()` and announced by `onSharedChange`.
//  - The scheduler hears about EVERY session end. The core fires `onClose` only for ends the shell
//    did not ask for; every end this service causes (deny, expiry, removal, a listener the
//    scheduler closes) runs the same `ended` bookkeeping, at most once per session.
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc'
import { connectRelayHost, killRelayHostsByPeerKey, type PeerAttach, type RelayHostSession } from './relay-host'
import type { RelayTransport } from './relay-socket'
import type { TrustDeniedReason } from './relay-trust'
import { createHostKey, loadHostKey, rotateHostKey, hostAddress, HostKeyUnreadableError } from './host-key'
import { TeamStore, peerFor, upsertPeer, removePeer, setShared, TEAM_ROLES, type TeamPeer, type TeamRole } from './team-store'
import { decideAccess, wrapSinkForRole, narrowResponseForRole, type AccessContext } from './access-policy'
import { mintHostToken } from './host-token'
import { createHostedScheduler, type Listener, type SchedulerStatus } from './hosted-scheduler'
import { encodeJoinCode } from './join-code'
import type { KeyPair } from './e2ee'
import type { UiSink } from '../ui-sink-registry'
import type { HostedPending as SharedHostedPending, HostedPendingClosedReason } from '../../shared/types'

/** An unanswered join request is refused after ten minutes. */
export const PENDING_TTL_MS = 600_000

/** At most this many join requests wait at once; the next is denied without telling any owner. A
 *  bound on what anyone holding a join code (public material) can make an owner's dialog show. */
export const PENDING_MAX = 16

/** Every hosted channel starts with this. Anything under it that the interceptor does not answer
 *  (a CAST of a hosted verb, an unknown hosted verb) is refused by the access hook. */
const HOSTED_PREFIX = 'relay:hosted:'

/** The join code's own label cap (join-code.ts): a longer host name would make an undecodable code. */
const JOIN_LABEL_MAX = 60

const NOT_A_MEMBER = 'You are not a member of this team.'

/** A relay peer never saves the host's workspace, whatever its role: a whole-workspace save is a
 *  stale copy of every canvas it holds, and the host's canvas authority is the one writer of a
 *  shared project's content, fed by ops (docs/hosted-team-relay.md). The desktop's own canvas saves
 *  go to its LOCAL core, so no relay tab flow depends on this request. */
export const RELAY_WORKSPACE_SAVE_REFUSED =
  "A hosted team cannot save the host's workspace over the relay; edits travel as canvas operations"

/** A device waiting for an owner. The renderer's type IS this one (one definition, in shared). */
export type HostedPending = SharedHostedPending
/** Why a pending request stopped being pending, as told to owners on `relay:hosted:pending-closed`.
 *  `replaced`: the same device connected again, and its newer request took this one's place. Shared
 *  with the renderer, so a reason added here without its owner-dialog handling fails to compile there. */
export type PendingClosedReason = HostedPendingClosedReason
/** `stopped`: a `stop()` landed after this `start()` was called and before it finished; it wins. */
export type HostedStartResult = 'started' | 'no-team' | 'host-key-unreadable' | 'stopped'
/** `not-running`: the key was rotated on a service that was not hosting, and hosting stays off. */
export type HostedRotateResult = HostedStartResult | 'not-running'

export interface HostedServiceDeps {
  dataDir: string
  apiBase: string
  relayUrl: string
  deviceId: string
  hostLabel: string
  attach: PeerAttach
  /** Every project holding this node id (`WorkspaceStore.projectIdsForNode`); [] = none. */
  projectsOfNode(nodeId: string): readonly string[]
  /** The node a live terminal session runs (`PtyManager.nodeOfSession`). A viewer's terminal frames
   *  are judged by it, so `team unshare` stops a stream the viewer already joined (R45). */
  nodeOfSession(sessionId: string): string | undefined
  projectCwd(projectId: string): string | undefined
  /** TEST ONLY: an in-process transport per listener. Production opens a real WebSocket. */
  transport?: () => RelayTransport
  /** TEST ONLY: the host-token mint's fetch. */
  fetch?: typeof fetch
  /** TEST ONLY: how a removal cuts the key's live sessions (default `killRelayHostsByPeerKey`). A
   *  test holds it back to observe the window between the team write and the kill. */
  killPeer?(pubkeyB64: string, reason: TrustDeniedReason): void
  /** Wall clock (ms): display only (`since`, `addedAt`) and the mint's clock-skew fallback. */
  now?: () => number
  /** MONOTONIC clock (ms) for the scheduler, whose hourly mint budget must not stretch or empty when
   *  the wall clock steps. Defaults to `performance.now`. */
  monotonicNow?: () => number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
  /** Called after every successful `share` (on or off), once the team file holds the new set. The
   *  Server Edition's canvas authority adopts and releases projects here. */
  onSharedChange?(): void
}

export interface HostedInfo { relayEndpoint: string; hostId: string; hostPublicKeyB64: string; hostDeviceId: string; label: string }

export interface HostedStatus {
  enabled: boolean
  scheduler: SchedulerStatus | null
  peers: Array<{ label: string; role: TeamRole; connected: boolean }>
  pending: HostedPending[]
}

export interface HostedService {
  /** Create the host key (once) and the team file. `created` is false when a key already existed —
   *  including when a concurrent init won the race. An unreadable key throws; it is never replaced. */
  init(): Promise<{ created: boolean }>
  /** Idempotent: a running (or concurrently starting) service answers 'started' with no second scheduler. */
  start(): Promise<HostedStartResult>
  /** Stop hosting: every listener, session and pending request ends. A start still loading loses. */
  stop(): void
  addOwner(pubkeyB64: string, label: string): Promise<void>
  remove(pubkeyB64: string, force: boolean): Promise<'removed' | 'last-owner' | 'unknown'>
  share(projectId: string, on: boolean): Promise<void>
  /** The projects shared with the team right now, read from the team store on every call. */
  sharedProjectIds(): ReadonlySet<string>
  info(): HostedInfo | null
  joinCode(): string | null
  status(): HostedStatus
  /** Replace the host key. Every teammate needs a new join code. A hosting service restarts on the
   *  new key and answers the start result; one that was not hosting stays off ('not-running'). */
  rotateKey(): Promise<HostedRotateResult>
}

/** One relay listener and, once a peer bridges, its session. */
interface Conn {
  session: RelayHostSession | null
  /** The scheduler's events for this listener. */
  ev: { onBridged(): void; onClose(): void }
  /** The peer's role-filtered sink, set when the core opens the session. */
  sink: UiSink | null
  /** Set while this session is a pending join request. */
  pendingId: string | null
  /** The owner decision awaiting the peer's own confirm; what `pins.record` writes. */
  approval: { role: TeamRole; by: string } | null
  /** This session's own approval was confirmed by both humans but could not be written. */
  pinFailed: boolean
  /** Set when THIS service refused the session (deny, expiry, removal) — never for a drop. */
  refused: TrustDeniedReason | null
  open: boolean
  ended: boolean
}

interface PendingEntry { info: HostedPending; conn: Conn; timer: unknown }

const OWNER_ONLY: Readonly<Record<string, string>> = Object.freeze({
  [IPC.relayHostedApprove]: 'Only an owner can approve.',
  [IPC.relayHostedDeny]: 'Only an owner can deny.',
  [IPC.relayHostedInviteCode]: 'Only an owner can invite.',
  [IPC.relayHostedPending]: 'Only an owner can see join requests.'
})

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const realpath = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const idOf = (p: unknown): unknown =>
  p !== null && typeof p === 'object' ? (p as Record<string, unknown>).id : undefined

/** `workspace:load` holds every project on this core; a hosted peer sees the shared ones only. Fails
 *  closed: a result that does not look like a workspace keeps no projects. */
function narrowWorkspace(result: unknown, shared: ReadonlySet<string>): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
  const ws = result as Record<string, unknown>
  const projects = Array.isArray(ws.projects)
    ? ws.projects.filter((p) => { const id = idOf(p); return typeof id === 'string' && shared.has(id) })
    : []
  const active = projects.some((p) => idOf(p) === ws.activeProjectId) ? ws.activeProjectId : (idOf(projects[0]) ?? '')
  return { ...ws, projects, activeProjectId: active }
}

export function createHostedService(deps: HostedServiceDeps): HostedService {
  const dir = path.join(deps.dataDir, 'relay')
  const team = new TeamStore(dir)
  // Looked up at call time (not captured), so a test's fake timers and fake Date apply.
  const wallNow = (): number => (deps.now ? deps.now() : Date.now())
  const monoNow = (): number => (deps.monotonicNow ? deps.monotonicNow() : performance.now())
  const setT = (fn: () => void, ms: number): unknown => (deps.setTimeout ? deps.setTimeout(fn, ms) : setTimeout(fn, ms))
  const clearT = (h: unknown): void => {
    if (h === null || h === undefined) return
    if (deps.clearTimeout) deps.clearTimeout(h)
    else clearTimeout(h as ReturnType<typeof setTimeout>)
  }
  const killPeer = (pubkeyB64: string, reason: TrustDeniedReason): void =>
    deps.killPeer ? deps.killPeer(pubkeyB64, reason) : killRelayHostsByPeerKey(pubkeyB64, reason)

  let keys: KeyPair | null = null
  let scheduler: ReturnType<typeof createHostedScheduler> | null = null
  /** Bumped by every stop(). A start that began in an older epoch never creates a scheduler. */
  let epoch = 0
  /** start / rotateKey run one at a time, so two admin commands can never race a scheduler into
   *  existence (R2) or start one with the key a rotation is replacing. */
  let lifecycle: Promise<unknown> = Promise.resolve()
  const conns = new Set<Conn>() // every listener whose session has not ended
  const pending = new Map<string, PendingEntry>()

  const onLifecycle = <T>(op: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(op)
    lifecycle = run.catch(() => {})
    return run
  }

  /** The team's word on this key, NOW. Never cached (see the header). */
  const memberRole = (key: string | null): TeamRole | undefined =>
    key ? peerFor(team.current(), key)?.role : undefined
  /** The role a session is served with, or null = serve it nothing. */
  const standing = (c: Conn, s: RelayHostSession): TeamRole | null =>
    memberRole(s.peerKeyB64()) ?? (c.pinFailed ? 'viewer' : null)
  const ctxWith = (role: TeamRole): AccessContext => {
    const shared = new Set(team.current().sharedProjects)
    return {
      role,
      sharedProjects: shared,
      projectsOfNode: (nodeId) => deps.projectsOfNode(nodeId),
      nodeOfSession: (sessionId) => deps.nodeOfSession(sessionId),
      projectCwds: () =>
        [...shared].map((p) => deps.projectCwd(p)).filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
      // Never readable by a non-editor, even when a shared project's folder contains it (M7).
      hostDataDir: deps.dataDir,
      realpath,
      isFile
    }
  }

  const keyOf = (c: Conn): string | null => c.session?.peerKeyB64() ?? null
  const send = (c: Conn, channel: string, payload: unknown): void => {
    if (!c.sink) return
    try {
      c.sink.sendText(JSON.stringify({ t: 'ev', channel, args: [payload] }))
    } catch {
      // Its socket is gone; the session's own close is already on its way.
    }
  }
  /** Connected owners ONLY, judged per send. Never a broadcast. */
  const tellOwners = (channel: string, payload: unknown): void => {
    for (const c of conns) if (c.open && memberRole(keyOf(c)) === 'owner') send(c, channel, payload)
  }
  const pendingList = (): HostedPending[] => [...pending.values()].map((p) => ({ ...p.info }))

  const closePending = (id: string, reason: PendingClosedReason): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearT(p.timer)
    if (p.conn.pendingId === id) p.conn.pendingId = null
    tellOwners(IPC.relayHostedPendingClosed, { pendingId: id, reason })
  }

  /** Everything owed to a session that ended, however it ended: drop it, close its request, and tell
   *  the scheduler (which no longer counts it as bridged). At most once per session. */
  const ended = (c: Conn, reason: PendingClosedReason): void => {
    if (c.ended) return
    c.ended = true
    c.open = false
    conns.delete(c)
    if (c.pendingId) closePending(c.pendingId, reason)
    try {
      c.ev.onClose()
    } catch {
      // The scheduler never throws here; a throw must not undo the bookkeeping above.
    }
  }

  /** End a session on this service's own decision. `deny` is a no-op on a session that already
   *  closed (a drop, a key swap, a kill from elsewhere), so this tolerates every such state. */
  const endSession = (c: Conn, why: TrustDeniedReason, reason: PendingClosedReason): void => {
    c.refused ??= why
    c.session?.deny(why)
    ended(c, reason)
  }

  /** Cut every live session holding this key, and do the bookkeeping the kill itself does not
   *  (a kill never fires the core's onClose). */
  const cutKey = (key: string, why: TrustDeniedReason): void => {
    killPeer(key, why)
    for (const c of [...conns]) {
      if (keyOf(c) !== key) continue
      c.refused ??= why
      ended(c, 'gone')
    }
  }

  const expire = (c: Conn, pendingId: string): void => {
    // Answered or gone already: its timer was cleared, but a clear can lose a race with the fire.
    if (c.pendingId !== pendingId) return
    endSession(c, 'expired', 'expired')
  }

  /** Take back a pin this service wrote for a session it then refused — only if the entry is still
   *  exactly what it wrote (a later `add-owner` of the same key is someone's deliberate act). */
  const unpin = async (entry: TeamPeer): Promise<void> => {
    let took = false
    try {
      await team.update((d) => {
        const cur = peerFor(d, entry.pubkeyB64)
        const ours = cur && cur.role === entry.role && cur.addedAt === entry.addedAt && cur.addedBy === entry.addedBy
        if (!ours) return 'last-owner' // the store's "write nothing"
        took = true
        return removePeer(d, entry.pubkeyB64, true)
      })
    } catch (err) {
      console.warn(`[hosted-team] could not take back a refused teammate's pin: ${errorMessage(err)}`)
      return
    }
    // A reconnect from that key could have auto-approved while the pin stood.
    if (took) cutKey(entry.pubkeyB64, 'denied')
  }

  /** Pin an OWNER-approved peer into the team. The trust gate calls this only after both ends
   *  confirmed, with the key bound into the gate. An auto-approved peer is already a member. */
  const recordApproval = async (c: Conn, peerKeyB64: string): Promise<void> => {
    const a = c.approval
    if (!a) return
    const entry: TeamPeer = { pubkeyB64: peerKeyB64, label: '', role: a.role, addedAt: new Date(wallNow()).toISOString(), addedBy: a.by }
    let wrote = false
    try {
      await team.update((d) => {
        // Denied or expired while this write waited its turn: pin nothing ('last-owner' = write nothing).
        if (c.refused) return 'last-owner'
        // The key already has an entry: someone wrote it while this pin waited its turn (a racing
        // `team add-owner`, say). That is a deliberate act and it stands; replacing it would demote
        // an owner to the role this dialog picked. The session is served that entry's role.
        if (peerFor(d, peerKeyB64)) return 'last-owner'
        wrote = true
        return upsertPeer(d, entry)
      })
    } catch (err) {
      // The gate still opens (consent for THIS session is mutual) and serves it with the lowest role;
      // the next connect asks again.
      c.pinFailed = true
      console.warn(`[hosted-team] could not record an approved teammate: ${errorMessage(err)}`)
      return
    }
    // Denied or expired while the write itself was in flight: the refusal wins.
    if (wrote && c.refused) await unpin(entry)
  }

  /** approve / deny / invite-code / pending. Owner-only, judged from the CALLER's session key.
   *  Synchronous on purpose: two approves of one request are decided in arrival order, and the
   *  second answers false. */
  const ownerVerb = (s: RelayHostSession, method: string, args: unknown[]): unknown => {
    const caller = s.peerKeyB64()
    if (memberRole(caller) !== 'owner' || !caller) throw new Error(OWNER_ONLY[method])
    if (method === IPC.relayHostedInviteCode) return api.joinCode()
    if (method === IPC.relayHostedPending) return pendingList()
    const [pendingId, role] = args
    const p = typeof pendingId === 'string' ? pending.get(pendingId) : undefined
    if (method === IPC.relayHostedDeny) {
      if (!p) return false
      endSession(p.conn, 'denied', 'denied')
      return true
    }
    if (typeof role !== 'string' || !(TEAM_ROLES as readonly string[]).includes(role)) throw new Error('Unknown role.')
    if (!p || p.conn.approval) return false // gone, or another owner got there first
    p.conn.approval = { role: role as TeamRole, by: caller }
    // This end's confirm. The request stays pending until the peer's own confirm opens it.
    p.conn.session?.confirm()
    return true
  }

  const onPending = (c: Conn, s: RelayHostSession): void => {
    if (c.ended) return
    const key = s.peerKeyB64() ?? ''
    // One request per device: a newer connection from the same key takes the older one's place.
    for (const p of [...pending.values()]) if (p.info.peerKeyB64 === key && p.conn !== c) endSession(p.conn, 'denied', 'replaced')
    if (pending.size >= PENDING_MAX) {
      console.warn(`[hosted-team] ${PENDING_MAX} join requests are already waiting; refused another`)
      endSession(c, 'denied', 'gone') // no request was ever opened, so no owner hears of it
      return
    }
    const info: HostedPending = { pendingId: randomUUID(), sas: s.sas() ?? '', peerKeyB64: key, since: wallNow() }
    const timer = setT(() => expire(c, info.pendingId), PENDING_TTL_MS)
    pending.set(info.pendingId, { info, conn: c, timer })
    c.pendingId = info.pendingId
    tellOwners(IPC.relayHostedPeerPending, info)
  }

  const onOpen = (c: Conn, s: RelayHostSession): void => {
    if (c.ended) return
    c.open = true
    if (c.pendingId) closePending(c.pendingId, 'approved')
    const role = standing(c, s)
    if (role === null) console.warn('[hosted-team] a session opened with no team entry; it is served nothing')
    // An owner who was offline when a request arrived is told the ones still open.
    if (memberRole(s.peerKeyB64()) === 'owner') for (const p of pending.values()) send(c, IPC.relayHostedPeerPending, p.info)
  }

  function openListener(hostKeys: KeyPair, token: string, ev: Conn['ev']): Listener {
    const c: Conn = { session: null, ev, sink: null, pendingId: null, approval: null, pinFailed: false, refused: null, open: false, ended: false }
    const bridged = (): void => {
      try {
        ev.onBridged()
      } catch {
        // Never let the scheduler's bookkeeping break a handshake.
      }
    }
    conns.add(c)
    try {
      c.session = connectRelayHost({
        url: deps.relayUrl,
        token,
        ourKeys: hostKeys,
        attach: deps.attach,
        transport: deps.transport ? deps.transport() : undefined,
        // Asked once, at the end of the handshake, on BOTH paths (pinned or not) — which makes it the
        // moment this listener stops being available to anyone else: a pinned peer that never
        // confirms must not hold the room's only idle listener until its refresh.
        autoApprove: (peerKeyB64) => {
          bridged()
          return memberRole(peerKeyB64) !== undefined
        },
        pins: { record: (state) => recordApproval(c, state.peerKeyB64) },
        hooks: {
          interceptReq: (s, method, args) => {
            if (method === IPC.relayHostedSelf) {
              const role = standing(c, s)
              if (role === null) return Promise.reject(new Error(NOT_A_MEMBER))
              const p = peerFor(team.current(), s.peerKeyB64() ?? '')
              return Promise.resolve({ role, label: p?.label ?? '', hostLabel: deps.hostLabel })
            }
            if (!Object.hasOwn(OWNER_ONLY, method)) return null
            try {
              return Promise.resolve(ownerVerb(s, method, args))
            } catch (err) {
              return Promise.reject(err)
            }
          },
          access: (s, kind, method, args) => {
            // Intercepted requests never get here, so a hosted verb that did is a cast or unknown.
            if (typeof method === 'string' && method.startsWith(HOSTED_PREFIX)) {
              return { allow: false, message: 'That is answered by the hosted team service only.' }
            }
            // Before the role: an owner is refused too (E_ROLE, like every access refusal).
            if (method === IPC.workspaceSave) return { allow: false, message: RELAY_WORKSPACE_SAVE_REFUSED }
            const role = standing(c, s)
            if (role === null) return { allow: false, message: NOT_A_MEMBER }
            return decideAccess(kind, method, args, ctxWith(role))
          },
          wrapSink: (s, sink) => {
            const filtered = wrapSinkForRole(sink, () => ctxWith(standing(c, s) ?? 'viewer'))
            // A session with no standing receives nothing, terminal bytes included.
            const wrapped: UiSink = {
              sendText: (json) => { if (standing(c, s) !== null) filtered.sendText(json) },
              sendBinary: (buf) => { if (standing(c, s) !== null) filtered.sendBinary(buf) },
              bufferedAmount: () => filtered.bufferedAmount?.() ?? 0
            }
            c.session ??= s
            c.sink = wrapped
            return wrapped
          },
          // RPC responses bypass the outbound sink filter, so the role narrowing runs here too — after
          // the shared-project narrowing of the workspace (the subagent snapshot is the case today).
          narrowResponse: (s, method, result) => {
            const role = standing(c, s)
            if (role === null) throw new Error(NOT_A_MEMBER)
            const ctx = ctxWith(role)
            const scoped = method === IPC.workspaceLoad ? narrowWorkspace(result, ctx.sharedProjects) : result
            return narrowResponseForRole(method, scoped, ctx)
          }
        },
        onPeerPending: (s) => {
          bridged()
          c.session ??= s
          onPending(c, s)
        },
        onOpen: (s) => {
          bridged()
          c.session ??= s
          onOpen(c, s)
        },
        onClose: () => ended(c, 'gone')
      })
    } catch (err) {
      conns.delete(c)
      throw err
    }
    return {
      bridged: false,
      close: () => {
        c.session?.close()
        ended(c, 'gone')
      }
    }
  }

  /** End hosting now: every listener, session and pending request. Leaves the epoch alone. */
  const teardown = (): void => {
    const s = scheduler
    scheduler = null
    s?.stop() // closes every listener it holds, bridged ones included
    for (const c of [...conns]) {
      c.session?.close()
      ended(c, 'gone')
    }
    for (const id of [...pending.keys()]) closePending(id, 'gone')
  }

  async function startNow(my: number): Promise<HostedStartResult> {
    if (scheduler) return 'started'
    if (my !== epoch) return 'stopped'
    if (!team.exists()) return 'no-team'
    // The team BEFORE the key: status() then shows the members even when the key is unreadable.
    await team.load()
    let k: KeyPair | null
    try {
      k = await loadHostKey(dir)
    } catch (err) {
      if (err instanceof HostKeyUnreadableError) {
        console.error('[hosted-team]', err.message)
        return 'host-key-unreadable'
      }
      throw err
    }
    if (!k) return 'no-team'
    if (my !== epoch) return 'stopped'
    keys = k
    const hostKeys = k
    const addr = hostAddress(k)
    const s = createHostedScheduler(
      {
        mint: () =>
          mintHostToken({
            apiBase: deps.apiBase,
            deviceId: deps.deviceId,
            hostPublicKeyB64: addr.hostPublicKeyB64,
            // Proves this process holds the host key (relay-pop.ts); the key never leaves it.
            hostSecretKey: hostKeys.secretKey,
            fetch: deps.fetch,
            now: wallNow
          }),
        open: (token, ev) => openListener(hostKeys, token, ev),
        setTimeout: (fn, ms) => setT(fn, ms),
        clearTimeout: (h) => clearT(h)
      },
      monoNow
    )
    scheduler = s
    s.start()
    return 'started'
  }

  const api: HostedService = {
    async init() {
      let created = false
      try {
        await createHostKey(dir)
        created = true
      } catch (err) {
        // A key already there (a second init, or one that won a concurrent race) is not an error.
        if ((err as { code?: unknown } | null)?.code !== 'E_HOST_KEY_EXISTS') throw err
      }
      if (!team.exists()) await team.update((d) => d)
      return { created }
    },
    start() {
      const my = epoch
      return onLifecycle(() => startNow(my))
    },
    stop() {
      epoch++
      teardown()
    },
    async addOwner(pubkeyB64, label) {
      await team.update((d) =>
        upsertPeer(d, { pubkeyB64, label, role: 'owner', addedAt: new Date(wallNow()).toISOString(), addedBy: 'cli' })
      )
    },
    async remove(pubkeyB64, force) {
      let known = false
      // Decided inside the store's chain, so it reads the file even before start() loaded it.
      const r = await team.update((d) => {
        known = peerFor(d, pubkeyB64) !== undefined
        // Nothing to remove: 'last-owner' is the store's "write nothing"; `known` says which it was.
        return known ? removePeer(d, pubkeyB64, force) : 'last-owner'
      })
      if (!known) return 'unknown'
      if (r === 'last-owner') return 'last-owner'
      // Until the kill lands, the session holds no team entry — and is served nothing (R27).
      cutKey(pubkeyB64, 'removed')
      return 'removed'
    },
    async share(projectId, on) {
      await team.update((d) => setShared(d, projectId, on))
      // The share landed; a failing listener must not report it as failed to the admin.
      try {
        deps.onSharedChange?.()
      } catch (err) {
        console.warn(`[hosted-team] the shared-projects listener failed: ${errorMessage(err)}`)
      }
    },
    sharedProjectIds() {
      return new Set(team.current().sharedProjects)
    },
    info() {
      if (!keys) return null
      const a = hostAddress(keys)
      return { relayEndpoint: deps.relayUrl, hostId: a.hostId, hostPublicKeyB64: a.hostPublicKeyB64, hostDeviceId: deps.deviceId, label: deps.hostLabel }
    },
    joinCode() {
      const i = api.info()
      return i ? encodeJoinCode({ v: 1, ...i, label: i.label.slice(0, JOIN_LABEL_MAX) }) : null
    },
    status() {
      const connected = new Set<string>()
      for (const c of conns) {
        const k = c.open ? keyOf(c) : null
        if (k) connected.add(k)
      }
      return {
        enabled: scheduler !== null,
        scheduler: scheduler?.status() ?? null,
        peers: team.current().peers.map((p) => ({ label: p.label, role: p.role, connected: connected.has(p.pubkeyB64) })),
        pending: pendingList()
      }
    },
    rotateKey() {
      return onLifecycle(async (): Promise<HostedRotateResult> => {
        const wasHosting = scheduler !== null
        teardown()
        const my = epoch
        keys = await rotateHostKey(dir)
        // A service that was not hosting stays off: rotating a key is not consent to start hosting.
        if (!wasHosting) return 'not-running'
        return startNow(my)
      })
    }
  }
  return api
}
