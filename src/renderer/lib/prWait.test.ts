import { describe, expect, it, vi } from 'vitest'
import { EMPTY_PULL_BOARD, type GitHubPullBoard, type GitHubPullStatus } from '@shared/github-pull-status'
import { INVALID_PR_WAIT_HOLD, type PrWaitHold } from '@shared/pr-wait'
import {
  evaluatePrWait,
  prHoldExpired,
  prHoldSatisfied,
  prHoldSummary,
  resolvePrWaitFor,
  startFreshReadAsks,
  PR_FRESH_READ_ASKS,
  type PrLookup,
  type PrWaitArmDeps
} from './prWait'

const NOW = 1_000_000
const ARMED = NOW - 5_000
const hold = (waits: PrWaitHold['waits'], deadlineAt = NOW + 3_600_000): PrWaitHold => ({
  repository: 'o/r',
  waits,
  deadlineAt,
  armedAt: ARMED
})
const pull = (number: number, patch: Partial<GitHubPullStatus> = {}): GitHubPullStatus => ({
  number,
  lifecycle: 'open',
  headRefName: 'b',
  headRefOid: 'abc',
  closes: [],
  ...patch
})
const board = (pulls: GitHubPullStatus[], patch: Partial<GitHubPullBoard> = {}): GitHubPullBoard => ({
  ...EMPTY_PULL_BOARD,
  repository: 'o/r',
  pulls,
  observedAt: NOW - 1000,
  readStartedAt: NOW - 2000,
  ...patch
})

describe('evaluatePrWait — merged', () => {
  const w = { number: 7, until: 'merged' as const }
  it('a merge needs no fresh read: it cannot be undone, so an early read that says so is true', () => {
    const early = board([pull(7, { lifecycle: 'merged' })], { readStartedAt: ARMED - 60_000 })
    expect(evaluatePrWait(w, hold([w]), early).state).toBe('met')
  })

  it('is met by a merged PR, even from a stale snapshot (a merge cannot be undone)', () => {
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })])).state).toBe('met')
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { stale: true })).state).toBe('met')
  })
  it('waits on an open or draft PR', () => {
    expect(evaluatePrWait(w, hold([w]), board([pull(7)])).state).toBe('waiting')
    expect(evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'draft' })])).state).toBe('waiting')
  })
  it('is blocked (named) by a PR closed without merging — a reopen would release it again', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'closed' })]))
    expect(r.state).toBe('blocked')
    expect(r.detail).toMatch(/closed without merging/)
  })
})

describe('evaluatePrWait — checks (SUCCESS at the PR’s current head)', () => {
  const w = { number: 7, until: 'checks' as const }
  const h = hold([w])
  it('is met by passed checks on a fresh board', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })])).state).toBe('met')
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed', lifecycle: 'draft' })])).state).toBe('met')
  })
  it('does NOT trust a read that started before the wait was armed (B2): a push in between carries other checks', () => {
    // Board closed → author pushes head B → arm `N:checks` → the host still remembers "passed at A".
    const early = board([pull(7, { ci: 'passed' })], { readStartedAt: ARMED - 1 })
    const r = evaluatePrWait(w, h, early)
    expect(r.state).toBe('unknown')
    expect(r.detail).toMatch(/read taken after this wait was armed/)
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { readStartedAt: undefined })).state).toBe('unknown')
    // A read that started at or after arming is an answer.
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { readStartedAt: ARMED })).state).toBe('met')
  })

  it('does NOT trust a stale snapshot: a push since the last read would carry other checks', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { stale: true })).state).toBe('unknown')
  })
  it('waits while checks run, after they fail (a re-run or push can still pass), and with none reported', () => {
    for (const ci of ['pending', 'failed', 'none'] as const) {
      expect(evaluatePrWait(w, h, board([pull(7, { ci })])).state).toBe('waiting')
    }
  })
  it('a missing rollup is never "passed" — no checks is not green', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { ci: 'none' })])).detail).toMatch(/no checks/)
  })
  it('an unknown ci (the host has not said) is unknown, not met', () => {
    expect(evaluatePrWait(w, h, board([pull(7)])).state).toBe('unknown')
  })
  it('is blocked when the token cannot read checks at all', () => {
    const r = evaluatePrWait(w, h, board([pull(7, { ci: 'passed' })], { access: { ci: false, merge: true } }))
    expect(r.state).toBe('blocked')
    expect(r.detail).toMatch(/cannot read checks/)
  })
  it('is blocked by a PR that merged before its checks were seen passing', () => {
    expect(evaluatePrWait(w, h, board([pull(7, { lifecycle: 'merged' })])).state).toBe('blocked')
  })
})

