// The live-link registry (docs/live-links.md): the owner's side of every link this machine hosts —
// at most MAX_LINKS_PER_MACHINE, each with its link host (link-host.ts). Records are persisted
// (spec D8) and resumed at launch. Owner state goes to OWNER clients only (`sendToOwners`): every
// view carries the link's URL, and the URL carries the secret.
//
// A LINK ENDS on: the owner's Stop (`revoke`, no notice — the owner did it), Stop all (`revokeAll`,
// one server call, awaited and reported — it is what reaches other machines' links), its expiry (a timer, plus a re-check on every host change because timers are
// monotonic and a closed lid pauses them — G24), the node leaving every project, or the server saying
// it is gone (a mint or status answering 410 — `onGone`, which does raise a notice).
//
// NODE GONE IS TRI-STATE (controller ruling R40). `nodeState` answers present / absent / unknown, and
// only ABSENT ends a link and revokes it server-side: an empty answer during the launch-time workspace
// load, or for a node in a project whose file was not read this run, is not evidence the node is gone,
// and a revoke cannot be undone. `init()` first waits for the workspace load it is handed, then keeps
// (and hosts) a link whose node is unknown — its join is join-only, so a node that never comes back
// costs a waiting viewer, never a spawned session. Create requires PRESENT. The same check runs before
// every join (R29): the link host is registry-free, so the registry wraps its `pty.join`.
//
// PERSISTENCE never blocks the owner (Task 9 note B, spec revoke order). Ending a link removes the
// record and ISSUES the write (the store snapshots at call time) before the sessions end, and never
// waits for it before the server revoke: a disk that hangs must not keep a revoked link's viewers
// connected or its server row alive. A create does wait for its write (a link that cannot be
// written must not exist: the server row is revoked), but no longer than PERSIST_TIMEOUT_MS.
// A links file that could not be read (WatchLinkStoreUnreadable) turns this run MEMORY-ONLY: the
// store is latched and never written, links still work and end at quit, and the owner is told on
// every create (R22, R42c). A keychain that refuses to SEAL is narrower (R45): the store still writes
// every link it holds a sealed form of — read at boot or sealed earlier this run — so only a link that
// was never sealed (the one just created) is not saved; it answers memory-only, and the owner is told.
// `init()` writes only when it actually pruned something (R42a), so a boot never rewrites the file.
//
// ENTITLEMENT. A host never mints with an empty entitlement (the API would answer 400, which stops
// minting for good): it answers itself a local refusal, and `onEntitlementChanged` re-arms every host
// the API refused once the license layer reports a change — a 7-day token expiring under a running
// link is the ordinary case (R41).
//
// THE SERVER EDITION registers this same service with `unsupported: true` until it has a license layer
// (R43): create answers `unsupported`, list answers [], nothing is loaded, hosted or revoked. The same
// mode is what a Server Edition that does not own its data dir would need (G15).
//
// Nothing here throws out of a callback or a void promise; every timer is cleared by `end`/`shutdown`.
import type { CorePlatform } from '../platform'
import type { WorkspaceStore } from '../workspace-store'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'
import { formatWatchLink } from '../../shared/watch-link/link'
import { deriveWatchLinkKeys, newWatchLinkSecret, sha256Hex } from '../../shared/watch-link/keys'
import type { WatchChatMessage, WatchLinkEndReason } from '../../shared/watch-link/protocol'
import {
  LABEL_MAX,
  MAX_LINKS_PER_MACHINE,
  TITLE_MAX,
  WATCH_LINK_TTLS,
  stripBidiControls,
  type CreateWatchLinkError,
  type CreateWatchLinkRequest,
  type CreateWatchLinkResult,
  type RevokeAllOutcome,
  type WatchLinkNotice,
  type WatchLinkView,
  type WatchLinkViewerView
} from '../../shared/watch-link-types'
import type { HostTokenResult, WatchLinkApi as WatchLinkApiClient } from './api'
import { createLinkHost, type LinkHost, type QuietClients, type WatchPty } from './link-host'
import { WatchLinkStoreUnreadable, type WatchLinkRecord, type WatchLinkStore } from './store'
import type { RelayTransport } from '../relay/relay-socket'

