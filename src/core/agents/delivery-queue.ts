import type { AgentMessageOutcome } from './agent-message-decide'
import { RETRYABLE } from './agent-message-decide'
import type { DeliveryTraceInput } from './agent-message-trace'
import type { DurableFactSpec } from '../durable-state'
import { isSafeNodeId } from '../../shared/safe-id'

/**
 * DELIVER-ON-IDLE — a bounded, per-target queue with a TTL, and never a silent drop.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * Gate 2 refuses a BUSY target (`targetBusy`) and a target between sessions
 * (`targetNotIdleUnknown`), and Eco hibernation leaves an idle node's pane on a SHELL — so
 * `targetNotAgentPane` refuses it *forever* on exactly the nodes an orchestration is most likely to
 * message (the ones sitting idle). "Retry in a moment" pushes that onto a language model with a rate
 * limiter in front of it: a busy-loop that burns tokens. Wake-then-deliver is therefore not a
 * nicety — it is what makes messaging usable across a long-running canvas.
 *
 * So a `targetBusy` / hibernated target with queueing on is ENQUEUED, and delivered when the target
 * next goes idle. `queued` is NOT `delivered`: the bytes have not reached the pane, and the receipt
 * (Task 3.4) is what will close the loop once they do. A queue full stops the sender loudly
 * (`queueFull`), and a message that waits out its TTL EXPIRES loudly — to the trace and to the
 * sender — because a silent drop is the one outcome a security core may never have.
 *
 * ── THE DECSET-2004 MEASUREMENT MADE THIS SAFE (2026-08-15, this host) ───────────────────────────
 *
 * Deliver-on-idle only works if a queued message can be framed into the target's pane WITHOUT a
 * per-delivery bracketed-paste probe. Measured: all four agent CLIs (claude, codex, gemini,
 * opencode) keep DECSET 2004 ON at idle AND during startup, twice each, no flapping — so
 * `paste-buffer -p` frames every flush, including one into a still-starting agent after a wake. The
 * ONE unsafe surface is a NON-agent pane (a plain REPL/terminal): 2004 OFF ⇒ the payload lands as
 * raw keystrokes, one submit per newline. This queue therefore gates on NODE TYPE, not on a runtime
 * probe: it only ever enqueues for a target whose delivery attempt refused as `targetBusy` /
 * `hibernated` — i.e. a pane gate 1 already judged an AGENT pane — and the flush re-runs the whole
 * delivery (gate 1 included), so a pane that became a terminal while queued is refused, never
 * sprayed with unframed lines.
 *
 * ── FLUSH-TIME RE-VALIDATION IS THE LOAD-BEARING PROPERTY ───────────────────────────────────────
 *
 * A message queued for a busy agent must NOT trust the decision that queued it. Ownership can change
 * (the pane is respawned by another project), the grant can be revoked (the switch turned off, the
 * clone notice declined), the flow budget can move — all while the message waits. So the flush does
 * not cache anything: it calls `deps.deliver(req)` again, which is the SAME end-to-end path the verb
 * took (scope → ownership → grant → flow → `deliverAgentMessage`). A grant revoked while queued
 * therefore comes back `notPermitted` at flush and the message is DROPPED, never delivered — pinned
 * by `delivery-queue.test.ts`, which flips the injected `deliver` from `targetBusy` to
 * `notPermitted` between enqueue and flush and asserts nothing reached the pane.
 *
 * ── DURABLE ACROSS A RESTART (`snapshot` / `restore`, `QUEUE_FACT`) ─────────────────────────────
 *
 * The queue used to be process memory, so a `send` answered `queued` vanished on an app restart
 * while its sender believed it would be delivered. Every change is now mirrored (the `persist` dep)
 * to `<userData>/orchestration-state/delivery-queue.json`, and a shell restores it at boot, AFTER
 * wiring every listener (`onQueued` is replayed for each restored entry, so the station-outcome
 * store's "work pending" count is rebuilt from the queue rather than persisted twice). What a
 * restart means for an entry, decided here:
 *
 *  - **Its TTL keeps running while the app is down.** The deadline is wall-clock (`enqueuedAt` +
 *    `ttlMs`), not "5 minutes of uptime". An entry whose deadline passed while the app was down is
 *    EXPIRED at restore — traced `expired` and the sender told through `onExpired`, exactly like an
 *    expiry in-run — never delivered late and never dropped in silence.
 *  - **It is typed only into the SAME session it was queued for.** At enqueue the target's agent
 *    and session id are recorded (`bindingOf`, the status mirror). A RESTORED entry flushes only if
 *    the target's current session and agent are the recorded ones; a different session (the pane
 *    was respawned, `/clear`, another agent now runs there) ends it as `targetGone` — the session it
 *    was addressed to is gone — and the sender is told. An entry with no recorded session is refused
 *    the same way (nothing proves it is the same conversation); a target whose session is not known
 *    YET waits (the flush trigger is a hook event, which names it). In-run entries are unchanged.
 *  - **The whole gate chain still runs at flush**, as it always did (scope, pane ownership, grant,
 *    flow). Note what that means after a restart where tmux survived: pane ownership is recorded
 *    only on a fresh spawn (pane-ownership.ts), so the surviving pane is UNPROVEN and the flush is
 *    refused `notPermitted` — the sender is told, which is still strictly better than the silent
 *    loss it replaces. After a machine reboot the cold-restored pane IS a fresh spawn, so a message
 *    for a session that resumed under its old id is delivered.
 *  - **Two kinds never flush after a restart**: a board comment (only the local user, typing in THIS
 *    app, may trigger one — a message read back off disk must not be able to speak as a person) and
 *    an app-composed station notice (its monitor's state did not survive). Both, and an entry whose
 *    body was too large to store (`QUEUE_PERSIST_BODY_MAX`), are expired at restore so their row /
 *    sender still hears the end.
 *  - Not flushed at boot: the first flush waits for the target's next `done`, like any entry. A
 *    target that stays idle through the rest of the TTL expires it (sender told).
 *  - A crash inside the save window loses that window; a clean quit flushes synchronously. The file
 *    is hand-editable, so every entry is re-checked on read (`sanitizePersistedQueueEntry`). It holds
 *    message bodies, so it is written 0600 under userData and never leaves the machine.
 *
 * ── SHIPS ON BOTH SHELLS, USED ON ONE ──────────────────────────────────────────────────────────
 *
 * Pure `src/core`: no electron, no main import (`no-electron.test.ts`). Every side effect — the
 * clock, the delivery, the wake, the trace, the sender-notify, the timer — is injected, so the whole
 * lifecycle is driven without a pty or a window. The desktop is the only shell that wires a consumer
 * (messaging does not exist on the Server Edition, Task 5.3); the module still compiles and ships
 * there, like everything else in this directory.
 */

