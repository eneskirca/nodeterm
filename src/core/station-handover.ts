/**
 * Which stations have been HANDED NEW WORK they have not finished — the fact plain `--after` needs
 * (@shared/station-handover has the why). ONE module for both shells: desktop main feeds it and
 * pushes its list to the renderer, whose launch loop (`launchesToFire`) reads it; the Server
 * Edition's headless factory asks it directly. So the two editions cannot come to disagree about
 * when a dependent starts.
 *
 * WHAT COUNTS AS A HAND-OVER — the same moments #1042's report rule uses
 * (src/core/station-outcome-store.ts), fed by the same events:
 *   - a `send` / `reply` QUEUED for a busy station (`onHandover` 'queued'): the station is handed
 *     over from that moment — its current `done` is the PREVIOUS task's — until the message lands
 *     and a turn after it ends;
 *   - the bytes LANDING in the pane (`onHandover` 'landed', first attempt or flush) at `at`, which
 *     is when that delivery attempt STARTED;
 *   - a queued message that ends WITHOUT landing (expired, refused on flush): still a hand-over,
 *     at the moment it settled. The orchestrator handed new work and armed a dependent believing it
 *     would be done; releasing that dependent on the older task's `done` is the bug this closes. The
 *     turn the station was on at the expiry does not end it — only a turn STARTED after it does, and
 *     nothing starts one unless the station is given work again (a resend, a person typing the task
 *     by hand). ▶ / `run` start the dependent anyway;
 *   - `write` succeeding (`noteControlAnswer`), stamped when the renderer STARTED TYPING
 *     (`typedAt` in its answer) — never at the request, which waits on a human confirm first: a turn
 *     that started while the dialog was open (a background child's task-notification) is not an
 *     answer to text not typed yet. A write into a station that was BLOCKED or WAITING when the
 *     request arrived is not a hand-over at all: it answers the prompt, and the same turn goes on;
 *   - `run` succeeding: it starts the named node's held launch, stamped when the request arrived
 *     (no confirm), before anything was typed.
 *
 * WHEN IT ENDS: a `done` for a turn that STARTED at or after the newest hand-over, with nothing
 * still queued. "Started" is the first active state (working / waiting / blocked) after the
 * station was last idle, or any genuine new turn (`newTurn`: after an Esc interrupt core may never
 * see the idle the renderer infers) — stamped by this module's own clock as events arrive, for
 * every station, handed over or not, because a delivered prompt can start (and even finish) its
 * turn before the delivery's `landed` event is emitted. The idle-prompt rescue (`idle: true`) is a
 * turn end only for a station still `working` (the reduceEntry rule): it also fires under an open
 * permission prompt, and taking it as idle there would let the approval's `working` stamp a fake
 * turn start inside the SAME turn. A turn already in progress when the work landed does not end
 * it: the typed text is answered by a LATER turn (if the CLI folds it into the current turn
 * instead, the hold lasts until the next turn — the holding direction, with ▶ and `run` as the way
 * out).
 *
 * BACKGROUND SUBAGENTS are the second kind of unfinished work. Claude's `Stop` carries
 * `background_tasks` — every background task still running at that turn end — and a turn that ends
 * with one running has not finished what a dependent is armed to read (measured live, 2026-09-30:
 * an agent's turn ended while its work went on in the background, and the node armed `--after` it
 * fired before anything was pushed). Only async SUBAGENTS hold
 * (`NormalizedAgentEvent.backgroundSubagentIds`, `type: 'subagent'`): a child ENDS, and its
 * task-notification wakes the parent into another turn, so a later `Stop` with it gone reliably
 * comes. A background SHELL does not hold — a dev server, a file watcher, `tail -f` may never end
 * and do not reliably wake the station, so holding on one held the dependent forever (the review
 * of #1052 measured three turns ending with the same dev server listed). A station whose
 * dependent needs a shell's result is told to wait for it before ending its turn. Rules:
 *   - an ABSENT inventory is "unknown", never "none" — and it changes nothing: a CLI too old to send
 *     the field never sets the hold (today's behaviour, exactly), and a `done` without one (the
 *     idle-prompt rescue, a `StopFailure`, another agent) neither sets nor clears it;
 *   - the hold is not cleared by a turn STARTING (the child may well outlive it) — only by a turn
 *     end that says no subagent is left, or by `SessionEnd` (the CLI exited, taking its children
 *     with it; waiting on a session that will never report again would strand the dependent).

 * NOT a hand-over: a board comment (a person steering), a station notice (the app telling an
 * orchestrator something), a person typing in the pane. Deliberately the same set #1042 counts.
 *
 * Bounded (past STATION_HANDOVER_MAX_TRACKED the oldest station with nothing held is evicted;
 * only when EVERY tracked station holds is the oldest held one dropped) and DURABLE ACROSS A
 * RESTART (`HANDOVER_FACT`, `<userData>/orchestration-state/station-handovers.json`, through
 * core/durable-state.ts). Without it an app restart forgot every hold, and a dependent armed on a
 * station that had just been handed its next task fired on the first `done` after the restart —
 * the previous task's, or a turn in flight before the work landed. What a restart means here:
 *   - the HOLDING stations are stored — `handedAt`, the current turn's start and state, the
 *     background flag — so a hold ends after the restart exactly as it would have without one: on
 *     a `done` for a turn that started at or after the hand-over (wall-clock times, so a turn that
 *     began before the restart still counts if it began after the hand-over);
 *   - `queued` is NOT stored: it is rebuilt from the durable delivery queue, whose restore replays
 *     a `queued` hand-over per waiting message (and a `settled` one, never landed, for each message
 *     that lapsed while the app was down — which is still a hand-over, see above);
 *   - hook events are lost while the app is down (the hook POSTs have nowhere to go), so a turn
 *     that ENDED during the downtime is not seen: the hold lasts until the station's next turn end.
 *     The holding direction, with ▶ / `run` as the way out, like every other uncertainty here;
 *   - a hold is not bound to a session: a station respawned into a new session still owes the work
 *     it was handed, and its next completed turn ends the hold as usual.
 * Loaded by each shell after the station reports and before the delivery queue.
 * The recent state `history` (what a confirm-delayed `write` answers) is NOT stored: it spans one
 * confirm dialog, and after a restart the request it described is gone.
 */
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import type { StationHandoverRecord } from '../shared/station-handover'
import type { MessageHandover } from './agents/agent-messaging'
import type { CorePlatform } from './platform'
import type { DurableFactFile, DurableFactSpec } from './durable-state'

