import { describe, it, expect } from 'vitest'
import {
  CLAUDE_FRAMES,
  CLAUDE_FRAME_ART,
  GROK_FRAME_ART,
  GROK_MASCOT,
  SUB_COLS,
  SUB_ROWS,
  decodeQuadrant,
  decodeFrame,
  QUADRANT_BITS,
  type MascotBitmap
} from './mascot'

const countOn = (b: MascotBitmap): number => b.pixels.filter(Boolean).length

// The last quadrant row (art row index 2) → sub-pixel rows 4 and 5: the feet.
const footRegion = (b: MascotBitmap): boolean[] =>
  b.pixels.slice(4 * b.width, 6 * b.width)

describe('decodeQuadrant', () => {
  it('maps full block to all four sub-pixels', () => {
    expect(decodeQuadrant('█')).toEqual([1, 1, 1, 1])
  })

  it('maps half/quarter blocks by UL,UR,LL,LR bit order', () => {
    expect(decodeQuadrant('▐')).toEqual([0, 1, 0, 1]) // right half
    expect(decodeQuadrant('▌')).toEqual([1, 0, 1, 0]) // left half
    expect(decodeQuadrant('▘')).toEqual([1, 0, 0, 0]) // upper-left dot
    expect(decodeQuadrant('▝')).toEqual([0, 1, 0, 0]) // upper-right dot
  })

  it('treats space and unknown chars as empty', () => {
    expect(decodeQuadrant(' ')).toEqual([0, 0, 0, 0])
    expect(decodeQuadrant('x')).toEqual([0, 0, 0, 0])
  })
})

describe('decodeFrame', () => {
  it('produces an 18×6 sub-pixel bitmap', () => {
    for (const frame of CLAUDE_FRAMES) {
      expect(frame.width).toBe(SUB_COLS)
      expect(frame.height).toBe(SUB_ROWS)
      expect(frame.pixels).toHaveLength(SUB_COLS * SUB_ROWS)
    }
  })

  it('places quadrant bits at the right sub-pixel coordinates', () => {
    // A single "▐" (right half) at char (0,0) lights UR (0,1) and LR (1,1) only.
    const b = decodeFrame(['▐'])
    expect(b.pixels[0 * b.width + 1]).toBe(true) // UR
    expect(b.pixels[1 * b.width + 1]).toBe(true) // LR
    expect(b.pixels[0 * b.width + 0]).toBe(false) // UL
    expect(b.pixels[1 * b.width + 0]).toBe(false) // LL
    expect(countOn(b)).toBe(2)
  })

  it('sums to the total lit sub-pixels across the whole art', () => {
    const expected = CLAUDE_FRAME_ART[0]
      .flatMap((row) => Array.from(row))
      .reduce((acc, ch) => acc + QUADRANT_BITS[ch].filter(Boolean).length, 0)
    expect(countOn(CLAUDE_FRAMES[0])).toBe(expected)
  })
})

describe('walk frames', () => {
  it('has exactly two frames', () => {
    expect(CLAUDE_FRAMES).toHaveLength(2)
  })

  it('shares the same body (identical bit count between frames)', () => {
    // The two frames differ only in the feet, so the total lit count is unchanged.
    expect(countOn(CLAUDE_FRAMES[0])).toBe(countOn(CLAUDE_FRAMES[1]))
  })

  it('differs in the feet region between frame 0 and frame 1', () => {
    const f0 = footRegion(CLAUDE_FRAMES[0])
    const f1 = footRegion(CLAUDE_FRAMES[1])
    expect(f0).not.toEqual(f1)
    // Feet are present in both frames (the walk moves them, it does not remove them).
    expect(f0.some(Boolean)).toBe(true)
    expect(f1.some(Boolean)).toBe(true)
  })

  it('keeps the non-foot rows identical between frames', () => {
    const body0 = CLAUDE_FRAMES[0].pixels.slice(0, 4 * SUB_COLS)
    const body1 = CLAUDE_FRAMES[1].pixels.slice(0, 4 * SUB_COLS)
    expect(body0).toEqual(body1)
  })
})

describe('grok mascot', () => {
  it('has two walk frames on the same sub-pixel grid as the others', () => {
    expect(GROK_FRAME_ART).toHaveLength(2)
    for (const frame of GROK_FRAME_ART) {
      const bmp = decodeFrame(frame)
      expect(bmp.width).toBe(SUB_COLS)
      expect(bmp.height).toBe(SUB_ROWS)
    }
  })

  it('draws an actual critter in both frames (not a blank sheet)', () => {
    // Without this, blanking the art to a single stray pixel passes every other assertion here.
    for (const frame of GROK_FRAME_ART) {
      expect(decodeFrame(frame).pixels.some(Boolean)).toBe(true)
      expect(countOn(decodeFrame(frame))).toBeGreaterThan(20)
    }
  })

  it('is written only from glyphs the decoder knows', () => {
    // Hand-authored art's realistic regression: a typo'd or look-alike block (e.g. the half-block
    // ▀, absent from QUADRANT_BITS) decodes SILENTLY to nothing, leaving holes no other test sees.
    for (const frame of GROK_FRAME_ART) {
      for (const ch of frame.join('')) {
        expect(QUADRANT_BITS[ch]).toBeDefined()
      }
    }
  })

  it('alternates the feet, so it walks instead of sliding', () => {
    // "Walks" = the FEET move while the body stays put. Whole-bitmap inequality is not enough:
    // grok's antennae already differ between frames, so it would pass with identical feet.
    const [a, b] = GROK_FRAME_ART.map(decodeFrame)
    const fa = footRegion(a)
    const fb = footRegion(b)
    expect(fa).not.toEqual(fb)
    // The walk moves the feet, it does not remove them.
    expect(fa.some(Boolean)).toBe(true)
    expect(fb.some(Boolean)).toBe(true)
    // The body (art row 1 → sub-pixel rows 2–3) is identical, so the critter does not slide.
    expect(a.pixels.slice(2 * SUB_COLS, 4 * SUB_COLS)).toEqual(
      b.pixels.slice(2 * SUB_COLS, 4 * SUB_COLS)
    )
    // The head row DOES differ, by design: the two antennae swap sides so it bobs as it walks.
    // (This is why the body slice above stops at row 2 instead of covering rows 0–3 like
    // claude's equivalent test.)
    expect(a.pixels.slice(0, 2 * SUB_COLS)).not.toEqual(b.pixels.slice(0, 2 * SUB_COLS))
  })

  it("is a DIFFERENT critter from claude's, not a recolor", () => {
    expect(GROK_FRAME_ART[0]).not.toEqual(CLAUDE_FRAME_ART[0])
  })

  it('exposes the geometry the CSS animation needs', () => {
    expect(GROK_MASCOT.frameCount).toBe(2)
    expect(GROK_MASCOT.frameWidth).toBeGreaterThan(0)
    expect(GROK_MASCOT.frameHeight).toBeGreaterThan(0)
  })
})
