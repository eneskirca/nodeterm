import { describe, expect, it } from 'vitest'
import { nextCronFire, parseCron } from './cron'

// All expectations are built from LOCAL Date components, so they hold in any CI timezone.
const local = (
  y: number, mo: number, d: number, h = 0, mi = 0
): number => new Date(y, mo - 1, d, h, mi).getTime()

const next = (expr: string, fromMs: number): number | null => {
  const s = parseCron(expr)
  return s ? nextCronFire(s, fromMs) : null
}

describe('parseCron', () => {
  it('refuses malformed expressions', () => {
    expect(parseCron('')).toBeNull()
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * *')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull()
    expect(parseCron('* * 32 * *')).toBeNull()
    expect(parseCron('* * * 13 *')).toBeNull()
    expect(parseCron('* * * * 8')).toBeNull()
    expect(parseCron('*/0 * * * *')).toBeNull()
    expect(parseCron('5-2 * * * *')).toBeNull()
    expect(parseCron('a * * * *')).toBeNull()
    expect(parseCron('1;2 * * * *')).toBeNull()
    expect(parseCron('1//2 * * * *')).toBeNull()
  })

  it('accepts names, steps, ranges, lists, and dow 7 as Sunday', () => {
    expect(parseCron('0 9 * jan-mar mon,fri')).not.toBeNull()
    expect(parseCron('*/15 0-6/2 1,15 * *')).not.toBeNull()
    const sunday7 = parseCron('0 0 * * 7')!
    expect(sunday7.dow[0]).toBe(true)
    const sunday0 = parseCron('0 0 * * sun')!
    expect(sunday0.dow[0]).toBe(true)
  })
})

describe('nextCronFire', () => {
  it('finds the next minute strictly after `from`', () => {
    // 2026-09-02 is a Wednesday.
    const from = local(2026, 9, 2, 12, 0)
    expect(next('* * * * *', from)).toBe(local(2026, 9, 2, 12, 1))
    // A time exactly on a match is not returned — strictly after.
    expect(next('0 12 * * *', from)).toBe(local(2026, 9, 3, 12, 0))
  })

  it('handles hour/day/month skips', () => {
    const from = local(2026, 9, 2, 15, 30)
    expect(next('0 9 * * *', from)).toBe(local(2026, 9, 3, 9, 0))
    expect(next('30 8 1 * *', from)).toBe(local(2026, 10, 1, 8, 30))
    expect(next('0 0 * feb *', from)).toBe(local(2027, 2, 1, 0, 0))
  })

  it('applies steps and ranges', () => {
    const from = local(2026, 9, 2, 12, 7)
    expect(next('*/15 * * * *', from)).toBe(local(2026, 9, 2, 12, 15))
    expect(next('5/20 * * * *', from)).toBe(local(2026, 9, 2, 12, 25))
    expect(next('0 9-17 * * *', local(2026, 9, 2, 18, 0))).toBe(local(2026, 9, 3, 9, 0))
  })

  it('weekday schedules land on the right day', () => {
    // From Wednesday 2026-09-02: next Monday is 09-07.
    const from = local(2026, 9, 2, 12, 0)
    expect(next('0 9 * * mon', from)).toBe(local(2026, 9, 7, 9, 0))
    // Weekday range: Thursday 09-03 is next.
    expect(next('0 9 * * 1-5', from)).toBe(local(2026, 9, 3, 9, 0))
  })

  it('vixie OR rule: dom AND dow both restricted fire on EITHER', () => {
    // From Wednesday 2026-09-02. `0 9 15 * mon`: Monday 09-07 comes before the 15th.
    const from = local(2026, 9, 2, 12, 0)
    expect(next('0 9 15 * mon', from)).toBe(local(2026, 9, 7, 9, 0))
    // From Monday 09-07 09:00 (after fire): next is Monday 09-14... which precedes the 15th.
    expect(next('0 9 15 * mon', local(2026, 9, 7, 9, 0))).toBe(local(2026, 9, 14, 9, 0))
    // From 09-14 09:00: the 15th (a Tuesday) is next — the dom leg.
    expect(next('0 9 15 * mon', local(2026, 9, 14, 9, 0))).toBe(local(2026, 9, 15, 9, 0))
    // Only dom restricted: Mondays do NOT fire.
    expect(next('0 9 15 * *', from)).toBe(local(2026, 9, 15, 9, 0))
  })

  it('an impossible schedule returns null instead of scanning forever', () => {
    expect(next('0 0 30 2 *', local(2026, 9, 2, 12, 0))).toBeNull()
  })
})
