import { afterEach, describe, expect, it } from 'vitest'
import { GlyphAtlas, GUTTER_PX } from './atlas'
import { packColor } from './cells'
import {
  ATLAS_SENTINEL_RGBA,
  SENTINEL_CSS,
  createCanvasRasterizer,
  sentinelIntact,
  shrinkEligible,
  shrinkToFit,
  underlineThickness
} from './raster'

/**
 * These tests pin the three rects a colored draw uses, because the whole mip story rests on them:
 * the slot's own BACKGROUND covers the FULL PITCH rect (gutter included — that is what makes a
 * level-1/2 texel blend this slot's content with itself rather than with the page ground), the
 * INK is clipped to the CELL rect (a glyph may never draw NEW geometry into the gutter — the
 * MAX_SAFE_LOD = 2 derivation in `atlas.ts` counts on 2*GUTTER_PX texels of this-slot-only content
 * between two slots' inks), and the gutter is then EDGE-EXTENDED from the cell's own border texels
 * so a full-bleed glyph continues into it instead of fading to background.
 *
 * Node has no OffscreenCanvas, so the contract is checked against a stub. The stub does two things:
 * it RECORDS the op list (order and geometry) and it maintains a tiny PIXEL MODEL of the page.
 * Both are needed — the replication is uniform by design (it runs for every glyph, and is a visual
 * no-op when the ink does not reach the cell edge), so the op list alone can never distinguish a
 * full-bleed glyph's gutter from an ordinary letter's.
 */

interface Op {
  kind: 'fillRect' | 'fillText' | 'clip' | 'clearRect' | 'drawImage' | 'translate' | 'scale'
  fill?: string
  args: number[]
  text?: string
  /** `imageSmoothingEnabled` as it stood when the op was recorded. Only meaningful for drawImage:
   *  a 1-texel source stretched over the gutter must REPLICATE, never resample. */
  smoothing?: boolean
  /** Whether the drawImage source was the rasterizer's OWN canvas — the only source it ever uses. */
  self?: boolean
  /** The canvas font string in effect for a `fillText` — family, size and WEIGHT. */
  font?: string
}

/** The active clip as half-open texel bounds, or `null` for "no clip". */
type Clip = { x0: number; y0: number; x1: number; y1: number } | null

/**
 * The pixel model is deliberately HARD-EDGED: it answers "whose content is in this texel", not
 * "what exact blend". A real canvas antialiases a fractional fill edge, and replicating such a
 * partial-coverage texel into the gutter is correct precisely because it is still the slot's OWN
 * edge colour — but a coverage model is not needed to check WHICH slot's content lands where.
 *
 * `fillText` paints NOTHING into the model: the stub has no font engine. That is not a gap for
 * these tests, it is the case they need — an ordinary letter is exactly a glyph whose ink stays
 * inside the cell, and the model then shows the replication copying background over background.
 */
function stubCanvas(
  sizePx = 256,
  /** The INK width `measureText` reports, in px, split evenly either side of the origin. The
   *  default is comfortably inside the 10px cell, which is what every test that predates
   *  shrink-to-fit assumes; a test about an oversized glyph passes its own. */
  inkWidth = 8
): {
  ops: Op[]
  pixelAt: (x: number, y: number) => string
  /** The page-wide `imageSmoothingEnabled` as it stands NOW — for asserting it was restored. */
  smoothingNow: () => boolean
  /** Wipe every texel WITHOUT going through `clearPage` — what a GPU reset does to the backing
   *  store behind the rasterizer's back, and the case the sentinel exists to detect. */
  blankPage: () => void
  /** Drive `ctx.isContextLost()`, the cheap check that runs before the readback. */
  setContextLost: (lost: boolean) => void
  /** Dispatch a canvas context event; returns whether a listener cancelled it. Cancelling
   *  `contextlost` is how a page REFUSES automatic restoration, so "was it cancelled" is a
   *  behavioural assertion, not a detail. */
  fire: (type: 'contextlost' | 'contextrestored') => boolean
  listenerCount: () => number
  restore: () => void
} {
  const ops: Op[] = []
  const px: string[] = new Array(sizePx * sizePx).fill('')
  let selfCanvas: unknown = null
  let clip: Clip = null
  let pending: { x: number; y: number; w: number; h: number } | null = null
  const clipStack: Clip[] = []

  const setPixel = (x: number, y: number, color: string): void => {
    if (x < 0 || y < 0 || x >= sizePx || y >= sizePx) return
    if (clip && (x < clip.x0 || y < clip.y0 || x >= clip.x1 || y >= clip.y1)) return
    px[y * sizePx + x] = color
  }
  // Texel centres, i.e. the pixel whose centre falls inside [a, a+len). `Math.round` is that rule
  // for every rect these tests use (all of them start on a whole texel).
  const paint = (x: number, y: number, w: number, h: number, color: string): void => {
    for (let j = Math.round(y); j < Math.round(y + h); j++)
      for (let i = Math.round(x); i < Math.round(x + w); i++) setPixel(i, j, color)
  }

  const ctx = {
    font: '',
    textBaseline: '',
    fillStyle: '',
    imageSmoothingEnabled: true,
    save() {
      clipStack.push(clip)
    },
    restore() {
      clip = clipStack.pop() ?? null
    },
    beginPath() {
      pending = null
    },
    rect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'clip', args: [x, y, w, h] })
      pending = { x, y, w, h }
    },
    clip() {
      if (!pending) return
      const next = {
        x0: Math.round(pending.x),
        y0: Math.round(pending.y),
        x1: Math.round(pending.x + pending.w),
        y1: Math.round(pending.y + pending.h)
      }
      clip = clip
        ? {
            x0: Math.max(clip.x0, next.x0),
            y0: Math.max(clip.y0, next.y0),
            x1: Math.min(clip.x1, next.x1),
            y1: Math.min(clip.y1, next.y1)
          }
        : next
    },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'fillRect', fill: ctx.fillStyle, args: [x, y, w, h] })
      paint(x, y, w, h, ctx.fillStyle)
    },
    clearRect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'clearRect', args: [x, y, w, h] })
      paint(x, y, w, h, '')
    },
    fillText(text: string, x: number, y: number) {
      // `font` rides along so a test can assert WHICH face/weight the ink was drawn with — the
      // 2026-08-09 weight bug was invisible in the op geometry and lived entirely in this string.
      ops.push({ kind: 'fillText', fill: ctx.fillStyle, args: [x, y], text, font: ctx.font })
    },
    // Recorded, NOT applied to the pixel model — which costs these tests nothing, because the
    // model's `fillText` paints no pixels either (there is no font engine here). What the shrink
    // tests need is the TRANSFORM the rasterizer asked for, and that is exactly what this keeps.
    translate(x: number, y: number) {
      ops.push({ kind: 'translate', args: [x, y] })
    },
    scale(sx: number, sy: number) {
      ops.push({ kind: 'scale', args: [sx, sy] })
    },
    /** Only the 9-argument form, and only with WHOLE-texel destination rects — which is all the
     *  rasterizer's gutter replication uses. Nearest-neighbour sampling off a SNAPSHOT of the page,
     *  which is what the spec guarantees for a self-referencing drawImage.
     *
     *  `imageSmoothingEnabled` is RECORDED, NOT HONOURED: this model always replicates. So the
     *  pixel assertions below prove WHICH texel is copied where — they do NOT prove that the real
     *  canvas replicates rather than resamples. That claim rests entirely on the flag being off,
     *  which is why it has its own op-level test. */
    drawImage(
      src: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ) {
      ops.push({
        kind: 'drawImage',
        args: [sx, sy, sw, sh, dx, dy, dw, dh],
        smoothing: ctx.imageSmoothingEnabled,
        self: src === selfCanvas
      })
      const snap = px.slice()
      for (let j = 0; j < dh; j++) {
        for (let i = 0; i < dw; i++) {
          const u = Math.floor(sx + ((i + 0.5) * sw) / dw)
          const v = Math.floor(sy + ((j + 0.5) * sh) / dh)
          if (u < 0 || v < 0 || u >= sizePx || v >= sizePx) continue
          setPixel(dx + i, dy + j, snap[v * sizePx + u])
        }
      }
    },
    // The ascent/descent pin the baseline (a face whose line box exactly fills the 20px cell), so
    // the baseline math is not the subject here. The actualBoundingBox pair is the INK extent
    // shrink-to-fit measures — `left: 0` puts the ink
    // entirely to the right of the origin, which is where a normal glyph's ink sits.
    measureText: () => ({
      fontBoundingBoxAscent: 16,
      fontBoundingBoxDescent: 4,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: inkWidth
    }),
    isContextLost: () => contextLost,
    /** Only the 1x1 form the sentinel check uses. The model stores CSS colour strings, so this is
     *  the inverse of `rgb(r,g,b)` — and an unpainted texel is transparent-black, exactly as a real
     *  fresh (or blanked) page reads back. */
    getImageData(x: number, y: number): { data: number[] } {
      const color = px[y * sizePx + x] ?? ''
      const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color)
      if (!m) return { data: [0, 0, 0, 0] }
      return { data: [Number(m[1]), Number(m[2]), Number(m[3]), 255] }
    }
  }
  const listeners = new Map<string, Set<(e: { preventDefault(): void }) => void>>()
  let contextLost = false
  const prev = (globalThis as Record<string, unknown>).OffscreenCanvas
  ;(globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number
    ) {
      selfCanvas = this
    }
    getContext(): unknown {
      return ctx
    }
    addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    }
    removeEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void {
      listeners.get(type)?.delete(fn)
    }
  }
  return {
    ops,
    pixelAt(x: number, y: number) {
      return px[y * sizePx + x]
    },
    smoothingNow() {
      return ctx.imageSmoothingEnabled
    },
    blankPage() {
      px.fill('')
    },
    setContextLost(lost: boolean) {
      contextLost = lost
    },
    fire(type) {
      let cancelled = false
      for (const fn of listeners.get(type) ?? []) fn({ preventDefault: () => (cancelled = true) })
      return cancelled
    },
    listenerCount() {
      let n = 0
      for (const set of listeners.values()) n += set.size
      return n
    },
    restore() {
      ;(globalThis as Record<string, unknown>).OffscreenCanvas = prev
    }
  }
}

