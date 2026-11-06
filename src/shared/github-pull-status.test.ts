import { describe, expect, it } from 'vitest'
import {
  PULL_CHASE_MAX,
  PULL_STATUS_GREY_AFTER_MS,
  checkDuration,
  checkRunState,
  ciState,
  isUndecided,
  mergeState,
  nextPullChase,
  pullChaseDelay,
  pullChaseDue,
  pullStatusFreshness,
  pullStatusFrom,
  sortChecks,
  statusContextState,
  type GitHubPullStatus,
  type PullStatusFacts
} from './github-pull-status'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const ALL = { ci: true, merge: true }

function facts(over: Partial<PullStatusFacts> = {}): PullStatusFacts {
  return {
    number: 7,
    headRefName: 'feat/x',
    headRefOid: HEAD,
    crossRepository: false,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    rollup: 'SUCCESS',
    rollupOid: HEAD,
    closes: [],
    ...over
  }
}

describe('ci state', () => {
  it('a missing rollup is "no checks", never "passed"', () => {
    expect(ciState(null)).toBe('none')
    expect(pullStatusFrom(facts({ rollup: null, rollupOid: null }), ALL).ci).toBe('none')
  })

  it('maps GitHub status states', () => {
    expect(ciState('SUCCESS')).toBe('passed')
    expect(ciState('FAILURE')).toBe('failed')
    expect(ciState('ERROR')).toBe('failed')
    expect(ciState('PENDING')).toBe('pending')
    expect(ciState('EXPECTED')).toBe('pending')
  })
})

describe('merge state', () => {
  it('MERGEABLE is not ready: only CLEAN is', () => {
    expect(mergeState('MERGEABLE', 'BLOCKED')).toBe('blocked')
    expect(mergeState('MERGEABLE', 'BEHIND')).toBe('behind')
    expect(mergeState('MERGEABLE', 'UNSTABLE')).toBe('unstable')
    expect(mergeState('MERGEABLE', 'HAS_HOOKS')).toBe('hooks')
    expect(mergeState('MERGEABLE', 'CLEAN')).toBe('ready')
  })

  it('conflicts from either field are conflicts', () => {
    expect(mergeState('CONFLICTING', 'DIRTY')).toBe('conflict')
    expect(mergeState('CONFLICTING', 'CLEAN')).toBe('conflict')
    expect(mergeState('MERGEABLE', 'DIRTY')).toBe('conflict')
  })

  it('UNKNOWN in either field is undecided', () => {
    expect(mergeState('UNKNOWN', 'CLEAN')).toBe('undecided')
    expect(mergeState('MERGEABLE', 'UNKNOWN')).toBe('undecided')
  })

  it('an unreadable or unrecognised value claims nothing', () => {
    expect(mergeState(null, 'CLEAN')).toBeUndefined()
    expect(mergeState('MERGEABLE', null)).toBeUndefined()
    expect(mergeState('MERGEABLE', 'SOMETHING_NEW')).toBeUndefined()
  })
})

describe('pullStatusFrom', () => {
  it('ignores a rollup taken at another commit', () => {
    const status = pullStatusFrom(facts({ rollup: 'SUCCESS', rollupOid: OLD }), ALL)
    expect(status.ci).not.toBe('passed')
    expect(status.ci).toBe('pending')
  })

  it('never carries CI from an older head onto a newer one', () => {
    const previous: GitHubPullStatus = {
      number: 7, lifecycle: 'open', headRefName: 'feat/x', headRefOid: OLD, ci: 'passed', closes: []
    }
    const status = pullStatusFrom(facts({ rollup: 'SUCCESS', rollupOid: OLD }), ALL, previous)
    expect(status.ci).toBe('pending')
  })

  it('keeps the previous CI for the SAME head when this read raced a push', () => {
    const previous: GitHubPullStatus = {
      number: 7, lifecycle: 'open', headRefName: 'feat/x', headRefOid: HEAD, ci: 'failed', closes: []
    }
    const status = pullStatusFrom(facts({ rollup: 'SUCCESS', rollupOid: OLD }), ALL, previous)
    expect(status.ci).toBe('failed')
  })

  it('omits ci and merge the token may not read', () => {
    const status = pullStatusFrom(facts(), { ci: false, merge: false })
    expect(status.ci).toBeUndefined()
    expect(status.merge).toBeUndefined()
    expect('ci' in status).toBe(false)
  })

  it('a draft reads as draft', () => {
    expect(pullStatusFrom(facts({ isDraft: true }), ALL).lifecycle).toBe('draft')
  })
})

