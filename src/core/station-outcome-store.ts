/**
 * The core half of @shared/station-outcome: what each station last REPORTED about its task, and the
 * `report-outcome` verb that records it. ONE module for both shells — desktop main and the Server
 * Edition both answer the verb here and both register the read channel — so the two cannot come to
 * accept different reports or keep them differently.
 *
 * DURABLE ACROSS A RESTART (it used to be transient, so after an app restart every
 * `--after-success` dependent read BLOCKED and needed ▶ / `run`). Held in MAIN rather than the
 * renderer so a renderer reload (⌘R, a Server Edition browser tab closing) does not lose it — the
 * station-notice monitor learned that lesson with its DROPPED verdict — and mirrored to
 * `<userData>/orchestration-state/station-outcomes.json` (`OUTCOME_FACT`) so an app restart does not
 * either. What a restart means for a report:
 *   - it comes back as it was, BOUND to the session that made it: `record` stores the station's
 *     agent and session id (`sessionOf`, the status mirror). At load, a report whose recorded
 *     session or agent differs from what the (restored) mirror now says for that node is dropped —
 *     the node id now belongs to another conversation, and its word is not this one's;
 *   - and afterwards: a `SessionStart` from the node naming a DIFFERENT session or agent than the
 *     one a report is bound to withdraws it (`onAgentEvent`). That also holds in-run — a report is
 *     about a task in one conversation, and `/clear`, a respawn or another agent in the pane is a
 *     different one. It errs toward holding, like every rule here. A report with no recorded
 *     session (its station never named one) is kept: there is nothing to compare;
 *   - "work pending" is NOT stored: it is rebuilt from the durable delivery queue, whose restore
 *     replays a `queued` hand-over for every message still waiting (delivery-queue.ts). A message
 *     that lapsed while the app was down is then settled without landing, which withdraws the report
 *     exactly as an in-run expiry does;
 *   - a report whose station was CLOSED keeps counting for the dependents it already had (the
 *     deleted-station rule, `evaluateSuccessDep`) — across a restart now too.
 * A crash inside the save window loses that window; a clean quit flushes synchronously.
 *
 * WHEN A REPORT ENDS (the "new task" rule):
 *   - the station reports again — the later report supersedes;
 *   - the station is handed new work THROUGH CANVAS CONTROL. That is how an orchestrator reuses a
 *     station, and without it "hand the station its next task, then open a dependent
 *     `--after-success` on it" would release that dependent at once on the PREVIOUS task's success —
 *     early, the direction nothing can undo. It is decided by WHEN THE WORK REACHES THE PANE, never
 *     by when a control answer comes back (the answer to a queued message comes back long before):
 *       · a `send` / `reply` that is QUEUED for a busy station marks it WORK PENDING
 *         (`onHandover` 'queued'): every report it makes stops counting — including the one it is
 *         about to make for the task it is still on — until the message lands;
 *       · when the bytes LAND (first attempt or flush), every report made before that delivery
 *         STARTED is withdrawn; a report made after it (about the new work) stands, however late
 *         the answer arrives;
 *       · a queued message that ends WITHOUT landing (expired, refused on flush) withdraws the
 *         report too. The orchestrator handed new work and was told it did not arrive; a dependent it
 *         armed after that hand-over must not start on the older task's word;
 *       · `write` / `run` (typed straight into the pane after its confirm, or a held launch started)
 *         withdraw every report older than their answer, which is when the bytes landed;
 *     Every one of these errs toward holding, which the deadline and ▶ / `run` can always end;
 *   - NOT a new turn. A turn is not a task: a station may report mid-turn and keep summarising, and
 *     a person typing "thanks" into its pane starts a turn without starting a task. nodeterm cannot
 *     tell a new task from a follow-up by looking at a turn, so a turn changes nothing here; the
 *     skill tells every station to report at the end of every task, which supersedes the old one;
 *   - NOT the station being closed. A closed station's success still counts for the dependents it
 *     already had (`evaluateSuccessDep`): closing finished stations is ordinary tidying.
 * The store is bounded, oldest evicted first, so a long session cannot grow it without limit.
 */
import type { BoardLogEntry } from '../shared/types'
import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import {
  REPORT_OUTCOME_CONTROL_REFUSAL,
  parseReportOutcome,
  sanitizeOutcomeRecords,
  type StationOutcome,
  type StationOutcomeRecord
} from '../shared/station-outcome'
import type { CorePlatform } from './platform'
import type { MessageHandover } from './agents/agent-messaging'
import type { DurableFactFile, DurableFactSpec } from './durable-state'

/** Which conversation a report was made in. */
export interface OutcomeBinding {
  sessionId?: string
  agentId?: string
}

