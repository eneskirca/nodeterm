import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CANVAS_COVERED_ATTR,
  canvasCoveredDepth,
  coveredByBoard,
  markCanvasCovered,
  resetCanvasCoveredForTest,
  type CoveredRoot
} from './canvasCovered'

function fakeRoot() {
  const attrs = new Map<string, string>()
  const writes: string[] = []
  const root: CoveredRoot = {
    setAttribute: (n, v) => {
      attrs.set(n, v)
      writes.push('set:' + v)
    },
    removeAttribute: (n) => {
      attrs.delete(n)
      writes.push('remove')
    }
  }
  return { root, writes, value: () => attrs.get(CANVAS_COVERED_ATTR) }
}

beforeEach(() => resetCanvasCoveredForTest())

describe('markCanvasCovered', () => {
  it('marks and unmarks around one surface', () => {
    const h = fakeRoot()
    const release = markCanvasCovered(h.root)
    expect(h.value()).toBe('covered')
    release()
    expect(h.value()).toBeUndefined()
  })

  it('survives an overlapping view switch', () => {
    // React can mount the incoming surface before unmounting the outgoing one. A plain set/clear
    // pair would let that unmount erase the live surface's claim, leaving the canvas animating
    // under a board that is very much on screen.
    const h = fakeRoot()
    const outgoing = markCanvasCovered(h.root)
    const incoming = markCanvasCovered(h.root)
    outgoing()
    expect(h.value()).toBe('covered')
    incoming()
    expect(h.value()).toBeUndefined()
  })

  it('writes the attribute once per covered period, not once per surface', () => {
    const h = fakeRoot()
    const a = markCanvasCovered(h.root)
    const b = markCanvasCovered(h.root)
    b()
    a()
    expect(h.writes).toEqual(['set:covered', 'remove'])
  })

  it('ignores a repeated release rather than driving the count negative', () => {
    // A double-invoked effect cleanup would otherwise leave the depth at -1, and the NEXT board
    // open would not reach 1 — the attribute would silently never be set again.
    const h = fakeRoot()
    const release = markCanvasCovered(h.root)
    release()
    release()
    expect(canvasCoveredDepth()).toBe(0)

    const again = markCanvasCovered(h.root)
    expect(h.value()).toBe('covered')
    again()
    expect(h.value()).toBeUndefined()
  })
})

describe('coveredByBoard', () => {
  /** An element `inFlow` of React Flow (or not), in a document whose root says `covered` (or not). */
  function el(covered: boolean, inFlow: boolean) {
    return {
      ownerDocument: {
        documentElement: { getAttribute: (n: string) => (covered && n === CANVAS_COVERED_ATTR ? 'covered' : null) }
      },
      closest: (sel: string) => (inFlow && sel === '.react-flow' ? {} : null)
    }
  }

  it('is true only for part of the canvas while a board covers it', () => {
    expect(coveredByBoard(el(true, true))).toBe(true)
    expect(coveredByBoard(el(false, true))).toBe(false)
  })

  it('is false outside the canvas: the card modal, a focus-mode node lifted above the board', () => {
    expect(coveredByBoard(el(true, false))).toBe(false)
  })
})

/**
 * Source-level pin, in the shape of `hook-verified-parity.test.ts`. Both board views cover the
 * canvas and BOTH must claim it; wiring one leaves the other silently without the gate, and the
 * failure is invisible — the board looks identical either way, and only a power measurement on a
 * machine nobody is watching would ever show it.
 */
describe('both full-page board views claim the canvas', () => {
  const views = ['KanbanView.tsx', 'GlobalKanbanView.tsx']

  it.each(views)('%s calls markCanvasCovered', (file) => {
    const src = fs
      .readFileSync(path.join(__dirname, '..', 'components', 'kanban', file), 'utf8')
      .replace(/\r\n/g, '\n')
    expect(src).toContain('markCanvasCovered')
  })
})

/** And the CSS has to act on the attribute, or the claim is bookkeeping nobody reads. */
describe('the covered attribute is wired to the stylesheet', () => {
  const css = fs
    .readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8')
    .replace(/\r\n/g, '\n')

  it('pauses the variable-gated animations on the canvas subtree', () => {
    expect(css).toMatch(
      /:root\[data-nt-canvas='covered'\]\s+\.react-flow\s*\{\s*--nt-anim-state:\s*paused/
    )
  })

  it('pauses the sessions sidebar too: pinned, it sits UNDER the board and kept animating', () => {
    // MEASURED (Server Edition, headless Chrome, pinned sidebar fully covered by the board, 20
    // working agents): its spinners alone held GPU 4.5 % + renderer 5.7 %, ~0 % with them paused.
    expect(css).toMatch(
      /:root\[data-nt-canvas='covered'\]\s+\.sessions-sidebar\s*\{\s*--nt-anim-state:\s*paused/
    )
    // Every animation in it reads the variable, so the inherited override is the whole gate.
    for (const sel of ['.ss-dot--working', '.ss-group__sig-spin', '.ss-check--unread', '.ss-bell']) {
      const i = css.indexOf(sel + ' {')
      expect(i, sel).toBeGreaterThanOrEqual(0)
      expect(css.slice(i, css.indexOf('}', i)), sel).toContain('animation-play-state: var(--nt-anim-state)')
    }
  })

  it.each(['unread', 'working', 'attention'])(
    'pauses the %s glow, which is not in the variable scheme',
    (state) => {
      // The three glows carry their own `animation:` shorthand, which RESETS play-state — so
      // inheriting the variable does nothing for them and they need naming here. A rule that
      // loses on specificity is the quiet version of this bug: it is present in the diff and
      // has no effect.
      expect(css).toContain(
        `:root[data-nt-canvas='covered'] .react-flow__node:has(.term-node.${state})::after`
      )
    }
  )
})