/** How many stations' activity one process tracks. Far past any canvas; evicts the oldest first. */
export const STATION_HANDOVER_MAX_TRACKED = 2000

/** The messaging verbs whose delivery hands a station new work (#1042's set). */
const HANDOVER_VERBS: ReadonlySet<string> = new Set(['send', 'reply'])

/** The control verbs whose successful ANSWER means new work reached the node they name. */
export const HANDOVER_CONTROL_VERBS: ReadonlySet<string> = new Set(['write', 'run'])

const ACTIVE: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'waiting', 'blocked'])

/** How many recent state changes a station keeps, to answer "what was it doing when that request
 *  arrived?" across a confirm dialog. A handful covers a prompt answered and re-asked. */
const STATE_HISTORY = 8

interface StationTrack {
  /** The last state seen. `undefined` until the first event. */
  state?: AgentState
  /** Recent state changes, oldest first: what `stateAt` reads. */
  history?: Array<{ state: AgentState; at: number }>
  /** When the current (or last) turn started: the first active state after an idle one. */
  turnStartedAt?: number
  /** `send` / `reply` entries still queued for this station. */
  queued: number
  /** The newest hand-over that no finished turn has answered yet. */
  handedAt?: number
  /** The last turn end listed background tasks still running (see the header). */
  background?: boolean
}