/** One report as it is written to disk: the published record plus its binding. */
export interface PersistedOutcome {
  nodeId: string
  outcome: StationOutcome
  note?: string
  at: number
  sessionId?: string
  agentId?: string
}

/** Re-check one report read from disk (hand-editable input). `null` drops it. The note is re-run
 *  through the SAME sanitizer a live report takes (`sanitizeOutcomeRecords`). */
export function sanitizePersistedOutcome(raw: unknown): PersistedOutcome | null {
  const [rec] = sanitizeOutcomeRecords([raw])
  if (!rec) return null
  const r = raw as Record<string, unknown>
  const out: PersistedOutcome = {
    nodeId: rec.nodeId,
    outcome: rec.outcome,
    at: rec.at,
    ...(rec.note ? { note: rec.note } : {})
  }
  for (const k of ['sessionId', 'agentId'] as const) {
    const v = r[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) return null
    out[k] = v
  }
  return out
}

/** Would a report bound to `recorded` still speak for a node now in `current`? Unknown on either
 *  side keeps it — only a VISIBLE difference drops it. */
export function sameConversation(recorded: OutcomeBinding, current: OutcomeBinding | undefined): boolean {
  if (!current) return true
  if (recorded.sessionId && current.sessionId && recorded.sessionId !== current.sessionId) return false
  if (recorded.agentId && current.agentId && recorded.agentId !== current.agentId) return false
  return true
}

export interface StationOutcomeStoreOptions {
  /** Mirror every change to disk and load from it at construction. */
  durable?: Pick<DurableFactFile<PersistedOutcome>, 'load' | 'save'>
  /** The node's current agent and session (the status mirror). Recorded with a report and compared
   *  at load. Absent ⇒ reports carry no binding. */
  sessionOf?(nodeId: string): OutcomeBinding | undefined
}

/** How many stations' reports one process keeps. Far past any canvas; evicts the oldest first. */
export const STATION_OUTCOME_MAX_RECORDS = 1000

/** The author of the board-log line — the app, like every other trace it writes. */
const OUTCOME_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

export class StationOutcomeStore {
  // Insertion order IS recency: a record is deleted and re-set on every write, so the first key is
  // always the oldest and eviction is one `keys().next()`.
  private readonly byId = new Map<string, StationOutcomeRecord>()
  /** Stations with a `send`/`reply` still QUEUED for them, and how many. While a station is here its
   *  report does not count (`workPending` on the published record). Every entry is removed by the
   *  queue's own `settled` event — the queue guarantees one per `queued`. */
  private readonly pending = new Map<string, number>()
  /** Which conversation each report was made in (persisted beside it, never published). */
  private readonly bindings = new Map<string, OutcomeBinding>()
  private readonly durable: StationOutcomeStoreOptions['durable']
  private readonly sessionOf: StationOutcomeStoreOptions['sessionOf']

  /** `publish` gets the FULL list after every change (never a delta), like station notices. */
  constructor(
    private readonly publish: (records: StationOutcomeRecord[]) => void = () => {},
    opts: StationOutcomeStoreOptions = {}
  ) {
    this.durable = opts.durable
    this.sessionOf = opts.sessionOf
  }

