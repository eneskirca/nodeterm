import { describe, it, expect } from 'vitest'
import {
  INACTIVE_PROJECT_LIMIT,
  PROJECT_LIMIT_DEADLINE_MS,
  PROJECT_LIMIT_DEFAULT_FREE,
  countOpenProjects,
  decideOpen,
  effectiveLimit,
  type ProjectLimitState
} from './project-limit'

describe('countOpenProjects — the one definition of an open project', () => {
  it('counts every project that is neither closed nor a relay tab', () => {
    expect(countOpenProjects([{}, { closed: true }, { remote: true }, { closed: false }])).toBe(2)
  })

  it('is 0 for an empty workspace', () => {
    expect(countOpenProjects([])).toBe(0)
  })
})

const on: ProjectLimitState = { active: true, pro: false, free: 5, allowance: null, dnt: false }

describe('decideOpen — allow, claim or block one new open', () => {
  it('allows anything while the limit is inactive, and for Pro', () => {
    expect(decideOpen({ ...on, active: false }, 99)).toBe('allow')
    expect(decideOpen({ ...on, pro: true }, 99)).toBe('allow')
  })

  it('allows under FREE and claims at it when no allowance is known', () => {
    expect(decideOpen(on, 4)).toBe('allow')
    expect(decideOpen(on, 5)).toBe('claim')
  })

  it('allows under a claimed allowance and blocks at it', () => {
    expect(decideOpen({ ...on, allowance: 30 }, 29)).toBe('allow')
    expect(decideOpen({ ...on, allowance: 30 }, 30)).toBe('block')
  })

  it('never lets an older allowance undercut a FREE the server raised after the token', () => {
    expect(decideOpen({ ...on, allowance: 5, free: 8 }, 6)).toBe('allow')
    expect(effectiveLimit({ ...on, allowance: 5, free: 8 })).toBe(8)
  })

  it('blocks a new open above the allowance (a Pro lapse) without asking again', () => {
    // Above the allowance is reachable (here: projects opened while Pro). The gate blocks the NEW
    // open and closes nothing; the allowance is known, so a claim would only hear the same number.
    expect(decideOpen({ ...on, allowance: 5 }, 7)).toBe('block')
  })

  it('reads the effective limit as FREE until an allowance is known', () => {
    expect(effectiveLimit(on)).toBe(5)
    expect(effectiveLimit({ ...on, allowance: 30 })).toBe(30)
    expect(effectiveLimit({ ...on, allowance: 0 })).toBe(5)
  })
})

describe('the dormant defaults', () => {
  it('INACTIVE_PROJECT_LIMIT allows every open and carries the compiled FREE', () => {
    expect(INACTIVE_PROJECT_LIMIT).toEqual({ active: false, pro: false, free: 5, allowance: null, dnt: false })
    expect(PROJECT_LIMIT_DEFAULT_FREE).toBe(5)
    expect(INACTIVE_PROJECT_LIMIT.free).toBe(PROJECT_LIMIT_DEFAULT_FREE)
    expect(decideOpen(INACTIVE_PROJECT_LIMIT, 1000)).toBe('allow')
  })

  it('the embedded deadline is a real instant', () => {
    // A typo in the literal makes Date.parse answer NaN, and `anchor >= NaN` is false forever: a
    // DNT client would then never ask the server at all, silently. The value itself is bumped every
    // release (docs/project-limit.md), so only its well-formedness is pinned here.
    expect(Number.isFinite(PROJECT_LIMIT_DEADLINE_MS)).toBe(true)
  })
})
