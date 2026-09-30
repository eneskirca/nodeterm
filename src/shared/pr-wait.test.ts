import { describe, expect, it } from 'vitest'
import {
  INVALID_PR_WAIT_HOLD,
  PR_DEADLINE_DEFAULT_MS,
  PR_DEADLINE_MAX_MS,
  PR_WAIT_MAX,
  RUN_NOW_AFTER_PR_REFUSAL,
  afterPrFlagRefusal,
  formatPrWaits,
  normalizePrWaitHold,
  parseAfterPrArg,
  parsePrDeadlineArg
} from './pr-wait'
import { LAUNCH_PROMPT_TTL_MS } from './launch-prompt'

describe('parseAfterPrArg — the --after-pr grammar', () => {
  it('reads N:checks and N:merged', () => {
    expect(parseAfterPrArg('1008:checks')).toEqual({ ok: true, specs: [{ number: 1008, until: 'checks' }] })
    expect(parseAfterPrArg('1008:merged')).toEqual({ ok: true, specs: [{ number: 1008, until: 'merged' }] })
  })

  it('accepts #N — quoted on the command line, since an unquoted leading # starts a shell comment', () => {
    expect(parseAfterPrArg('#12:merged')).toEqual({ ok: true, specs: [{ number: 12, until: 'merged' }] })
  })

  it('accepts owner/repo#N and keeps the repository for the caller to compare', () => {
    expect(parseAfterPrArg('eneskirca/nodeterm#1008:checks')).toEqual({
      ok: true,
      specs: [{ number: 1008, until: 'checks', repository: 'eneskirca/nodeterm' }]
    })
  })

  it('reads a comma list, every condition must hold', () => {
    expect(parseAfterPrArg('12:checks, 13:merged')).toEqual({
      ok: true,
      specs: [
        { number: 12, until: 'checks' },
        { number: 13, until: 'merged' }
      ]
    })
  })

  it.each([
    ['', 'empty'],
    ['1008', 'no condition'],
    ['1008:', 'empty condition'],
    ['1008:green', 'unknown condition'],
    ['1008:Merged', 'case is not repaired'],
    ['0:merged', 'zero'],
    ['-3:merged', 'negative'],
    ['12a:merged', 'not a number'],
    ['owner/repo:merged', 'no number'],
    ['owner/re po#3:merged', 'bad repository'],
    ['1,2:merged', 'an item without a condition'],
    ['12:merged,,13:merged', 'an empty item'],
    ['12:merged;rm -rf /', 'trailing garbage']
  ])('refuses %j (%s) and names the accepted forms', (raw) => {
    const r = parseAfterPrArg(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/--after-pr must be/)
  })

  it('refuses a non-string (a hostile caller, never a shim)', () => {
    expect(parseAfterPrArg(42).ok).toBe(false)
    expect(parseAfterPrArg(undefined).ok).toBe(false)
  })

  it('refuses the same pull request named twice', () => {
    const r = parseAfterPrArg('12:checks,12:merged')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/once/)
  })

  it(`refuses more than ${PR_WAIT_MAX} pull requests`, () => {
    const raw = Array.from({ length: PR_WAIT_MAX + 1 }, (_, i) => `${i + 1}:merged`).join(',')
    expect(parseAfterPrArg(raw).ok).toBe(false)
    const ok = Array.from({ length: PR_WAIT_MAX }, (_, i) => `${i + 1}:merged`).join(',')
    expect(parseAfterPrArg(ok).ok).toBe(true)
  })
})

describe('parsePrDeadlineArg', () => {
  it('defaults to 24 h when absent', () => {
    expect(parsePrDeadlineArg(undefined)).toEqual({ ok: true, ms: PR_DEADLINE_DEFAULT_MS })
    expect(PR_DEADLINE_DEFAULT_MS).toBe(24 * 3600_000)
  })

  it('reads minutes, hours and days', () => {
    expect(parsePrDeadlineArg('90m')).toEqual({ ok: true, ms: 90 * 60_000 })
    expect(parsePrDeadlineArg('6h')).toEqual({ ok: true, ms: 6 * 3600_000 })
    expect(parsePrDeadlineArg('3d')).toEqual({ ok: true, ms: 3 * 86_400_000 })
  })

  it.each(['', '0m', '6', 'h', '1.5h', '6 h', '-1h', '1w', 'forever'])('refuses %j', (raw) => {
    expect(parsePrDeadlineArg(raw).ok).toBe(false)
  })

  it('refuses a deadline past 14 days rather than clamping it', () => {
    expect(parsePrDeadlineArg('14d')).toEqual({ ok: true, ms: PR_DEADLINE_MAX_MS })
    expect(parsePrDeadlineArg('15d').ok).toBe(false)
  })
})

