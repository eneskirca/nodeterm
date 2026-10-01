import { describe, it, expect } from 'vitest'
import { createTokenBucket } from './token-bucket'

describe('createTokenBucket', () => {
  it('spends a burst, then refills at the rate, never above the burst', () => {
    let t = 0
    const b = createTokenBucket({ ratePerSec: 100, burst: 300, now: () => t })
    expect(b.take(300)).toBe(true)
    expect(b.take(1)).toBe(false)
    t = 500
    expect(b.take(50)).toBe(true)
    expect(b.take(1)).toBe(false)
    t = 100_000
    expect(b.take(301)).toBe(false)
    expect(b.take(300)).toBe(true)
  })

  it('a refused take spends nothing', () => {
    let t = 0
    const b = createTokenBucket({ ratePerSec: 100, burst: 300, now: () => t })
    expect(b.take(250)).toBe(true)
    expect(b.take(60)).toBe(false)
    expect(b.take(50)).toBe(true)
    t = 10
    expect(b.take(1)).toBe(true)
    expect(b.take(1)).toBe(false)
  })

  it('a wall clock stepping backwards neither drains nor refills the bucket', () => {
    // The caller passes Date.now, which NTP can step back; an hour back must not leave the viewer
    // on keyframes for an hour, and the refill resumes from the new reading.
    let t = 10_000_000
    const b = createTokenBucket({ ratePerSec: 100, burst: 300, now: () => t })
    expect(b.take(200)).toBe(true)
    t -= 3_600_000
    expect(b.take(100)).toBe(true)
    expect(b.take(1)).toBe(false)
    t += 1000
    expect(b.take(100)).toBe(true)
    expect(b.take(1)).toBe(false)
  })
})