/** How long a message waits queued before it expires. Long enough for an orchestration turn (which
 *  can run minutes), bounded so a target that never goes idle cannot pin a message forever. */
export const DELIVERY_QUEUE_TTL_MS = 5 * 60_000

/** How many messages one target may have queued at once. Small and per-target: an unbounded queue
 *  is a memory-DoS surface, and refusing at the bound (rather than dropping the oldest) keeps FIFO
 *  fairness and tells the sender loudly instead of silently discarding a message already accepted. */
export const DELIVERY_QUEUE_CAPACITY = 16

/** The request the queue carries — opaque to the queue, handed straight back to `deps.deliver`. The
 *  queue keys everything on `targetNodeId` (the flush trigger and the per-target bound) and
 *  `sourceNodeId` (so an expiry can name who to tell); the rest travels untouched. */
export interface QueuedDeliveryRequest {
  sourceNodeId: string
  targetNodeId: string
  sourceTitle: string
  /** For the expiry trace's `bodyChars` — the body itself is never traced (see agent-message-trace). */
  body: string
  [k: string]: unknown
}

/** Cancels a scheduled timer. Returned by `schedule`. */
export type CancelTimer = () => void

export interface DeliveryQueueDeps {
  now(): number
  /**
   * The FULL, re-validated delivery — in production `deliverFromControl`. Called on every flush, so
   * the whole gate chain (scope, ownership, grant, flow, `deliverAgentMessage`) runs again against
   * live state. This is what makes the queue safe: it caches no authorization decision.
   */
  deliver(req: QueuedDeliveryRequest): Promise<AgentMessageOutcome>
  /** Record an outcome (`recordDelivery`). The queue traces `queued` on enqueue and `expired` on a
   *  TTL lapse; the flush's own outcomes are traced inside `deliver`. `req` is the queued request
   *  itself, so a shell can route the line by what the request carries (a board comment's board). */
  trace(input: DeliveryTraceInput, req?: QueuedDeliveryRequest): Promise<{ traceId: string; traced: string }>
  /**
   * Wake a hibernated target through the existing registry (`agent-restart.ts` hibernate/wake
   * pair). Optional: a target that is merely busy (not hibernated) needs no wake, and a shell with
   * no registry (the Server Edition) wires nothing. A wake is fire-and-forget here — the target's
   * eventual idle event is what triggers the flush, not this call's resolution.
   */
  wake?(nodeId: string): void
  /**
   * Tell the SENDER a queued message expired. The trace is the durable leg (always written); this
   * is the live leg — the shell surfaces it (a board-log line for the sender, a push). Optional so
   * the core can be tested without a notify channel, but a production wiring that omits it turns the
   * "never a silent drop" guarantee into "durable-only", so the desktop always supplies it.
   */
  onExpired?(req: QueuedDeliveryRequest, info: { traceId: string; queuedForMs: number }): void
  /** Tell the sender how a flush ended (delivered, or refused because the world changed under it).
   *  Same optionality reasoning as `onExpired`. */
  onFlushed?(req: QueuedDeliveryRequest, outcome: AgentMessageOutcome): void
  /** An entry was accepted into a target's queue — called synchronously, right as it is added, so a
   *  listener learns of it before any flush or expiry of that entry can run. Every entry that fires
   *  this later ends in exactly one `onFlushed` or `onExpired`. */
  onQueued?(req: QueuedDeliveryRequest): void
  /** Arm a one-shot timer, returning its cancel. Injected so tests drive TTL expiry deterministically
   *  instead of waiting real milliseconds; defaults to `setTimeout`/`clearTimeout`. */
  schedule?(ms: number, fn: () => void): CancelTimer
  /** The whole queue changed: mirror `snapshot()` to disk. Absent ⇒ process memory only. */
  persist?(entries: PersistedQueueEntry[]): void
  /** The target's current agent and session (the status mirror), recorded at enqueue and compared
   *  when a RESTORED entry flushes. Absent ⇒ nothing is recorded, and a restored entry is refused. */
  bindingOf?(nodeId: string): QueueBinding | undefined
}

