// A station's TASK outcome, as the station itself reports it — and the wait that holds a dependent
// until that outcome is a success (`--after-success`).
//
// WHY THIS EXISTS. `--after <ids>` releases a node when every station it waits on ends a TURN
// (`done`). A turn ending is not the work succeeding: a station can finish its turn having given
// up, having answered its own question, or having produced something broken. #521 already keeps an
// ERRORED turn (an API/model failure) from releasing dependents, but an ordinary turn that failed
// at the TASK is indistinguishable from one that succeeded — only the station knows. So the station
// says so (`report-outcome --outcome succeeded|failed`), and a dependent opened with
// `--after-success <ids>` waits for that word.
//
// This module owns everything the three places that need it must agree on — desktop main's shape
// gate, the Server Edition's parser and headless factory, the renderer's control dispatch and
// launch loop, and the load seam that sanitizes a hand-editable project file:
//   - the `report-outcome` grammar and the note's display rule,
//   - the `--after-success` / `--success-deadline` grammar and the refusals of the mixed forms,
//   - the persisted SHAPE of the hold (`pendingLaunch.afterSuccess`), validated at both seams,
//   - and the pure EVALUATION of a hold against observed facts, so the renderer's launch loop and
//     the Server Edition's `refreshArmed` cannot come to disagree about when a dependent starts.
//
// WHERE THE OUTCOME LIVES is deliberately not here: a core store per process
// (`core/station-outcome-store.ts`), transient like the agent state it sits beside. It is never
// read from a project file — `.nodeterm/project.json` is git-shared, and a success claimed in a
// file anyone can commit would release every dependent waiting on it.

import { oneLine } from './one-line'
import { parseWaitDeadlineArg } from './pr-wait'
import { runNowRequested } from './control-verbs'
import { isSafeNodeId } from './safe-id'

export type StationOutcome = 'succeeded' | 'failed'

const OUTCOMES: ReadonlySet<string> = new Set<StationOutcome>(['succeeded', 'failed'])

export function isStationOutcome(value: unknown): value is StationOutcome {
  return typeof value === 'string' && OUTCOMES.has(value)
}

/** One station's latest report. `at` is the recording process's clock. */
export interface StationOutcomeRecord {
  nodeId: string
  outcome: StationOutcome
  /** Display text only: one line, capped, controls stripped (`sanitizeOutcomeNote`). Never typed
   *  into a pane, never read as a gate. */
  note?: string
  at: number
  /** New work (a `send` / `reply`) is QUEUED for this station and has not reached it yet: this
   *  report was made before that work, so it does not count — a success wait keeps waiting. Set by
   *  the core store on what it publishes; never persisted. */
  workPending?: true
}

/** The verb a station runs about ITSELF. Named apart from `report-issue` on purpose: "report" alone
 *  sits one flag away from filing a public GitHub issue. */
export const REPORT_OUTCOME_VERB = 'report-outcome'

/** The verified-only refusal (hook-server's `verifiedRefusalFor`): one sentence, no diagnosis —
 *  an outcome nobody can attribute to the station it names is not evidence. */
export const REPORT_OUTCOME_CONTROL_REFUSAL = 'Outcome report refused.'

/** Longest note kept, in code points. Long enough for "tests pass, PR #12 opened"; short enough
 *  that `list` stays one readable line per node. */
export const OUTCOME_NOTE_MAX = 200

// Unicode FORMAT characters (bidi overrides and isolates, zero-width joiners and spaces, the BOM):
// invisible, and the bidi ones can make a note read backwards in a tooltip or a terminal. `oneLine`
// already removes every control character and line separator.
const FORMAT_CHARS = /\p{Cf}+/gu

/**
 * The note as it may be shown: one line, no control or format characters, capped, or `undefined`
 * when nothing visible is left. It reaches `list` output (read by agents), the QUEUED tooltip and the
 * board log — never a pane — so this is a display rule, not an injection defence; `oneLine` is the
 * rule every other one-line value in the app follows.
 */
export function sanitizeOutcomeNote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const flat = oneLine(raw.replace(FORMAT_CHARS, ''))
  if (!flat) return undefined
  const points = Array.from(flat)
  return points.length > OUTCOME_NOTE_MAX ? `${points.slice(0, OUTCOME_NOTE_MAX - 1).join('')}…` : flat
}

/**
 * `report-outcome --outcome succeeded|failed [--note <text>] [--node <your own id>]`.
 *
 * A node reports only about ITSELF: the caller is the verified node the request came from, and a
 * `--node` naming anyone else is refused rather than ignored — an agent that tried to report for a
 * station it opened must learn that it cannot, not believe that it did.
 */