const FONT = { family: 'monospace', sizePx: 16, cellW: 10, cellH: 20, weight: 400, weightBold: 700 }
/** The pitch this font lays out on: ceil(cell) + a gutter on each side. */
const PITCH_W = 10 + 2 * GUTTER_PX
const PITCH_H = 20 + 2 * GUTTER_PX
/** The WHOLE texel columns/rows a cell occupies — `ceil(cell)`, i.e. the pitch minus its gutters.
 *  The edge-extension works in these because a texel is the smallest thing it can copy. */
const COLS_W = 10
const COLS_H = 20

/** A realistic INK origin — the corner of a pitch cell plus one gutter on each axis, which is
 *  exactly what `GlyphAtlas.cellXY` hands the rasterizer. */
const INK_X = PITCH_W + GUTTER_PX
const INK_Y = PITCH_H + GUTTER_PX

/** Final packed colour lanes, deliberately not black/white so a swapped fg/bg is visible. */
const FG = packColor(255, 160, 0, 255)
const BG = packColor(16, 32, 48, 255)
const FG_CSS = 'rgb(255,160,0)'
const BG_CSS = 'rgb(16,32,48)'

let active: { restore: () => void } | null = null
afterEach(() => {
  active?.restore()
  active = null
})

describe('createCanvasRasterizer', () => {
  it('degrades to null (caller keeps the DOM renderer) when OffscreenCanvas is unavailable', () => {
    const prev = (globalThis as Record<string, unknown>).OffscreenCanvas
    delete (globalThis as Record<string, unknown>).OffscreenCanvas
    expect(createCanvasRasterizer(FONT, 256)).toBeNull()
    ;(globalThis as Record<string, unknown>).OffscreenCanvas = prev
  })

  it('paints NOTHING at creation — the page ground stays transparent-black', () => {
    const stub = stubCanvas()
    active = stub
    createCanvasRasterizer(FONT, 256)
    // The old opaque-black page fill is GONE: the backdrop is now per-slot (the bg fill in
    // `draw`), and a page-wide fill would put an opaque colour in slot 0, which every space
    // samples. The ONE texel painted here is the sentinel, and it lands in slot 0's GUTTER —
    // outside every sampled rect on the page. See `sentinelIntact`.
    expect(stub.ops).toEqual([{ kind: 'fillRect', fill: SENTINEL_CSS, args: [0, 0, 1, 1] }])
    // The part that actually matters: slot 0's SAMPLED cell box is untouched, so a space still
    // samples transparent-black.
    expect(stub.pixelAt(GUTTER_PX, GUTTER_PX)).toBe('')
    expect(stub.pixelAt(GUTTER_PX + COLS_W - 1, GUTTER_PX + COLS_H - 1)).toBe('')
  })

  it('fills the FULL PITCH rect with bg, then clips the ink to the CELL rect and draws it in fg', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x41, false, false, INK_X, INK_Y, FG, BG)

    // 1. The background covers the pitch cell — its origin is the INK origin minus one gutter on
    //    each axis, and its extent is the whole pitch (gutters included).
    expect(stub.ops[0]).toEqual({
      kind: 'fillRect',
      fill: BG_CSS,
      args: [INK_X - GUTTER_PX, INK_Y - GUTTER_PX, PITCH_W, PITCH_H]
    })
    // 2. The ink is clipped to the CELL rect, which starts at the ink origin.
    expect(stub.ops[1]).toEqual({ kind: 'clip', args: [INK_X, INK_Y, FONT.cellW, FONT.cellH] })
    // 3. The glyph itself, in the foreground colour.
    const ink = stub.ops[2]
    expect(ink.kind).toBe('fillText')
    expect(ink.text).toBe('A')
    expect(ink.fill).toBe(FG_CSS)
    // Baseline: unchanged half-leading convention, now measured from the ink origin (i.e. inside
    // the cell rect, one gutter into the pitch cell), on a WHOLE device pixel.
    expect(ink.args[0]).toBe(INK_X)
    expect(ink.args[1]).toBe(INK_Y + 16)
    expect(Number.isInteger(ink.args[1])).toBe(true)
  })

  describe("the right half of a double-width character ('wide-right')", () => {
    // A slot's ink box is one cell and step 2 CUTS the overflow, so a character the terminal gave
    // two cells to was rendered as its first cell alone — the 2026-08-05 ⭐ report. The follower
    // cell asks for the same character's other half, which is the same draw with the glyph's
    // origin moved one cell left: the window this slot's clip keeps is then the second cell.
    it('draws the glyph one cell LEFT of the ink origin', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x4e2d, false, false, INK_X, INK_Y, FG, BG, 'wide-right')
      const ink = stub.ops.find((o) => o.kind === 'fillText')!
      expect(ink.args[0]).toBe(INK_X - FONT.cellW)
      // The baseline does not move: only the horizontal window changes.
      expect(ink.args[1]).toBe(INK_Y + 16)
    })

    it('leaves the CLIP on this slot’s own cell box', () => {
      // This is the whole reason the fix costs nothing structurally. The clip is what holds the
      // 2*GUTTER_PX separation MAX_SAFE_LOD is derived from; if it moved with the ink, the right
      // half would spill into the neighbouring slot and show up as a ghost in its mip.
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x4e2d, false, false, INK_X, INK_Y, FG, BG, 'wide-right')
      expect(stub.ops.find((o) => o.kind === 'clip')).toEqual({
        kind: 'clip',
        args: [INK_X, INK_Y, FONT.cellW, FONT.cellH]
      })
    })

    it('fills this slot’s own pitch rect with bg, exactly as the left half does', () => {
      // The follower's background is what makes a selection or a block cursor one unbroken run
      // across a wide glyph. The shift must not reach it.
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x4e2d, false, false, INK_X, INK_Y, FG, BG, 'wide-right')
      expect(stub.ops[0]).toEqual({
        kind: 'fillRect',
        fill: BG_CSS,
        args: [INK_X - GUTTER_PX, INK_Y - GUTTER_PX, PITCH_W, PITCH_H]
      })
    })

    it('defaults to the left half, so every existing call is unchanged', () => {
      const withDefault = stubCanvas()
      active = withDefault
      createCanvasRasterizer(FONT, 256)!.draw(0x41, false, false, INK_X, INK_Y, FG, BG)
      const explicit = stubCanvas()
      active = explicit
      createCanvasRasterizer(FONT, 256)!.draw(0x41, false, false, INK_X, INK_Y, FG, BG, 'whole')
      expect(withDefault.ops).toEqual(explicit.ops)
    })
  })

  /**
   * The 2026-08-05 device finding: an agent CLI's task-list icon rendered with its right edge
   * sliced off, while GPU mode showed it whole. A symbol whose ink is wider than its cell used to
   * be CUT by the ink clip, and the clip cannot be relaxed — ink in the gutter is what the
   * MAX_SAFE_LOD derivation forbids. So the glyph is made to fit instead of trimmed to fit.
   */
  describe('shrink-to-fit for a glyph whose ink exceeds its cell', () => {
    /** The `fillText` op, and the transform (if any) that was in effect for it. */
    function inkOp(ops: Op[]): { text: Op; scale?: Op; translate?: Op } {
      return {
        text: ops.find((o) => o.kind === 'fillText')!,
        scale: ops.find((o) => o.kind === 'scale'),
        translate: ops.find((o) => o.kind === 'translate')
      }
    }

    it('an ordinary glyph is drawn by the SAME call as before — no transform at all', () => {
      // Load-bearing: a scale of exactly 1 must take the untouched path, so nothing anyone has
      // already looked at moves. 8px of ink in a 10px cell is an ordinary letter.
      const stub = stubCanvas(256, 8)
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x41, false, false, INK_X, INK_Y, FG, BG)
      const { text, scale, translate } = inkOp(stub.ops)
      expect(scale).toBeUndefined()
      expect(translate).toBeUndefined()
      expect(text.args).toEqual([INK_X, INK_Y + 16])
    })

    it('a LETTER is never scaled, however far its ink overhangs', () => {
      // The 2026-08-07 regression. An italic face measures ~1.19 of the advance at its worst glyph
      // and a bold-italic one ~1.25, so a rule that shrinks "anything oversized" renders italic
      // text at ~84% of the roman text beside it — and per glyph, so the narrow letters in a word
      // stay full size and the wide ones do not. Overhang is normal for text; clipping its tip is
      // what this renderer has always done and what nobody has ever reported.
      const stub = stubCanvas(256, 14) // 14px of ink in a 10px cell — 1.4×, far past the tolerance
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x58, false, true, INK_X, INK_Y, FG, BG) // italic 'X'
      expect(inkOp(stub.ops).scale).toBeUndefined()
    })

    it('an oversized SYMBOL is SCALED to its cell instead of being clipped', () => {
      // 14px of ink entitled to one 10px cell: without this it lost 4px off its right edge.
      const stub = stubCanvas(256, 14)
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x29c9, false, false, INK_X, INK_Y, FG, BG)
      const { text, scale, translate } = inkOp(stub.ops)
      expect(scale!.args).toEqual([10 / 14, 10 / 14])
      // Scaled about the BASELINE, so the glyph keeps sitting on its neighbours' line, and
      // re-centred inside the cell — here the scaled ink is exactly the cell, so the centring term
      // is zero and the ink starts at the ink origin.
      expect(translate!.args).toEqual([INK_X, INK_Y + 16])
      expect(text.args).toEqual([0, 0])
    })

    it('a slight overhang is left alone — the tolerance absorbs an antialiasing fringe', () => {
      // 10.3px in a 10px cell is a full-bleed glyph measuring a fraction over, not an oversized
      // symbol. Scaling it would buy nothing and could open a hairline in a run of `───`.
      const stub = stubCanvas(256, 10.3)
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x41, false, false, INK_X, INK_Y, FG, BG)
      expect(inkOp(stub.ops).scale).toBeUndefined()
    })

    it('a DOUBLE-WIDTH character is measured against TWO cells, not one', () => {
      // The regression this guards is severe and silent: an emoji's ink is ~1.7 cells, so measuring
      // either half against ONE cell would shrink every emoji back into the fragment the two-slot
      // mechanism exists to prevent. 18px of ink is inside a 20px entitlement — leave it alone.
      for (const part of ['wide-left', 'wide-right'] as const) {
        const stub = stubCanvas(256, 18)
        active = stub
        const r = createCanvasRasterizer(FONT, 256)!
        stub.ops.length = 0
        r.draw(0x1f44d, false, false, INK_X, INK_Y, FG, BG, part)
        expect(inkOp(stub.ops).scale, part).toBeUndefined()
      }
    })
  })

  // The claim is about GEOMETRY, not about pixels: no glyph may generate NEW ink outside the slot's
  // own WHOLE-TEXEL CELL BOX, because the MAX_SAFE_LOD derivation counts on 2*GUTTER_PX texels
  // between two slots' inks. The gutter is not required to be BACKGROUND — the edge-extension
  // strips below copy this slot's own border texels into it, and a copy of the slot's own content
  // is not a second slot's ink. So this pin filters `fillRect`/`fillText` ops only, and the
  // replication `drawImage`s are checked separately for their exact (this-slot-only) rects.
  //
  // RE-SCOPED (2026-08-04, far-edge snapping) from the fractional CELL rect to that box —
  // `max(1, ceil(cell))`, the pitch minus its two gutters. A box/block op whose span REACHES the
  // fractional cell edge is now grown to the whole texel, so on a fractional axis its ink
  // legitimately ends past `cellW`. Nothing the LOD derivation rests on moves: the pitch is
  // `ceil(cell) + 2*GUTTER_PX` by construction, so the box is exactly the pitch minus its gutters
  // and two slots' inks are still 2*GUTTER_PX texels apart. What is still forbidden — and what this
  // pin still catches — is ink IN THE GUTTER, which stays reachable only through step 3's
  // replication of this slot's own texels. The integral case is the old assertion unchanged
  // (ceil is the identity there); the fractional one is what the re-scope buys.
  it.each([
    ['integral 10x20', { cellW: 10, cellH: 20 }],
    ['fractional 10.5x20.5', { cellW: 10.5, cellH: 20.5 }]
  ])('keeps every ink op inside the whole-texel CELL BOX on a %s cell', (_label, sizes) => {
    const stub = stubCanvas()
    active = stub
    const font = { family: 'monospace', sizePx: 16, weight: 400, weightBold: 700, ...sizes }
    const colsW = Math.max(1, Math.ceil(sizes.cellW))
    const colsH = Math.max(1, Math.ceil(sizes.cellH))
    const ink0 = 40
    const r = createCanvasRasterizer(font, 256)!
    stub.ops.length = 0
    r.draw(0x2588, false, false, ink0, ink0, FG, BG) // █ — the glyph that fills the whole cell

    const ink = stub.ops.filter((o) => o.kind === 'fillRect' && o.fill === FG_CSS)
    expect(ink.length).toBeGreaterThan(0)
    for (const op of ink) {
      const [x, y, w, h] = op.args
      expect(x).toBeGreaterThanOrEqual(ink0)
      expect(y).toBeGreaterThanOrEqual(ink0)
      expect(x + w).toBeLessThanOrEqual(ink0 + colsW)
      expect(y + h).toBeLessThanOrEqual(ink0 + colsH)
    }
    // And the only fill that is allowed outside the cell box is the background one, which is
    // exactly the pitch rect.
    const outside = stub.ops.filter(
      (o) =>
        o.kind === 'fillRect' &&
        (o.args[0] < ink0 ||
          o.args[1] < ink0 ||
          o.args[0] + o.args[2] > ink0 + colsW ||
          o.args[1] + o.args[3] > ink0 + colsH)
    )
    expect(outside).toEqual([
      {
        kind: 'fillRect',
        fill: BG_CSS,
        args: [ink0 - GUTTER_PX, ink0 - GUTTER_PX, colsW + 2 * GUTTER_PX, colsH + 2 * GUTTER_PX]
      }
    ])
  })

  // The pin above draws ONE glyph. The property the widened box clip actually rests on is stronger
  // — no op of ANY geometric glyph may exceed the whole-texel box on a fractional cell — and the
  // clip is the only thing standing behind it, so a change to box-glyphs.ts's span/snap arithmetic
  // could break it without touching this file. Sweeping the two ranges box-glyphs.ts owns makes it
  // a standing guarantee rather than something re-derived by hand at review time. It also pins the
  // FAR-EDGE SNAP's own precondition from the other side: `span` never returns a reaching edge
  // SHORT of the cell extent, so FAR_EDGE_EPS has nothing to bridge and can stay at float noise.
  it('never lets any box/block glyph escape the whole-texel box, over both ranges', () => {
    const stub = stubCanvas()
    active = stub
    const cellW = 10.5
    const cellH = 20.5
    const font = { family: 'monospace', sizePx: 16, cellW, cellH, weight: 400, weightBold: 700 }
    const colsW = Math.max(1, Math.ceil(cellW))
    const colsH = Math.max(1, Math.ceil(cellH))
    const ink0 = 40
    const r = createCanvasRasterizer(font, 4096)!
    let drawn = 0
    let short = 0
    for (let code = 0x2500; code <= 0x259f; code++) {
      stub.ops.length = 0
      r.draw(code, false, false, ink0, ink0, FG, BG)
      const ink = stub.ops.filter((o) => o.kind === 'fillRect' && o.fill === FG_CSS)
      if (!ink.length) continue
      drawn++
      for (const op of ink) {
        const [x, y, w, h] = op.args
        expect(x).toBeGreaterThanOrEqual(ink0)
        expect(y).toBeGreaterThanOrEqual(ink0)
        expect(x + w).toBeLessThanOrEqual(ink0 + colsW)
        expect(y + h).toBeLessThanOrEqual(ink0 + colsH)
        // No edge may land a HAIR short of the cell extent. That band is what a "reaching" edge
        // would look like if `span` ever returned float noise instead of the extent verbatim — the
        // snap would miss it and the grout would survive. Edges further inside are ordinary
        // interior geometry (a ┈ dash can legitimately end at 10 on a 10.5 cell), which is exactly
        // what FAR_EDGE_EPS must NOT capture; only the noise band is evidence of a miss.
        const right = x + w - ink0
        if (right > cellW - 1e-3 && right < cellW) short++
      }
    }
    expect(drawn).toBeGreaterThan(100)
    expect(short).toBe(0)
  })

  it('draws the geometric box/block glyphs in the FOREGROUND over the bg fill, never with the font', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x2591, false, false, INK_X, INK_Y, FG, BG) // ░ — a stipple, fg pixels over bg

    expect(stub.ops.some((o) => o.kind === 'fillText')).toBe(false)
    const fills = stub.ops.filter((o) => o.kind === 'fillRect')
    expect(fills[0].fill).toBe(BG_CSS) // the slot's own backdrop, first
    expect(fills.slice(1).every((o) => o.fill === FG_CSS)).toBe(true)
    expect(fills.length).toBeGreaterThan(1)
  })

  it('converts both packed lanes to css rgb(), reading the RGB lanes in packColor order', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    // A colour whose channels are all different, so a swapped r/b lane cannot pass.
    r.draw(0x41, false, false, INK_X, INK_Y, packColor(1, 2, 3, 255), packColor(4, 5, 6, 255))
    expect(stub.ops[0].fill).toBe('rgb(4,5,6)')
    expect(stub.ops.find((o) => o.kind === 'fillText')!.fill).toBe('rgb(1,2,3)')
  })

  it('keys off the UNSIGNED lanes — a negative packed colour is the same colour', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    // `0xff << 24` is negative in JS; an arithmetic path can hand us that spelling.
    r.draw(0x41, false, false, INK_X, INK_Y, (0xff << 24) | 0x0000ff, (0xff << 24) | 0x00ff00)
    expect(stub.ops[0].fill).toBe('rgb(0,255,0)')
    expect(stub.ops.find((o) => o.kind === 'fillText')!.fill).toBe('rgb(255,0,0)')
  })

  it('clearPage() blanks the whole page back to transparent-black', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.clearPage()
    // clearRect, NOT a fill: the page ground has to go back to transparent-black so slot 0 stays
    // the blank slot every space samples. The sentinel is then REPAINTED, because a reset is a
    // normal event and a page missing its sentinel afterwards would read as a lost 2D context and
    // rebuild the whole canvas on the next revive.
    expect(stub.ops).toEqual([
      { kind: 'clearRect', args: [0, 0, 256, 256] },
      { kind: 'fillRect', fill: SENTINEL_CSS, args: [0, 0, 1, 1] }
    ])
  })

  it('never draws slot 0, so the blank slot every space samples stays transparent', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    const atlas = new GlyphAtlas(r, 256)
    stub.ops.length = 0
    expect(atlas.glyphFor(0x20, false, false, FG, BG)).toBe(0)
    expect(stub.ops).toEqual([])
    // The first real glyph starts at slot 1 — i.e. past the origin cell. Not even its background
    // fill may reach slot 0's pitch rect.
    atlas.glyphFor(0x41, false, false, FG, BG)
    // Which args carry the DESTINATION differs by op: a drawImage records source-then-dest, so the
    // reach of a replication strip is args[4..5], not args[0..1] (its source is by construction
    // inside the slot's own cell, and reading that as the destination would pin nothing).
    const reachesSlot0 = (o: Op): boolean => {
      const dx = o.kind === 'drawImage' ? o.args[4] : o.args[0]
      const dy = o.kind === 'drawImage' ? o.args[5] : o.args[1]
      return dx < PITCH_W && dy < PITCH_H
    }
    expect(stub.ops.some(reachesSlot0)).toBe(false)
  })

  /**
   * EDGE-EXTENDED GUTTERS (device round, 2026-08-04). A gutter filled with flat background made the
   * mip chain average cell-edge INK with background, which drew a dark "grout" line along every
   * boundary between two full-bleed cells at zoom < 1 (the Claude mascot's block art, tmux's │ ─
   * pane separators). The fix is the standard atlas one: clamp-to-edge padding — the gutter carries
   * the cell's own outermost texel row/column, so a minified sample keeps averaging ink with ink.
   */
  describe('gutter edge-extension', () => {
    /** All four replication ops, in the order the rasterizer must emit them. */
    const strips = (ops: Op[]): Op[] => ops.filter((o) => o.kind === 'drawImage')

    it('replicates the cell border into the gutter — sides first, then full-pitch rows for the corners', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x2588, false, false, INK_X, INK_Y, FG, BG) // █

      // Order is load-bearing: the LEFT/RIGHT strips run first over the cell's rows only, then the
      // TOP/BOTTOM strips copy a full-PITCH-wide row — by which time that row already holds the
      // side strips, so each corner of the gutter ends up with the cell's corner texel.
      expect(strips(stub.ops).map((o) => o.args)).toEqual([
        // left: the cell's first column, stretched over the left gutter
        [INK_X, INK_Y, 1, COLS_H, INK_X - GUTTER_PX, INK_Y, GUTTER_PX, COLS_H],
        // right: its last column, over the right gutter
        [
          INK_X + COLS_W - 1,
          INK_Y,
          1,
          COLS_H,
          INK_X + COLS_W,
          INK_Y,
          GUTTER_PX,
          COLS_H
        ],
        // top: the (now side-extended) first row, over the full pitch width
        [INK_X - GUTTER_PX, INK_Y, PITCH_W, 1, INK_X - GUTTER_PX, INK_Y - GUTTER_PX, PITCH_W, GUTTER_PX],
        // bottom: mirrored
        [
          INK_X - GUTTER_PX,
          INK_Y + COLS_H - 1,
          PITCH_W,
          1,
          INK_X - GUTTER_PX,
          INK_Y + COLS_H,
          PITCH_W,
          GUTTER_PX
        ]
      ])
      // The source is the page itself — a self-referencing drawImage, which 2D canvas defines as
      // reading a snapshot.
      expect(strips(stub.ops).every((o) => o.self)).toBe(true)
    })

    it('disables image smoothing while replicating and restores it afterwards', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      stub.ops.length = 0
      r.draw(0x2588, false, false, INK_X, INK_Y, FG, BG)
      // A 1-texel source stretched over GUTTER_PX texels has to REPLICATE, not resample: smoothing
      // would fade the copy back towards whatever the gutter held before.
      expect(strips(stub.ops).map((o) => o.smoothing)).toEqual([false, false, false, false])
      // …and the page-wide flag is left as it was found, because the next slot's bg fill and ink
      // are not this call's business. (Every draw restores it, so the second call still sees it
      // disabled only for its own strips.)
      r.draw(0x41, false, false, INK_X, INK_Y, FG, BG)
      expect(strips(stub.ops).map((o) => o.smoothing)).toEqual(new Array(8).fill(false))
      expect(stub.smoothingNow()).toBe(true)
    })

    /** Every texel of the slot's PITCH rect that lies outside its whole-texel cell box. */
    const gutterTexels = (): { x: number; y: number }[] => {
      const out: { x: number; y: number }[] = []
      for (let y = INK_Y - GUTTER_PX; y < INK_Y - GUTTER_PX + PITCH_H; y++)
        for (let x = INK_X - GUTTER_PX; x < INK_X - GUTTER_PX + PITCH_W; x++)
          if (x < INK_X || x >= INK_X + COLS_W || y < INK_Y || y >= INK_Y + COLS_H) out.push({ x, y })
      return out
    }

    it('a FULL-BLEED glyph leaves the whole gutter — corners included — carrying its ink', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      r.draw(0x2588, false, false, INK_X, INK_Y, FG, BG) // █ fills the cell edge to edge
      for (const { x, y } of gutterTexels()) expect(`${x},${y}:${stub.pixelAt(x, y)}`).toBe(`${x},${y}:${FG_CSS}`)
    })

    it('a glyph whose ink stays inside the cell leaves the gutter as background', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      r.draw(0x41, false, false, INK_X, INK_Y, FG, BG) // an ordinary letter — ink nowhere near the edge
      // Replication still runs (it is uniform, never conditional on where the ink landed); for
      // ordinary text it copies background over background, i.e. bit-identical to the old bg-filled
      // gutter. That is why no detection of "does this glyph bleed?" is needed anywhere.
      for (const { x, y } of gutterTexels()) expect(`${x},${y}:${stub.pixelAt(x, y)}`).toBe(`${x},${y}:${BG_CSS}`)
    })

    it('a half block continues the ink on ITS side only — the other gutter stays background', () => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(FONT, 256)!
      r.draw(0x258c, false, false, INK_X, INK_Y, FG, BG) // ▌ left half

      const midY = INK_Y + COLS_H / 2
      // Left gutter: ink, all the way out to the pitch edge.
      for (let x = INK_X - GUTTER_PX; x < INK_X; x++) expect(stub.pixelAt(x, midY)).toBe(FG_CSS)
      // Right gutter: background, because the cell's last column is background.
      for (let x = INK_X + COLS_W; x < INK_X + COLS_W + GUTTER_PX; x++)
        expect(stub.pixelAt(x, midY)).toBe(BG_CSS)
      // And the corners follow the side they belong to — the property the strip ORDER buys.
      expect(stub.pixelAt(INK_X - GUTTER_PX, INK_Y - GUTTER_PX)).toBe(FG_CSS)
      expect(stub.pixelAt(INK_X + COLS_W + GUTTER_PX - 1, INK_Y - GUTTER_PX)).toBe(BG_CSS)
      expect(stub.pixelAt(INK_X - GUTTER_PX, INK_Y + COLS_H + GUTTER_PX - 1)).toBe(FG_CSS)
    })

    /**
     * FRACTIONAL AND SUB-TEXEL CELLS. `device.cell.width` is `charWidth * dpr` and is fractional in
     * general, so `ceil` being the identity is a property of the 10x20 font above and of nothing
     * else. Two things have to hold on a fractional axis:
     *
     *  - the strip DESTINATIONS still tile the gutter frame EXACTLY (the pitch rect minus the whole
     *    texel columns/rows the cell occupies) — no double-covered texel, no missed one, and in
     *    particular a right/bottom gutter that is exactly GUTTER_PX wide rather than
     *    `pitch - cell` wide;
     *  - the strip SOURCE is the last FULLY covered texel, one further in than the cell's outermost
     *    texel — which on a fractional axis is only PARTIALLY covered by the cell. See the
     *    coverage table in raster.ts step 3 for why (replicating the partial texel leaves a
     *    37.5-point dip; sourcing the last full one drops it to 12.5).
     */
    const at = (ink: number, sizes: { cellW: number; cellH: number }) => {
      const cols = (c: number): number => Math.max(1, Math.ceil(c))
      return {
        font: { family: 'monospace', sizePx: 16, weight: 400, weightBold: 700, ...sizes },
        ink,
        colsW: cols(sizes.cellW),
        colsH: cols(sizes.cellH),
        pitchW: cols(sizes.cellW) + 2 * GUTTER_PX,
        pitchH: cols(sizes.cellH) + 2 * GUTTER_PX
      }
    }
    /** Source rects of the four strips, in emit order (left, right, top, bottom). */
    const sources = (ops: Op[]): number[][] => strips(ops).map((o) => o.args.slice(0, 4))
    /** Destination rects, same order. */
    const dests = (ops: Op[]): number[][] => strips(ops).map((o) => o.args.slice(4))
    const texelsOf = (rects: number[][]): string[] => {
      const out: string[] = []
      for (const [rx, ry, rw, rh] of rects)
        for (let j = ry; j < ry + rh; j++) for (let i = rx; i < rx + rw; i++) out.push(`${i},${j}`)
      return out
    }

    it('a FRACTIONAL cell sources the last FULLY COVERED column/row, not the partial edge texel', () => {
      const stub = stubCanvas()
      active = stub
      // 10.5 x 20.5: the cell's outermost texel on each axis is only HALF covered.
      const c = at(40, { cellW: 10.5, cellH: 20.5 })
      const r = createCanvasRasterizer(c.font, 256)!
      stub.ops.length = 0
      r.draw(0x2588, false, false, c.ink, c.ink, FG, BG)

      // ceil(10.5) - 1 = 10 would be the HALF-covered texel; floor(10.5) - 1 = 9 is the last full
      // one. The partial texel stays exactly where it is — it is genuine cell content.
      expect(sources(stub.ops)[1]).toEqual([c.ink + 9, c.ink, 1, c.colsH])
      expect(sources(stub.ops)[3]).toEqual([c.ink - GUTTER_PX, c.ink + 19, c.pitchW, 1])
      // The near edges are integral by construction (the ink origin is a whole texel), so their
      // sources are unchanged.
      expect(sources(stub.ops)[0]).toEqual([c.ink, c.ink, 1, c.colsH])
      expect(sources(stub.ops)[2]).toEqual([c.ink - GUTTER_PX, c.ink, c.pitchW, 1])
      // And the right gutter is exactly GUTTER_PX wide — not `pitch - cellW`.
      expect(dests(stub.ops)[1]).toEqual([c.ink + c.colsW, c.ink, GUTTER_PX, c.colsH])
      expect(dests(stub.ops)[3]).toEqual([c.ink - GUTTER_PX, c.ink + c.colsH, c.pitchW, GUTTER_PX])
    })

    it('a SUB-TEXEL cell sources its one (partial) texel rather than indexing off the page', () => {
      const stub = stubCanvas()
      active = stub
      // 0.5 x 0.5: `floor(cell) - 1` is -1, and the clamp is what keeps the source inside the slot.
      // There is exactly one texel, half covered, and it is the only thing there is to replicate.
      const c = at(40, { cellW: 0.5, cellH: 0.5 })
      const r = createCanvasRasterizer(c.font, 256)!
      stub.ops.length = 0
      r.draw(0x2588, false, false, c.ink, c.ink, FG, BG)

      expect(c.colsW).toBe(1)
      expect(sources(stub.ops)[1]).toEqual([c.ink, c.ink, 1, 1])
      expect(sources(stub.ops)[3]).toEqual([c.ink - GUTTER_PX, c.ink, c.pitchW, 1])
      expect(dests(stub.ops)[1]).toEqual([c.ink + 1, c.ink, GUTTER_PX, 1])
    })

    it.each([
      ['integral 10x20', { cellW: 10, cellH: 20 }],
      ['fractional 10.5x20.5', { cellW: 10.5, cellH: 20.5 }],
      ['barely-fractional 10.01x20.99', { cellW: 10.01, cellH: 20.99 }],
      ['sub-texel 0.5x0.5', { cellW: 0.5, cellH: 0.5 }]
    ])('tiles the gutter frame EXACTLY on a %s cell', (_label, sizes) => {
      const stub = stubCanvas()
      active = stub
      const c = at(40, sizes)
      const r = createCanvasRasterizer(c.font, 256)!
      stub.ops.length = 0
      r.draw(0x2588, false, false, c.ink, c.ink, FG, BG)

      const covered = texelsOf(dests(stub.ops))
      // No texel is written twice — the four strips abut, they do not overlap.
      expect(new Set(covered).size).toBe(covered.length)
      // And their union is precisely the pitch rect minus the cell's whole-texel box: every gutter
      // texel gets edge-extended, and not one texel of the cell is overwritten by a strip.
      const frame: string[] = []
      for (let j = c.ink - GUTTER_PX; j < c.ink - GUTTER_PX + c.pitchH; j++)
        for (let i = c.ink - GUTTER_PX; i < c.ink - GUTTER_PX + c.pitchW; i++)
          if (i < c.ink || i >= c.ink + c.colsW || j < c.ink || j >= c.ink + c.colsH)
            frame.push(`${i},${j}`)
      expect(new Set(covered)).toEqual(new Set(frame))
    })
  })

  /**
   * GEOMETRIC FAR-EDGE SNAPPING (device round, 2026-08-04, second screenshot). Edge-extended
   * gutters removed most of the grout, but a phase-dependent residual dip survived on a FRACTIONAL
   * axis: the cell's outermost texel is only partly covered, so a full-bleed geometric glyph left it
   * as a half ink / half background blend that no gutter content can cancel. In the COMPOSED frame
   * the other half of that boundary pixel is the NEIGHBOUR cell's ink, so full ink is the correct
   * colour there — xterm never meets this because its atlas cells are integral device px.
   *
   * So a box/block op whose span REACHES the far cell edge has that edge snapped outward to the
   * whole-texel cell box. Two things the tests below have to keep honest: only edges that actually
   * reach the boundary move (an interior edge — a half block's midline, a dash's tail — must not),
   * and only the GEOMETRY branch is affected (a font glyph's partial far column is genuine
   * antialiased content).
   */
  describe('geometric far-edge snapping', () => {
    /** A fractional cell on BOTH axes: 10.5 x 20.5, whole-texel box 11 x 21. */
    const FRAC = { family: 'monospace', sizePx: 16, cellW: 10.5, cellH: 20.5, weight: 400, weightBold: 700 }
    const FRAC_COLS_W = 11
    const FRAC_COLS_H = 21
    /** A whole-texel ink origin, as `GlyphAtlas.cellXY` always hands over. */
    const IX = 40

    /** The ink ops in CELL-LOCAL coordinates — i.e. exactly what the box branch filled. */
    const inkRects = (ops: Op[], ink = IX): number[][] =>
      ops
        .filter((o) => o.kind === 'fillRect' && o.fill === FG_CSS)
        .map((o) => [o.args[0] - ink, o.args[1] - ink, o.args[2], o.args[3]])

    const drawFrac = (code: number, font = FRAC): ReturnType<typeof stubCanvas> => {
      const stub = stubCanvas()
      active = stub
      const r = createCanvasRasterizer(font, 256)!
      stub.ops.length = 0
      r.draw(code, false, false, IX, IX, FG, BG)
      return stub
    }

    it('grows a FULL-BLEED block to the whole-texel cell box on a fractional cell', () => {
      const stub = drawFrac(0x2588) // █
      // 10.5 x 20.5 of ink would leave the outermost texel on each axis half covered; 11 x 21 fills
      // it. The op still STARTS at 0 — the near edges need no snap, see the dedicated pin below.
      expect(inkRects(stub.ops)).toEqual([[0, 0, FRAC_COLS_W, FRAC_COLS_H]])
    })

    it('snaps ONLY the far edge of a right-half block — its interior midline does not move', () => {
      const stub = drawFrac(0x2590) // ▐ right half
      // The midline is `round(4/8 * 10.5)` = 5, a genuine INTERIOR edge sitting ~half a cell from
      // the boundary; the right edge reaches 10.5 and becomes the whole texel 11, i.e. w = 11 - 5.
      expect(inkRects(stub.ops)).toEqual([[5, 0, FRAC_COLS_W - 5, FRAC_COLS_H]])
    })

    it('snaps the right end of a horizontal rule, leaving its thickness alone', () => {
      const stub = drawFrac(0x2500) // ─
      // The rule spans the cell horizontally (→ snapped) and is one device px thick, centred: its
      // bottom edge is nowhere near the cell's, so the vertical axis is untouched.
      expect(inkRects(stub.ops)).toEqual([[0, 10, FRAC_COLS_W, 1]])
    })

    it('leaves a non-edge-reaching span alone — the two axes are decided independently', () => {
      const stub = drawFrac(0x2502) // │
      const [x, y, w, h] = inkRects(stub.ops)[0]
      // The stem sits at the cell's midline: 1 device px wide, five texels short of the far edge.
      // Untouched, both position and width.
      expect([x, w]).toEqual([5, 1])
      // Its own far edge — the BOTTOM — does reach, and snaps. Nothing about the horizontal axis
      // follows from that.
      expect([y, h]).toEqual([0, FRAC_COLS_H])
    })

    it('does not capture a dashed rule whose last dash merely ends NEAR the far edge', () => {
      const stub = drawFrac(0x2508) // ┈ — four dashes, deliberately NOT tiling
      // The guard on the epsilon. On a 10.5-wide cell the last dash rounds to a right edge of 10,
      // exactly HALF A PIXEL short of the boundary — so the "obvious" `>= cellW - 0.5` tolerance
      // would weld it to the next cell's first dash and quietly turn ┈ into ─. The gap IS the
      // character, so the tolerance has to be tight enough to leave it.
      expect(inkRects(stub.ops)).toEqual([
        [0, 10, 2, 1],
        [3, 10, 1, 1],
        [5, 10, 2, 1],
        [8, 10, 2, 1]
      ])
    })

    it('needs no near-edge snap — an op that starts at the cell edge already starts on a texel', () => {
      const stub = drawFrac(0x2588)
      // The ink ORIGIN is a whole texel (`GlyphAtlas.cellXY` derives it from the whole-texel pitch),
      // and `span`'s `snap` returns a literal 0 for anything at or before the near edge. So the near
      // edges are flush with a texel boundary by construction and there is nothing to round out.
      for (const [x, y] of inkRects(stub.ops)) {
        expect(x).toBe(0)
        expect(y).toBe(0)
      }
      expect(Number.isInteger(IX)).toBe(true)
    })

    it('clips the GEOMETRY branch to the whole-texel box and the FONT branch to the fractional cell', () => {
      // Geometry: the clip has to admit the snap, or the widened rects are simply cut back.
      const geo = drawFrac(0x2588)
      expect(geo.ops.find((o) => o.kind === 'clip')).toEqual({
        kind: 'clip',
        args: [IX, IX, FRAC_COLS_W, FRAC_COLS_H]
      })
      active?.restore()
      active = null
      // Font: unchanged, and deliberately so. A glyph's partial far column carries genuine
      // antialiased glyph edge — real content, drawn by the platform rasterizer — and overwriting
      // or extending it would corrupt pixels rather than complete a shape we generated ourselves.
      const font = drawFrac(0x41) // 'A'
      expect(font.ops.find((o) => o.kind === 'clip')).toEqual({
        kind: 'clip',
        args: [IX, IX, FRAC.cellW, FRAC.cellH]
      })
      expect(font.ops.some((o) => o.kind === 'fillText')).toBe(true)
    })

    /**
     * The PIXEL half of the claim, and why it is measured at .25 rather than at the brief's .5.
     *
     * The stub's pixel model is hard-edged and assigns a texel by its CENTRE (`Math.round`), so on a
     * `.5`-fractional cell it already reports the half-covered edge texel as fully inked — the model
     * cannot distinguish before from after there, which is precisely the kind of "green either way"
     * assertion that pins nothing. At `.25` the centre of that texel falls OUTSIDE the fractional
     * cell, so the model leaves it as background until the snap fills it. The `.5` case is pinned
     * exactly, on op GEOMETRY, by the first test in this block.
     */
    it('fills the partial far texel on a fractional cell, and the gutter beyond continues it', () => {
      const stub = stubCanvas()
      active = stub
      // 10.25 x 20.25: whole-texel box 11 x 21, last FULLY covered texel 9 / 19.
      const r = createCanvasRasterizer({ family: 'monospace', sizePx: 16, cellW: 10.25, cellH: 20.25, weight: 400, weightBold: 700 }, 256)!
      r.draw(0x2588, false, false, IX, IX, FG, BG) // █

      // The partial far column and row — texel 10 / 20 — now carry FULL ink rather than a blend
      // fading to background.
      expect(stub.pixelAt(IX + 10, IX + 5)).toBe(FG_CSS)
      expect(stub.pixelAt(IX + 5, IX + 20)).toBe(FG_CSS)
      // Including the corner where the two meet.
      expect(stub.pixelAt(IX + 10, IX + 20)).toBe(FG_CSS)
      // And the gutter past the box continues it, so a minified sample at the boundary keeps
      // averaging ink with ink all the way out to the pitch edge.
      for (let g = 0; g < GUTTER_PX; g++) {
        expect(stub.pixelAt(IX + 11 + g, IX + 5)).toBe(FG_CSS)
        expect(stub.pixelAt(IX + 5, IX + 21 + g)).toBe(FG_CSS)
      }
    })

    it('leaves the STIPPLE shades a stipple — a far-edge dot grows by a partial texel at most', () => {
      const stub = drawFrac(0x2592) // ▒ — a dither pattern, not a tint
      const rects = inkRects(stub.ops)
      // Still a scatter of pattern-sized runs rather than one grown slab: the snap only ever moves
      // a run's OWN far edge out to the whole texel, so a dot that happens to sit against the cell
      // edge gains half a texel (1 → 1.5 here) and every other dot is untouched. Half a texel of a
      // dither dot reads as ~50% tone either way, which is why the shades need no special case.
      expect(rects.length).toBeGreaterThan(10)
      for (const [, , w, h] of rects) {
        expect(w).toBeLessThanOrEqual(1.5)
        expect(h).toBeLessThanOrEqual(1.5)
      }
      // And the tone is still a tone: ▒ is a 2-of-8 pattern, nowhere near a filled cell.
      const inked = rects.reduce((sum, [, , w, h]) => sum + w * h, 0)
      expect(inked).toBeLessThan(0.4 * FRAC_COLS_W * FRAC_COLS_H)
    })
  })
})