  /**
   * Load what an earlier process saved (see the header). A shell calls it ONCE at boot, AFTER the
   * status mirror is restored (the binding check reads it) and BEFORE the delivery queue is
   * restored (whose replayed hand-overs act on these reports). Reports already recorded in this
   * run win. Never throws: the file layer turns a bad file into an empty list.
   */
  loadFromDisk(): void {
    if (!this.durable) return
    let dropped = false
    for (const p of this.durable.load()) {
      const binding: OutcomeBinding = {
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.agentId ? { agentId: p.agentId } : {})
      }
      if (!sameConversation(binding, this.sessionOf?.(p.nodeId))) {
        dropped = true
        continue
      }
      if (this.byId.has(p.nodeId)) continue
      this.byId.set(p.nodeId, {
        nodeId: p.nodeId,
        outcome: p.outcome,
        at: p.at,
        ...(p.note ? { note: p.note } : {})
      })
      this.bindings.set(p.nodeId, binding)
    }
    this.evict()
    if (dropped) this.persist()
    this.publish(this.list())
  }

  record(rec: StationOutcomeRecord): void {
    this.byId.delete(rec.nodeId)
    this.byId.set(rec.nodeId, rec)
    const b = this.sessionOf?.(rec.nodeId)
    this.bindings.set(rec.nodeId, {
      ...(b?.sessionId ? { sessionId: b.sessionId } : {}),
      ...(b?.agentId ? { agentId: b.agentId } : {})
    })
    this.evict()
    this.changed()
  }

  /** Withdraw a station's report. `true` when there was one. */
  clear(nodeId: string): boolean {
    if (!this.byId.delete(nodeId)) return false
    this.bindings.delete(nodeId)
    this.changed()
    return true
  }

  /**
   * One normalized agent event. Only a session START matters: a node that begins a DIFFERENT
   * session (or now runs a different agent) than the one its report was made in no longer speaks
   * with that report's voice — withdraw it. Any other event, and a start naming no session, changes
   * nothing (a subagent's stop can name the child's session; only a start is the node's own).
   */
  onAgentEvent(e: {
    nodeId?: string
    sessionPhase?: string
    sessionId?: string
    agentId?: string
    subagentType?: string
  }): void {
    // A child's own session events (grok) name the CHILD's session, never the node's.
    if (!e?.nodeId || e.sessionPhase !== 'start' || e.subagentType) return
    const binding = this.bindings.get(e.nodeId)
    if (!binding || !this.byId.has(e.nodeId)) return
    const current: OutcomeBinding = {
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.agentId ? { agentId: e.agentId } : {})
    }
    if (!sameConversation(binding, current)) this.clear(e.nodeId)
  }

  private evict(): void {
    while (this.byId.size > STATION_OUTCOME_MAX_RECORDS) {
      const oldest = this.byId.keys().next().value
      if (oldest === undefined) break
      this.byId.delete(oldest)
      this.bindings.delete(oldest)
    }
  }

  private changed(): void {
    this.persist()
    this.publish(this.list())
  }

  private persist(): void {
    if (!this.durable) return
    const out: PersistedOutcome[] = []
    for (const rec of this.byId.values()) {
      const b = this.bindings.get(rec.nodeId)
      out.push({
        nodeId: rec.nodeId,
        outcome: rec.outcome,
        at: rec.at,
        ...(rec.note ? { note: rec.note } : {}),
        ...(b?.sessionId ? { sessionId: b.sessionId } : {}),
        ...(b?.agentId ? { agentId: b.agentId } : {})
      })
    }
    this.durable.save(out)
  }

  /** Withdraw a station's report if it was made BEFORE `at` — new work landed at `at`, so only a
   *  report made after it can be about that work. `true` when one was withdrawn. */
  withdrawBefore(nodeId: string, at: number): boolean {
    const rec = this.byId.get(nodeId)
    if (!rec || rec.at >= at) return false
    return this.clear(nodeId)
  }

  /**
   * The messaging layer's hand-over events (`AgentMessagingDeps.onHandover`). Only `send` and
   * `reply` count: a board comment is a person steering (like typing in the pane), and a station
   * notice is the app telling an orchestrator something — neither is a task handed to a station.
   */
  onHandover(ev: MessageHandover): void {
    if (!HANDOVER_VERBS.has(ev.verb) || !isSafeNodeId(ev.targetNodeId)) return
    const id = ev.targetNodeId
    if (ev.phase === 'queued') {
      this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
      this.publish(this.list())
      return
    }
    if (ev.phase === 'landed') {
      this.withdrawBefore(id, ev.at)
      return
    }
    // settled: the queued entry is gone. One that never landed withdraws the report as well (see
    // the header); one that landed already withdrew the older reports on its `landed` event.
    const left = (this.pending.get(id) ?? 1) - 1
    if (left > 0) this.pending.set(id, left)
    else this.pending.delete(id)
    if (!ev.landed && this.byId.delete(id)) {
      this.bindings.delete(id)
      this.persist()
    }
    this.publish(this.list())
  }

  get(nodeId: string): StationOutcomeRecord | undefined {
    const rec = this.byId.get(nodeId)
    return rec && this.pending.has(nodeId) ? { ...rec, workPending: true } : rec
  }

  /** Every record, newest first, each flagged `workPending` while new work is still queued for it. */
  list(): StationOutcomeRecord[] {
    return [...this.byId.values()]
      .reverse()
      .map((rec) => (this.pending.has(rec.nodeId) ? { ...rec, workPending: true as const } : rec))
  }
}

/** The messaging verbs whose delivery hands a station new work. */
const HANDOVER_VERBS: ReadonlySet<string> = new Set(['send', 'reply'])

/**
 * The control verbs whose ANSWER marks new work landing in the node they name (`--node`): `write`
 * types into the pane right before it answers (after its confirm), and `run` answers once a held
 * launch was delivered. `send` / `reply` are NOT here — their answer can be `queued`, long before
 * the bytes reach the pane — and are handled by the messaging layer's own hand-over events
 * (`StationOutcomeStore.onHandover`). `notify` types nothing into the pane.
 */
export const OUTCOME_CLEARING_VERBS: ReadonlySet<string> = new Set(['write', 'run'])

/**
 * Apply the "new task" rule to one finished `write` / `run`. Run by each shell's control handler on
 * the answer, and only on success: a refused write handed nothing. Withdraws only reports made
 * BEFORE `now` — the answer is when the bytes landed. A caller naming ITSELF is not handed work by
 * anyone (a station `write`-ing into its own pane is still doing its own task).
 */
