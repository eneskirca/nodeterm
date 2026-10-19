/**
 * The addon's test fakes: a recording `GridHandle`, a recording atlas, a fake decoration service, a
 * fake blink seam, and the `TermInternals` a terminal would supply.
 *
 * NOT a `.test.ts`, deliberately. Two test files need these — `addon.test.ts` and the shared
 * layer's, which drives the real addon through the real blink clock — and importing one test file
 * from another makes vitest COLLECT the imported file's whole suite a second time under the
 * importer. A plain module is the only way to share a harness. It is also dead code in a production
 * build: nothing outside the two test files imports it.
 *
 * It lives on the glyphgrid side because the dependency direction is canvas → glyphgrid. The layer
 * test may reach in here; this directory must never reach out.
 */

import type { GlyphAtlas } from './atlas'
import { packColor } from './cells'
import type { GridCursor } from './cursor'
import type { GridHandle } from './engine'
import type { CursorBlinkPhaseTarget, CursorBlinkSeam, TermInternals } from './addon'
import type { DecorationReader } from './decorations'
import type { CellView, ThemeLanes } from './feed'

export const THEME: ThemeLanes = {
  fg: packColor(0xd0, 0xd1, 0xd2, 0xff),
  bg: packColor(0x10, 0x11, 0x12, 0xff),
  ansi: Array.from({ length: 256 }, (_, i) => packColor(i, 0x80, 0xff - i, 0xff)),
  cursorFg: packColor(0x01, 0x02, 0x03, 0xff),
  cursorBg: packColor(0xfa, 0xfb, 0xfc, 0xff),
  selectionBg: packColor(0x30, 0x50, 0x80, 0xff)
}

/** A cell whose code point encodes the ABSOLUTE buffer row it came from, so a packed row can be
 *  traced back to the buffer row that produced it — which is the whole point of the mapping
 *  tests (a viewportY off-by-one is otherwise invisible). */
export function rowCodedCell(absRow: number, col: number): CellView {
  const code = 0x100 + absRow * 16 + col
  return {
    getChars: () => String.fromCodePoint(code),
    getCode: () => code,
    getWidth: () => 1,
    isBold: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isStrikethrough: () => 0,
    isInverse: () => 0,
    isDim: () => 0,
    isFgDefault: () => true,
    isFgPalette: () => false,
    isFgRGB: () => false,
    isBgDefault: () => true,
    isBgPalette: () => false,
    isBgRGB: () => false,
    getFgColor: () => 0,
    getBgColor: () => 0
  }
}

export interface RecordedRow {
  row: number
  /** Copy — the core reuses ONE row buffer, so keeping the live reference would record the last
   *  frame N times. */
  cells: Uint32Array
  /** The buffer INSTANCE handed to updateRow, kept only to assert the reuse contract. */
  buf: Uint32Array
}

export function recordingHandle(): GridHandle & {
  rows: RecordedRow[]
  log: string[]
  resizes: Array<[number, number]>
  /** Every cursor spec pushed to the grid, newest last — `at(-1)` is what a frame would draw. */
  cursors: Array<GridCursor | null>
} {
  const rows: RecordedRow[] = []
  const log: string[] = []
  const resizes: Array<[number, number]> = []
  const cursors: Array<GridCursor | null> = []
  return {
    rows,
    log,
    resizes,
    cursors,
    updateRow(row, cells) {
      log.push(`updateRow:${row}`)
      rows.push({ row, cells: cells.slice(), buf: cells })
    },
    setOrigin() {},
    // The addon owns CELLS, never geometry — the plate is the node's business. A stub, present
    // only to satisfy the handle contract.
    setPlateRect() {},
    setCursor(cursor) {
      cursors.push(cursor)
    },
    setZ() {},
    resize(cols, r) {
      log.push(`resize:${cols}x${r}`)
      resizes.push([cols, r])
    },
    dispose() {
      log.push('dispose')
    }
  }
}

/** The atlas surface the addon holds: a slot source AND a reset broadcaster.
 *
 *  `fireReset()` is the test's hand on the real atlas's most awkward behaviour — a reset fires
 *  SYNCHRONOUSLY inside a `glyphFor` call, i.e. in the middle of someone's row pack — so
 *  `onGlyphFor` exists to fire it from exactly there. */
export function recordingAtlas(o: { onGlyphFor?: (fire: () => void) => void } = {}): Pick<
  GlyphAtlas,
  'glyphFor' | 'onReset'
> & { fireReset(): void; subCount(): number } {
  const subs = new Set<() => void>()
  const fireReset = (): void => {
    for (const cb of [...subs]) cb()
  }
  return {
    // Identity-ish: the slot IS derived from the code point, so a packed glyph lane names the cell
    // it came from without a second bookkeeping structure.
    glyphFor: (code) => {
      o.onGlyphFor?.(fireReset)
      return code
    },
    onReset: (cb) => {
      subs.add(cb)
      return {
        dispose: (): void => {
          subs.delete(cb)
        }
      }
    },
    fireReset,
    subCount: () => subs.size
  }
}

/** The decoration surface the shell hands over: a reader plus the two "something changed" events.
 *  `fire*` is the test's hand on xterm's decoration service — the search addon registering a hit. */