/**
 * The shrink factor on its own — the arithmetic, without a canvas in the way.
 *
 * Separate from the draw tests because the interesting cases are the EDGES (the tolerance, the
 * floor, a platform that reports no ink box), and each of those is one number rather than a
 * rendering.
 */
describe('underline', () => {
  /**
   * Reported 2026-08-05: a hovered link showed no underline in shared mode while GPU mode drew one.
   * The cause was broader than links — `FLAG_UNDERLINE` was written by the feed and read by nobody,
   * so NO underline rendered at all, including a plain `\e[4m` run.
   */
  it('draws a rule at the bottom of the cell, spanning the WHOLE-TEXEL box', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x41, false, false, INK_X, INK_Y, FG, BG, 'whole', true)
    const rule = stub.ops.filter((o) => o.kind === 'fillRect').at(-1)!
    // Full box width, not the fractional cell: consecutive underlined cells have to JOIN, and a
    // rule that stopped inside the partial edge texel would dash at every cell boundary.
    expect(rule.args[0]).toBe(INK_X)
    expect(rule.args[2]).toBe(COLS_W)
    // Bottom of the cell, in the FOREGROUND colour.
    expect(rule.args[1]).toBe(INK_Y + COLS_H - 1)
    expect(rule.fill).toBe(FG_CSS)
  })

  it('draws NOTHING extra when the cell is not underlined', () => {
    const plain = stubCanvas()
    active = plain
    createCanvasRasterizer(FONT, 256)!.draw(0x41, false, false, INK_X, INK_Y, FG, BG)
    const underlined = stubCanvas()
    active = underlined
    createCanvasRasterizer(FONT, 256)!.draw(0x41, false, false, INK_X, INK_Y, FG, BG, 'whole', true)
    expect(underlined.ops.length).toBeGreaterThan(plain.ops.length)
  })
})

