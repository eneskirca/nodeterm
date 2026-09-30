// `--after-pr`: an armed node that ALSO waits on pull requests of its project's GitHub board.
//
// `--after <ids>` releases a node when upstream agent stations finish a turn. That covers "B needs
// what A produced" inside the canvas, but not "start the reviewer once CI is green" or "start the
// release notes once the PR is merged", which are facts about GitHub. This module owns the GRAMMAR
// of that flag and the persisted SHAPE of the hold, and is shared by the three places that read
// them: main's shape gate (and the Server Edition's parser, which then refuses the flag by name),
// the renderer's control dispatch, and the load seam that sanitizes a hand-editable project file.
// When a hold is SATISFIED is the renderer's question (`renderer/lib/prWait.ts`), answered from
// the pull request status #1008 already keeps — nothing here reads GitHub.
//
// Grammar: `--after-pr <ref>:<checks|merged>[,<ref>:<checks|merged>…]`, where `<ref>` is `N`,
// `#N` or `owner/repo#N` (which must be the board's own repository). One flag carries one whole
// condition, so there is no second flag to pair with it, and every flag has a value — the SSH shim
// rule (an older shim on a host takes the token after ANY flag as its value). `N` needs no quoting;
// an unquoted `#N` at the start of a shell word begins a comment and swallows the rest of the line.

import { runNowRequested } from './control-verbs'
import { parseRepository } from './github-issue-ref'

export type PrWaitUntil = 'checks' | 'merged'

const UNTIL: ReadonlySet<string> = new Set<PrWaitUntil>(['checks', 'merged'])

/** One parsed `--after-pr` item. `repository` is present only when the caller wrote the full form. */
export interface PrWaitSpec {
  number: number
  until: PrWaitUntil
  repository?: string
}

export interface PrWait {
  number: number
  until: PrWaitUntil
}

/** What an armed node persists in `pendingLaunch.afterPr`. */
export interface PrWaitHold {
  /** `owner/name` the numbers belong to: the board's repository when the node was armed. A board
   *  that later syncs another repository cannot satisfy this hold. */
  repository: string
  waits: PrWait[]
  /** Epoch ms on this machine's clock. Past it the node never starts on its own (▶ still runs it). */
  deadlineAt: number
  /** Epoch ms on the HOST clock (the one GitHub status reads are stamped with) when the wait was
   *  armed. `checks` is judged only on a read that started at or after it: the host may still
   *  remember "passed" for the head before a push made just before arming. */
  armedAt: number
  /** A hold read from a project file that did not survive validation. Never satisfied. */
  invalid?: true
}

/** How many pull requests one open may wait on. */
export const PR_WAIT_MAX = 8
export const PR_DEADLINE_DEFAULT_MS = 24 * 3_600_000
export const PR_DEADLINE_MIN_MS = 60_000
export const PR_DEADLINE_MAX_MS = 14 * 86_400_000

/** The shape a malformed persisted hold becomes: present (the node stays held), never satisfied,
 *  already past its deadline so the node reads EXPIRED and offers ▶. */
export const INVALID_PR_WAIT_HOLD: PrWaitHold = Object.freeze({
  repository: '',
  waits: [],
  deadlineAt: 0,
  armedAt: 0,
  invalid: true
}) as PrWaitHold

/** "Start now" and "start when the pull request is ready" contradict each other, exactly like
 *  `--run-now` with `--after`. */
export const RUN_NOW_AFTER_PR_REFUSAL =
  'run-now-after-pr-unsupported: --run-now cannot be combined with --after-pr'

const FORMS = 'N:checks or N:merged (N may be #N or owner/repo#N), comma-separated'

// The repository a hold names is a STORED value, so it is read with the one owner/name grammar
// (`parseRepository` over GITHUB_OWNER_PATTERN): what GitHub has actually issued, `john-` and
// `hello--world` included. A narrower rule would turn every hold on such a repository invalid on
// load and write it out that way on save.
const NUMBER = /^[1-9][0-9]{0,9}$/
const MAX_NUMBER = 2 ** 31 - 1

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_NUMBER
}

function parseNumber(text: string): number | undefined {
  if (!NUMBER.test(text)) return undefined
  const n = Number(text)
  return validNumber(n) ? n : undefined
}

/** `N`, `#N` or `owner/repo#N`. Nothing is repaired: a guess could only name the wrong PR. */
function parseRef(text: string): { number: number; repository?: string } | undefined {
  const hash = text.indexOf('#')
  if (hash < 0) {
    const number = parseNumber(text)
    return number === undefined ? undefined : { number }
  }
  if (text.indexOf('#', hash + 1) >= 0) return undefined
  const number = parseNumber(text.slice(hash + 1))
  if (number === undefined) return undefined
  if (hash === 0) return { number }
  const repo = parseRepository(text.slice(0, hash))
  return repo ? { number, repository: `${repo.owner}/${repo.repo}` } : undefined
}

export function parseAfterPrArg(
  raw: unknown
): { ok: true; specs: PrWaitSpec[] } | { ok: false; error: string } {
  const bad = (): { ok: false; error: string } => ({
    ok: false,
    error: `--after-pr must be ${FORMS} (got ${JSON.stringify(String(raw ?? '')).slice(0, 80)})`
  })
  if (typeof raw !== 'string') return bad()
  const items = raw.split(',').map((item) => item.trim())
  const specs: PrWaitSpec[] = []
  for (const item of items) {
    const colon = item.lastIndexOf(':')
    if (colon <= 0) return bad()
    const until = item.slice(colon + 1)
    if (!UNTIL.has(until)) return bad()
    const ref = parseRef(item.slice(0, colon))
    if (!ref) return bad()
    specs.push({ number: ref.number, until: until as PrWaitUntil, ...(ref.repository ? { repository: ref.repository } : {}) })
  }
  if (specs.length > PR_WAIT_MAX) {
    return { ok: false, error: `--after-pr names at most ${PR_WAIT_MAX} pull requests` }
  }
  if (new Set(specs.map((s) => s.number)).size !== specs.length) {
    return { ok: false, error: '--after-pr: name each pull request once' }
  }
  return { ok: true, specs }
}

