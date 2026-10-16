import { describe, expect, it } from 'vitest'
import { CANVAS_BACKING_DEFAULT, backedFillStyle, resolveCanvasBacking } from './canvas-backing'
import { DEFAULT_SETTINGS } from './types'

describe('resolveCanvasBacking (issue #1113)', () => {
  it('defaults to 0 (today\'s see-through look) for anything that is not a finite number', () => {
    for (const bad of [undefined, null, 'x', NaN, Infinity, {}, [50]])
      expect(resolveCanvasBacking(bad)).toBe(CANVAS_BACKING_DEFAULT)
    expect(CANVAS_BACKING_DEFAULT).toBe(0)
  })
  it('clamps to 0–100 and rounds', () => {
    expect(resolveCanvasBacking(-20)).toBe(0)
    expect(resolveCanvasBacking(140)).toBe(100)
    expect(resolveCanvasBacking(42.6)).toBe(43)
  })
  it('ships both settings at the default', () => {
    expect(DEFAULT_SETTINGS.stickyNoteBacking).toBe(0)
    expect(DEFAULT_SETTINGS.groupFrameBacking).toBe(0)
  })
})

describe('backedFillStyle', () => {
  it('is byte-identical to the old inline style at the default', () => {
    expect(backedFillStyle('#ff0000', '22', 0)).toEqual({ background: '#ff000022' })
    expect(backedFillStyle('#ff0000', '0f', 'junk')).toEqual({ background: '#ff00000f' })
  })
  it('keeps the tint and puts a canvas-coloured backing under it', () => {
    expect(backedFillStyle('#ff0000', '22', 60)).toEqual({
      backgroundColor: 'color-mix(in srgb, var(--canvas-bg) 60%, transparent)',
      backgroundImage: 'linear-gradient(#ff000022, #ff000022)'
    })
  })
})