describe('underlineThickness', () => {
  it("follows xterm's own rule, so the weight matches the renderer beside it", () => {
    expect(underlineThickness(15)).toBe(1)
    expect(underlineThickness(30)).toBe(2)
    expect(underlineThickness(45)).toBe(3)
  })

  it('never rounds away to nothing — an absent underline IS the bug', () => {
    expect(underlineThickness(8)).toBe(1)
    expect(underlineThickness(0)).toBe(1)
    expect(underlineThickness(NaN)).toBe(1)
  })
})

describe('shrinkToFit', () => {
  const metrics = (left: number, right: number): TextMetrics =>
    ({ actualBoundingBoxLeft: left, actualBoundingBoxRight: right }) as TextMetrics

  it('returns exactly 1 for ink that fits, so the caller takes the untouched path', () => {
    expect(shrinkToFit(metrics(0, 8), 10)).toBe(1)
    expect(shrinkToFit(metrics(2, 6), 10)).toBe(1)
  })

  it('scales an oversized glyph down to its allowance', () => {
    expect(shrinkToFit(metrics(0, 14), 10)).toBeCloseTo(10 / 14)
    // The ink box is measured either side of the ORIGIN — a glyph with a left side bearing that
    // reaches back past it is just as oversized as one that runs long to the right.
    expect(shrinkToFit(metrics(4, 10), 10)).toBeCloseTo(10 / 14)
  })

  it('tolerates a small overhang', () => {
    expect(shrinkToFit(metrics(0, 10.4), 10)).toBe(1) // 4% — the fringe
    expect(shrinkToFit(metrics(0, 10.5), 10)).toBeLessThan(1) // past it
  })

  it('stops shrinking at the floor — a legible fragment beats an illegible whole', () => {
    // 25px in a 10px cell would be a 0.4 scale. Clamped, so the excess is clipped as it always was
    // (L16) rather than rendering something too small to read.
    expect(shrinkToFit(metrics(0, 25), 10)).toBe(0.6)
  })

  it('declines to shrink when the platform reports no usable ink box', () => {
    // The failure to avoid is a NaN scale silently blanking every glyph. Declining restores the
    // pre-2026-08-05 behaviour for that platform, which is a correct outcome, not a broken one.
    expect(shrinkToFit({} as TextMetrics, 10)).toBe(1)
    expect(shrinkToFit(metrics(NaN, NaN), 10)).toBe(1)
    expect(shrinkToFit(metrics(0, 0), 10)).toBe(1)
    expect(shrinkToFit(metrics(0, 14), 0)).toBe(1)
  })
})

