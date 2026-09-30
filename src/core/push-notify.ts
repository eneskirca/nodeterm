// Desktop → paired-phone APNs push (spec: nodeterm-server/docs/specs/2026-07-19-apns-push.md,
// "Desktop (nodeterm)" section).
//
// When an agent needs approval, asks a question, or finishes a turn, a paired iPhone should get a
// real APNs push even with the app backgrounded/killed. This service is fed by the SAME seam that
// produces the mobile Inbox feed — `onInboxActionable` in `agent-status-mirror.ts` — so it fires
// exactly on approval/question (post-dedup) and done (turn edge). It batches events in a short
// window and POSTs them to the backend, which fans out to the host's relay-paired phones.
//
// It lives in `src/core` (no electron imports) behind injected deps, so it is pure + unit-testable
// and both shells can boot it. In practice only the DESKTOP shell has a standing relay host
// identity + paired-phone registry to feed it — the Server Edition has neither, so it never
// constructs this (a documented, deliberate three-surfaces degrade; see src/server/index.ts).

import type { InboxEvent, NodeStateChange, NodeNowChange } from './agent-status-mirror'
import type { PushGrant } from './push-grants'
import { fetchPopChallenge, popRefusalOf, type PopProver } from './relay/relay-pop'

const DEFAULT_API_BASE = 'https://api.nodeterm.dev'
// Batch actionable events landing close together into one POST (≤10 events/call per the contract).
const DEFAULT_BATCH_WINDOW_MS = 2000
// Per-node throttle — mirrors the local-notification throttle (5s/node): a chatty node can't
// spam pushes.
const DEFAULT_THROTTLE_MS = 5000
// Max events per POST (backend contract: events[≤10]).
const MAX_EVENTS_PER_CALL = 10
const FETCH_TIMEOUT_MS = 8000
// Backend contract cap for the optional per-event `nodeTitle` (the node's canvas/sidebar name,
// rendered into the alert title as "<Needs you|Completed> — <nodeTitle>").
const NODE_TITLE_MAX = 80
// Bound on the presence-aware hold queue: while the user is present at the desktop, alerts pile up
// here until they go idle/lock. Oldest-dropped past this cap; the queue is in-memory, so a restart
// loses it (the mirror still carries the events — acceptable, documented).
const HELD_QUEUE_MAX = 50

/** The standing relay host's identity, needed for the backend's (hostDeviceId, hostId-from-pubkey)
 *  auth. `hasPairedPhone` is what makes the service live at all — no paired phone ⇒ nowhere to fan
 *  out to ⇒ inert. `null` from `getHostIdentity` (no relay host configured / key locked) is also
 *  inert. */
export interface PushHostIdentity {
  hostDeviceId: string
  hostPublicKeyB64: string
  hostLabel: string
  hasPairedPhone: boolean
  /** Proves possession of the host key for a PoP-enabled backend (relay-pop.ts). The secret stays in
   *  the prover's closure; absent ⇒ host-mode push stays legacy. */
  prove?: PopProver
}

/** The per-event body the backend `/v1/push/notify` expects (a subset of InboxEvent). */
export interface PushNotifyEvent {
  kind: 'approval' | 'question' | 'done'
  title: string
  detail?: string
  nodeId: string
  agentId?: string
  /** The node's human display title (canvas header / sessions sidebar name), clipped to 80 chars.
   *  Optional: the backend renders the alert title as "<Needs you|Completed> — <nodeTitle>" when
   *  present, and falls back to a generic title when absent. */
  nodeTitle?: string
  /** question only: the AskUserQuestion choices (≤4 labels, each ≤60 chars). The backend renders
   *  them as numbered notification actions + appends them to the body (spec:
   *  interactive-push-live-activities). Absent for approvals + plain questions. */
  options?: string[]
  /** question only: the AskUserQuestion `multiSelect` flag — the picker accepts multiple choices.
   *  Rides the `nt` block so the phone renders multi-select. Omitted when absent/false. */
  multiSelect?: boolean
  /** Unix **MILLISECONDS** — see `TS_UNIT` below. Forwarded verbatim from `InboxEvent.ts`
   *  (`Date.now()` in agent-status-mirror); never divided, never re-stamped here. */
  ts: number
}

/** The unit EVERY `ts` in this file's payloads carries: Unix **milliseconds**, straight from the
 *  agent-status mirror (`InboxEvent.ts` / `NodeStateChange.ts` / `NodeNowChange.ts`, all
 *  `Date.now()`). The mirror is the source of truth for the whole timestamp story — the phone
 *  already divides `InboxEvent.ts` / `installedAt` / `resetsAt` by 1000 to build a `Date`, and the
 *  Live Activity `ContentState.ts` is the same field from the same producer. A second producer that
 *  writes SECONDS into one of these fields (an iOS foreground poll stamping
 *  `Date().timeIntervalSince1970`, say) disagrees with this one by a factor of 1000 and makes every
 *  comparison — "is this update newer than what I'm showing?" — nonsense. Nothing in this file may
 *  scale a `ts`: forward the mirror's number or don't send one. */
export const TS_UNIT = 'unix-ms' as const

/** Where a batch is sent. BOTH legs can be live at once: `host` is the relay-identity POST the
 *  backend fans out over its `relay_devices` rows, `grants` is one Bearer-authorized POST per
 *  SSH-possession grant. `null` on either side means that leg has no destination. */
interface SendTarget {
  host: PushHostIdentity | null
  grants: PushGrant[]
}

/**
 * One POST per (host, device), not per grant FILE.
 *
 * `src/main`'s `allPushGrants` concatenates this machine's `~/.nodeterm/push-grants` with a sweep of
 * every connected SSH host, so one phone that reached several of them appears several times — once
 * per host, with a DIFFERENT token each time. Those are not duplicates: each token is signed for
 * the phone's connectionId for THAT host, which is also the scope its per-host mute is keyed by.
 * This used to collapse them per deviceId ("first occurrence wins") and post every event under the
 * survivor, so host B's events went out under host A's grant and the backend consulted A's mute for
 * a B event — a host the user had turned OFF kept ringing the phone (issue #435). Events are now
 * routed per host (`grantsFor` / `groupByGrantHost`); within one host a device has exactly one file
 * (the filename is the deviceId), so the first-wins here is defensive only.
 */