export function parseReportOutcome(
  args: Record<string, string | undefined>,
  callerNodeId: string
): { ok: true; outcome: StationOutcome; note?: string } | { ok: false; error: string } {
  if (args.node !== undefined && args.node !== callerNodeId) {
    return {
      ok: false,
      error:
        'report-outcome-not-self: a node reports only its OWN task outcome — drop --node, or pass ' +
        'your own node id. To learn how another station did, read `list`.'
    }
  }
  const outcome = args.outcome
  if (!isStationOutcome(outcome)) {
    return {
      ok: false,
      error: `report-outcome requires --outcome succeeded|failed (got ${JSON.stringify(String(outcome ?? '')).slice(0, 40)})`
    }
  }
  const note = sanitizeOutcomeNote(args.note)
  return { ok: true, outcome, ...(note ? { note } : {}) }
}

/** One station's record out of a by-id map, read as an OWN property only — `__proto__` and
 *  `constructor` pass the node-id charset, and must never resolve to something inherited. */
export function outcomeOf(
  byId: Readonly<Record<string, StationOutcomeRecord>>,
  nodeId: string
): StationOutcomeRecord | undefined {
  return Object.prototype.hasOwnProperty.call(byId, nodeId) ? byId[nodeId] : undefined
}

/** A list of records from IPC or the browser bridge, re-checked field by field. */
export function sanitizeOutcomeRecords(raw: unknown): StationOutcomeRecord[] {
  if (!Array.isArray(raw)) return []
  const out: StationOutcomeRecord[] = []
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) continue
    if (!isStationOutcome(r.outcome)) continue
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
    const note = sanitizeOutcomeNote(r.note)
    out.push({
      nodeId: r.nodeId,
      outcome: r.outcome,
      at: r.at,
      ...(note ? { note } : {}),
      ...(r.workPending === true ? { workPending: true as const } : {})
    })
  }
  return out
}

// ── The wait (`--after-success`) ────────────────────────────────────────────────────────────

/**
 * What an armed node persists in `pendingLaunch.afterSuccess`. Every id in `deps` is ALSO in
 * `pendingLaunch.after`: a success wait is `--after` (the station's turn is over and did not error)
 * PLUS the station's reported success. Keeping the ids in `after` is what lets the dependency rope,
 * its dashed "waiting" look, the rope-delete escape and every `--after` rule apply unchanged — and
 * it is the downgrade story: a build that does not know this field still waits for the turn.
 */
export interface SuccessWaitHold {
  deps: string[]
  /** Epoch ms. Past it the node never starts on its own (▶ and `run` still start it). */
  deadlineAt: number
  /** A hold read from a project file that did not survive validation. Never satisfied. */
  invalid?: true
}

/** How many stations one open may wait on for success. */
export const SUCCESS_WAIT_MAX = 16

/** The shape a malformed persisted hold becomes: present (the node stays held), never satisfied,
 *  already past its deadline so the node reads EXPIRED and offers ▶. */
export const INVALID_SUCCESS_WAIT_HOLD: SuccessWaitHold = Object.freeze({
  deps: [],
  deadlineAt: 0,
  invalid: true
}) as SuccessWaitHold

/** "Start now" and "start once they succeed" contradict each other, exactly like `--after`. */
export const RUN_NOW_AFTER_SUCCESS_REFUSAL =
  'run-now-after-success-unsupported: --run-now cannot be combined with --after-success'

const OPEN_VERBS: ReadonlySet<string> = new Set(['open-terminal', 'open-claude', 'open-agent'])

function splitIds(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `--after-success <id,id>`: plain node ids, each named once. Nothing is repaired. */
export function parseAfterSuccessArg(raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '--after-success requires <id,id>' }
  const ids = splitIds(raw)
  if (ids.length === 0) return { ok: false, error: '--after-success requires <id,id>' }
  for (const id of ids) {
    if (!isSafeNodeId(id)) {
      return {
        ok: false,
        error: `--after-success takes plain node ids, comma-separated (got ${JSON.stringify(id).slice(0, 60)})`
      }
    }
  }
  const unique = [...new Set(ids)]
  if (unique.length > SUCCESS_WAIT_MAX) {
    return { ok: false, error: `--after-success names at most ${SUCCESS_WAIT_MAX} stations` }
  }
  return { ok: true, ids: unique }
}