/**
 * The line between "this glyph may be shrunk" and "this glyph must be left alone" is not a ratio —
 * bold-italic `X` measures 1.25 of its advance and so does the icon shrink-to-fit was written for.
 * It is what the character IS.
 */
describe('shrinkEligible', () => {
  it('refuses every letter, digit and ASCII punctuation', () => {
    for (const ch of 'AZaz09.,;:!?-_/\\|()[]{}<>@#$%^&*+="\'`~') {
      expect(shrinkEligible(ch.codePointAt(0) as number), ch).toBe(false)
    }
  })

  it('refuses accented and non-Latin TEXT, which overhangs for the same reasons', () => {
    for (const ch of 'çğışöüÇĞİŞÖÜéèñåøαβγдж') {
      expect(shrinkEligible(ch.codePointAt(0) as number), ch).toBe(false)
    }
  })

  it('allows the symbols drawn to a box — the class the shrink exists for', () => {
    for (const ch of '⧉⎿★⭐▪◆➜✦☑⏺🎉👍') {
      expect(shrinkEligible(ch.codePointAt(0) as number), ch).toBe(true)
    }
  })
})

/**
 * The 2026-08-09 report — external feedback that "the terminal text isn't so crisp", confirmed by
 * the author comparing Shared against GPU per terminal on a Retina display.
 *
 * The atlas was already measured innocent on resolution (dumped `cellH` 36 at dpr 2, i.e. device
 * pixels), the sampler is NEAREST at zoom >= 1, the pan is snapped to whole device pixels and the
 * drawing buffer follows the dpr. What was left was WEIGHT: this file built its font string with no
 * weight token at all for regular text and the literal `bold` for bold, so `settings.fontWeight` /
 * `fontWeightBold` were silently discarded. Invisible at the defaults — no token means 400 and
 * `bold` means 700, which is exactly the default pair — and LIGHTER than the GPU renderer beside it
 * for anyone who had moved the picker.
 */