function dedupeGrants(grants: readonly PushGrant[]): PushGrant[] {
  const seen = new Set<string>()
  const out: PushGrant[] = []
  for (const g of grants) {
    const key = `${g.host ?? ''}\u0000${g.deviceId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(g)
  }
  return out
}

/** The grants that may carry an event about `host` (undefined = a node on THIS machine): exactly
 *  the ones swept from that host. A grant dropped here never carries a remote node's event, and a
 *  remote host's grant never carries another host's — the phone signed each for one host. */
function grantsFor(grants: readonly PushGrant[], host: string | undefined): PushGrant[] {
  return grants.filter((g) => (g.host ?? undefined) === host)
}

/** Bucket a batch by the host each item's node lives on. Without a `hostOf` resolver (the Server
 *  Edition: one machine, its own grant dir) everything is local — one bucket, the legacy fan-out. */
function groupByGrantHost<T extends { nodeId: string }>(
  items: readonly T[],
  hostOf: ((nodeId: string) => string | undefined) | undefined
): Map<string | undefined, T[]> {
  const out = new Map<string | undefined, T[]>()
  for (const it of items) {
    const host = hostOf ? hostOf(it.nodeId) : undefined
    const bucket = out.get(host)
    if (bucket) bucket.push(it)
    else out.set(host, [it])
  }
  return out
}

/**
 * The single targeting rule, shared by BOTH senders (`createPushNotify` and `createLiveUpdatePush`
 * each had their own copy of it, and a copy is a thing that drifts). The per-sender gates — the
 * master switch, DNT/packaged, the live-activities sub-gate — stay with their sender; this answers
 * only "who does a batch go to".
 *
 * **It is a UNION, not an either/or.** It used to return host-mode the moment a phone was
 * relay-paired and never look at the grants at all, to avoid double-pushing a phone that was both
 * paired AND granted. The goal was right, the granularity was wrong: host mode fans out over the
 * backend's `relay_devices` rows, and an SSH-ONLY phone has no row there — its grant was its only
 * route — so ONE relay-paired phone silenced every other phone on the machine, with no error
 * anywhere. A duplicate notification is a cheap regression; a phone that never rings is not.
 *
 * The correct exclusion is per DEVICE, and this process cannot express it: a `PushGrant` is keyed by
 * the phone's `deviceId` (the grant filename), while the relay-paired registry
 * (`remote-approved-phones.json`, read by `phonePins.load`) stores nothing but base64 NaCl box
 * PUBLIC KEYS — and this service is only told `hasPairedPhone: boolean` in the first place. The two
 * identifiers never meet on the desktop: the phone's own deviceId is seen exactly once, transiently,
 * during a LAN QR pair (`pairing-service.ts`'s `phoneDeviceId`, spent on the `/v1/relay/device` mint
 * and never persisted), and not at all on the relay-only path where an unknown phone is pinned by
 * pubkey after the SAS prompt. So neither core nor `src/main` can subtract the paired phones from
 * the grant list today.
 *
 * Consequence, stated plainly: a phone that is BOTH relay-paired to this machine AND has dropped a
 * grant it can reach receives TWO pushes for one event. Closing that needs the overlap to be
 * knowable — either the backend does it (it sees the relay device row AND the grant's deviceId, so
 * it is the only party holding both halves) or the desktop starts persisting the phone's deviceId
 * beside its pinned pubkey at pair time. Both are protocol changes, not a filter we can add here.
 *
 * **The grants are the whole list, tagged by host — the SPLIT happens at send time.** The relay leg
 * carries every event under this machine's identity (the backend has no other host identity to
 * check a per-host mute against — see the known gap in the PR). The granted leg is per host: each
 * event goes only under the grants swept from the host its node lives on (`grantHostFor`), because
 * a grant is signed for that one host's connectionId and the phone's mute is keyed by exactly that.
 */
function resolveSendTarget(
  getHostIdentity: () => PushHostIdentity | null,
  getGrants: (() => PushGrant[]) | undefined
): SendTarget | null {
  const id = getHostIdentity()
  // The paired-phone gate is host-mode only — a grant IS the phone's opt-in.
  const host = id && id.hasPairedPhone ? id : null
  const grants = dedupeGrants(getGrants?.() ?? [])
  if (!host && grants.length === 0) return null
  return { host, grants }
}

/** POST a JSON body with the shared timeout, swallowing network errors (no retry queue — the phone
 *  still polls the mirror). Returns the Response (so granted mode can read 401/403) or null on a
 *  thrown/aborted fetch. When `grant` is set, sends `Authorization: Bearer <grant>` instead of a
 *  host-identity body. */
async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  grant?: string
): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(grant ? { authorization: `Bearer ${grant}` } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---- Host-mode proof of possession: the hostAuth session ------------------------------------
// A PoP-enabled backend latches a host the first time it proves it holds its key, and from then on
// refuses an unproven host-mode notify or live-update (403 pop_required). The host proves once —
// `/v1/relay/challenge` (purpose `push`) then `POST /v1/push/host-auth` — and attaches the session it
// gets (`hostAuth`) to every host-mode post until it re-proves. Push never stops anything, so nothing
// here is terminal: a batch that cannot be proven is DROPPED, exactly like a network error, because an
// unproven send from a latched host is refused anyway. Only a challenge answered 404/405 means "this
// backend predates the proof" (relay-pop.ts), and only then does the post go out legacy — with ONE
// exception, push's own: a 200 challenge whose host-auth post answers 404 (see `establish`), cached for
// 10 minutes like the 404/405 verdict. One backend registers both routes or neither, so that answer
// comes only from a redeploy window; push stops nothing, and the backend gates the unproven post
// regardless (a latched host's is refused, which forgets the verdict — see postHostMode).

// The server's session TTL is 15 min; re-prove on OUR clock, well inside it, so a skewed clock or a
// long batch window never presents an expired session.
const HOST_AUTH_REPROVE_MS = 10 * 60_000
// Earliest next proving attempt after the Nth failure in a row (the last entry repeats). The first
// retry is free — a blip costs one batch, not the next minute — but a backend that keeps refusing
// (no live pairing, a proof it never accepts, its own 429) is asked once a minute, not once a batch:
// the live-update stream flushes up to once a second, and every attempt spends the per-IP
// /v1/relay/challenge budget the relay host-token mint needs too.
const HOST_AUTH_RETRY_MS = [0, 5_000, 15_000, 60_000]
// The hold is an absolute WALL-clock time, on purpose: the 10-minute session age above must keep
// advancing across a sleep, which a monotonic clock does not. So a hold farther out than the longest
// step can only be a clock that stepped BACK after it was set, and it is ignored — honouring it would
// hold host-mode push for the whole step (a day, for a day's step).
const HOST_AUTH_RETRY_MAX_MS = Math.max(...HOST_AUTH_RETRY_MS)

export interface HostAuthCache {
  /** The session token to attach, undefined for legacy (no prover, or an old backend), or 'drop'
   *  when a failure means this batch must not go out unproven. Never '' — the backend reads an
   *  empty `hostAuth` as present-but-invalid. Never rejects: a proof that throws is a failure like
   *  any other ('drop', and the backoff). */
  get(identity: PushHostIdentity): Promise<string | undefined | 'drop'>
  /** Whether `get` would answer from the cache right now, without asking the backend. */
  onFile(identity: PushHostIdentity): boolean
  /** Forget the session (or the old-backend verdict): the next batch proves again. */
  invalidate(): void
}

/**
 * One hostAuth session per sender (notify and live-update each own one: they are independent streams
 * and each re-proves at most every 10 minutes). The "old backend" verdict is cached the same way, so
 * a backend without the routes that ACCEPTS the host's posts costs one challenge per 10 minutes rather
 * than one per batch. One that refuses them (403 forbidden: no live pairing) costs a challenge on every
 * batch, because each refused unproven post forgets the verdict (postHostMode) — one request per batch
 * more than before the proof existed, until the backend with the proof is deployed and its host-auth
 * `forbidden` is backed off instead. The
 * challenge, the host-auth post and its body read share ONE `FETCH_TIMEOUT_MS` timer: nothing else
 * bounds a stalled challenge, and the batch waits on it. Concurrent `get`s share the proof in flight.
 */
export function createHostAuthCache(d: { apiBase: string; fetchImpl: typeof fetch; now: () => number }): HostAuthCache {
  // token undefined = the backend predates the proof (challenge 404/405, or no host-auth route).
  let cached: { key: string; token: string | undefined; at: number } | null = null
  let inflight: { key: string; result: Promise<string | undefined | 'drop'> } | null = null
  let failures = 0
  let retryAt = 0

  async function establish(id: PushHostIdentity, prove: PopProver): Promise<string | undefined | 'drop'> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const ch = await fetchPopChallenge({
        apiBase: d.apiBase,
        hostPublicKeyB64: id.hostPublicKeyB64,
        purpose: 'push',
        fetch: d.fetchImpl,
        signal: ctrl.signal
      })
      // Never unproven after a transient failure: a latched host's unproven send is refused.
      if (!ch.ok) return ch.unsupported ? undefined : 'drop'
      let popProof: string
      try {
        popProof = prove({
          challenge: ch.challenge,
          serverPublicKeyB64: ch.serverPublicKeyB64,
          purpose: 'push',
          subject: id.hostDeviceId
        })
      } catch {
        return 'drop' // a server key the proof cannot use (malformed, or low-order)
      }
      let res: Response
      try {
        res = await d.fetchImpl(`${d.apiBase}/v1/push/host-auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            hostDeviceId: id.hostDeviceId,
            hostPublicKeyB64: id.hostPublicKeyB64,
            popChallenge: ch.challenge,
            popProof
          }),
          signal: ctrl.signal
        })
      } catch {
        return 'drop'
      }
      if (res.status === 404) return undefined // a backend with the challenge but no session route
      if (!res.ok) return 'drop' // 403 forbidden (no live pairing) / pop_invalid, 429, 5xx
      const json = (await res.json().catch(() => null)) as { hostAuth?: unknown } | null
      if (!json || typeof json.hostAuth !== 'string' || !json.hostAuth) return 'drop'
      return json.hostAuth
    } finally {
      clearTimeout(timer)
    }
  }

  const keyOf = (id: PushHostIdentity): string => `${id.hostPublicKeyB64}\n${id.hostDeviceId}`
  // A NEGATIVE age is a wall clock that stepped back since the entry was cached, and is read as
  // expired: taken as fresh, a step back of an hour would serve the same session (or old-backend
  // verdict) for that hour plus the 10 minutes, past the server's 15-minute TTL.
  const onFile = (key: string): boolean => {
    if (!cached || cached.key !== key) return false
    const age = d.now() - cached.at
    return age >= 0 && age < HOST_AUTH_REPROVE_MS
  }

  return {
    invalidate() {
      cached = null
    },
    onFile(id) {
      return !!id.prove && onFile(keyOf(id))
    },
    async get(id) {
      if (!id.prove) return undefined
      const key = keyOf(id)
      if (cached && onFile(key)) return cached.token
      if (inflight && inflight.key === key) return inflight.result
      const now = d.now()
      if (now < retryAt && retryAt - now <= HOST_AUTH_RETRY_MAX_MS) return 'drop'
      // A proof that throws is a failure like any other: 'drop', through the backoff below. The
      // catch is on the SHARED promise, so a caller joining the proof in flight never sees a
      // rejection either (the timer-driven flush has nowhere to send one).
      const result = establish(id, id.prove).catch((): 'drop' => 'drop')
      inflight = { key, result }
      try {
        const r = await result
        if (r === 'drop') {
          failures++
          retryAt = d.now() + HOST_AUTH_RETRY_MS[Math.min(failures, HOST_AUTH_RETRY_MS.length) - 1]
        } else {
          failures = 0
          retryAt = 0
          cached = { key, token: r, at: d.now() }
        }
        return r
      } finally {
        if (inflight?.result === result) inflight = null
      }
    }
  }
}