/** setTimeout's own ceiling (a longer delay fires at once). A link lives ≤ 24 h, far below it. */
const MAX_DELAY_MS = 2_147_483_647
/** The longest a create waits for its local write (or for the links file's boot load). */
export const PERSIST_TIMEOUT_MS = 10_000
/** The longest `init()` waits for the boot workspace load before deciding with the nodes it cannot
 *  place yet read as unknown (which keeps their links: the safe side). */
export const WORKSPACE_READY_TIMEOUT_MS = 10_000

export type WatchLinkNodeState = 'present' | 'absent' | 'unknown'

export interface WatchLinkServiceDeps {
  api: WatchLinkApiClient
  relayUrl: string
  store: Pick<WatchLinkStore, 'load' | 'save' | 'discardOpaque' | 'opaqueCount'>
  /** The stored Pro entitlement token, or null. Travels only in the API client's JSON body. */
  entitlement(): string | null
  /** False in a build that may not relay (an unpackaged dev build): no create, and resumed links
   *  are kept but not hosted (G21) — a dev run must not host the installed app's links. */
  relayAllowed(): boolean
  /** Is the node in some project (present), provably in none (absent), or cannot be told (unknown)?
   *  The shells answer with `workspaceNodeState`. */
  nodeState(nodeId: string): WatchLinkNodeState
  /** Resolves once the workspace index has been read: `init()` decides nothing before it (R40). */
  workspaceReady?(): Promise<unknown>
  clients: QuietClients
  pty: WatchPty
  /** Owner clients only (`sendToOwners`). */
  emit(channel: string, ...args: unknown[]): void
  /** This shell cannot host links (the Server Edition until it has a license layer — R43). */
  unsupported?: boolean
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(h: unknown): void
  /** TEST ONLY. */
  persistTimeoutMs?: number
  /** TEST ONLY. */
  workspaceWaitMs?: number
  /** TEST ONLY. */
  createHost?: typeof createLinkHost
  /** TEST ONLY: the relay transport the link hosts dial. */
  transport?: () => RelayTransport
}

export interface WatchLinkService {
  /** Load and resume the persisted links. Idempotent (one promise); never rejects. */
  init(): Promise<void>
  create(req: unknown): Promise<CreateWatchLinkResult>
  list(): WatchLinkView[]
  revoke(linkId: string): Promise<void>
  /** Stop this machine's links at once, then ask the server to revoke every link of the license and
   *  answer what that reached (`RevokeAllOutcome`). Never rejects. */
  revokeAll(): Promise<RevokeAllOutcome>
  kick(linkId: string, viewerId: string): boolean
  sendChat(linkId: string, text: string): WatchChatMessage | null
  chatHistory(linkId: string): WatchChatMessage[]
  /** After every workspace load/save: a node that is now ABSENT ends its links. */
  onWorkspaceChanged(): void
  /** After the license layer reports a change: re-arm every host the API refused. */
  onEntitlementChanged(): void
  /** Stop every host (`host-stopping`), keep the records for the next launch. Resolves once the
   *  last write this service issued has settled (the caller bounds it). */
  shutdown(): Promise<void>
}

/**
 * The node-gone rule over the workspace store, shared by both shells: present when some project
 * holds the node; absent only when the store has a COMPLETE read of every project
 * (`knownNodeIdsStrict`) and the node is not in it; unknown otherwise (the index not loaded yet, a
 * project file not read this run, an SSH project with no cache, an index rebuilt from nothing this
 * run). The STRICT accessor, never the mirror's `knownNodeIds`: absent here revokes a link for good.
 */
export function workspaceNodeState(
  store: Pick<WorkspaceStore, 'projectIdsForNode' | 'knownNodeIdsStrict'>,
  nodeId: string
): WatchLinkNodeState {
  if (store.projectIdsForNode(nodeId).length > 0) return 'present'
  const known = store.knownNodeIdsStrict()
  if (!known) return 'unknown'
  return known.has(nodeId) ? 'present' : 'absent'
}

// C0/C1 controls and DEL; the bidi controls are `stripBidiControls`'s.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

/** A label or title as the owner typed it (or as a git-shared node title says): controls and bidi
 *  overrides gone, trimmed, capped at `max` UTF-16 units — the unit the store checks on load —
 *  without splitting a surrogate pair. null when nothing is left. */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = stripBidiControls(raw.replace(CONTROLS, '')).trim()
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  out = out.trim()
  return out || null
}