describe('afterPrFlagRefusal — the shape gate main and the Server Edition parser run', () => {
  it('passes a call without the flags', () => {
    expect(afterPrFlagRefusal('open-agent', {})).toBeNull()
    expect(afterPrFlagRefusal('write', { node: 'n1', text: 'x' })).toBeNull()
  })

  it('passes a well-formed wait on every open verb', () => {
    for (const verb of ['open-claude', 'open-agent']) {
      expect(afterPrFlagRefusal(verb, { 'after-pr': '12:merged', 'pr-deadline': '2d' })).toBeNull()
    }
    expect(afterPrFlagRefusal('open-terminal', { 'after-pr': '12:merged', cmd: 'make release' })).toBeNull()
  })

  it('refuses open-terminal --after-pr with no --cmd: there is no launch to hold', () => {
    // Accepting it would reply "waiting for PR #12" about a terminal that has nothing to run.
    expect(afterPrFlagRefusal('open-terminal', { 'after-pr': '12:merged' })).toMatch(/needs --cmd/)
  })

  it('refuses --after-pr on any other verb, rather than ignoring it', () => {
    expect(afterPrFlagRefusal('spawn-team', { 'after-pr': '12:merged' })).toMatch(
      /applies only to open-terminal \/ open-claude \/ open-agent/
    )
  })

  it('refuses a malformed value with the verb in front', () => {
    expect(afterPrFlagRefusal('open-agent', { 'after-pr': '12' })).toMatch(/^open-agent: --after-pr must be/)
  })

  it('refuses --pr-deadline without --after-pr, and a bad duration', () => {
    expect(afterPrFlagRefusal('open-agent', { 'pr-deadline': '2d' })).toMatch(/only with --after-pr/)
    expect(afterPrFlagRefusal('open-agent', { 'after-pr': '12:merged', 'pr-deadline': 'soon' })).toMatch(
      /--pr-deadline must be/
    )
  })

  it('refuses --run-now with --after-pr: "start now" and "start when the PR is ready" contradict', () => {
    expect(afterPrFlagRefusal('open-agent', { 'after-pr': '12:merged', 'run-now': '' })).toBe(
      RUN_NOW_AFTER_PR_REFUSAL
    )
    // An explicit off is off, exactly as `runNowRequested` reads it.
    expect(afterPrFlagRefusal('open-agent', { 'after-pr': '12:merged', 'run-now': 'false' })).toBeNull()
  })
})

describe('normalizePrWaitHold — a git-shared, hand-editable project file is hostile input', () => {
  const good = {
    repository: 'eneskirca/nodeterm',
    waits: [{ number: 12, until: 'checks' }],
    deadlineAt: 1_900_000_000_000,
    armedAt: 1_800_000_000_000
  }

  it('absent stays absent', () => {
    expect(normalizePrWaitHold(undefined)).toBeUndefined()
    expect(normalizePrWaitHold(null)).toBeUndefined()
  })

  it('a valid hold comes back with only the fields this module vouches for', () => {
    expect(normalizePrWaitHold({ ...good, extra: '<script>' })).toEqual(good)
  })

  it.each([
    ['a string', 'x'],
    ['an array', []],
    ['a bad repository', { ...good, repository: 'not a repo' }],
    ['waits not a list', { ...good, waits: 'all' }],
    ['no waits', { ...good, waits: [] }],
    ['a bad number', { ...good, waits: [{ number: -1, until: 'merged' }] }],
    ['a bad condition', { ...good, waits: [{ number: 12, until: 'green' }] }],
    ['a duplicate', { ...good, waits: [{ number: 12, until: 'merged' }, { number: 12, until: 'checks' }] }],
    ['too many', { ...good, waits: Array.from({ length: PR_WAIT_MAX + 1 }, (_, i) => ({ number: i + 1, until: 'merged' })) }],
    ['a NaN deadline', { ...good, deadlineAt: Number.NaN }],
    ['a string deadline', { ...good, deadlineAt: '2030' }],
    // `checks` is judged against reads that started after this moment: without it a stale
    // "passed at the previous head" would count, so a hold that lacks it cannot be judged.
    ['no arming time', { ...good, armedAt: undefined }],
    ['a NaN arming time', { ...good, armedAt: Number.NaN }],
    ['a hold already marked invalid', { ...good, invalid: true }]
  ])('%s becomes the INVALID hold — present, never satisfied, never throws', (_label, value) => {
    // Dropping a malformed hold would let the node start on its `--after` deps alone, i.e. EARLY:
    // the unsafe direction. The invalid hold keeps it waiting for a human (▶).
    expect(normalizePrWaitHold(value)).toEqual(INVALID_PR_WAIT_HOLD)
  })
})

describe('owner names GitHub really issued (a stored value is never narrower than GitHub)', () => {
  // MEASURED 2026-09-29 (gh api users/<name>): `john-` (user), `Test-` (org), `hello--world` (user)
  // and `foo--bar` (org) exist; `-foo` does not. A validator narrower than that would turn every
  // stored hold on such a repository invalid on load, and the next save would write it out that way.
  it.each(['john-/repo', 'Test-/x', 'hello--world/nodeterm', 'foo--bar/a.b_c-d'])('keeps a hold on %s', (repository) => {
    const hold = { repository, waits: [{ number: 3, until: 'merged' }], deadlineAt: 5, armedAt: 1 }
    expect(normalizePrWaitHold(hold)).toEqual(hold)
    expect(parseAfterPrArg(`${repository}#3:merged`)).toEqual({
      ok: true,
      specs: [{ number: 3, until: 'merged', repository }]
    })
  })

  it.each(['-foo/repo', 'o/-repo', 'o/..', 'o/.', 'a'.repeat(40) + '/r', 'o/r;x', 'o/r x'])('still refuses %s', (repository) => {
    expect(normalizePrWaitHold({ repository, waits: [{ number: 3, until: 'merged' }], deadlineAt: 5, armedAt: 1 })).toEqual(
      INVALID_PR_WAIT_HOLD
    )
  })
})

describe('the deadline never outlives the prompt file a held launch reads (B3)', () => {
  it('a spilled prompt is kept longer than the longest --pr-deadline', () => {
    // A PR wait may hold a cold-opened node for up to 14 days; its spilled prompt must still be
    // there when it fires (and the delivery loop checks, for waits longer than any TTL).
    expect(LAUNCH_PROMPT_TTL_MS).toBeGreaterThan(PR_DEADLINE_MAX_MS + 7 * 86_400_000)
  })
})

describe('formatPrWaits', () => {
  it('names each pull request and its condition', () => {
    expect(
      formatPrWaits({
        waits: [
          { number: 12, until: 'checks' },
          { number: 13, until: 'merged' }
        ]
      })
    ).toBe('PR #12 checks, PR #13 merged')
  })
})
