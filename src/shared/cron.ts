/**
 * A small, dependency-free cron matcher for trigger nodes (issue #493) — the ONE parser both the
 * core scheduler (fire times) and the renderer (next-run display, phase 4) ask, so the two can
 * never disagree about when a schedule fires.
 *
 * Grammar: classic five fields (minute hour day-of-month month day-of-week), each a comma list of
 * `*`, `N`, `A-B`, with an optional `/step` on any part; month and day-of-week accept the usual
 * three-letter names (jan…dec, sun…sat) and dow `7` is Sunday (normalized to 0). No `@daily`
 * aliases, no seconds field, no wrapping ranges (`22-2` is refused) — a grammar this small is one
 * that can be tested exhaustively, and `parseCron` returning `null` is the SAFE outcome: an
 * unparseable expression schedules nothing (the trigger card will say "invalid schedule"), it
 * never half-runs. Same degrade rule as everything else fed from `.nodeterm/project.json`.
 *
 * Vixie-cron's day rule is honored: when BOTH day-of-month and day-of-week are restricted
 * (their raw field is not `*`), a day matches if EITHER matches — `0 9 15 * mon` fires on the
 * 15th AND on Mondays. This is the classic trap a naive AND implementation silently gets wrong.
 *
 * Times are LOCAL wall-clock, computed by scanning real timestamps and asking each for its local
 * fields — which is what makes DST behave sanely without a timezone library. Two documented
 * edges, both matching what classic cron daemons do: a wall time that does not exist on
 * spring-forward day is skipped, and a wall time that occurs twice on fall-back day can match
 * both instants (the scheduler fires the first it reaches).
 */

export interface CronSchedule {
  minute: boolean[]
  hour: boolean[]
  /** Index 1-31. */
  dom: boolean[]
  /** Index 1-12. */
  month: boolean[]
  /** Index 0-6, Sunday = 0 (an input 7 is normalized). */
  dow: boolean[]
  /** Raw field was not `*` — feeds the vixie OR rule above. */
  domRestricted: boolean
  dowRestricted: boolean
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
}

interface FieldRule {
  min: number
  max: number
  names?: Record<string, number>
  /** dow: 7 means Sunday. */
  normalize?: (n: number) => number
}

function parseValue(token: string, rule: FieldRule): number | null {
  const named = rule.names?.[token.toLowerCase()]
  if (named !== undefined) return named
  if (!/^\d+$/.test(token)) return null
  const n = Number(token)
  const v = rule.normalize ? rule.normalize(n) : n
  return v >= rule.min && v <= rule.max ? v : null
}

/** One comma-part: `*`, `N`, `A-B`, each optionally `/step`. Returns false on any refusal. */
function applyPart(part: string, rule: FieldRule, out: boolean[]): boolean {
  const [rangeRaw, stepRaw, extra] = part.split('/')
  if (extra !== undefined || rangeRaw === '') return false
  let step = 1
  if (stepRaw !== undefined) {
    if (!/^\d+$/.test(stepRaw)) return false
    step = Number(stepRaw)
    if (step < 1) return false
  }
  let lo: number
  let hi: number
  if (rangeRaw === '*') {
    lo = rule.min
    hi = rule.max
  } else if (rangeRaw.includes('-')) {
    const [a, b, more] = rangeRaw.split('-')
    if (more !== undefined) return false
    const va = parseValue(a, rule)
    const vb = parseValue(b, rule)
    if (va === null || vb === null || va > vb) return false
    lo = va
    hi = vb
  } else {
    const v = parseValue(rangeRaw, rule)
    if (v === null) return false
    // A bare value with a step (`5/15`) is vixie's "from 5 to max, every 15".
    if (stepRaw !== undefined) {
      lo = v
      hi = rule.max
    } else {
      out[v] = true
      return true
    }
  }
  for (let v = lo; v <= hi; v += step) out[v] = true
  return true
}

function parseField(field: string, rule: FieldRule, size: number): boolean[] | null {
  const out = new Array<boolean>(size).fill(false)
  for (const part of field.split(',')) {
    if (!applyPart(part, rule, out)) return null
  }
  return out
}

const DOW_RULE: FieldRule = { min: 0, max: 6, names: DOW_NAMES, normalize: (n) => (n === 7 ? 0 : n) }

/** Parse a five-field cron expression; `null` = refused (schedules nothing). */
export function parseCron(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0], { min: 0, max: 59 }, 60)
  const hour = parseField(fields[1], { min: 0, max: 23 }, 24)
  const dom = parseField(fields[2], { min: 1, max: 31 }, 32)
  const month = parseField(fields[3], { min: 1, max: 12, names: MONTH_NAMES }, 13)
  const dow = parseField(fields[4], DOW_RULE, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  return {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*'
  }
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  const domHit = s.dom[d.getDate()]
  const dowHit = s.dow[d.getDay()]
  if (s.domRestricted && s.dowRestricted) return domHit || dowHit
  if (s.domRestricted) return domHit
  if (s.dowRestricted) return dowHit
  return true
}

/** Default search horizon. `0 0 30 2 *` (Feb 30) never matches; a bound turns that into `null`
 *  instead of an unbounded scan. 366 days covers every real yearly schedule. */
export const CRON_HORIZON_MS = 366 * 24 * 60 * 60 * 1000

/**
 * The first firing time STRICTLY AFTER `fromMs`, as epoch ms, or `null` when none exists within
 * the horizon. Scans day → hour → minute with skipping (a non-matching month jumps to the next
 * month's first day, a non-matching day to the next midnight, a non-matching hour to the next
 * hour), so the worst case is a few hundred steps, not half a million.
 */
export function nextCronFire(
  schedule: CronSchedule,
  fromMs: number,
  horizonMs: number = CRON_HORIZON_MS
): number | null {
  const t = new Date(fromMs)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const end = fromMs + horizonMs
  while (t.getTime() <= end) {
    if (!schedule.month[t.getMonth() + 1]) {
      t.setDate(1)
      t.setHours(0, 0, 0, 0)
      t.setMonth(t.getMonth() + 1)
      continue
    }
    if (!dayMatches(schedule, t)) {
      t.setHours(0, 0, 0, 0)
      t.setDate(t.getDate() + 1)
      continue
    }
    if (!schedule.hour[t.getHours()]) {
      t.setMinutes(0, 0, 0)
      t.setHours(t.getHours() + 1)
      continue
    }
    if (!schedule.minute[t.getMinutes()]) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }
    return t.getTime()
  }
  return null
}