function parseRequest(raw: unknown): CreateWatchLinkRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // `isSafeNodeId` coerces: `12` passes its regex. The type check comes first.
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  if (r.role !== 'viewer' && r.role !== 'commenter') return null
  if (!(WATCH_LINK_TTLS as readonly unknown[]).includes(r.ttlSeconds)) return null
  const label = cleanText(r.label, LABEL_MAX)
  if (!label) return null
  const title = cleanText(r.title, TITLE_MAX) ?? 'Terminal'
  return { nodeId: r.nodeId, role: r.role, ttlSeconds: r.ttlSeconds as CreateWatchLinkRequest['ttlSeconds'], label, title }
}

/** A chat message as the OWNER is shown it: whatever a viewer wrote, without bidi overrides. */
function ownerChat(msg: WatchChatMessage): WatchChatMessage {
  return { ...msg, name: stripBidiControls(msg.name), text: stripBidiControls(msg.text) }
}

/** Send to the machine's OWNER clients only — never a relay peer, never a live link's viewer. */
export function sendToOwners(
  p: Pick<CorePlatform, 'clientIds' | 'isOwnerClient' | 'sendTo'>,
  channel: string,
  ...args: unknown[]
): void {
  for (const id of p.clientIds()) if (p.isOwnerClient?.(id) === true) p.sendTo(id, channel, ...args)
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const TIMEOUT = Symbol('timeout')

export function createWatchLinkService(deps: WatchLinkServiceDeps): WatchLinkService {
  const now = deps.now ?? Date.now
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const createHost = deps.createHost ?? createLinkHost
  const persistTimeoutMs = deps.persistTimeoutMs ?? PERSIST_TIMEOUT_MS
  const workspaceWaitMs = deps.workspaceWaitMs ?? WORKSPACE_READY_TIMEOUT_MS
  // A wait on init covers init's own (bounded) workspace wait plus the links file's load: init's
  // bound always fires first, so a slow workspace never reads as a failed write.
  const initWaitMs = workspaceWaitMs + persistTimeoutMs
  const unsupported = deps.unsupported === true

  const records = new Map<string, WatchLinkRecord>()
  /** Created server-side, being written: in every write's snapshot (a concurrent write must not drop
   *  it from disk), but not yet a link — not listed, not hosted, and no stop path can end it half-way. */
  const writing = new Map<string, WatchLinkRecord>()
  const hosts = new Map<string, LinkHost>()
  const expiry = new Map<string, unknown>()
  let initPromise: Promise<void> | null = null
  /** Creates between their cap check and their answer (G17): they count against the cap. A create's
   *  record joins `records` only as it answers, so it is never counted twice. */
  let creating = 0
  let stopped = false
  /** The links file could not be read: never write it this run (R22). */
  let storeLatched = false
  /** The last write could not seal (the keychain refused): links live in memory only. */
  let sealRefused = false
  let lastWrite: Promise<unknown> = Promise.resolve()

  const fail = (error: CreateWatchLinkError): CreateWatchLinkResult => ({ ok: false, error })
  const warn = (line: string): void => console.warn(`[watch-link] ${line}`)
  const warned = new Set<string>()
  const warnOnce = (kind: string, line: string): void => {
    if (warned.has(kind)) return
    warned.add(kind)
    warn(line)
  }
  const persistentNow = (): boolean => !storeLatched && !sealRefused

  function safeEmit(channel: string, ...args: unknown[]): void {
    try {
      deps.emit(channel, ...args)
    } catch (err) {
      warn(`telling the owner failed: ${errorText(err)}`)
    }
  }
  const notice = (n: WatchLinkNotice): void => safeEmit(IPC.watchLinkNotice, n)

  function nodeStateOf(nodeId: string): WatchLinkNodeState {
    try {
      const s = deps.nodeState(nodeId)
      return s === 'present' || s === 'absent' ? s : 'unknown'
    } catch {
      return 'unknown' // a check that cannot answer is never evidence of absence
    }
  }

  /** `p`'s answer, or TIMEOUT after `ms` (the timer is cleared as soon as `p` settles). A rejection
   *  reads as a timeout: either way the caller got no answer. */
  function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    return new Promise((resolve) => {
      const h = setT(() => resolve(TIMEOUT), ms)
      p.then(
        (v) => {
          clearT(h)
          resolve(v)
        },
        () => {
          clearT(h)
          resolve(TIMEOUT)
        }
      )
    })
  }

  function viewOf(r: WatchLinkRecord): WatchLinkView {
    const h = hosts.get(r.linkId)
    // No host: a build that may not relay (G21), or a host that could not be built — nobody can
    // watch it, which is what `refused` says.
    let status: WatchLinkView['status'] = 'refused'
    let viewers: WatchLinkViewerView[] = []
    if (h) {
      try {
        status = h.status()
        viewers = h.viewers().map((v) => ({
          viewerId: v.viewerId,
          name: v.name === null ? null : stripBidiControls(v.name),
          joinedAt: v.joinedAt,
          waiting: v.waiting === true
        }))
      } catch (err) {
        warn(`reading a link's state failed: ${errorText(err)}`)
      }
    }
    return {
      linkId: r.linkId,
      nodeId: r.nodeId,
      role: r.role,
      label: stripBidiControls(r.label),
      title: stripBidiControls(r.title),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      url: formatWatchLink(r.linkId, r.secret),
      status,
      viewers
    }
  }
  const list = (): WatchLinkView[] => (unsupported ? [] : [...records.values()].map(viewOf))
  // Coalesced (R46/M7): ending a link stops its host, whose `stop` reports a change, and then the end
  // reports its own; a shutdown stops every host. One push per synchronous burst — each push carries
  // every link's URL, and the list is read when the push goes out, so it is never stale.
  let statePending = false
  const emitState = (): void => {
    if (statePending) return
    statePending = true
    queueMicrotask(() => {
      statePending = false
      // `formatWatchLink` throws on a record it could not make a URL of. Every record passed its
      // checks (the API client's link-id rule, the store's load rules), but a throw here would be
      // uncaught inside a microtask, so it is caught and reported instead.
      try {
        safeEmit(IPC.watchLinkState, list())
      } catch (err) {
        warn(`listing live links failed: ${errorText(err)}`)
      }
    })
  }
  /** Links this machine holds but cannot host this run (sealed, keychain locked) — they count against
   *  the cap like any link (R46/M3). */
  const opaqueHeld = (): number => {
    try {
      return deps.store.opaqueCount()
    } catch {
      return 0
    }
  }

  /** Write the current records. Called, not awaited, wherever the owner must not wait on the disk;
   *  the store snapshots at call time and serializes its writes, so disk order is call order. */
  function persist(): Promise<boolean> {
    if (storeLatched) return Promise.resolve(true) // memory-only this run: nothing is written
    const p = deps.store.save([...records.values(), ...writing.values()]).then(
      (outcome) => {
        sealRefused = outcome === 'memory-only'
        return outcome !== 'failed'
      },
      () => false
    )
    lastWrite = p
    return p
  }

  function revokeServer(linkId: string): void {
    const ent = deps.entitlement()
    if (!ent) return
    void deps.api.revoke(linkId, ent).catch(() => false) // best effort (the client never rejects)
  }

  function armExpiry(r: WatchLinkRecord): void {
    const t = expiry.get(r.linkId)
    if (t !== undefined) clearT(t)
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, r.expiresAt - now()))
    expiry.set(
      r.linkId,
      setT(() => {
        expiry.delete(r.linkId)
        if (records.get(r.linkId) !== r) return
        if (now() < r.expiresAt) armExpiry(r) // a clamped delay: not yet
        else end(r.linkId, 'expired', { serverRevoke: false, notify: true })
      }, delay)
    )
  }

  /** The host's pty seam, with the node-gone check before every join (R29, G8). */
  function guardedPty(r: WatchLinkRecord): WatchPty {
    return {
      join: async (clientId, nodeId, viewerId) => {
        // Off the link host's own call stack: ending the link stops that host.
        await Promise.resolve()
        if (nodeStateOf(nodeId) === 'absent') {
          end(r.linkId, 'node-gone', { serverRevoke: true, notify: true })
          return null
        }
        return deps.pty.join(clientId, nodeId, viewerId)
      },
      leave: (clientId, sessionId, viewerId) => deps.pty.leave(clientId, sessionId, viewerId),
      captureVisible: (sessionId) => deps.pty.captureVisible(sessionId),
      syncSize: (sessionId) => deps.pty.syncSize(sessionId),
      alive: (sessionId) => deps.pty.alive(sessionId)
    }
  }

  function onHostChange(linkId: string): void {
    const r = records.get(linkId)
    if (r && now() >= r.expiresAt) {
      // A reconnect after a lid-close: the expiry timer may not have fired yet (G24). Deferred: this
      // runs inside the link host's own status callback, and ending the link stops that host.
      queueMicrotask(() => end(linkId, 'expired', { serverRevoke: false, notify: true }))
      return
    }
    emitState()
  }

  function start(r: WatchLinkRecord): void {
    if (stopped || hosts.has(r.linkId)) return
    armExpiry(r)
    if (!deps.relayAllowed()) return // kept and listed `refused`, never hosted (G21)
    let host: LinkHost
    try {
      host = createHost(r, {
        relayUrl: deps.relayUrl,
        mint: async (): Promise<HostTokenResult> => {
          const ent = deps.entitlement()
          // Never a request with an empty entitlement: the API answers 400, and a 400 stops minting
          // for good. The same end state, reached locally; `onEntitlementChanged` re-arms it (R41).
          if (!ent) return { ok: false, kind: 'refused', status: 402 }
          return deps.api.hostToken(r.linkId, ent)
        },
        status: async () => {
          const ent = deps.entitlement()
          return ent ? deps.api.status(r.linkId, ent) : 'unknown'
        },
        clients: deps.clients,
        pty: guardedPty(r),
        transport: deps.transport,
        now,
        setTimeout: setT,
        clearTimeout: clearT,
        onChange: () => onHostChange(r.linkId),
        onChat: (msg) => safeEmit(IPC.watchLinkChat, r.linkId, ownerChat(msg)),
        onViewerJoined: (count) =>
          notice({ kind: 'joined', linkId: r.linkId, nodeId: r.nodeId, title: stripBidiControls(r.title), viewers: count }),
        onGone: (reason) => end(r.linkId, reason, { serverRevoke: false, notify: true })
      })
    } catch (err) {
      warn(`a link could not be hosted: ${errorText(err)}`)
      return
    }
    hosts.set(r.linkId, host)
    try {
      host.start()
    } catch (err) {
      warn(`a link host did not start: ${errorText(err)}`)
    }
  }

  /** Forget the record and its timer; the host is returned for the caller to stop AFTER the write
   *  was issued (spec: delete and write the record first, then end the sessions). */
  function drop(linkId: string): { record: WatchLinkRecord; host: LinkHost | undefined } | null {
    const record = records.get(linkId)
    if (!record) return null
    records.delete(linkId)
    const t = expiry.get(linkId)
    if (t !== undefined) clearT(t)
    expiry.delete(linkId)
    const host = hosts.get(linkId)
    hosts.delete(linkId)
    return { record, host }
  }
  function stopHost(host: LinkHost | undefined, reason: WatchLinkEndReason): void {
    try {
      host?.stop(reason)
    } catch (err) {
      warn(`stopping a link host failed: ${errorText(err)}`)
    }
  }

  function end(
    linkId: string,
    reason: 'expired' | 'revoked' | 'node-gone',
    o: { serverRevoke: boolean; notify: boolean }
  ): void {
    const gone = drop(linkId)
    if (!gone) return
    void persist()
    stopHost(gone.host, reason)
    emitState()
    if (o.notify) {
      notice({ kind: 'ended', linkId, nodeId: gone.record.nodeId, title: stripBidiControls(gone.record.title), reason })
    }
    if (o.serverRevoke) revokeServer(linkId)
  }

  async function runInit(): Promise<void> {
    if (unsupported) return
    if (deps.workspaceReady) {
      // A failed load leaves nodes unknown, which keeps every link: the safe side. A load that does
      // not finish (a stalled mount) is waited for no longer than WORKSPACE_READY_TIMEOUT_MS (R46/M5).
      const ready = await within(
        Promise.resolve().then(() => deps.workspaceReady!()).then(() => 'ready', () => 'failed'),
        workspaceWaitMs
      )
      if (ready === TIMEOUT) {
        warn(`the workspace did not finish loading within ${workspaceWaitMs} ms; resuming links whose node cannot be placed yet`)
      }
    }
    let loaded: WatchLinkRecord[] = []
    try {
      loaded = await deps.store.load()
    } catch (err) {
      // The store refuses to write over a file it could not read (and latched itself); any other
      // failure is treated the same way, because writing over it is the one unrecoverable mistake.
      storeLatched = true
      const why = err instanceof WatchLinkStoreUnreadable ? `${err.reason}: ${err.message}` : errorText(err)
      warn(`live links will not be saved this run — the links file could not be read (${why})`)
    }
    if (stopped) return
    const t = now()
    let pruned = false
    for (const r of loaded) {
      if (records.has(r.linkId)) continue
      if (r.expiresAt <= t) {
        pruned = true
        continue
      }
      if (nodeStateOf(r.nodeId) === 'absent') {
        pruned = true
        revokeServer(r.linkId)
        continue
      }
      if (records.size >= MAX_LINKS_PER_MACHINE) {
        // A hand-edited file: this machine hosts five links at most.
        pruned = true
        revokeServer(r.linkId)
        continue
      }
      records.set(r.linkId, r)
    }
    if (pruned) void persist()
    for (const r of [...records.values()]) start(r)
    emitState()
    if (!persistentNow()) notice({ kind: 'not-persistent' })
  }

  const init = (): Promise<void> =>
    (initPromise ??= runInit().catch((err) => warn(`resuming live links failed: ${errorText(err)}`)))

  return {
    init,

    async create(raw) {
      if (unsupported || stopped) return fail('unsupported')
      const req = parseRequest(raw)
      if (!req) return fail('bad-request')
      if (!deps.relayAllowed()) return fail('relay-unavailable')
      // The resumed links count against the cap, and init must never start a host for a link a
      // create already started (G11). Bounded: a hung disk answers, it does not hang the dialog.
      if ((await within(init(), initWaitMs)) === TIMEOUT) {
        warnOnce('init-timeout', `the live-links file did not load within ${initWaitMs} ms`)
        return fail('persist-failed')
      }
      if (stopped) return fail('unsupported')
      if (nodeStateOf(req.nodeId) !== 'present') return fail('node-missing')
      if (records.size + creating + opaqueHeld() >= MAX_LINKS_PER_MACHINE) return fail('limit-machine')
      const ent = deps.entitlement()
      if (!ent) return fail('not-entitled')
      creating++
      try {
        const secret = newWatchLinkSecret()
        const joinKeyHash = await sha256Hex(deriveWatchLinkKeys(secret).joinKey)
        const created = await deps.api.create(ent, joinKeyHash, req.ttlSeconds)
        if (!created.ok) return fail(created.error)
        if (stopped) {
          revokeServer(created.linkId)
          return fail('unsupported')
        }
        const record: WatchLinkRecord = {
          linkId: created.linkId,
          nodeId: req.nodeId,
          role: req.role,
          label: req.label,
          title: req.title,
          createdAt: now(),
          expiresAt: created.expiresAt,
          secret
        }
        writing.set(record.linkId, record)
        let written: boolean | typeof TIMEOUT
        try {
          written = await within(persist(), persistTimeoutMs)
        } finally {
          writing.delete(record.linkId)
        }
        if (written !== true || stopped) {
          // No half-created link: queue the list without it behind whatever is stuck (so a write
          // that lands late is overwritten), and revoke the server row. (Quitting meanwhile is the
          // same: the owner was never shown this link.)
          void persist()
          revokeServer(record.linkId)
          return fail(stopped ? 'unsupported' : 'persist-failed')
        }
        // The node may have left every project while the record was being written — a workspace
        // change could not see this record then (it is not a link yet). Absent now: undo it (R46/M4).
        if (nodeStateOf(record.nodeId) === 'absent') {
          void persist()
          revokeServer(record.linkId)
          return fail('node-missing')
        }
        records.set(record.linkId, record)
        start(record)
        emitState()
        if (!persistentNow()) notice({ kind: 'not-persistent' })
        return { ok: true, link: viewOf(record) }
      } catch (err) {
        warn(`creating a live link failed: ${errorText(err)}`)
        return fail('network')
      } finally {
        creating--
      }
    },

    list,

    async revoke(linkId) {
      if (unsupported || typeof linkId !== 'string') return
      await within(init(), initWaitMs) // no link exists before init; a hung load must not hang the stop
      end(linkId, 'revoked', { serverRevoke: true, notify: false })
    },

    async revokeAll() {
      if (unsupported) return 'unsupported'
      // Bounded like revoke: on a disk that hangs, "Stop all" still reaches the server below.
      await within(init(), initWaitMs)
      const gone = [...records.keys()].map(drop)
      // "Stop all" revokes every link of the license server-side, the ones this run cannot unseal too.
      try {
        deps.store.discardOpaque()
      } catch (err) {
        warn(`forgetting unreadable links failed: ${errorText(err)}`)
      }
      void persist()
      for (const g of gone) stopHost(g?.host, 'revoked')
      emitState()
      // This machine's links are stopped. The server call is the only thing that reaches the links of
      // OTHER machines on the license, so it is AWAITED and its answer reported (R62): a stop that did
      // not reach the server must not look like one that did.
      let ent: string | null
      try {
        ent = deps.entitlement()
      } catch {
        ent = null
      }
      if (!ent) return 'no-entitlement'
      try {
        return (await deps.api.revokeAll(ent)) ? 'stopped' : 'failed'
      } catch {
        return 'failed'
      }
    },

    kick(linkId, viewerId) {
      try {
        return hosts.get(linkId)?.kick(viewerId) ?? false
      } catch (err) {
        warn(`kicking a viewer failed: ${errorText(err)}`)
        return false
      }
    },

    sendChat(linkId, text) {
      try {
        const msg = hosts.get(linkId)?.postSharerChat(text) ?? null
        return msg ? ownerChat(msg) : null
      } catch (err) {
        warn(`sending a chat message failed: ${errorText(err)}`)
        return null
      }
    },

    chatHistory(linkId) {
      try {
        return (hosts.get(linkId)?.chatHistory() ?? []).map(ownerChat)
      } catch {
        return []
      }
    },

    onWorkspaceChanged() {
      if (unsupported || stopped) return
      void init().then(() => {
        if (stopped) return
        for (const r of [...records.values()]) {
          if (nodeStateOf(r.nodeId) === 'absent') end(r.linkId, 'node-gone', { serverRevoke: true, notify: true })
        }
      })
    },

    onEntitlementChanged() {
      if (stopped) return
      for (const h of hosts.values()) {
        try {
          if (h.status() === 'refused') h.start()
        } catch (err) {
          warn(`re-arming a link host failed: ${errorText(err)}`)
        }
      }
    },

    shutdown() {
      if (!stopped) {
        stopped = true
        for (const t of expiry.values()) clearT(t)
        expiry.clear()
        const all = [...hosts.values()]
        hosts.clear()
        for (const h of all) stopHost(h, 'host-stopping')
      }
      return lastWrite.then(
        () => undefined,
        () => undefined
      )
    }
  }
}

