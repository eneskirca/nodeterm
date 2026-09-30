// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readSentComments, useBoardCommentDelivery, SENT_COMMENTS_KEY } from './boardCommentDelivery'

describe('which comments THIS machine sent', () => {
  beforeEach(() => {
    localStorage.clear()
    useBoardCommentDelivery.getState().reset()
  })

  it('survives a reload (localStorage) — it is what lets a reloaded row trust its log outcomes', () => {
    useBoardCommentDelivery.getState().markSent('c-1')
    expect(useBoardCommentDelivery.getState().sent['c-1']).toBeTypeOf('number')
    expect(Object.keys(readSentComments())).toEqual(['c-1'])
  })

  it('is bounded, oldest forgotten first', () => {
    for (let i = 0; i < 520; i++) useBoardCommentDelivery.getState().markSent(`c-${i}`)
    const kept = Object.keys(readSentComments())
    expect(kept.length).toBe(500)
    expect(kept).not.toContain('c-0')
    expect(kept).toContain('c-519')
  })

  it('a malformed or hostile stored value reads as nothing, never a crash', () => {
    for (const raw of ['{', '5', '{"a":"x","__proto__":1}', JSON.stringify({ 'bad id': 1, ok: 2 })]) {
      localStorage.setItem(SENT_COMMENTS_KEY, raw)
      const r = readSentComments()
      for (const [k, v] of Object.entries(r)) {
        expect(/^[A-Za-z0-9-]{1,64}$/.test(k), raw).toBe(true)
        expect(typeof v).toBe('number')
      }
    }
  })
})