describe('evaluatePrWait — what the board does not know', () => {
  const w = { number: 7, until: 'merged' as const }
  it('no board yet is unknown', () => {
    expect(evaluatePrWait(w, hold([w]), undefined).state).toBe('unknown')
  })
  it('a PR the board does not list is unknown, and a truncated board says why', () => {
    expect(evaluatePrWait(w, hold([w]), board([])).state).toBe('unknown')
    expect(evaluatePrWait(w, hold([w]), board([], { truncated: true })).detail).toMatch(/more open pull requests/)
  })
  it('a board that now syncs ANOTHER repository cannot satisfy the hold', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { repository: 'o/other' }))
    expect(r.state).toBe('blocked')
  })
  it('compares repositories case-insensitively, as GitHub does', () => {
    const r = evaluatePrWait(w, hold([w]), board([pull(7, { lifecycle: 'merged' })], { repository: 'O/R' }))
    expect(r.state).toBe('met')
  })
})

describe('prHoldSatisfied / prHoldExpired', () => {
  const a = { number: 7, until: 'merged' as const }
  const b = { number: 8, until: 'checks' as const }
  const both = board([pull(7, { lifecycle: 'merged' }), pull(8, { ci: 'passed' })])
  it('needs EVERY wait met', () => {
    expect(prHoldSatisfied(hold([a, b]), both, NOW)).toBe(true)
    expect(prHoldSatisfied(hold([a, b]), board([pull(7, { lifecycle: 'merged' }), pull(8, { ci: 'pending' })]), NOW)).toBe(false)
  })
  it('never fires past the deadline, however green the PR is', () => {
    expect(prHoldExpired(hold([a], NOW), NOW)).toBe(true)
    expect(prHoldSatisfied(hold([a], NOW), both, NOW)).toBe(false)
    expect(prHoldExpired(hold([a], NOW + 1), NOW)).toBe(false)
  })
  it('an invalid (hostile or corrupt) hold is expired and never satisfied', () => {
    expect(prHoldExpired(INVALID_PR_WAIT_HOLD, NOW)).toBe(true)
    expect(prHoldSatisfied(INVALID_PR_WAIT_HOLD, both, NOW)).toBe(false)
  })
})