describe('font weight reaches the rasterized glyph', () => {
  const fontAt = (weight: number, weightBold: number) => ({
    family: 'monospace',
    sizePx: 16,
    cellW: 10,
    cellH: 20,
    weight,
    weightBold
  })

  const fontStringFor = (weight: number, weightBold: number, bold: boolean): string => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(fontAt(weight, weightBold), 256)!
    stub.ops.length = 0
    r.draw(0x41, bold, false, INK_X, INK_Y, FG, BG)
    return stub.ops.find((o) => o.kind === 'fillText')?.font ?? ''
  }

  it('uses the configured regular weight, not the CSS default', () => {
    expect(fontStringFor(500, 700, false)).toContain('500 16px')
  })

  it('uses the configured BOLD weight, not the `bold` keyword', () => {
    // The keyword is 700 and nothing else, so it silently discarded a user's 600 or 800.
    expect(fontStringFor(400, 600, true)).toContain('600 16px')
    expect(fontStringFor(400, 600, true)).not.toContain('bold')
  })

  it('still produces the historical string at the DEFAULT weights', () => {
    // 400/700 is what "no token" and "bold" already meant, so nobody on defaults sees a change.
    expect(fontStringFor(400, 700, false)).toContain('400 16px')
    expect(fontStringFor(400, 700, true)).toContain('700 16px')
  })
})