const DURATION = /^([1-9][0-9]{0,4})([mhd])$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * A wait's deadline flag (`90m`, `12h`, `3d`), 1 minute to 14 days; absent = 24 h. Refused, not
 * clamped: a caller who asked for a month would otherwise be told nothing about getting two weeks.
 * ONE grammar for every held-launch deadline (`--pr-deadline`, `--success-deadline`), so the two
 * flags cannot come to accept different spellings or bounds.
 */
export function parseWaitDeadlineArg(
  raw: string | undefined,
  flag: string
): { ok: true; ms: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, ms: PR_DEADLINE_DEFAULT_MS }
  const m = DURATION.exec(raw)
  const ms = m ? Number(m[1]) * UNIT_MS[m[2]] : NaN
  if (!m || ms < PR_DEADLINE_MIN_MS || ms > PR_DEADLINE_MAX_MS) {
    return {
      ok: false,
      error: `${flag} must be a duration like 90m, 12h or 3d, between 1m and 14d (got ${JSON.stringify(raw).slice(0, 40)})`
    }
  }
  return { ok: true, ms }
}

/** `--pr-deadline <duration>`: see `parseWaitDeadlineArg`. */
export function parsePrDeadlineArg(
  raw: string | undefined
): { ok: true; ms: number } | { ok: false; error: string } {
  return parseWaitDeadlineArg(raw, '--pr-deadline')
}

const OPEN_VERBS: ReadonlySet<string> = new Set(['open-terminal', 'open-claude', 'open-agent'])

/**
 * The `--after-pr` / `--pr-deadline` SHAPE gate. Desktop main runs it in its control handler before
 * forwarding (it does not run `parseControlRequest`), the Server Edition inside
 * `parseControlRequest` — which then refuses the well-formed flag as unsupported, since that
 * edition keeps no pull request watch. What a number MEANS (does the board's repository have that
 * pull request?) is the renderer's question; this is the early half, never the only one.
 */
export function afterPrFlagRefusal(verb: string, args: Record<string, string | undefined>): string | null {
  if (args['after-pr'] === undefined) {
    return args['pr-deadline'] === undefined ? null : `${verb}: --pr-deadline applies only with --after-pr`
  }
  if (!OPEN_VERBS.has(verb)) {
    return `${verb}: --after-pr applies only to open-terminal / open-claude / open-agent`
  }
  // A terminal with no `--cmd` has no launch to hold, so a reply saying it waits would be untrue.
  if (verb === 'open-terminal' && !args.cmd) {
    return 'open-terminal: --after-pr needs --cmd (a terminal with no command has nothing to hold)'
  }
  const parsed = parseAfterPrArg(args['after-pr'])
  if (!parsed.ok) return `${verb}: ${parsed.error}`
  const deadline = parsePrDeadlineArg(args['pr-deadline'])
  if (!deadline.ok) return `${verb}: ${deadline.error}`
  if (runNowRequested(args)) return RUN_NOW_AFTER_PR_REFUSAL
  return null
}

/**
 * The persisted hold, validated at both serializer seams. Absent stays absent. Anything present
 * but malformed becomes `INVALID_PR_WAIT_HOLD`, never `undefined`: dropping it would let the node
 * start on its `--after` deps alone — early, the unsafe direction. Only vouched-for fields survive.
 */
export function normalizePrWaitHold(value: unknown): PrWaitHold | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return INVALID_PR_WAIT_HOLD
  const v = value as Record<string, unknown>
  if (v.invalid !== undefined) return INVALID_PR_WAIT_HOLD
  const repo = parseRepository(v.repository)
  if (!repo) return INVALID_PR_WAIT_HOLD
  if (!Array.isArray(v.waits) || v.waits.length === 0 || v.waits.length > PR_WAIT_MAX) {
    return INVALID_PR_WAIT_HOLD
  }
  const waits: PrWait[] = []
  for (const w of v.waits as unknown[]) {
    if (!w || typeof w !== 'object') return INVALID_PR_WAIT_HOLD
    const { number, until } = w as Record<string, unknown>
    if (!validNumber(number) || typeof until !== 'string' || !UNTIL.has(until)) return INVALID_PR_WAIT_HOLD
    if (waits.some((x) => x.number === number)) return INVALID_PR_WAIT_HOLD
    waits.push({ number, until: until as PrWaitUntil })
  }
  if (typeof v.deadlineAt !== 'number' || !Number.isFinite(v.deadlineAt)) return INVALID_PR_WAIT_HOLD
  if (typeof v.armedAt !== 'number' || !Number.isFinite(v.armedAt)) return INVALID_PR_WAIT_HOLD
  return { repository: `${repo.owner}/${repo.repo}`, waits, deadlineAt: v.deadlineAt, armedAt: v.armedAt }
}

/** "PR #12 checks, PR #13 merged" — the one wording for replies, the badge and `list`. */
export function formatPrWaits(hold: Pick<PrWaitHold, 'waits'>): string {
  return hold.waits.map((w) => `PR #${w.number} ${w.until}`).join(', ')
}
