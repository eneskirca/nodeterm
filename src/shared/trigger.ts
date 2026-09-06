/**
 * The persisted shape + validation rules of a `trigger` node — a canvas-owned schedule that fires
 * a payload into a connected terminal/agent node (issue #493).
 *
 * TRUST MODEL, stated once because every rule below follows from it: the spec lives on the node in
 * `.nodeterm/project.json`, which is HOSTILE input — git-shared, hand-editable, auto-adopted by
 * "Open folder…", and for an SSH project it lives on the remote host (see @shared/node-exec for
 * the precedent). A trigger definition alone must therefore NEVER cause execution. Firing
 * additionally requires a MACHINE-LOCAL arm record (`core/trigger-arm-store.ts`) that binds this
 * machine's consent to the exact spec content on screen when the user armed it
 * (`canonicalTriggerSpec`). A spec that arrives — or silently changes — via git pull is visible
 * but inert until someone on this machine arms it (again).
 *
 * Two consequences for the shape rules here:
 *  - `sanitizeTriggerSpec` REBUILDS the object from known fields only, so a file cannot smuggle
 *    extra keys (an `armed: true`, a prototype-polluting key) through a load/save round trip.
 *  - Anything malformed degrades to `undefined` = an inert node with no spec — never a crash,
 *    never a "nearest match" repair that silently changes what would run (the same rule as
 *    `permissionModeFlag`: an unrecognized value yields the safe nothing).
 */

import { isSafeNodeId } from './safe-id'

/** When the trigger fires. `cron` grammar is validated by the scheduler (the one parser is the
 *  authority); here only shape/charset/size are enforced, so an expression the parser refuses
 *  renders as "invalid schedule" instead of half-running. */
export type TriggerSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'once'; at: string }

export interface TriggerSpec {
  schedule: TriggerSchedule
  /**
   * Delivered into the target's pane via the `sendText` paste path when the trigger fires (multi-
   * line is fine — `paste-buffer -p` frames it). Content-validated here AND re-sanitized at the
   * delivery site: schema acceptance is not an execution license.
   */
  payload: string
  /** Node id of the terminal/agent node the payload is delivered to. */
  target: string
  /** Optional human note shown on the card. */
  note?: string
}

/** Same cap as BOARD_LOG_TEXT_MAX — far beyond any real prompt, small enough to bound. */
export const TRIGGER_PAYLOAD_MAX = 16_384
export const TRIGGER_CRON_MAX = 256
export const TRIGGER_NOTE_MAX = 500
export const TRIGGER_ONCE_AT_MAX = 64
export const TRIGGER_INTERVAL_MIN_MINUTES = 1
/** One year. An interval is minutes-granular like cron; anything longer is a `once`. */
export const TRIGGER_INTERVAL_MAX_MINUTES = 366 * 24 * 60

/** Printable ASCII only — a cron expression is ASCII by definition, and this keeps control
 *  sequences out of a string that gets rendered and logged. */
const CRON_CHARSET = /^[\x20-\x7e]+$/

/**
 * C0 control characters except \t \n \r, plus DEL. A payload is something the user typed to run
 * in a pane; a raw ESC/C0 byte in it is either an accident or a terminal-injection attempt
 * (bracketed-paste escapes), so the whole spec is refused rather than silently rewritten.
 * The delivery path strips again at the interpolation site — this is the schema's half.
 */
const PAYLOAD_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function sanitizeSchedule(value: unknown): TriggerSchedule | undefined {
  if (!value || typeof value !== 'object') return undefined
  const s = value as { kind?: unknown; expr?: unknown; everyMinutes?: unknown; at?: unknown }
  if (s.kind === 'cron') {
    if (typeof s.expr !== 'string') return undefined
    const expr = s.expr.trim()
    if (!expr || expr.length > TRIGGER_CRON_MAX || !CRON_CHARSET.test(expr)) return undefined
    return { kind: 'cron', expr }
  }
  if (s.kind === 'interval') {
    const m = s.everyMinutes
    if (typeof m !== 'number' || !Number.isInteger(m)) return undefined
    if (m < TRIGGER_INTERVAL_MIN_MINUTES || m > TRIGGER_INTERVAL_MAX_MINUTES) return undefined
    return { kind: 'interval', everyMinutes: m }
  }
  if (s.kind === 'once') {
    if (typeof s.at !== 'string' || !s.at || s.at.length > TRIGGER_ONCE_AT_MAX) return undefined
    if (!Number.isFinite(Date.parse(s.at))) return undefined
    return { kind: 'once', at: s.at }
  }
  return undefined
}