/** Read a JSON body within `ms` (null past it, or on a body that is not JSON). A response body can
 *  stall after its headers, and `postJson`'s timer stops at the headers. */
async function jsonWithin(res: Response, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      res.json().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The host-mode post, shared by notify and live-update: attach the session when there is one (the
 * field only when it is a non-empty string), and forget it when the backend refuses it. The refusal
 * is read ONLY from a 403 to a post that carried a session: an unproven post's body is never
 * read — a 403 there (a latched host behind an old-backend verdict, or no live pairing) is judged by
 * its status alone, and forgets the verdict.
 *
 * An unproven post refused under a verdict that was already ON FILE (asked for in an earlier batch)
 * is the host having latched since, through another path: the standing host's proven mint, or the
 * other push stream. That batch proves at once and is re-posted ONCE, carrying the session, if the
 * proof comes back with one; otherwise it is dropped, as before. A verdict asked for in THIS batch is
 * not re-asked: the challenge answered moments ago, so asking again would add a request to every
 * batch of an old backend that refuses this host (403 forbidden, no live pairing) and change nothing.
 * The re-post is never re-posted.
 */
async function postHostMode(
  fetchImpl: typeof fetch,
  cache: HostAuthCache,
  url: string,
  host: PushHostIdentity,
  payload: Record<string, unknown>
): Promise<void> {
  const onFile = cache.onFile(host)
  const hostAuth = await cache.get(host)
  if (hostAuth === 'drop') return
  const body = {
    hostDeviceId: host.hostDeviceId,
    hostPublicKeyB64: host.hostPublicKeyB64,
    hostLabel: host.hostLabel,
    ...payload
  }
  const res = await postJson(fetchImpl, url, hostAuth ? { ...body, hostAuth } : body)
  if (!res || res.status !== 403 || !host.prove) return
  if (hostAuth) {
    if (popRefusalOf(403, await jsonWithin(res, FETCH_TIMEOUT_MS))) cache.invalidate()
    return
  }
  cache.invalidate()
  if (!onFile) return
  const proven = await cache.get(host)
  if (!proven || proven === 'drop') return
  const again = await postJson(fetchImpl, url, { ...body, hostAuth: proven })
  if (again?.status === 403 && popRefusalOf(403, await jsonWithin(again, FETCH_TIMEOUT_MS))) cache.invalidate()
}

export interface PushNotifyDeps {
  /** Subscribe to actionable inbox events. In production this is `onInboxActionable`. */
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** Granted mode (SSH-possession push grants; spec: 2026-07-21-push-grants). The batch is POSTed
   *  once PER grant with `Authorization: Bearer <grant>` (no host identity fields) — the Server
   *  Edition's only path, and the desktop's route to any phone that reaches it over plain SSH.
   *  Sent ALONGSIDE host mode when both are live, never instead of it: see `resolveSendTarget` for
   *  why the exclusion cannot be done per device here, and what that costs. */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
  /** The SSH host (`sshHostKey`, `user@host`) a node's project lives on, or undefined for a node on
   *  THIS machine. Drives the granted leg's per-host routing: an event goes only under the grants
   *  swept from its node's host (`PushGrant.host`), never under another host's — each grant is
   *  signed for one host's connectionId, the scope the phone's per-host mute is keyed by (issue
   *  #435). Absent (the Server Edition) ⇒ every node is local and every grant is local: the legacy
   *  fan-out. In production this is `workspaceStore.sshProjectIdForNode` → the project's host key. */
  grantHostFor?: (nodeId: string) => string | undefined
  /** `os.hostname()`, passed in to keep core pure — the granted-mode `hostLabel` (a granted send
   *  carries no host identity, so this is the only host label the backend sees). */
  hostLabel?: () => string
  /** The `settings.mobilePushEnabled` gate (default on) — the master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobilePushNeedsYou` sub-gate (default on): approval + question kinds. */
  mobilePushNeedsYou: () => boolean
  /** The `settings.mobilePushDone` sub-gate (default on): the done kind. */
  mobilePushDone: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title (canvas/sidebar name) for the push `nodeTitle`. In
   *  production this is `workspaceStore.getNodeTitle`. Optional / may return undefined — the field
   *  is then simply omitted from the payload. */
  getNodeTitle?: (nodeId: string) => string | undefined
  /** Presence-aware alert deferral (owner UX call): pushing an ALERT to the phone while the user is
   *  actively at the desktop is noise; when they go idle/lock it's exactly right. When this returns
   *  true at send time, the batched event goes to an in-memory HOLD queue instead of POSTing. Absent
   *  (or always-false, the Server Edition's headless case) ⇒ every event sends immediately, i.e.
   *  exact legacy behavior. Alerts only — the live-update stream (createLiveUpdatePush) is ambient
   *  and never deferred. */
  isUserPresent?: () => boolean
  /** Poke on the present→away transition to flush the hold queue. In production the desktop shell
   *  detects the edge (powerMonitor idle poll + lock-screen) and fires `cb`. Returns an unsubscribe.
   *  Paired with `isUserPresent`; absent ⇒ nothing is ever held so nothing needs flushing. */
  subscribePresence?: (cb: () => void) => () => void
  /** On the away-flush, drop a held event that got resolved in the mirror while it waited (an
   *  approval/question the node has since left, or a `done` the desktop user already read). In
   *  production this is `agent-status-mirror.isEventUnresolved`. Absent ⇒ all held events flush
   *  unfiltered. */
  isEventUnresolved?: (nodeId: string, eventId: string) => boolean
  /** Override base URL. Defaults to `env.NODETERM_API_BASE || 'https://api.nodeterm.dev'`. */
  apiBase?: string
  /** Injectable env (DNT guards + local-dev base). Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Injectable fetch (tests mock it). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  batchWindowMs?: number
  throttleMs?: number
}

export interface PushNotifyHandle {
  /** Unsubscribe + cancel any pending flush. */
  stop(): void
  /** Test-only: force any buffered events to POST now. */
  _flushNow(): Promise<void>
}

/**
 * Wire the push-notify service. Subscribes to actionable inbox events, gates them (setting off /
 * no relay host / no paired phone / DNT / unpackaged all make it inert), throttles per node, and
 * batches the survivors into `POST {apiBase}/v1/push/notify`. Drops on any network error — there is
 * NO retry queue in v1. Everything is injected, so this is pure + unit-testable.
 */
export function createPushNotify(deps: PushNotifyDeps): PushNotifyHandle {
  const env = deps.env ?? process.env
  const apiBase = deps.apiBase ?? env.NODETERM_API_BASE ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const batchWindowMs = deps.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS

  // This sender's own hostAuth session (the host-mode proof of possession, above).
  const hostAuthCache = createHostAuthCache({ apiBase, fetchImpl, now })

  const buffer: PushNotifyEvent[] = []
  // Presence-aware hold queue: while the user is present, accepted alerts wait here (with the mirror
  // event id, so the away-flush can drop any that got resolved meanwhile). Bounded, oldest-dropped.
  const held: { event: PushNotifyEvent; nodeId: string; eventId: string }[] = []
  const lastPushAt = new Map<string, number>()
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  // Same build + DO_NOT_TRACK gate as check.ts: dev never hits the prod API unless a local server
  // is targeted explicitly.
  function allowed(): boolean {
    if (env.DO_NOT_TRACK || env.NODETERM_TELEMETRY_DISABLED) return false
    if (!deps.isPackaged() && !env.NODETERM_API_BASE) return false
    return true
  }

  /** Resolve where a batch goes. The master + DNT/packaged gates are this sender's; the rule for
   *  WHO gets it is the shared `resolveSendTarget` (both senders call it, so they cannot drift). */
  function resolveTarget(): SendTarget | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    return resolveSendTarget(
      () => deps.getHostIdentity(),
      deps.getGrants ? () => deps.getGrants!() : undefined
    )
  }

  function scheduleFlush(): void {
    if (batchTimer) return
    batchTimer = setTimeout(() => {
      batchTimer = null
      void flush()
    }, batchWindowMs)
    batchTimer.unref?.()
  }

  /** Per-kind sub-gate: "Needs you" covers approval + question, "Completed" covers done. Both
   *  default on; the master `mobilePushEnabled` still wins (checked via liveIdentity). When both
   *  sub-gates are off the service sends nothing — the master toggle stays honest. */
  function kindAllowed(kind: InboxEvent['kind']): boolean {
    if (kind === 'done') return deps.mobilePushDone()
    // approval | question
    return deps.mobilePushNeedsYou()
  }

  function onEvent(e: InboxEvent): void {
    // Cheap gate first: if the service is inert, don't buffer anything.
    if (!resolveTarget()) return
    // Per-kind selection: drop before the throttle window is consumed, so a declined kind
    // never blocks a later accepted one on the same node.
    if (!kindAllowed(e.kind)) return
    const t = now()
    // Per-node throttle: at most one push per node per `throttleMs` (mirrors the local notify
    // throttle). Recorded at accept time — a declined event costs no throttle window.
    if (t - (lastPushAt.get(e.nodeId) ?? -Infinity) < throttleMs) return
    lastPushAt.set(e.nodeId, t)
    // Resolve the node's display title (fail-open: a throwing/absent accessor omits the field).
    let nodeTitle: string | undefined
    try {
      nodeTitle = deps.getNodeTitle?.(e.nodeId)?.slice(0, NODE_TITLE_MAX) || undefined
    } catch {
      nodeTitle = undefined
    }
    const payload: PushNotifyEvent = {
      kind: e.kind,
      title: e.title,
      ...(e.detail ? { detail: e.detail } : {}),
      nodeId: e.nodeId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(nodeTitle ? { nodeTitle } : {}),
      ...(e.options && e.options.length > 0 ? { options: e.options } : {}),
      ...(e.multiSelect ? { multiSelect: true } : {}),
      // Unix MILLISECONDS (TS_UNIT): the mirror's InboxEvent.ts (Date.now()), forwarded verbatim.
      ts: e.ts
    }
    // Presence-aware deferral: if the user is at the desktop right now, hold the alert instead of
    // POSTing it — the present→away flush (subscribePresence) sends the survivors later. Carry the
    // mirror event id so that flush can drop any that got resolved while held. Bounded/oldest-dropped.
    if (deps.isUserPresent?.()) {
      held.push({ event: payload, nodeId: e.nodeId, eventId: e.id })
      if (held.length > HELD_QUEUE_MAX) held.splice(0, held.length - HELD_QUEUE_MAX)
      return
    }
    buffer.push(payload)
    scheduleFlush()
  }

  /** Present→away edge: move held alerts still RELEVANT (unresolved in the mirror) into the send
   *  buffer and flush; drop the rest (answered approval/question, read `done`). No-op when nothing
   *  is held. */
  function flushHeldOnAway(): void {
    if (held.length === 0) return
    const items = held.splice(0, held.length)
    for (const it of items) {
      if (deps.isEventUnresolved && !deps.isEventUnresolved(it.nodeId, it.eventId)) continue
      buffer.push(it.event)
    }
    if (buffer.length > 0) scheduleFlush()
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    // Re-check the gate at flush: identity/grants/setting can change during the batch window.
    const target = resolveTarget()
    if (!target) {
      buffer.length = 0
      return
    }
    const events = buffer.splice(0, MAX_EVENTS_PER_CALL)
    // More than one call's worth accumulated in the window — send the rest right after.
    if (buffer.length > 0) scheduleFlush()

    const url = `${apiBase}/v1/push/notify`
    if (target.host) {
      // Relay-identity body — byte-identical to the pre-grants shape when no prover is set, and
      // carrying `hostAuth` once the host has proven possession of its key.
      await postHostMode(fetchImpl, hostAuthCache, url, target.host, { events })
    }
    // …and the grants, in the SAME flush (see resolveSendTarget: a paired phone must not silence
    // the SSH-only ones). PER HOST: each event goes only under the grants swept from the host its
    // node lives on — a grant is signed for that one host's connectionId, which is what the phone's
    // per-host mute is keyed by (issue #435). One POST per live grant, Bearer-authorized, NO host
    // identity fields — just `hostLabel` (os.hostname(), injected). A 401/403 marks that grant dead.
    const label = deps.hostLabel?.()
    for (const [host, group] of groupByGrantHost(events, deps.grantHostFor)) {
      for (const g of grantsFor(target.grants, host)) {
        const res = await postJson(
          fetchImpl,
          url,
          { ...(label ? { hostLabel: label } : {}), events: group },
          g.grant
        )
        if (res && (res.status === 401 || res.status === 403)) deps.markGrantDead?.(g.grant)
      }
    }
  }

  const unsubscribe = deps.subscribe(onEvent)
  const unsubPresence = deps.subscribePresence?.(flushHeldOnAway)

  return {
    stop() {
      unsubscribe()
      unsubPresence?.()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      buffer.length = 0
      held.length = 0
    },
    _flushNow: flush
  }
}

