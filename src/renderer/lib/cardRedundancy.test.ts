import { describe, expect, it } from 'vitest'
import { cardShowsOverdue, sessionNameRepeatsTitle } from './cardRedundancy'

describe('sessionNameRepeatsTitle', () => {
  it('hides the chip when the session name is the title (titleAuto)', () => {
    expect(sessionNameRepeatsTitle('Fix login', 'Fix login')).toBe(true)
    expect(sessionNameRepeatsTitle('  fix   LOGIN ', 'Fix login')).toBe(true)
  })

  it('keeps it when it says something the title does not', () => {
    expect(sessionNameRepeatsTitle('Fix login', 'Auth station')).toBe(false)
    expect(sessionNameRepeatsTitle('Fix login', '')).toBe(false)
    expect(sessionNameRepeatsTitle('Fix login', undefined)).toBe(false)
  })

  it('an empty or non-string session name has nothing to show', () => {
    expect(sessionNameRepeatsTitle(undefined, 'x')).toBe(true)
    expect(sessionNameRepeatsTitle('   ', 'x')).toBe(true)
    expect(sessionNameRepeatsTitle({ evil: 1 }, 'x')).toBe(true)
  })
})

describe('cardShowsOverdue', () => {
  const now = 1_000
  it('raises the alarm for a past date in a column that is not finished', () => {
    expect(cardShowsOverdue(500, now, undefined)).toBe(true)
    expect(cardShowsOverdue(500, now, 'unstarted')).toBe(true)
    expect(cardShowsOverdue(500, now, 'started')).toBe(true)
  })

  it('the done / closed column already settled it', () => {
    expect(cardShowsOverdue(500, now, 'done')).toBe(false)
    expect(cardShowsOverdue(500, now, 'closed')).toBe(false)
  })

  it('no date, a future date, or a hostile value is never overdue', () => {
    expect(cardShowsOverdue(undefined, now, 'started')).toBe(false)
    expect(cardShowsOverdue(2_000, now, 'started')).toBe(false)
    expect(cardShowsOverdue(Number.NaN, now, 'started')).toBe(false)
    expect(cardShowsOverdue('5' as never, now, 'started')).toBe(false)
  })
})