describe('prHoldSummary', () => {
  it('says, per pull request, what is still being waited for', () => {
    const s = prHoldSummary(
      hold([{ number: 7, until: 'merged' }, { number: 8, until: 'checks' }]),
      board([pull(7), pull(8, { ci: 'pending' })])
    )
    expect(s).toMatch(/PR #7 merged/)
    expect(s).toMatch(/PR #8 checks/)
    expect(s).toMatch(/running/)
  })
})

// ── Arming: what an open with --after-pr is allowed to store ──────────────────────────────────

function deps(patch: Partial<PrWaitArmDeps> = {}): PrWaitArmDeps {
  return {
    project: { id: 'p1', cwd: '/w', kanban: { github: { repository: 'o/r' } } },
    controlStatus: vi.fn(async () => ({ repository: 'o/r', approved: true })),
    lookupPulls: vi.fn(async (_id: string, numbers: number[]) =>
      new Map<number, PrLookup>(numbers.map((n) => [n, { found: true, lifecycle: 'open' }]))
    ),
    now: () => NOW,
    hostNow: vi.fn(async () => 777),
    ...patch
  }
}

describe('resolvePrWaitFor — the refusal matrix', () => {
  it('no flag, nothing to do (and nothing is asked)', async () => {
    const d = deps()
    expect(await resolvePrWaitFor(undefined, undefined, 'open-agent', d)).toEqual({ ok: true, alreadyMerged: [] })
    expect(d.controlStatus).not.toHaveBeenCalled()
  })

  it('stores a hold on the board repository with the deadline on this clock', async () => {
    const r = await resolvePrWaitFor('7:checks', '2h', 'open-agent', deps())
    expect(r).toEqual({
      ok: true,
      hold: { repository: 'o/r', waits: [{ number: 7, until: 'checks' }], deadlineAt: NOW + 2 * 3_600_000, armedAt: 777 },
      alreadyMerged: []
    })
  })

  it('records the arming time on the HOST clock, falling back to this one when the host cannot say', async () => {
    const r = await resolvePrWaitFor('7:checks', undefined, 'open-agent', deps({ hostNow: vi.fn(async () => undefined) }))
    expect(r.ok && r.hold?.armedAt).toBe(NOW)
    const t = await resolvePrWaitFor('7:checks', undefined, 'open-agent', deps({ hostNow: vi.fn(async () => { throw new Error('x') }) }))
    expect(t.ok && t.hold?.armedAt).toBe(NOW)
  })

  it('a relay tab is refused by name', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p', remote: true } }))
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toMatch(/^after-pr-unavailable: .*relay/)
  })

  it('a project whose board has no GitHub sync is refused by name — and a cwd-less one says why', async () => {
    const plain = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p', cwd: '/w' } }))
    expect(!plain.ok && plain.error).toMatch(/^after-pr-unavailable: this project's kanban board is not connected to GitHub/)
    const cwdless = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({ project: { id: 'p' } }))
    expect(!cwdless.ok && cwdless.error).toMatch(/no folder/)
  })

  it('an SSH project with a GitHub board is NOT refused — the PR status is read on this machine', async () => {
    const r = await resolvePrWaitFor(
      '7:merged',
      undefined,
      'open-agent',
      deps({ project: { id: 'p', ssh: { host: 'h' }, kanban: { github: {} } } })
    )
    expect(r.ok).toBe(true)
  })

  it('a board with no repository, or an unapproved one, is refused by name', async () => {
    const none = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => ({ approved: false }))
    }))
    expect(!none.ok && none.error).toMatch(/names no GitHub repository/)
    const unapproved = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => ({ repository: 'o/r', approved: false }))
    }))
    expect(!unapproved.ok && unapproved.error).toMatch(/not approved on this machine/)
    const threw = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      controlStatus: vi.fn(async () => { throw new Error('boom') })
    }))
    expect(!threw.ok && threw.error).toMatch(/^after-pr-unavailable:/)
  })

  it('refuses a full reference into another repository', async () => {
    const r = await resolvePrWaitFor('x/y#7:merged', undefined, 'open-agent', deps())
    expect(!r.ok && r.error).toMatch(/^after-pr-other-repository: x\/y#7/)
    // The same repository in another case is the same repository.
    expect((await resolvePrWaitFor('O/R#7:merged', undefined, 'open-agent', deps())).ok).toBe(true)
  })

  it('refuses a number the repository does not have', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: false, complete: true }]]))
    }))
    expect(!r.ok && r.error).toMatch(/^after-pr-unknown: o\/r has no pull request #7/)
  })

  it('does not call an incomplete read evidence of absence — a retryable refusal instead', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: false, complete: false }]]))
    }))
    expect(!r.ok && r.error).toMatch(/^after-pr-unconfirmed:.*retry/)
    const threw = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => { throw new Error('offline') })
    }))
    expect(!threw.ok && threw.error).toMatch(/^after-pr-unconfirmed:/)
  })

  it('a truncated harvest is named, and not told to retry — waiting never lists a PR it dropped', async () => {
    const r = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: false, complete: false, truncated: true }]]))
    }))
    expect(!r.ok && r.error).toMatch(/^after-pr-unconfirmed:/)
    expect(!r.ok && r.error).toMatch(/keeps fewer pull requests than o\/r has/)
    expect(!r.ok && r.error).toMatch(/do not retry/)
    expect(!r.ok && r.error).not.toMatch(/retry in a minute/)
  })

  it('refuses a closed-unmerged PR, and checks on a merged one', async () => {
    const closed = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'closed' }]]))
    }))
    expect(!closed.ok && closed.error).toMatch(/^after-pr-closed:/)
    const merged = await resolvePrWaitFor('7:checks', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'merged' }]]))
    }))
    expect(!merged.ok && merged.error).toMatch(/^after-pr-merged:/)
  })

  it('a :merged wait on an already-merged PR is met now, reported, and not stored', async () => {
    const r = await resolvePrWaitFor('7:merged,8:checks', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([
        [7, { found: true, lifecycle: 'merged' }],
        [8, { found: true, lifecycle: 'open' }]
      ]))
    }))
    expect(r).toMatchObject({ ok: true, alreadyMerged: [7], hold: { waits: [{ number: 8, until: 'checks' }] } })
    const all = await resolvePrWaitFor('7:merged', undefined, 'open-agent', deps({
      lookupPulls: vi.fn(async () => new Map<number, PrLookup>([[7, { found: true, lifecycle: 'merged' }]]))
    }))
    expect(all).toEqual({ ok: true, alreadyMerged: [7] })
  })

  it('re-parses the flag: the renderer never trusts that main’s gate ran', async () => {
    const r = await resolvePrWaitFor('7', undefined, 'open-agent', deps())
    expect(!r.ok && r.error).toMatch(/^open-agent: --after-pr must be/)
  })
})

describe('startFreshReadAsks — one fresh read for a checks wait, asked a bounded number of times', () => {
  it('asks at once, then re-asks on the retry interval, and stops at the cap', () => {
    const timers: { fn: () => void; ms: number }[] = []
    const ask = vi.fn()
    const stop = startFreshReadAsks({
      ask,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearTimeout: () => undefined
    })
    expect(ask).toHaveBeenCalledTimes(1)
    // The host's refresh floor is 30 s: a re-ask inside it would be swallowed.
    expect(timers[0].ms).toBeGreaterThan(30_000)
    // Fire every timer the helper arms, once each, until it stops arming new ones.
    for (let i = 0; i < timers.length && i < 20; i++) timers[i].fn()
    expect(ask).toHaveBeenCalledTimes(PR_FRESH_READ_ASKS)
    stop()
  })

  it('stop() cancels the pending re-ask', () => {
    let pending: (() => void) | undefined
    const cleared: unknown[] = []
    const ask = vi.fn()
    const stop = startFreshReadAsks({
      ask,
      setTimeout: (fn) => {
        pending = fn
        return 'timer'
      },
      clearTimeout: (t) => cleared.push(t)
    })
    stop()
    expect(cleared).toEqual(['timer'])
    expect(ask).toHaveBeenCalledTimes(1)
    void pending
  })
})