/** Which conversation a queued message was addressed to. */
export interface QueueBinding {
  sessionId?: string
  agentId?: string
}

interface QueueEntry {
  req: QueuedDeliveryRequest
  enqueuedAt: number
  ttlMs: number
  cancelTimer: CancelTimer
  /** The traceId minted when this was queued, reused on its expiry so the two entries correlate. */
  queuedTraceId: string
  binding?: QueueBinding
  /** Came back from disk after a restart: flushes only into the session it was queued for. */
  restored?: true
}

/** One queued message as written to disk. */
export interface PersistedQueueEntry {
  req: QueuedDeliveryRequest
  enqueuedAt: number
  ttlMs: number
  queuedTraceId: string
  binding?: QueueBinding
  /** The body was too large to store; the entry is written only so its end can be told. */
  bodyOmitted?: true
}

/** A body larger than this is not written; its entry is expired at restore (sender told). */
export const QUEUE_PERSIST_BODY_MAX = 256 * 1024
/** JSON bytes of FULL entries a snapshot writes before the rest go out reduced (`snapshot`). Half
 *  the file limit: a reduced entry is a few hundred bytes, so 1024 of them fit in the other half. */
export const QUEUE_PERSIST_BYTES_BUDGET = 8 * 1024 * 1024

/** A reduced entry keeps only what its expiry needs to be routed and traced. */
const REDUCED_STRING_MAX = 200
const REDUCED_EXTRAS_MAX = 4

function clip(v: string): string {
  return v.length > REDUCED_STRING_MAX ? v.slice(0, REDUCED_STRING_MAX) : v
}

/** The request of an entry written without its body: short fields only, never a message text. */
function reducedRequest(req: QueuedDeliveryRequest): QueuedDeliveryRequest {
  const out: QueuedDeliveryRequest = {
    verb: typeof req.verb === 'string' ? clip(req.verb) : req.verb,
    sourceNodeId: clip(req.sourceNodeId),
    targetNodeId: req.targetNodeId,
    sourceTitle: clip(req.sourceTitle),
    body: ''
  }
  let extras = 0
  for (const [k, v] of Object.entries(req)) {
    if (k in out || extras >= REDUCED_EXTRAS_MAX) continue
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= REDUCED_STRING_MAX)) {
      out[k] = v
      extras++
    }
  }
  return out
}