// ---- Live-update stream (spec: interactive-push-live-activities) ----------------------------
// A second, chattier stream to `POST {apiBase}/v1/push/live-update`, feeding iOS Live Activities.
// Two sources from the mirror:
//   - STATE EDGES (`onNodeStateChange`): working start → event 'start', edge into waiting/blocked →
//     event 'update' state 'needsYou', edge into done → event 'end'. Sent IMMEDIATELY (short batch
//     window only, to coalesce simultaneous edges into one POST + honor the ≤20 cap).
//   - NOW CHANGES (`onNodeNowChange`): activity line / context% ticks, COALESCED to ≥20s per node
//     (event 'update', state 'working' — activity only moves while a turn runs).
// Same host-identity auth + DNT/packaged/paired-phone guards as notify, plus its own
// `mobileLiveActivities` sub-gate (both under the `mobilePushEnabled` master).

// Batch window for POSTing accumulated updates — short, so a state edge goes out "immediately".
const DEFAULT_LIVE_BATCH_WINDOW_MS = 1000
// Coalesce activity/context ticks to at most one live-update per node per this window.
const DEFAULT_LIVE_COALESCE_MS = 20_000
// Backend contract cap: updates[≤20] per call.
const MAX_UPDATES_PER_CALL = 20
// Live-activity field caps (Apple content-state stays small).
const LIVE_ACTIVITY_MAX = 80
const LIVE_MESSAGE_MAX = 120
// The `You: …` line. Same cap the mirror already applied — clipped again here because the field
// crosses a process/network boundary and the backend caps independently.
const LIVE_PROMPT_MAX = 120

