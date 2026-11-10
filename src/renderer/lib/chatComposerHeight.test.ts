import { describe, expect, it } from 'vitest'
import {
  COMPLETE_MENU_MAX_PX,
  THREAD_RESERVE_PX,
  completeMenuMax,
  composerHeight,
  parseComposerHeight
} from './chatComposerHeight'

const base = { content: 40, min: 40, inner: 800, chrome: 50, set: null }

describe('composerHeight', () => {
  it('keeps the two-row minimum for a short draft', () => {
    expect(composerHeight(base)).toBe(40)
  })

  it('grows with the draft', () => {
    expect(composerHeight({ ...base, content: 300 })).toBe(300)
  })

  it('stops growing by itself once the whole composer fills half the inner space', () => {
    expect(composerHeight({ ...base, content: 1000 })).toBe(400 - 50)
  })

  it('keeps a set height whatever the draft holds', () => {
    expect(composerHeight({ ...base, content: 40, set: 250 })).toBe(250)
    expect(composerHeight({ ...base, content: 1000, set: 250 })).toBe(250)
  })

  it('lets a set height go past half the inner space, but keeps room for the thread', () => {
    expect(composerHeight({ ...base, set: 600 })).toBe(600)
    expect(composerHeight({ ...base, set: 5000 })).toBe(800 - 50 - THREAD_RESERVE_PX)
  })

  it('never sets less than the two-row minimum', () => {
    expect(composerHeight({ ...base, set: 5 })).toBe(40)
    expect(composerHeight({ ...base, inner: 100, content: 300 })).toBe(40)
  })

  it('has no upper bound while the panel has no box', () => {
    expect(composerHeight({ ...base, inner: 0, content: 1000 })).toBe(1000)
  })
})

describe('completeMenuMax', () => {
  it('keeps its own ceiling in a tall panel', () => {
    expect(completeMenuMax({ inner: 800, composer: 100 })).toBe(COMPLETE_MENU_MAX_PX)
  })

  it('takes at most half the inner space', () => {
    expect(completeMenuMax({ inner: 300, composer: 90 })).toBe(150)
  })

  it('fits in the room above a composer set taller than half', () => {
    expect(completeMenuMax({ inner: 400, composer: 300 })).toBe(104)
  })

  it('never goes negative, and leaves the stylesheet in charge with no box', () => {
    expect(completeMenuMax({ inner: 200, composer: 400 })).toBe(0)
    expect(completeMenuMax({ inner: 0, composer: 90 })).toBeNull()
  })
})

describe('parseComposerHeight', () => {
  it('reads a stored height', () => {
    expect(parseComposerHeight('320')).toBe(320)
  })

  it('reads anything else as auto', () => {
    for (const raw of [null, '', '0', '-5', '12.5', 'tall', '999999']) expect(parseComposerHeight(raw)).toBeNull()
  })
})