/**
 * THE BLANK-EVERYTHING BUG the sentinel exists for.
 *
 * The atlas page is an OffscreenCanvas 2D context, and a GPU reset (sleep/wake, a driver hiccup)
 * blanks its backing store. Nothing downstream notices: `GlyphAtlas.slots` still holds every key, so
 * no glyph is ever re-rasterized, and `engine.reviveGpu` re-uploads the now-EMPTY page as the atlas
 * texture. Every terminal on the canvas shows empty cells at once, for the rest of the session.
 *
 * One texel of known colour, checked with a 1px readback, is what turns that into a detectable
 * event — including the silent case, where the 2D context fires no `contextlost` at all.
 */
describe('sentinelIntact', () => {
  it('accepts the sentinel colour', () => {
    expect(sentinelIntact([...ATLAS_SENTINEL_RGBA])).toBe(true)
  })

  it('REJECTS transparent-black, which is what a blanked page reads back as', () => {
    expect(sentinelIntact([0, 0, 0, 0])).toBe(false)
  })

  it('rejects an opaque black or white page — a wipe need not be to transparent', () => {
    expect(sentinelIntact([0, 0, 0, 255])).toBe(false)
    expect(sentinelIntact([255, 255, 255, 255])).toBe(false)
  })

  it('tolerates a few units of colour-management rounding either way', () => {
    expect(sentinelIntact([252, 3, 251, 255])).toBe(true)
  })

  it('rejects a short buffer rather than reading past the end', () => {
    expect(sentinelIntact([255, 0, 255])).toBe(false)
  })
})