/**
 * Strict shape rule for a trigger spec read from ANY untrusted carrier (the project file, the
 * ssh cache, a wire frame). Returns a REBUILT object holding only the known fields, or
 * `undefined` when any required part fails — the caller drops the spec and the node is inert.
 * An invalid optional `note` is dropped alone (it never executes anything).
 */
export function sanitizeTriggerSpec(value: unknown): TriggerSpec | undefined {
  if (!value || typeof value !== 'object') return undefined
  const t = value as { schedule?: unknown; payload?: unknown; target?: unknown; note?: unknown }
  const schedule = sanitizeSchedule(t.schedule)
  if (!schedule) return undefined
  if (typeof t.payload !== 'string' || !t.payload || t.payload.length > TRIGGER_PAYLOAD_MAX)
    return undefined
  if (PAYLOAD_FORBIDDEN.test(t.payload)) return undefined
  if (typeof t.target !== 'string' || !isSafeNodeId(t.target)) return undefined
  const note =
    typeof t.note === 'string' && t.note.length > 0 && t.note.length <= TRIGGER_NOTE_MAX
      ? t.note
      : undefined
  return {
    schedule,
    payload: t.payload,
    target: t.target,
    ...(note !== undefined ? { note } : {})
  }
}

/**
 * Deterministic serialization of a spec, used as the ARM BINDING: the machine-local arm store
 * records this string at arm time, and the scheduler fires only while the node's CURRENT spec
 * canonicalizes to the same string. That is what turns "arm once" into consent for one exact
 * payload/schedule/target — a git pull that edits any of them lands the trigger back in the
 * disarmed state instead of running the new content under the old consent.
 *
 * Determinism comes from construction (fixed key order, no reliance on input key order), so it
 * must only ever be fed a spec that went through `sanitizeTriggerSpec` — enforce that at the
 * call site rather than re-validating here.
 */
/**
 * `fired`/`missed`/`failed` come straight back from a fire attempt; `queued` means the target was
 * busy and the payload waits in the deliver-on-idle queue, whose late outcomes are
 * `delivered-late` / `expired` (plus a `missed` for a target that went away, or a trigger
 * disarmed/edited while queued). Shared because the card renders the history the core records.
 */
export type TriggerRunOutcome =
  | 'fired'
  | 'failed'
  | 'missed'
  | 'queued'
  | 'delivered-late'
  | 'expired'

export interface TriggerRun {
  at: number
  outcome: TriggerRunOutcome
  detail?: string
}

/** What `triggers:status` answers — everything the card needs in one read. */
export interface TriggerNodeStatus {
  /** Armed on THIS machine for the node's CURRENT content. */
  armed: boolean
  /** An arm record exists but for DIFFERENT content — "changed since armed", not "never armed". */
  armedForOtherContent: boolean
  /** Next due time (epoch ms), or null (disarmed schedules still compute; invalid/spent = null). */
  nextFireAt: number | null
  runs: TriggerRun[]
}

/** Human-readable schedule line for the card ("every 30 min", "once at …", the cron expr). */
export function describeTriggerSchedule(schedule: TriggerSchedule): string {
  if (schedule.kind === 'interval') {
    const m = schedule.everyMinutes
    if (m % 60 === 0) {
      const h = m / 60
      return h === 1 ? 'every hour' : `every ${h} hours`
    }
    return m === 1 ? 'every minute' : `every ${m} minutes`
  }
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at)
    return Number.isFinite(at) ? `once at ${new Date(at).toLocaleString()}` : 'once (invalid time)'
  }
  return `cron ${schedule.expr}`
}

export function canonicalTriggerSpec(spec: TriggerSpec): string {
  const s = spec.schedule
  const schedule =
    s.kind === 'cron'
      ? { kind: s.kind, expr: s.expr }
      : s.kind === 'interval'
        ? { kind: s.kind, everyMinutes: s.everyMinutes }
        : { kind: s.kind, at: s.at }
  return JSON.stringify({
    schedule,
    payload: spec.payload,
    target: spec.target,
    ...(spec.note !== undefined ? { note: spec.note } : {})
  })
}