/** One holding station as it is written to disk (`queued` is rebuilt, never stored). */
export interface PersistedHandover {
  nodeId: string
  handedAt?: number
  turnStartedAt?: number
  state?: AgentState
  background?: true
}

const STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'blocked', 'done'])

/** Re-check one entry read from disk (hand-editable input). `null` drops it. */
export function sanitizePersistedHandover(raw: unknown): PersistedHandover | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const out: PersistedHandover = { nodeId: r.nodeId }
  for (const k of ['handedAt', 'turnStartedAt'] as const) {
    if (r[k] === undefined) continue
    if (!fin(r[k])) return null
    out[k] = r[k] as number
  }
  if (r.state !== undefined) {
    if (typeof r.state !== 'string' || !STATES.has(r.state)) return null
    out.state = r.state as AgentState
  }
  if (r.background === true) out.background = true
  // An entry that holds nothing is not a hand-over (and would only take a slot).
  if (out.handedAt === undefined && !out.background) return null
  return out
}

function holds(t: StationTrack): boolean {
  return t.queued > 0 || t.handedAt !== undefined || t.background === true
}

export class StationHandoverTracker {
  // Insertion order IS recency (re-set on every touch), so eviction is one `keys().next()`.
  private readonly byId = new Map<string, StationTrack>()
  private lastSig = ''

  constructor(
    private readonly publish: (records: StationHandoverRecord[]) => void = () => {},
    private readonly now: () => number = Date.now,
    /** Mirror the holding stations to disk; `loadFromDisk` reads them back at boot. */
    private readonly durable?: Pick<DurableFactFile<PersistedHandover>, 'load' | 'save'>
  ) {}

  /**
   * Bring back the holds an earlier process saved (see the header). Called once per shell at boot,
   * BEFORE the delivery queue is restored (its replay adds `queued` on top). Stations this run has
   * already seen win. Never throws: the file layer turns a bad file into an empty list.
   */
  loadFromDisk(): void {
    if (!this.durable) return
    for (const p of this.durable.load()) {
      if (this.byId.has(p.nodeId)) continue
      const t = this.touch(p.nodeId)
      if (p.handedAt !== undefined) t.handedAt = p.handedAt
      if (p.turnStartedAt !== undefined) t.turnStartedAt = p.turnStartedAt
      if (p.state !== undefined) t.state = p.state
      if (p.background) t.background = true
    }
    this.changed()
  }

  private persist(): void {
    if (!this.durable) return
    const out: PersistedHandover[] = []
    for (const [nodeId, t] of this.byId) {
      if (t.handedAt === undefined && !t.background) continue
      out.push({
        nodeId,
        ...(t.handedAt !== undefined ? { handedAt: t.handedAt } : {}),
        ...(t.turnStartedAt !== undefined ? { turnStartedAt: t.turnStartedAt } : {}),
        ...(t.state !== undefined ? { state: t.state } : {}),
        ...(t.background ? { background: true as const } : {})
      })
    }
    this.durable.save(out)
  }

  private touch(nodeId: string): StationTrack {
    const cur = this.byId.get(nodeId) ?? { queued: 0 }
    this.byId.delete(nodeId)
    this.byId.set(nodeId, cur)
    // Evict the oldest station with NOTHING handed over: dropping a held one would release its
    // dependents — the direction nothing can undo. Only a map full of held stations drops one.
    while (this.byId.size > STATION_HANDOVER_MAX_TRACKED) {
      let victim: string | undefined
      for (const [id, t] of this.byId) {
        if (id !== nodeId && !holds(t)) {
          victim = id
          break
        }
      }
      victim ??= this.byId.keys().next().value
      if (victim === undefined) break
      this.byId.delete(victim)
    }
    return cur
  }