/**
 * The `--after-success` / `--success-deadline` SHAPE gate, and the one refusal of the ambiguous
 * form. Desktop main runs it before forwarding (it does not run `parseControlRequest`), the Server
 * Edition inside `parseControlRequest`. Whether a named station exists and can report is each
 * shell's own question, answered against the project the node opens in.
 *
 * ONE grammar, and the other one is refused by name: a suffix on `--after` (`--after a1:ok`,
 * `--after a1:success`) reads like it might mean a success wait, and silently treating it as an
 * unknown node id would tell the caller "no such node" about a node it can see. Node ids never
 * contain `:`, so any `:` in `--after` is this mistake.
 */
export function afterSuccessFlagRefusal(verb: string, args: Record<string, string | undefined>): string | null {
  const after = args.after
  if (typeof after === 'string' && after.includes(':')) {
    return (
      `${verb}: --after takes plain node ids (got ${JSON.stringify(after).slice(0, 60)}). ` +
      'To wait for a station to REPORT SUCCESS, use --after-success <id,id>.'
    )
  }
  if (args['after-success'] === undefined) {
    return args['success-deadline'] === undefined
      ? null
      : `${verb}: --success-deadline applies only with --after-success`
  }
  if (!OPEN_VERBS.has(verb)) {
    return `${verb}: --after-success applies only to open-terminal / open-claude / open-agent`
  }
  if (verb === 'open-terminal' && !args.cmd) {
    return 'open-terminal: --after-success needs --cmd (a terminal with no command has nothing to hold)'
  }
  const parsed = parseAfterSuccessArg(args['after-success'])
  if (!parsed.ok) return `${verb}: ${parsed.error}`
  const plain = new Set(typeof after === 'string' ? splitIds(after) : [])
  const both = parsed.ids.filter((id) => plain.has(id))
  if (both.length) {
    return (
      `${verb}: name each station once — ${both.join(', ')} is in both --after and --after-success. ` +
      '--after-success already waits for its turn to end; drop it from --after.'
    )
  }
  const deadline = parseSuccessDeadlineArg(args['success-deadline'])
  if (!deadline.ok) return `${verb}: ${deadline.error}`
  if (runNowRequested(args)) return RUN_NOW_AFTER_SUCCESS_REFUSAL
  return null
}

/** `--success-deadline <90m|12h|3d>`: the same bounds and grammar as `--pr-deadline`. */
export function parseSuccessDeadlineArg(
  raw: string | undefined
): { ok: true; ms: number } | { ok: false; error: string } {
  return parseWaitDeadlineArg(raw, '--success-deadline')
}

/** The refusal for a `--after-success` station that could never report: only an agent session that
 *  runs canvas control has `report-outcome`, so waiting on anything else would hold until the
 *  deadline. Shared so both shells refuse in one sentence. */
export function successDepRefusal(verb: string, depId: string): string {
  return (
    `${verb}: --after-success ${depId} cannot report an outcome — only an agent session with canvas ` +
    'control runs report-outcome. Use --after to wait for its turn to end instead.'
  )
}

/**
 * The persisted hold, validated at both serializer seams. Absent stays absent. Anything present but
 * malformed becomes `INVALID_SUCCESS_WAIT_HOLD`, never `undefined`: dropping it would let the node
 * start on its turn-end deps alone — early, the unsafe direction.
 */
export function normalizeSuccessWaitHold(value: unknown): SuccessWaitHold | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return INVALID_SUCCESS_WAIT_HOLD
  const v = value as Record<string, unknown>
  if (v.invalid !== undefined) return INVALID_SUCCESS_WAIT_HOLD
  if (!Array.isArray(v.deps) || v.deps.length === 0 || v.deps.length > SUCCESS_WAIT_MAX) {
    return INVALID_SUCCESS_WAIT_HOLD
  }
  const deps: string[] = []
  for (const d of v.deps as unknown[]) {
    if (typeof d !== 'string' || !isSafeNodeId(d) || deps.includes(d)) return INVALID_SUCCESS_WAIT_HOLD
    deps.push(d)
  }
  if (typeof v.deadlineAt !== 'number' || !Number.isFinite(v.deadlineAt)) return INVALID_SUCCESS_WAIT_HOLD
  return { deps, deadlineAt: v.deadlineAt }
}