export function fakeDecorations(
  entries: Array<{ col: number; row: number; layer?: string; bg?: number; fg?: number }> = []
): {
  reader: DecorationReader
  onDecorationRegistered(cb: () => void): { dispose(): void }
  onDecorationRemoved(cb: () => void): { dispose(): void }
  fireRegistered(): void
  fireRemoved(): void
  subCount(): number
} {
  const registered = new Set<() => void>()
  const removed = new Set<() => void>()
  const sub = (set: Set<() => void>, cb: () => void): { dispose(): void } => {
    set.add(cb)
    return {
      dispose: (): void => {
        set.delete(cb)
      }
    }
  }
  return {
    reader: {
      empty: () => entries.length === 0,
      atCell: (col, row, cb) => entries.filter((e) => e.col === col && e.row === row).forEach(cb)
    },
    onDecorationRegistered: (cb) => sub(registered, cb),
    onDecorationRemoved: (cb) => sub(removed, cb),
    fireRegistered: () => {
      for (const cb of [...registered]) cb()
    },
    fireRemoved: () => {
      for (const cb of [...removed]) cb()
    },
    subCount: () => registered.size + removed.size
  }
}

/** The canvas blink clock's end of the seam, as the attach shell implements it: `release` is
 *  IDENTITY-GUARDED, because browsers do not promise that the blurred terminal's blur reaches us
 *  before the newly focused one's focus. Modelling that here is what makes the handover assertion
 *  mean anything — an unguarded fake would pass against an unguarded shell.
 *
 *  `onRelease` stands in for the clock's own restoring `setPhase(true)`, which is the behaviour
 *  `dispose` has to leave room for. */
export function fakeBlinkSeam(o: { onRelease?: (t: CursorBlinkPhaseTarget) => void } = {}): {
  seam: CursorBlinkSeam
  target(): CursorBlinkPhaseTarget | null
  claims: CursorBlinkPhaseTarget[]
  releases: CursorBlinkPhaseTarget[]
  restarts: CursorBlinkPhaseTarget[]
} {
  let current: CursorBlinkPhaseTarget | null = null
  const claims: CursorBlinkPhaseTarget[] = []
  const releases: CursorBlinkPhaseTarget[] = []
  const restarts: CursorBlinkPhaseTarget[] = []
  return {
    seam: {
      claim(t) {
        claims.push(t)
        current = t
      },
      release(t) {
        releases.push(t)
        if (current !== t) return
        current = null
        o.onRelease?.(t)
      },
      // Recorded UNGUARDED, unlike `release`: the identity guard for a restart is the real seam's
      // (`restartCursorBlink`, tested where it lives), so what an addon test learns from this list
      // is whether the ADDON asked at all — which is its own focus rule.
      restart(t) {
        restarts.push(t)
      }
    },
    target: () => current,
    claims,
    releases,
    restarts
  }
}

export interface FakeTermOpts {
  cols?: number
  rows?: number
  viewportY?: number
  baseY?: number
  cursorX?: number
  cursorY?: number
  cursorVisible?: boolean
  focus?: boolean
  decorations?: ReturnType<typeof fakeDecorations>
  /** xterm's two cursor options, verbatim. ABSENT on purpose in every test that does not name them:
   *  an xterm build that stopped reporting them must degrade to xterm's own defaults (a focused
   *  block, a blurred outline), never to no cursor at all. */
  cursorStyle?: { style?: string; inactiveStyle?: string }
  /** Columns whose cell reports width 2 — a wide glyph's LEAD. The column after one reports width
   *  0, exactly as xterm's buffer stores a double-width character. */
  wideCols?: readonly number[]
  /** The blink seam. ABSENT in every test that does not name it — a build with no shared layer
   *  hands the addon exactly this, and the cursor simply never blinks. */
  blink?: CursorBlinkSeam
}

export type FakeTermState = Required<
  Omit<FakeTermOpts, 'decorations' | 'cursorStyle' | 'wideCols' | 'blink'>
>

export function fakeTerm(o: FakeTermOpts = {}): TermInternals & { state: FakeTermState } {
  const state: FakeTermState = {
    cols: o.cols ?? 4,
    rows: o.rows ?? 6,
    viewportY: o.viewportY ?? 0,
    baseY: o.baseY ?? 0,
    cursorX: o.cursorX ?? 0,
    cursorY: o.cursorY ?? 0,
    cursorVisible: o.cursorVisible ?? true,
    focus: o.focus ?? true
  }
  const workCell = rowCodedCell(-1, -1)
  return {
    state,
    cols: () => state.cols,
    rows: () => state.rows,
    viewportY: () => state.viewportY,
    baseY: () => state.baseY,
    cursorX: () => state.cursorX,
    cursorY: () => state.cursorY,
    cursorVisible: () => state.cursorVisible,
    readCell: (absRow, col) => {
      const wide = o.wideCols ?? []
      if (wide.includes(col)) return { ...rowCodedCell(absRow, col), getWidth: () => 2 }
      if (wide.includes(col - 1)) return { ...rowCodedCell(absRow, col), getWidth: () => 0 }
      return rowCodedCell(absRow, col)
    },
    makeWorkCell: () => workCell,
    deviceMetrics: () => ({ charW: 16, charH: 34, cellW: 16, cellH: 34 }),
    dpr: () => 2,
    theme: () => THEME,
    hasFocus: () => state.focus,
    // Absent unless a test names them — see FakeTermOpts.cursorStyle.
    cursorStyle: o.cursorStyle ? () => o.cursorStyle as { style?: string } : undefined,
    // Absent unless a test asks for it, like the decorations below.
    blink: o.blink,
    // Absent unless a test asks for them — an xterm build with no decoration service hands the
    // addon exactly this, and every other test in this file is that case.
    decorations: o.decorations?.reader,
    onDecorationRegistered: o.decorations?.onDecorationRegistered,
    onDecorationRemoved: o.decorations?.onDecorationRemoved
  }
}