  private setState(t: StationTrack, state: AgentState): void {
    if (t.state !== state) {
      const h = (t.history ??= [])
      h.push({ state, at: this.now() })
      if (h.length > STATE_HISTORY) h.shift()
    }
    t.state = state
  }

  /** The station's state at `at`, from its recent history; unknown when older than the history. */
  private stateAt(t: StationTrack, at: number): AgentState | undefined {
    let out: AgentState | undefined
    for (const e of t.history ?? []) {
      if (e.at > at) break
      out = e.state
    }
    return out
  }

  /** Has the turn answering the hand-over already ended? */
  private settle(t: StationTrack): void {
    if (
      t.handedAt !== undefined &&
      t.state === 'done' &&
      t.turnStartedAt !== undefined &&
      t.turnStartedAt >= t.handedAt
    )
      t.handedAt = undefined
  }

  private changed(): void {
    this.persist()
    const list = this.list()
    const sig = list
      .map((r) => `${r.nodeId}:${r.since ?? ''}:${r.queued ? 1 : 0}:${r.background ? 1 : 0}`)
      .join('|')
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.publish(list)
  }

  /** Every agent event of every node, fed BEFORE anything that acts on it (the Server Edition's
   *  `refreshArmed`, the messaging queue's flush on `done`). Events without a state are ignored. */
  onAgentEvent(
    event: Pick<NormalizedAgentEvent, 'nodeId' | 'state'> &
      Partial<Pick<NormalizedAgentEvent, 'backgroundSubagentIds' | 'sessionPhase' | 'newTurn' | 'idle'>>
  ): void {
    if (!event?.nodeId || !isSafeNodeId(event.nodeId)) return
    // The CLI exited: its background tasks died with it, and it will never report them finished.
    if (event.sessionPhase === 'end') {
      const t = this.byId.get(event.nodeId)
      if (t?.background) {
        t.background = false
        this.changed()
      }
      return
    }
    const state = event.state
    if (typeof state !== 'string') return
    // The idle-prompt rescue (`idle: true`) is a turn end ONLY for a station still `working` — the
    // reduceEntry rule. It also fires while a permission prompt is up, and taking it there as
    // idle would let the approval's `working` stamp a turn start in the middle of the SAME turn.
    if (event.idle === true && this.byId.get(event.nodeId)?.state !== 'working') return
    const t = this.touch(event.nodeId)
    if (ACTIVE.has(state)) {
      // A genuine new turn (`newTurn`) starts one whatever came before: after an Esc interrupt the
      // renderer infers the idle, but core may never see one, and the next real turn must count.
      const started = !t.state || !ACTIVE.has(t.state) || event.newTurn === true
      if (started) t.turnStartedAt = this.now()
      this.setState(t, state)
      // A held station's turn start is what ends its hold: it must survive a restart too.
      if (started && holds(t)) this.persist()
      return
    }
    this.setState(t, state)
    if (state === 'done') {
      // Only a PRESENT inventory speaks about background work; an absent one is unknown. Only
      // background SUBAGENTS hold (see liveBackgroundSubagentIds and the header).
      if (Array.isArray(event.backgroundSubagentIds)) t.background = event.backgroundSubagentIds.length > 0
      this.settle(t)
      this.changed()
    }
  }

  /** New work landed in the station's pane at `at` (this process's clock). */
  markHandedOver(nodeId: string, at: number): void {
    if (!isSafeNodeId(nodeId) || !Number.isFinite(at)) return
    const t = this.touch(nodeId)
    t.handedAt = Math.max(t.handedAt ?? at, at)
    // A delivered prompt can start AND finish its turn before the delivery reports back.
    this.settle(t)
    this.changed()
  }