describe('atlas page health', () => {
  it('reports the page intact right after construction', () => {
    const stub = stubCanvas()
    active = stub
    expect(createCanvasRasterizer(FONT, 256)!.sourceIntact()).toBe(true)
  })

  it('reports the page intact after a clearPage, because a reset repaints the sentinel', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    r.clearPage()
    expect(r.sourceIntact()).toBe(true)
  })

  it('reports LOST when the backing store was wiped behind our back', () => {
    // Exactly the silent case: no event fired, `slots` still full, and the next `reviveGpu` would
    // upload an empty page over every terminal on the canvas.
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.blankPage()
    expect(r.sourceIntact()).toBe(false)
  })

  it('reports LOST on isContextLost() without needing the readback', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.setContextLost(true)
    expect(r.sourceIntact()).toBe(false)
  })

  it('routes contextlost / contextrestored to the caller and does NOT cancel the loss', () => {
    // Cancelling `contextlost` tells the browser not to restore automatically, which is the
    // opposite of what this wants: the restore is the signal that a fresh page can be built.
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    const seen: string[] = []
    r.onSourceLoss({ lost: () => seen.push('lost'), restored: () => seen.push('restored') })
    expect(stub.fire('contextlost')).toBe(false)
    stub.fire('contextrestored')
    expect(seen).toEqual(['lost', 'restored'])
  })

  it('dispose() unsubscribes, so a rebuilt context never hears the old page`s events', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    const seen: string[] = []
    const sub = r.onSourceLoss({ lost: () => seen.push('lost'), restored: () => undefined })
    sub.dispose()
    expect(stub.listenerCount()).toBe(0)
    stub.fire('contextlost')
    expect(seen).toEqual([])
  })
})