/**
 * `shutdown()` bounded: the service's last write may hang on a stalled disk, and a shell's close must
 * not (R46/M6). The Server Edition awaits this in both close paths; the desktop races its own 1.5 s
 * flush instead. The timer is cleared (and never holds the process) either way.
 */
export async function shutdownWithin(s: WatchLinkService | null, ms: number): Promise<void> {
  if (!s) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  try {
    await Promise.race([s.shutdown(), bound])
  } finally {
    clearTimeout(timer)
  }
}

/** The owner IPC. Relay peers never reach these handlers (the `watchLink:` prefix is host-only and
 *  refused before any policy runs); the owner check is the belt behind that, for any other client. */
export function registerWatchLinkIpc(
  p: Pick<CorePlatform, 'handleWithSender' | 'isOwnerClient'>,
  s: WatchLinkService
): void {
  const owner = (id: number): boolean => p.isOwnerClient?.(id) === true
  const str = (v: unknown): v is string => typeof v === 'string'
  p.handleWithSender(IPC.watchLinkCreate, (sender: number, req: unknown) =>
    owner(sender) ? s.create(req) : ({ ok: false, error: 'unsupported' } satisfies CreateWatchLinkResult))
  p.handleWithSender(IPC.watchLinkList, (sender: number) => (owner(sender) ? s.list() : []))
  p.handleWithSender(IPC.watchLinkRevoke, (sender: number, id: unknown) =>
    owner(sender) && str(id) ? s.revoke(id) : undefined)
  p.handleWithSender(IPC.watchLinkRevokeAll, (sender: number) =>
    owner(sender) ? s.revokeAll() : ('unsupported' satisfies RevokeAllOutcome))
  p.handleWithSender(IPC.watchLinkKick, (sender: number, id: unknown, viewer: unknown) =>
    owner(sender) && str(id) && str(viewer) ? s.kick(id, viewer) : false)
  p.handleWithSender(IPC.watchLinkChatSend, (sender: number, id: unknown, text: unknown) =>
    owner(sender) && str(id) && str(text) ? s.sendChat(id, text) : null)
  p.handleWithSender(IPC.watchLinkChatHistory, (sender: number, id: unknown) =>
    owner(sender) && str(id) ? s.chatHistory(id) : [])
}