/** One entry of the `/v1/push/live-update` `updates[]` array (backend contract). */
export interface LiveUpdateItem {
  nodeId: string
  nodeTitle?: string
  agentId?: string
  event: 'start' | 'update' | 'end'
  state: 'working' | 'needsYou' | 'done'
  activity?: string
  contextPercent?: number
  message?: string
  /** working START edge only: the first line of the user prompt that opened the turn — rendered as
   *  `You: …`, the same line the notch capsule shows. Omitted on every other event. */
  prompt?: string
  /** needsYou only (spec: interactive-push-live-activities addendum): 'approval' | 'question'.
   *  Omitted otherwise — the backend also forces null on non-needsYou content-state. */
  kind?: 'approval' | 'question'
  /** question needsYou only: the AskUserQuestion choices (≤4 × ≤60), for Live Activity buttons. */
  options?: string[]
  /** question needsYou only: the AskUserQuestion `multiSelect` flag. Omitted when absent/false. */
  multiSelect?: boolean
  /** approval needsYou only: the deterministic hook-reply ticket, letting an intent answer. */
  pendingId?: string
  /** done only: the turn ended because the user INTERRUPTED it (Esc/Ctrl-C), not because it
   *  finished. Omitted when false/absent, and never sent off a done edge — the backend also forces
   *  it null on non-done content-state. Without it the phone had only the `message` STRING
   *  ('Stopped' vs 'Finished') to tell the two apart, so a wording change silently altered
   *  behaviour. A consumer that CELEBRATES a completion must skip this (same rule as the notch
   *  HUD's `doneSeen`) — nothing was accomplished, so there is nothing to go and read. */
  interrupted?: boolean
  /** done only: this end came from the stale-working SWEEP (nobody heard from the session for
   *  WORKING_STALE_MS, so it is presumed gone), NOT from the session itself. Same omission rules and
   *  the same "never celebrate it" contract as `interrupted` — but a DIFFERENT fact: `interrupted`
   *  is "you stopped it", `stale` is "we lost the host". The mirror sends message:'Stopped' for
   *  both, which is exactly why the phone cannot infer this from the text. */
  stale?: boolean
  /** true on a state EDGE (start / needsYou / end, and the working update that follows an answered
   *  needs-you) — a user-visible state change. Absent on the ≥20s activity/context coalesced ticks.
   *  The backend uses it for APNs priority: an edge is priority 10, a tick priority 5 (iOS delays
   *  priority-5 liveactivity pushes, which was leaving the island up minutes after an answer). */
  edge?: boolean
  /** Unix **MILLISECONDS** (`TS_UNIT`) — the mirror's `Date.now()`, forwarded verbatim. This is the
   *  field the iOS Live Activity reads as `ContentState.ts`; it is ms on both producers (the push
   *  below and the phone's own foreground poll), so it is compared, never mixed with seconds. */
  ts: number
}