export function clearOutcomesAfterControl(
  store: Pick<StationOutcomeStore, 'withdrawBefore'>,
  verb: string,
  args: Record<string, string | undefined>,
  result: { ok: boolean },
  callerNodeId: string,
  now: number = Date.now()
): void {
  if (!result.ok || !OUTCOME_CLEARING_VERBS.has(verb) || typeof args.node !== 'string') return
  for (const id of args.node.split(',').map((s) => s.trim())) {
    if (id && id !== callerNodeId && isSafeNodeId(id)) store.withdrawBefore(id, now)
  }
}

export interface ReportOutcomeDeps {
  store: StationOutcomeStore
  now(): number
  /** The station's project, for the board-log line. `undefined` = not in a saved project yet: the
   *  report is still recorded (it is what the wait reads); only the durable line is skipped. */
  projectIdOfNode(nodeId: string): string | undefined
  appendBoardLog(projectId: string, entry: BoardLogEntry): Promise<boolean>
  newId?(): string
  /** After a record lands. The Server Edition re-evaluates its armed launches here; the desktop's
   *  renderer hears the store's push instead. */
  onRecorded?(record: StationOutcomeRecord): void
}

export interface ReportOutcomeReply {
  ok: boolean
  message?: string
  error?: string
  result?: unknown
}

const RELEASE_TEXT: Record<StationOutcome, string> = {
  succeeded:
    'Nodes opened with --after-success on you start once your turn ends (and their other waits are met).',
  failed:
    'Nodes opened with --after-success on you stay held — they will not start on this. If the task is ' +
    'retried, report again when it ends.'
}

/**
 * `report-outcome`, answered in the shell's control handler (main on the desktop, never forwarded to
 * the renderer). The caller is the VERIFIED node the request came from — the hook server refuses an
 * unverified one before any handler runs, and this is the belt — and it may report only about
 * itself (`parseReportOutcome`).
 */
export async function handleReportOutcome(
  req: { nodeId: string; args: Record<string, string>; verified: boolean },
  deps: ReportOutcomeDeps
): Promise<ReportOutcomeReply> {
  const refuse = (error: string): ReportOutcomeReply => ({ ok: false, error, message: error })
  if (!req.verified) return refuse(REPORT_OUTCOME_CONTROL_REFUSAL)
  if (!isSafeNodeId(req.nodeId)) return refuse(REPORT_OUTCOME_CONTROL_REFUSAL)
  const parsed = parseReportOutcome(req.args, req.nodeId)
  if (!parsed.ok) return refuse(parsed.error)
  const at = deps.now()
  const record: StationOutcomeRecord = {
    nodeId: req.nodeId,
    outcome: parsed.outcome,
    at,
    ...(parsed.note ? { note: parsed.note } : {})
  }
  deps.store.record(record)
  const projectId = deps.projectIdOfNode(req.nodeId)
  let logged = false
  if (projectId) {
    const entry: BoardLogEntry = {
      id: deps.newId?.() ?? `station-reported-${req.nodeId}-${at}`,
      ts: at,
      author: OUTCOME_AUTHOR,
      nodeId: req.nodeId,
      kind: 'event',
      event: {
        type: 'station-reported',
        from: req.nodeId,
        to: parsed.outcome,
        ...(parsed.note ? { title: parsed.note } : {})
      }
    }
    logged = await deps.appendBoardLog(projectId, entry).catch(() => false)
  }
  deps.onRecorded?.(record)
  const message = [
    `recorded: your task ${parsed.outcome}${parsed.note ? ` — "${parsed.note}"` : ''}.`,
    RELEASE_TEXT[parsed.outcome],
    'It stands until you report again, or until new work handed to you through canvas control (a ' +
      'send, reply, write or run aimed at you) reaches your session. A new turn does not change it.'
  ].join(' ')
  return {
    ok: true,
    message,
    result: { nodeId: req.nodeId, outcome: parsed.outcome, at, boardLog: logged }
  }
}

/** The read channel, registered by BOTH shells. `store` is a thunk for the same reason as the
 *  station-notice channels': a shell may build its store after the platform handlers. */
export function registerStationOutcomeIpc(
  platform: Pick<CorePlatform, 'handle'>,
  store: () => StationOutcomeStore | null
): void {
  platform.handle(IPC.stationOutcomeList, () => store()?.list() ?? [])
}

/** The store's durable file (core/durable-state.ts). */
export const OUTCOME_FACT: DurableFactSpec<PersistedOutcome> = {
  kind: 'station-outcomes',
  version: 1,
  maxRecords: STATION_OUTCOME_MAX_RECORDS,
  sanitize: sanitizePersistedOutcome
}
