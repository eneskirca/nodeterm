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
  ts: number
}

/** Where a batch is sent: the relay host (legacy) or, in granted mode, a list of grants to
 *  fan the same body out over (once each, Bearer-authorized). */
type SendTarget =
  | { mode: 'host'; id: PushHostIdentity }
  | { mode: 'grants'; grants: PushGrant[] }

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

export interface PushNotifyDeps {
  /** Subscribe to actionable inbox events. In production this is `onInboxActionable`. */
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** Granted mode (SSH-possession push grants; spec: 2026-07-21-push-grants). When there is no
   *  usable relay host identity but grants exist, the batch is POSTed once PER grant with
   *  `Authorization: Bearer <grant>` (no host identity fields) — the Server Edition's path. Optional:
   *  the desktop leaves it unwired (it uses its relay identity; a host that is both paired AND
   *  granted would double-push the same phone). */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
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

  /** Resolve where a batch goes: the relay host (byte-identical legacy behavior) when a paired host
   *  identity is available; else, in granted mode, the live grant list; else null (inert). The
   *  master + DNT/packaged gates apply to both modes; the paired-phone gate is host-mode only (a
   *  grant IS the phone's opt-in). */
  function resolveTarget(): SendTarget | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    const id = deps.getHostIdentity()
    if (id && id.hasPairedPhone) return { mode: 'host', id }
    const grants = deps.getGrants?.() ?? []
    if (grants.length > 0) return { mode: 'grants', grants }
    return null
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
    if (target.mode === 'host') {
      // Legacy relay-identity body — byte-identical to the pre-grants shape.
      await postJson(fetchImpl, url, {
        hostDeviceId: target.id.hostDeviceId,
        hostPublicKeyB64: target.id.hostPublicKeyB64,
        hostLabel: target.id.hostLabel,
        events
      })
      return
    }
    // Granted mode: one POST per live grant, Bearer-authorized, NO host identity fields —
    // just `hostLabel` (os.hostname(), injected). A 401/403 marks that grant dead.
    const label = deps.hostLabel?.()
    for (const g of target.grants) {
      const res = await postJson(
        fetchImpl,
        url,
        { ...(label ? { hostLabel: label } : {}), events },
        g.grant
      )
      if (res && (res.status === 401 || res.status === 403)) deps.markGrantDead?.(g.grant)
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
  /** true on a state EDGE (start / needsYou / end, and the working update that follows an answered
   *  needs-you) — a user-visible state change. Absent on the ≥20s activity/context coalesced ticks.
   *  The backend uses it for APNs priority: an edge is priority 10, a tick priority 5 (iOS delays
   *  priority-5 liveactivity pushes, which was leaving the island up minutes after an answer). */
  edge?: boolean
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
   *  field on `PushNotifyDeps`: no usable host identity + grants present ⇒ one POST per grant,
   *  Bearer-authorized, no host fields. Desktop leaves it unwired. */
  getGrants?: () => PushGrant[]
  /** Mark a grant dead after a 401/403 (dropped until its file changes). Paired with `getGrants`. */
  markGrantDead?: (grant: string) => void
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

  function resolveTarget(): SendTarget | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    if (!deps.mobileLiveActivities()) return null
    const id = deps.getHostIdentity()
    if (id && id.hasPairedPhone) return { mode: 'host', id }
    const grants = deps.getGrants?.() ?? []
    if (grants.length > 0) return { mode: 'grants', grants }
    return null
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
    if (target.mode === 'host') {
      // Legacy relay-identity body — byte-identical to the pre-grants shape.
      await postJson(fetchImpl, url, {
        hostDeviceId: target.id.hostDeviceId,
        hostPublicKeyB64: target.id.hostPublicKeyB64,
        hostLabel: target.id.hostLabel,
        updates
      })
      return
    }
    // Granted mode: one POST per live grant, Bearer-authorized, NO host identity fields.
    const label = deps.hostLabel?.()
    for (const g of target.grants) {
      const res = await postJson(
        fetchImpl,
        url,
        { ...(label ? { hostLabel: label } : {}), updates },
        g.grant
      )
      if (res && (res.status === 401 || res.status === 403)) deps.markGrantDead?.(g.grant)
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