export interface LiveUpdateDeps {
  /** Subscribe to main-state edges. In production this is `onNodeStateChange`. */
  subscribeStateChange: (cb: (c: NodeStateChange) => void) => () => void
  /** Subscribe to per-node activity/context changes. In production this is `onNodeNowChange`. */
  subscribeNowChange: (cb: (c: NodeNowChange) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** Granted mode (SSH-possession push grants; spec: 2026-07-21-push-grants). See the identical
   *  field on `PushNotifyDeps`: one POST per grant, Bearer-authorized, no host fields, sent
   *  ALONGSIDE host mode when both are live (`resolveSendTarget`). */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
  /** See the identical field on `PushNotifyDeps`: the node → SSH host resolver behind the granted
   *  leg's per-host routing. Absent ⇒ every node and every grant is local. */
  grantHostFor?: (nodeId: string) => string | undefined
  /** `os.hostname()`, passed in to keep core pure — the granted-mode `hostLabel`. */
  hostLabel?: () => string
  /** The `settings.mobilePushEnabled` master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobileLiveActivities` sub-gate (default on). */
  mobileLiveActivities: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title. In production this is `workspaceStore.getNodeTitle`. */
  getNodeTitle?: (nodeId: string) => string | undefined
  apiBase?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  batchWindowMs?: number
  coalesceMs?: number
}

export interface LiveUpdateHandle {
  stop(): void
  _flushNow(): Promise<void>
}

/**
 * Wire the live-update push stream. State edges post immediately (within a short batch window);
 * activity/context ticks coalesce to ≥20s per node. Gated by the master switch, the
 * `mobileLiveActivities` sub-gate, and the same DNT/packaged/identity/paired-phone guards as
 * notify. Everything is injected — pure + unit-testable. Drops on any network error (no retry).
 */
export function createLiveUpdatePush(deps: LiveUpdateDeps): LiveUpdateHandle {
  const env = deps.env ?? process.env
  const apiBase = deps.apiBase ?? env.NODETERM_API_BASE ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const batchWindowMs = deps.batchWindowMs ?? DEFAULT_LIVE_BATCH_WINDOW_MS
  const coalesceMs = deps.coalesceMs ?? DEFAULT_LIVE_COALESCE_MS

  // Its own hostAuth session, independent of notify's (each re-proves at most every 10 minutes).
  const hostAuthCache = createHostAuthCache({ apiBase, fetchImpl, now })

  const buffer: LiveUpdateItem[] = []
  // Per-node coalescing of activity/context ticks.
  const lastNowSentAt = new Map<string, number>()
  const pendingNow = new Map<string, NodeNowChange>()
  /**
   * The last STATE we told the phone about, per node. A now-tick carries no state of its own
   * (`NodeNowChange` has none — the notch HUD, the other consumer of that seam, correctly never
   * reads one), yet it has to send something, and it used to hardcode `working`. Two producers
   * fire a tick at exactly the wrong moment — the raw `Stop` hook clears the activity, and the
   * context tail's 1 s poll lands the turn's final usage record — so a tick would be parked for up
   * to `coalesceMs` and then assert "working" AFTER the end had already gone out, flipping the
   * island back to Working with nothing left to end it.
   *
   * So ticks are now told what the node's state actually is, and are dropped entirely once it is
   * no longer working. Undefined = we have not seen an edge for this node yet; a tick then still
   * goes out as working, which is the pre-existing behaviour for a node whose activity we learn
   * about before its first edge.
   */
  const lastStateSent = new Map<string, NodeStateChange['state']>()
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null

  function allowed(): boolean {
    if (env.DO_NOT_TRACK || env.NODETERM_TELEMETRY_DISABLED) return false
    if (!deps.isPackaged() && !env.NODETERM_API_BASE) return false
    return true
  }

  /** This sender's own gates (master + live-activities sub-gate + DNT/packaged), then the SHARED
   *  targeting rule — the same one `createPushNotify` uses, so the two cannot drift apart. */
  function resolveTarget(): SendTarget | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    if (!deps.mobileLiveActivities()) return null
    return resolveSendTarget(
      () => deps.getHostIdentity(),
      deps.getGrants ? () => deps.getGrants!() : undefined
    )
  }