/** At most this many entries on disk. `DELIVERY_QUEUE_CAPACITY` per target bounds it in practice. */
export const QUEUE_PERSIST_MAX = 1024
/** The longest TTL a restored entry may claim — a hand-edited `ttlMs` must not keep one forever. */
export const QUEUE_PERSIST_TTL_MAX = 24 * 60 * 60 * 1000

/** The verbs a restored entry may still deliver. See the header: a board comment and a station
 *  notice are expired at restore instead. */
const RESTORABLE_VERBS: ReadonlySet<string> = new Set(['send', 'reply', 'notify'])

const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/

/** Re-check one entry read from disk (hand-editable input). `null` drops it. */
export function sanitizePersistedQueueEntry(raw: unknown): PersistedQueueEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const r = e.req as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (typeof r.targetNodeId !== 'string' || !isSafeNodeId(r.targetNodeId)) return null
  // A board comment's source is `board-comment:<id>`, never a node id; everything else is a node.
  if (typeof r.sourceNodeId !== 'string' || r.sourceNodeId.length === 0 || r.sourceNodeId.length > 200)
    return null
  if (typeof r.verb !== 'string' || r.verb.length > 40) return null
  if (RESTORABLE_VERBS.has(r.verb) && !isSafeNodeId(r.sourceNodeId)) return null
  if (typeof r.sourceTitle !== 'string' || r.sourceTitle.length > 1000) return null
  if (typeof r.body !== 'string' || r.body.length > QUEUE_PERSIST_BODY_MAX) return null
  const req: QueuedDeliveryRequest = {
    sourceNodeId: r.sourceNodeId,
    targetNodeId: r.targetNodeId,
    sourceTitle: r.sourceTitle,
    body: r.body,
    verb: r.verb
  }
  let extras = 0
  for (const [k, v] of Object.entries(r)) {
    if (k in req) continue
    if (!EXTRA_KEY_RE.test(k) || ++extras > 16) return null
    if (typeof v === 'string' ? v.length > 64 * 1024 : typeof v !== 'number' && typeof v !== 'boolean')
      return null
    req[k] = v
  }
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!fin(e.enqueuedAt) || !fin(e.ttlMs) || e.ttlMs <= 0 || e.ttlMs > QUEUE_PERSIST_TTL_MAX) return null
  if (typeof e.queuedTraceId !== 'string' || e.queuedTraceId.length > 200) return null
  const out: PersistedQueueEntry = {
    req,
    enqueuedAt: e.enqueuedAt,
    ttlMs: e.ttlMs,
    queuedTraceId: e.queuedTraceId
  }
  if (e.binding !== undefined) {
    const b = e.binding as Record<string, unknown> | null
    if (!b || typeof b !== 'object') return null
    const binding: QueueBinding = {}
    if (b.sessionId !== undefined) {
      if (typeof b.sessionId !== 'string' || b.sessionId.length > 200) return null
      binding.sessionId = b.sessionId
    }
    if (b.agentId !== undefined) {
      if (typeof b.agentId !== 'string' || b.agentId.length > 200) return null
      binding.agentId = b.agentId
    }
    out.binding = binding
  }
  if (e.bodyOmitted === true) out.bodyOmitted = true
  return out
}

/** The queue's durable file (core/durable-state.ts). */
export const QUEUE_FACT: DurableFactSpec<PersistedQueueEntry> = {
  kind: 'delivery-queue',
  version: 1,
  maxRecords: QUEUE_PERSIST_MAX,
  sanitize: sanitizePersistedQueueEntry
}

/**
 * May a RESTORED entry go into the target now? `deliver` = run the gate chain; `wait` = the
 * target's session is not known yet (re-queue, TTL still running); `gone` = it is a different
 * conversation, or nothing recorded which one it was.
 */
export function restoredBindingVerdict(
  recorded: QueueBinding | undefined,
  current: QueueBinding | undefined
): 'deliver' | 'wait' | 'gone' {
  if (!recorded?.sessionId) return 'gone'
  if (!current?.sessionId) return 'wait'
  if (current.sessionId !== recorded.sessionId) return 'gone'
  if (recorded.agentId && current.agentId && current.agentId !== recorded.agentId) return 'gone'
  return 'deliver'
}

