import { describe, it, expect } from 'vitest'
import { PARK_MAX, planParkEviction } from './park-budget'

describe('planParkEviction', () => {
  it('returns nothing at or under the cap', () => {
    expect(planParkEviction(['a', 'b'], 2)).toEqual([])
    expect(planParkEviction([], 2)).toEqual([])
  })
  it('evicts the oldest entries beyond the cap, oldest first', () => {
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })
  it('default cap is 12', () => {
    expect(PARK_MAX).toBe(12)
    const keys = Array.from({ length: 13 }, (_, i) => `k${i}`)
    expect(planParkEviction(keys, PARK_MAX)).toEqual(['k0'])
  })
})