  function nodeTitleOf(nodeId: string): string | undefined {
    try {
      return deps.getNodeTitle?.(nodeId)?.slice(0, NODE_TITLE_MAX) || undefined
    } catch {
      return undefined
    }
  }

  function scheduleFlush(): void {
    if (batchTimer) return
    batchTimer = setTimeout(() => {
      batchTimer = null
      void flush()
    }, batchWindowMs)
    batchTimer.unref?.()
  }

  function onStateChange(c: NodeStateChange): void {
    if (!resolveTarget()) return
    // This edge is newer than anything coalescing for the node, and a tick asserts `working` —
    // so a parked one must never be allowed to land after it and undo it. Drop it and record the
    // state, which also gates any tick that arrives later in the same turn (see lastStateSent).
    lastStateSent.set(c.nodeId, c.state)
    pendingNow.delete(c.nodeId)
    const title = nodeTitleOf(c.nodeId)
    // kind/options/multiSelect/pendingId ride only a needsYou edge (spec:
    // interactive-push-live-activities addendum) — belt-and-braces gate on state so a working/done
    // edge never carries them (the backend also nulls them on non-needsYou content-state).
    const needsYou = c.state === 'needsYou'
    // interrupted/stale are the WHY of an end edge, and they ride done edges only — same
    // belt-and-braces gate as the needsYou block above (the backend nulls them off done too).
    // They are forwarded because 'Stopped' is the mirror's message for BOTH the interrupt and the
    // stale sweep: without these flags the phone cannot tell "you stopped it" from "we lost the
    // host", and both are indistinguishable from a real completion except by that string.
    const done = c.state === 'done'
    buffer.push({
      nodeId: c.nodeId,
      ...(title ? { nodeTitle: title } : {}),
      ...(c.agentId ? { agentId: c.agentId } : {}),
      event: c.event,
      state: c.state,
      // Every onStateChange push IS a state edge (start / needsYou / end, and the working update
      // that follows an answered needs-you) — mark it so the backend can prioritize it (10 vs the
      // ticks' 5). The now-tick sender (emitNow) deliberately omits this.
      edge: true,
      ...(c.message ? { message: c.message.slice(0, LIVE_MESSAGE_MAX) } : {}),
      // The prompt rides the working start edge only (the mirror sets it there), so a needs-you or
      // an end never carries a stale "You:" line.
      ...(c.state === 'working' && c.prompt ? { prompt: c.prompt.slice(0, LIVE_PROMPT_MAX) } : {}),
      ...(needsYou && c.kind ? { kind: c.kind } : {}),
      ...(needsYou && c.options && c.options.length > 0 ? { options: c.options } : {}),
      ...(needsYou && c.multiSelect ? { multiSelect: true } : {}),
      ...(needsYou && c.pendingId ? { pendingId: c.pendingId } : {}),
      ...(done && c.interrupted ? { interrupted: true } : {}),
      ...(done && c.stale ? { stale: true } : {}),
      // Unix MILLISECONDS (TS_UNIT): the mirror's NodeStateChange.ts (Date.now()), forwarded
      // verbatim. This lands in the phone's Live Activity ContentState.ts — do not scale it.
      ts: c.ts
    })
    scheduleFlush()
  }