/** An invalid hold (read from a corrupt or hostile file) is already past its deadline. */
export function successWaitExpired(hold: SuccessWaitHold, now: number): boolean {
  return !!hold.invalid || now >= hold.deadlineAt
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────────

/** What the caller observed about ONE station a hold waits on. */
export interface SuccessDepFacts {
  /** The station is still on the canvas. */
  exists: boolean
  /** Its last turn is over and did not end on an error — `--after`'s own rule, whatever the shell
   *  counts as that (`depSatisfied` on the desktop, `stateOf === 'done'` on the Server Edition). */
  turnDone: boolean
  /** Its latest report, if any (durable across a restart, bound to its session). */
  outcome?: Pick<StationOutcomeRecord, 'outcome' | 'note' | 'workPending'>
}

export type SuccessDepState = 'met' | 'waiting' | 'blocked'

export interface SuccessDepReport {
  id: string
  state: SuccessDepState
  /** Short, human: what is true about this station right now. Never a cause nobody observed. */
  detail: string
}

/**
 * One station's verdict.
 *
 *  - `failed` BLOCKS: the dependent never fires on it, whatever else happens, until the station
 *    reports again (or is handed new work, which withdraws the report) — or the deadline passes and
 *    a human or an agent runs it on purpose.
 *  - `succeeded` is met once the station's turn is over, so a dependent that reads the station's
 *    work (get-linked-context) reads a finished transcript — the same idle edge `--after` uses.
 *  - no report yet: waiting. "No news" is never success; that is the whole point of the wait.
 *  - a DELETED station: met only if it reported success before it went (a closed station can never
 *    report again, and closing one is exactly how an orchestrator abandons a failed attempt — reading
 *    the deletion as success, which is `--after`'s rule, would release dependents on a failure).
 *    Closed without a success report ⇒ blocked, with the deadline and ▶ as the way out. Reports
 *    survive an app restart (core/station-outcome-store.ts), bound to the session that made them.
 *  - a report made before new work that is still QUEUED for the station (`workPending`) is no
 *    report: it speaks for the task before, and the station has not even received the next one.
 */
export function evaluateSuccessDep(id: string, facts: SuccessDepFacts): SuccessDepReport {
  const r = (state: SuccessDepState, detail: string): SuccessDepReport => ({ id, state, detail })
  if (facts.outcome?.workPending) {
    return facts.exists
      ? r('waiting', 'new work is queued for it; waiting for its next report')
      : r('blocked', 'closed while new work was queued for it')
  }
  const reported = facts.outcome
  if (reported?.outcome === 'failed') {
    return r('blocked', `reported failure${reported.note ? `: "${reported.note}"` : ''}`)
  }
  if (reported?.outcome === 'succeeded') {
    if (facts.exists && !facts.turnDone) return r('waiting', 'reported success; waiting for its turn to end')
    return r('met', 'reported success')
  }
  return facts.exists
    ? r('waiting', 'no outcome reported yet')
    : r('blocked', 'closed without reporting success')
}

export function successWaitReports(
  hold: SuccessWaitHold,
  factsOf: (id: string) => SuccessDepFacts
): SuccessDepReport[] {
  return hold.deps.map((id) => evaluateSuccessDep(id, factsOf(id)))
}

/** EVERY station met, the hold readable, and the deadline not passed. */
export function successWaitSatisfied(
  hold: SuccessWaitHold,
  factsOf: (id: string) => SuccessDepFacts,
  now: number
): boolean {
  if (successWaitExpired(hold, now) || hold.deps.length === 0) return false
  return successWaitReports(hold, factsOf).every((d) => d.state === 'met')
}

/** The one-word state `list`, the badge and the tooltip speak. Expiry first: past the deadline the
 *  node will not start on its own whatever its stations did, and the answer is `run` / ▶. */
export type SuccessWaitStatus = 'met' | 'waiting' | 'blocked' | 'expired'

export function successWaitStatus(
  hold: SuccessWaitHold,
  factsOf: (id: string) => SuccessDepFacts,
  now: number
): SuccessWaitStatus {
  if (successWaitExpired(hold, now)) return 'expired'
  const reports = successWaitReports(hold, factsOf)
  if (reports.some((d) => d.state === 'blocked')) return 'blocked'
  return reports.every((d) => d.state === 'met') ? 'met' : 'waiting'
}

/** "a1 (reported failure: "tests red"); a2 (no outcome reported yet)" — the unmet stations only.
 *  `name` turns an id into what a reader recognises (a node title), defaulting to the id. */
export function successWaitSummary(
  hold: SuccessWaitHold,
  factsOf: (id: string) => SuccessDepFacts,
  name: (id: string) => string = (id) => id
): string {
  return successWaitReports(hold, factsOf)
    .filter((d) => d.state !== 'met')
    .map((d) => `${name(d.id)} (${d.detail})`)
    .join('; ')
}