describe('undecided', () => {
  it('pending CI or undecided mergeability keeps an open PR undecided', () => {
    expect(isUndecided({ lifecycle: 'open', ci: 'pending', merge: 'ready' })).toBe(true)
    expect(isUndecided({ lifecycle: 'open', ci: 'passed', merge: 'undecided' })).toBe(true)
    expect(isUndecided({ lifecycle: 'open', ci: 'none', merge: 'ready' })).toBe(false)
    expect(isUndecided({ lifecycle: 'merged', ci: 'pending', merge: 'undecided' })).toBe(false)
  })
})

describe('chase', () => {
  const pending = (number: number, oid = HEAD): GitHubPullStatus => ({
    number, lifecycle: 'open', headRefName: 'x', headRefOid: oid, ci: 'pending', merge: 'ready', closes: []
  })
  const settled = (number: number): GitHubPullStatus => ({ ...pending(number), ci: 'passed' })

  it('follows 30 s, 1 min, 2 min, then 5 min', () => {
    expect([0, 1, 2, 3, 4, 11].map(pullChaseDelay)).toEqual(
      [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]
    )
  })

  it('caps an episode at 12 reads', () => {
    let chase = nextPullChase(null, [pending(1)], 0)!
    let now = 0
    let reads = 0
    for (let tick = 0; tick < 200; tick++) {
      now += 30_000
      if (!pullChaseDue(chase, now)) continue
      reads += 1
      chase = { ...nextPullChase(chase, [pending(1)], now)!, attempts: chase.attempts + 1 }
    }
    expect(reads).toBe(PULL_CHASE_MAX)
    expect(pullChaseDue(chase, now + 3_600_000)).toBe(false)
  })

  it('is not due before its delay', () => {
    const chase = nextPullChase(null, [pending(1)], 1_000)!
    expect(pullChaseDue(chase, 1_000 + 29_999)).toBe(false)
    expect(pullChaseDue(chase, 1_000 + 30_000)).toBe(true)
  })

  it('ends when nothing is undecided', () => {
    expect(nextPullChase({ keys: ['1@x'], attempts: 3, lastReadAt: 0 }, [settled(1)], 5)).toBeNull()
  })

  it('a new head or a new undecided PR starts a new episode; the same one keeps counting', () => {
    const base = nextPullChase(null, [pending(1)], 0)!
    const spent = { ...base, attempts: 9 }
    expect(nextPullChase(spent, [pending(1)], 10)!.attempts).toBe(9)
    expect(nextPullChase(spent, [pending(1, OLD)], 10)!.attempts).toBe(0)
    expect(nextPullChase(spent, [pending(1), pending(2)], 10)!.attempts).toBe(0)
  })
})

describe('freshness', () => {
  it('a snapshot is fresh until a read fails, then stale, then greyed', () => {
    expect(pullStatusFreshness({ stale: false, observedAt: 0 }, 10 ** 9)).toBe('fresh')
    expect(pullStatusFreshness({ stale: true, observedAt: 1_000 }, 2_000)).toBe('stale')
    expect(pullStatusFreshness({ stale: true, observedAt: 1_000 }, 1_000 + PULL_STATUS_GREY_AFTER_MS))
      .toBe('expired')
  })
})

describe('checks', () => {
  it('maps check runs and status contexts', () => {
    expect(checkRunState('IN_PROGRESS', null)).toBe('pending')
    expect(checkRunState('COMPLETED', 'SUCCESS')).toBe('passed')
    expect(checkRunState('COMPLETED', 'TIMED_OUT')).toBe('failed')
    expect(checkRunState('COMPLETED', 'SKIPPED')).toBe('skipped')
    expect(statusContextState('EXPECTED')).toBe('pending')
    expect(statusContextState('ERROR')).toBe('failed')
  })

  it('sorts failures first', () => {
    expect(sortChecks([
      { name: 'b', state: 'passed' }, { name: 'a', state: 'failed' }, { name: 'c', state: 'pending' }
    ]).map((check) => check.name)).toEqual(['a', 'c', 'b'])
  })

  it('words a finished run\'s duration; a running or untimed check has none', () => {
    const run = (startedAt?: string, completedAt?: string) => ({ name: 'x', state: 'passed' as const, startedAt, completedAt })
    expect(checkDuration(run('2026-11-01T10:00:00Z', '2026-11-01T10:00:42Z'))).toBe('42s')
    expect(checkDuration(run('2026-11-01T10:00:00Z', '2026-11-01T10:02:05Z'))).toBe('2m 5s')
    expect(checkDuration(run('2026-11-01T10:00:00Z', '2026-11-01T11:03:00Z'))).toBe('1h 3m')
    expect(checkDuration(run('2026-11-01T10:00:00Z'))).toBeUndefined()
    expect(checkDuration(run(undefined, '2026-11-01T10:00:00Z'))).toBeUndefined()
    expect(checkDuration(run('2026-11-01T10:00:05Z', '2026-11-01T10:00:00Z'))).toBeUndefined()
  })
})