  /** The messaging layer's hand-over events (`AgentMessagingDeps.onHandover`). */
  onHandover(ev: MessageHandover): void {
    if (!HANDOVER_VERBS.has(ev.verb) || !isSafeNodeId(ev.targetNodeId)) return
    const id = ev.targetNodeId
    if (ev.phase === 'queued') {
      this.touch(id).queued++
      this.changed()
      return
    }
    if (ev.phase === 'landed') {
      this.markHandedOver(id, ev.at)
      return
    }
    const t = this.touch(id)
    t.queued = Math.max(0, t.queued - 1)
    // A queued message that never landed still counts as handed over (see the header).
    if (!ev.landed) t.handedAt = Math.max(t.handedAt ?? 0, this.now())
    this.changed()
  }

  /**
   * One finished `write` / `run`. Run by each shell's control handler on the answer (prompt or
   * late), and only on success: a refused write handed nothing. A caller naming itself is not
   * handed work by anyone.
   *
   * WHEN the work landed:
   *   - `run` (no confirm): `requestAt`, when the request ARRIVED — before its held launch was typed.
   *   - `write`: when the renderer STARTED TYPING (`result.result.typedAt`), not the request time. A
   *     write waits on a human confirm first, and a turn that started while the dialog was open (a
   *     background child's task-notification, say) is not an answer to text not yet typed. A
   *     `typedAt` outside [requestAt, now] is not believed, and the answer time stands in: later
   *     errs toward holding.
   * A station that was BLOCKED or WAITING when the request arrived is not handed work: the text
   * answers its prompt, and the same turn simply continues (no new turn will ever start for it).
   */
  noteControlAnswer(
    verb: string,
    args: Record<string, string | undefined>,
    result: { ok: boolean; result?: unknown },
    callerNodeId: string,
    requestAt: number
  ): void {
    if (!result.ok || !HANDOVER_CONTROL_VERBS.has(verb) || typeof args.node !== 'string') return
    const now = this.now()
    let at = requestAt
    if (verb === 'write') {
      const typedAt = (result.result as { typedAt?: unknown } | undefined)?.typedAt
      at =
        typeof typedAt === 'number' && typedAt >= requestAt && typedAt <= now
          ? typedAt
          : Math.max(requestAt, now)
    }
    for (const id of args.node.split(',').map((s) => s.trim())) {
      if (!id || id === callerNodeId || !isSafeNodeId(id)) continue
      const t = this.byId.get(id)
      const was = t ? this.stateAt(t, requestAt) : undefined
      if (was === 'blocked' || was === 'waiting') continue
      this.markHandedOver(id, at)
    }
  }

  /** Is `--after` on this station held by unfinished work — handed over, or still running in the
   *  background of its last turn? */
  isHandedOver(nodeId: string): boolean {
    const t = this.byId.get(nodeId)
    return !!t && holds(t)
  }

  /** Every station with unfinished handed-over work, newest first. */
  list(): StationHandoverRecord[] {
    const out: StationHandoverRecord[] = []
    for (const [nodeId, t] of [...this.byId.entries()].reverse()) {
      if (!holds(t)) continue
      out.push({
        nodeId,
        ...(t.handedAt !== undefined ? { since: t.handedAt } : {}),
        ...(t.queued > 0 ? { queued: true as const } : {}),
        ...(t.background ? { background: true as const } : {})
      })
    }
    return out
  }
}

/** The read channel, registered by BOTH shells. `tracker` is a thunk: a shell may build it after
 *  the platform handlers. */
export function registerStationHandoverIpc(
  platform: Pick<CorePlatform, 'handle'>,
  tracker: () => StationHandoverTracker | null
): void {
  platform.handle(IPC.stationHandoverList, () => tracker()?.list() ?? [])
}

/** The tracker's durable file (core/durable-state.ts). */
export const HANDOVER_FACT: DurableFactSpec<PersistedHandover> = {
  kind: 'station-handovers',
  version: 1,
  maxRecords: STATION_HANDOVER_MAX_TRACKED,
  sanitize: sanitizePersistedHandover
}
