import { describe, expect, it } from 'vitest'
import { RANK_MAX_LENGTH, isValidRank, rankBetween, ranksBetween } from './kanban-rank'

describe('rankBetween — fractional-index strings', () => {
  it('mints a first key, then keys before and after it', () => {
    const first = rankBetween(null, null)
    expect(isValidRank(first)).toBe(true)
    const before = rankBetween(null, first)
    const after = rankBetween(first, null)
    expect(before < first).toBe(true)
    expect(after > first).toBe(true)
  })

  it('always finds a key strictly between two distinct keys (no gap exhaustion)', () => {
    let lo = rankBetween(null, null)
    let hi = rankBetween(lo, null)
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(lo, hi)
      expect(mid > lo && mid < hi, `${lo} < ${mid} < ${hi}`).toBe(true)
      expect(isValidRank(mid)).toBe(true)
      // Alternate sides so the gap keeps shrinking from both ends.
      if (i % 2) lo = mid
      else hi = mid
    }
  })

  it('stays SHORT under the board’s default: a thousand inserts at the top of one column', () => {
    let top = rankBetween(null, null)
    for (let i = 0; i < 1000; i++) {
      const next = rankBetween(null, top)
      expect(next < top).toBe(true)
      top = next
    }
    expect(top.length).toBeLessThanOrEqual(4)
  })

  it('stays short for a thousand appends too', () => {
    let last = rankBetween(null, null)
    for (let i = 0; i < 1000; i++) last = rankBetween(last, null)
    expect(last.length).toBeLessThanOrEqual(4)
  })

  it('refuses an inverted or equal pair and an invalid key, rather than inventing an order', () => {
    const a = rankBetween(null, null)
    const b = rankBetween(a, null)
    expect(() => rankBetween(b, a)).toThrow()
    expect(() => rankBetween(a, a)).toThrow()
    expect(() => rankBetween('not a key!', null)).toThrow()
  })

  it('compares with plain string order (code units) — what every reader, on every surface, uses', () => {
    const keys: string[] = []
    let k = rankBetween(null, null)
    for (let i = 0; i < 50; i++) {
      keys.push(k)
      k = rankBetween(k, null)
    }
    expect([...keys].sort()).toEqual(keys)
  })
})

describe('ranksBetween', () => {
  it('mints n ascending keys inside the gap', () => {
    const lo = rankBetween(null, null)
    const hi = rankBetween(lo, null)
    const keys = ranksBetween(lo, hi, 7)
    expect(keys).toHaveLength(7)
    expect([lo, ...keys, hi]).toEqual([lo, ...keys, hi].slice().sort())
    expect(new Set(keys).size).toBe(7)
  })

  it('works open-ended on either side', () => {
    expect(ranksBetween(null, null, 3)).toEqual([...ranksBetween(null, null, 3)].sort())
    const hi = rankBetween(null, null)
    const below = ranksBetween(null, hi, 4)
    expect(below.every((k) => k < hi)).toBe(true)
    expect(ranksBetween(null, null, 0)).toEqual([])
  })
})

describe('the bottom of the key space', () => {
  // The smallest integer part is reserved (nothing may sort before it, so nothing may BE it); the
  // smallest integer a key may carry is one above it.
  const reserved = 'A' + '0'.repeat(26)
  const lowestInteger = 'A' + '0'.repeat(25) + '1'

  it('the reserved integer itself is never a key', () => {
    expect(isValidRank(reserved)).toBe(false)
  })

  it('there is always a valid key before the lowest integer, and before that one', () => {
    expect(isValidRank(lowestInteger)).toBe(true)
    let k = lowestInteger
    for (let i = 0; i < 50; i++) {
      const below = rankBetween(null, k)
      expect(isValidRank(below), below).toBe(true)
      expect(below < k).toBe(true)
      k = below
    }
    expect(ranksBetween(null, lowestInteger, 5).every((key) => isValidRank(key) && key < lowestInteger))
      .toBe(true)
  })
})

describe('isValidRank', () => {
  it('accepts what rankBetween mints', () => {
    expect(isValidRank(rankBetween(null, null))).toBe(true)
  })

  it('rejects garbage a hand edit could put in the file', () => {
    for (const bad of ['', 'a', 'a0 ', 'a00', '!!', 'Aaaa', 7, null, {}, 'a0é', 'x'.repeat(300)]) {
      expect(isValidRank(bad), String(bad)).toBe(false)
    }
  })
})

describe('rankBetween — randomized insert positions', () => {
  it('keeps any sequence of inserts strictly ordered and valid (seeded)', () => {
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const keys: string[] = []
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rand() * (keys.length + 1))
      const k = rankBetween(keys[at - 1] ?? null, keys[at] ?? null)
      expect(isValidRank(k)).toBe(true)
      keys.splice(at, 0, k)
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true)
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(RANK_MAX_LENGTH)
  })
})