  /** Push a coalesced now-update for a node into the buffer. */
  function emitNow(c: NodeNowChange): void {
    const title = nodeTitleOf(c.nodeId)
    buffer.push({
      nodeId: c.nodeId,
      ...(title ? { nodeTitle: title } : {}),
      event: 'update',
      state: 'working',
      ...(c.activity ? { activity: c.activity.slice(0, LIVE_ACTIVITY_MAX) } : {}),
      ...(typeof c.contextPercent === 'number' ? { contextPercent: c.contextPercent } : {}),
      // Unix MILLISECONDS (TS_UNIT): the mirror's NodeNowChange.ts (Date.now()), forwarded
      // verbatim — the same field, same unit, as the state-edge sender above.
      ts: c.ts
    })
    scheduleFlush()
  }

  function scheduleCoalesceTimer(): void {
    if (coalesceTimer || pendingNow.size === 0) return
    // Fire at the soonest node's window edge.
    const t = now()
    let soonest = Infinity
    for (const nodeId of pendingNow.keys()) {
      const due = (lastNowSentAt.get(nodeId) ?? 0) + coalesceMs
      if (due < soonest) soonest = due
    }
    const delay = Math.max(0, soonest - t)
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null
      const cur = now()
      for (const [nodeId, change] of [...pendingNow]) {
        if (cur - (lastNowSentAt.get(nodeId) ?? -Infinity) >= coalesceMs) {
          pendingNow.delete(nodeId)
          lastNowSentAt.set(nodeId, cur)
          emitNow(change)
        }
      }
      scheduleCoalesceTimer()
    }, delay)
    coalesceTimer.unref?.()
  }

  function onNowChange(c: NodeNowChange): void {
    if (!resolveTarget()) return
    // A tick describes work in progress. Once the node has left `working` (needs-you, or an end)
    // there is nothing for it to say, and saying `working` would contradict the edge we just sent.
    if ((lastStateSent.get(c.nodeId) ?? 'working') !== 'working') {
      pendingNow.delete(c.nodeId)
      return
    }
    const t = now()
    const last = lastNowSentAt.get(c.nodeId) ?? -Infinity
    if (t - last >= coalesceMs) {
      // Leading edge: send now.
      lastNowSentAt.set(c.nodeId, t)
      pendingNow.delete(c.nodeId)
      emitNow(c)
    } else {
      // Within the window: keep only the latest, flush at the window edge.
      pendingNow.set(c.nodeId, c)
      scheduleCoalesceTimer()
    }
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    const target = resolveTarget()
    if (!target) {
      buffer.length = 0
      return
    }
    const updates = buffer.splice(0, MAX_UPDATES_PER_CALL)
    if (buffer.length > 0) scheduleFlush()

    const url = `${apiBase}/v1/push/live-update`
    if (target.host) {
      // Relay-identity body — byte-identical to the pre-grants shape when no prover is set, and
      // carrying `hostAuth` once the host has proven possession of its key.
      await postHostMode(fetchImpl, hostAuthCache, url, target.host, { updates })
    }
    // …and the grants, in the SAME flush (see resolveSendTarget), PER HOST exactly like notify:
    // an update goes only under the grants swept from its node's host. One POST per live grant,
    // Bearer-authorized, NO host identity fields.
    const label = deps.hostLabel?.()
    for (const [host, group] of groupByGrantHost(updates, deps.grantHostFor)) {
      for (const g of grantsFor(target.grants, host)) {
        const res = await postJson(
          fetchImpl,
          url,
          { ...(label ? { hostLabel: label } : {}), updates: group },
          g.grant
        )
        if (res && (res.status === 401 || res.status === 403)) deps.markGrantDead?.(g.grant)
      }
    }
  }

  const unsubState = deps.subscribeStateChange(onStateChange)
  const unsubNow = deps.subscribeNowChange(onNowChange)

  return {
    stop() {
      unsubState()
      unsubNow()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (coalesceTimer) {
        clearTimeout(coalesceTimer)
        coalesceTimer = null
      }
      buffer.length = 0
      pendingNow.clear()
    },
    _flushNow: flush
  }
}