/** Outcomes that mean "the target still is not ready, come back" — a flush that gets one of these
 *  RE-QUEUES the entry at the front (its TTL keeps counting from the original enqueue) and STOPS
 *  draining, because one idle event does not promise the target stays idle. Derived from `RETRYABLE`
 *  minus the two outcomes the queue itself produces (`queueFull`, `expired`) — so `deliver`'s
 *  retryable outcomes (`rateLimited`, `targetBusy`, `targetNotIdleUnknown`, `targetStatusStale`) all
 *  wait for the NEXT idle, and a new retryable outcome added upstream is handled here the moment it
 *  exists rather than silently dropped. `rateLimited` waiting for the next idle (not re-flushing on a
 *  timer) is what keeps the queue from spinning against the very limiter that refused it. */
const REQUEUE_ON: ReadonlySet<AgentMessageOutcome['kind']> = new Set(
  (Object.keys(RETRYABLE) as AgentMessageOutcome['kind'][]).filter(
    (k) => RETRYABLE[k] && k !== 'queueFull' && k !== 'expired'
  )
)

export class DeliveryQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  /** At most one pending retry nudge per target (`retryAfter`). */
  private readonly nudges = new Map<string, CancelTimer>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly schedule: (ms: number, fn: () => void) => CancelTimer

  constructor(
    private readonly deps: DeliveryQueueDeps,
    opts: { capacity?: number; ttlMs?: number } = {}
  ) {
    this.capacity = opts.capacity ?? DELIVERY_QUEUE_CAPACITY
    this.ttlMs = opts.ttlMs ?? DELIVERY_QUEUE_TTL_MS
    this.schedule =
      deps.schedule ??
      ((ms, fn): CancelTimer => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
  }

  /** How many messages are queued for a target right now — for assertions and a position count. */
  depth(nodeId: string): number {
    return this.queues.get(nodeId)?.length ?? 0
  }

  /**
   * Enqueue a message whose initial delivery refused as `targetBusy` (or whose target is
   * hibernated). Returns the `queued` receipt (with its position and TTL) or `queueFull` at the
   * bound — never enqueues past capacity. A `hibernated` target is woken here, before it is idle;
   * the wake's eventual idle event is what triggers the flush.
   */
  async enqueue(
    req: QueuedDeliveryRequest,
    opts: { hibernated?: boolean; ttlMs?: number } = {}
  ): Promise<
    Extract<AgentMessageOutcome, { kind: 'queued' } | { kind: 'queueFull' }>
  > {
    const list = this.queues.get(req.targetNodeId) ?? []
    if (list.length >= this.capacity) {
      // Refused, not dropped-oldest: an accepted message is never silently discarded to make room.
      return { kind: 'queueFull', capacity: this.capacity }
    }
    const now = this.deps.now()
    const t = await this.deps.trace({
      sourceNodeId: req.sourceNodeId,
      sourceTitle: req.sourceTitle,
      targetNodeId: req.targetNodeId,
      outcome: 'queued',
      bodyChars: req.body.length
    }, req)
    const binding = this.deps.bindingOf?.(req.targetNodeId)
    // A caller may ask for a longer wait than the queue's default (a target that has not STARTED
    // yet waits for a person to open its project), bounded by what a restored entry may claim.
    const ttlMs = Math.min(opts.ttlMs ?? this.ttlMs, QUEUE_PERSIST_TTL_MAX)
    const entry: QueueEntry = {
      req,
      enqueuedAt: now,
      ttlMs,
      queuedTraceId: t.traceId,
      cancelTimer: this.schedule(ttlMs, () => void this.expire(req.targetNodeId, entry)),
      ...(binding ? { binding: { ...binding } } : {})
    }
    list.push(entry)
    this.queues.set(req.targetNodeId, list)
    this.persist()
    this.deps.onQueued?.(req)
    // Kick the wake for a hibernated target so it starts its resume; the flush waits on the idle
    // event, not on the wake. A busy (non-hibernated) target needs nothing — it will go idle on its
    // own turn end.
    if (opts.hibernated) this.deps.wake?.(req.targetNodeId)
    return { kind: 'queued', traceId: t.traceId, position: list.length, ttlMs }
  }

  /**
   * The target went idle — flush its queue, oldest first. Each entry is delivered through
   * `deps.deliver`, which RE-RUNS the whole gate chain against live state (the flush-time
   * re-validation). An entry whose flush says "still not ready" is put back (its TTL unchanged); any
   * other outcome is terminal and the entry is gone. Draining stops the moment the target is not
   * ready again — one idle event does not promise the target stays idle across N deliveries.
   */
  async onTargetIdle(nodeId: string): Promise<void> {
    for (;;) {
      const list = this.queues.get(nodeId)
      if (!list || list.length === 0) return
      const entry = list[0]
      // Take it off before delivering: a re-entrant idle event (deliver can await a real round-trip)
      // must not flush the same entry twice. It goes back on failure, at the FRONT, preserving order.
      list.shift()
      entry.cancelTimer()
      // Written off disk BEFORE the attempt (claim before effect): a crash mid-delivery then loses
      // this one message rather than typing it twice after the next boot. At most once.
      this.persist()
      // A restored entry goes only into the session it was queued for (see the header).
      const verdict = entry.restored
        ? restoredBindingVerdict(entry.binding, this.deps.bindingOf?.(nodeId))
        : 'deliver'
      if (verdict === 'wait') {
        this.requeueFront(nodeId, entry)
        return
      }
      const outcome: AgentMessageOutcome =
        verdict === 'gone' ? { kind: 'targetGone' } : await this.deps.deliver(entry.req)
      if (REQUEUE_ON.has(outcome.kind)) {
        // Not ready yet (busy again, still unverified, or rate-limited): keep it, TTL counting from
        // its ORIGINAL enqueue, and stop draining — the target is evidently not idle after all.
        this.requeueFront(nodeId, entry)
        return
      }
      // Terminal: delivered, or a refusal waiting will not fix (notPermitted from a revoked grant,
      // targetGone, targetNotAgentPane…). The entry is done; tell the sender and move to the next.
      if (this.queues.get(nodeId)?.length === 0) this.queues.delete(nodeId)
      this.persist()
      this.deps.onFlushed?.(entry.req, outcome)
    }
  }

  /**
   * Re-offer a target's queue after `ms` — for an entry held by a CLOCK (the pair window) rather than
   * by the target's turn. A busy target emits `done` when its turn ends, which is what flushes the
   * queue; a pair window ending emits nothing, so an entry waiting only on it (the target idle all
   * along, or its `done` having landed inside the window) would otherwise sit until its TTL expired.
   *
   * One pending nudge per target: a second request while one is armed is dropped, and a nudge that
   * fires too early simply meets the same refusal, whose caller arms the next. Bounded by the TTL — an
   * expired or delivered entry leaves an empty queue, and a nudge on an empty queue does nothing — and
   * cheap: a refusal on the pair window is decided before any pane probe.
   */
  retryAfter(nodeId: string, ms: number): void {
    if (this.nudges.has(nodeId)) return
    const cancel = this.schedule(Math.max(0, ms), () => {
      this.nudges.delete(nodeId)
      void this.onTargetIdle(nodeId)
    })
    this.nudges.set(nodeId, cancel)
  }

  /** Put an entry back at the front with its TTL re-armed for the time it has LEFT (never reset to a
   *  full TTL — the wait it has already served counts). A lapsed remainder expires it immediately. */
  private requeueFront(nodeId: string, entry: QueueEntry): void {
    const remaining = Math.max(0, entry.ttlMs - (this.deps.now() - entry.enqueuedAt))
    entry.cancelTimer = this.schedule(remaining, () => void this.expire(nodeId, entry))
    const list = this.queues.get(nodeId) ?? []
    list.unshift(entry)
    this.queues.set(nodeId, list)
    this.persist()
  }

  /**
   * A queued message waited out its TTL. Remove it, trace `expired`, and tell the sender — both
   * legs, because a dropped message with no record anywhere is the failure this module refuses to
   * have. Idempotent against a flush that already removed the entry (the timer can fire in the seam
   * before its cancel runs).
   */
  private async expire(nodeId: string, entry: QueueEntry): Promise<void> {
    const list = this.queues.get(nodeId)
    if (!list) return
    const i = list.indexOf(entry)
    if (i < 0) return // already delivered/re-queued with a fresh timer — this fire is stale
    list.splice(i, 1)
    if (list.length === 0) this.queues.delete(nodeId)
    entry.cancelTimer()
    this.persist()
    await this.reportExpired(entry)
  }

  /** Trace `expired` and tell the sender — the two legs every expiry owes. */
  private async reportExpired(entry: QueueEntry): Promise<void> {
    const queuedForMs = this.deps.now() - entry.enqueuedAt
    const t = await this.deps.trace({
      sourceNodeId: entry.req.sourceNodeId,
      sourceTitle: entry.req.sourceTitle,
      targetNodeId: entry.req.targetNodeId,
      outcome: 'expired',
      bodyChars: entry.req.body.length
    }, entry.req)
    this.deps.onExpired?.(entry.req, { traceId: t.traceId, queuedForMs })
  }

  /** Every queued entry as it is written to disk, oldest first per target. */
  snapshot(): PersistedQueueEntry[] {
    const out: PersistedQueueEntry[] = []
    // The file is set aside WHOLE at load past DURABLE_STATE_MAX_BYTES, so the write is budgeted:
    // once the full entries reach QUEUE_PERSIST_BYTES_BUDGET (JSON bytes, oldest first per target),
    // the rest are written REDUCED — no body, only short fields — which restore turns into an
    // expiry the sender hears about. Never a file the next boot throws away with every message in it.
    let used = 0
    for (const list of this.queues.values()) {
      for (const e of list) {
        const base = {
          enqueuedAt: e.enqueuedAt,
          ttlMs: e.ttlMs,
          queuedTraceId: e.queuedTraceId,
          ...(e.binding ? { binding: e.binding } : {})
        }
        const full: PersistedQueueEntry = { req: e.req, ...base }
        const size = e.req.body.length > QUEUE_PERSIST_BODY_MAX ? Infinity : JSON.stringify(full).length
        if (used + size <= QUEUE_PERSIST_BYTES_BUDGET) {
          used += size
          out.push(full)
          continue
        }
        const reduced: PersistedQueueEntry = { req: reducedRequest(e.req), ...base, bodyOmitted: true }
        used += JSON.stringify(reduced).length
        out.push(reduced)
      }
    }
    return out
  }

  /**
   * Bring back entries an earlier process queued (boot, after every listener is wired). Each one is
   * announced through `onQueued` like a fresh enqueue; one whose wall-clock TTL lapsed while the app
   * was down — or that may not flush after a restart at all — is then EXPIRED at once (traced, and
   * the sender told). The rest wait for their target's next `done` with the TTL they have LEFT.
   * Capacity still applies per target; an entry past it is expired rather than dropped.
   */
  async restore(entries: readonly PersistedQueueEntry[]): Promise<void> {
    const now = this.deps.now()
    const lapsed: QueueEntry[] = []
    for (const p of entries) {
      // A clock that went backwards must not stretch the wait past one full TTL.
      const age = Math.max(0, now - p.enqueuedAt)
      const remaining = Math.min(p.ttlMs, p.ttlMs - age)
      const entry: QueueEntry = {
        req: p.req,
        enqueuedAt: Math.min(p.enqueuedAt, now),
        ttlMs: p.ttlMs,
        queuedTraceId: p.queuedTraceId,
        cancelTimer: () => {},
        restored: true,
        ...(p.binding ? { binding: p.binding } : {})
      }
      this.deps.onQueued?.(entry.req)
      // Capacity counts only what is really re-queued: a lapsed entry never takes a slot.
      const deliverable =
        remaining > 0 &&
        !p.bodyOmitted &&
        RESTORABLE_VERBS.has(String(p.req.verb)) &&
        this.depth(p.req.targetNodeId) < this.capacity
      if (!deliverable) {
        // Never inserted into the live lists: a flush running during one of the expiries below
        // must not be able to deliver a board comment or an empty (body-omitted) entry.
        lapsed.push(entry)
        continue
      }
      const list = this.queues.get(p.req.targetNodeId) ?? []
      list.push(entry)
      this.queues.set(p.req.targetNodeId, list)
      entry.cancelTimer = this.schedule(remaining, () => void this.expire(p.req.targetNodeId, entry))
    }
    // The lapsed entries' ends are reported BEFORE the file drops them: a crash in between reports
    // one twice at the next boot, never not at all.
    for (const entry of lapsed) await this.reportExpired(entry)
    this.persist()
  }

  private persist(): void {
    this.deps.persist?.(this.snapshot())
  }

  /** Test seam / shutdown: cancel every timer and drop every queue WITHOUT tracing (a teardown is
   *  not an expiry the sender needs to hear about). */
  resetForTests(): void {
    for (const list of this.queues.values()) for (const e of list) e.cancelTimer()
    this.queues.clear()
    for (const cancel of this.nudges.values()) cancel()
    this.nudges.clear()
  }
}
