// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installLinkContextMenu, linkAtCell, type LinkHit, type LinkHitDeps } from './file-links'

const COLS = 40
const CELL_W = 10
const CELL_H = 20

/**
 * The slice of xterm the hit-test and the listener read: a buffer of plain rows (no wraps), the
 * `.xterm-screen` box the pointer maps against, and an optional OSC 8 cell. `host` stands in for
 * `term.element`; a child plays xterm's own element, whose listeners must never see a swallowed
 * event.
 */
function fakeTerm(rows: string[], osc8?: { row: number; col: number; uri: string }) {
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: COLS * CELL_W, height: rows.length * CELL_H }) as DOMRect
  host.appendChild(screen)
  document.body.appendChild(host)
  const term = {
    cols: COLS,
    rows: rows.length,
    element: host,
    modes: { mouseTrackingMode: 'vt200' },
    buffer: {
      active: {
        viewportY: 0,
        length: rows.length,
        getLine: (r: number) =>
          r < rows.length
            ? {
                isWrapped: false,
                translateToString: (trim: boolean) => (trim ? rows[r].trimEnd() : rows[r].padEnd(COLS)),
                getCell: (c: number) => ({
                  extended: { urlId: osc8 && osc8.row === r && osc8.col === c ? 7 : 0 }
                })
              }
            : undefined
      }
    },
    _core: { _oscLinkService: { getLinkData: () => (osc8 ? { uri: osc8.uri } : undefined) } }
  } as unknown as Terminal
  return { term, host, screen }
}

const deps = (over: Partial<LinkHitDeps> = {}): LinkHitDeps => ({
  getCwd: () => '/home/me/proj',
  convention: () => ({}),
  fileEnabled: () => true,
  ...over
})

describe('linkAtCell', () => {
  const { term } = fakeTerm([
    'see https://example.com/docs now',
    'wrote out/report.csv ok',
    'plain words only'
  ])

  it('finds a URL under the cell', () => {
    expect(linkAtCell(term, 0, 6, deps())).toEqual({ kind: 'url', url: 'https://example.com/docs' })
  })

  it('finds a path and resolves it against cwd', () => {
    expect(linkAtCell(term, 1, 8, deps())).toEqual({
      kind: 'path',
      token: 'out/report.csv',
      abs: '/home/me/proj/out/report.csv'
    })
  })

  it('is null off a link, and for paths while file links are disabled', () => {
    expect(linkAtCell(term, 2, 3, deps())).toBeNull()
    expect(linkAtCell(term, 0, 1, deps())).toBeNull()
    expect(linkAtCell(term, 1, 8, deps({ fileEnabled: () => false }))).toBeNull()
    expect(linkAtCell(term, 1, 8, deps({ convention: () => null }))).toBeNull()
  })

  it('prefers an OSC 8 link, whose URL the visible text does not show', () => {
    const t = fakeTerm(['click here'], { row: 0, col: 2, uri: 'https://pr.example/1' }).term
    expect(linkAtCell(t, 0, 2, deps())).toEqual({ kind: 'url', url: 'https://pr.example/1' })
  })
})

/** Dispatch a mouse event at buffer cell (row, col), targeting the screen like a real click. */
function fire(target: HTMLElement, type: string, row: number, col: number, button = 2): MouseEvent {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    clientX: col * CELL_W + 2,
    clientY: row * CELL_H + 2
  })
  target.dispatchEvent(ev)
  return ev
}

describe('installLinkContextMenu', () => {
  function setup(over: Partial<LinkHitDeps> = {}) {
    const { term, host, screen } = fakeTerm(['wrote out/report.csv ok', 'plain words only'])
    const opened: Array<{ hit: LinkHit; x: number; y: number }> = []
    const reached = { mousedown: 0, mouseup: 0, contextmenu: 0 }
    // Stand-ins for the listeners BEHIND ours: xterm's mouse reporting (on its element) and React
    // Flow's node context menu (bubbling up the tree).
    for (const type of Object.keys(reached) as Array<keyof typeof reached>) {
      screen.addEventListener(type, () => reached[type]++)
    }
    const handle = installLinkContextMenu(term, host, {
      ...deps(over),
      openMenu: (hit, x, y) => opened.push({ hit, x, y })
    })
    return { host, screen, opened, reached, handle }
  }

  it('a right-click on a link opens the menu and never reaches the terminal or the node', () => {
    const { screen, opened, reached } = setup()
    const down = fire(screen, 'mousedown', 0, 8)
    const up = fire(screen, 'mouseup', 0, 8)
    const menu = fire(screen, 'contextmenu', 0, 8)
    expect(opened).toEqual([
      { hit: { kind: 'path', token: 'out/report.csv', abs: '/home/me/proj/out/report.csv' }, x: 82, y: 2 }
    ])
    expect(reached).toEqual({ mousedown: 0, mouseup: 0, contextmenu: 0 })
    expect(down.defaultPrevented && up.defaultPrevented && menu.defaultPrevented).toBe(true)
  })

  it('a right-click off a link is left exactly as it was', () => {
    const { screen, opened, reached } = setup()
    const down = fire(screen, 'mousedown', 1, 3)
    fire(screen, 'mouseup', 1, 3)
    const menu = fire(screen, 'contextmenu', 1, 3)
    expect(opened).toEqual([])
    expect(reached).toEqual({ mousedown: 1, mouseup: 1, contextmenu: 1 })
    expect(down.defaultPrevented || menu.defaultPrevented).toBe(false)
  })

  it('leaves the left button alone, even on a link (selection, Cmd+click)', () => {
    const { screen, opened, reached } = setup()
    fire(screen, 'mousedown', 0, 8, 0)
    fire(screen, 'mouseup', 0, 8, 0)
    expect(opened).toEqual([])
    expect(reached.mousedown).toBe(1)
    expect(reached.mouseup).toBe(1)
  })

  it('a keyboard context menu (no right press before it) passes through', () => {
    const { screen, opened, reached } = setup()
    fire(screen, 'mousedown', 0, 8) // right press on a link, menu shown…
    fire(screen, 'contextmenu', 0, 8)
    fire(screen, 'contextmenu', 0, 8) // …then Shift+F10: not ours
    expect(opened).toHaveLength(1)
    expect(reached.contextmenu).toBe(1)
  })

  it('stops listening once disposed', () => {
    const { screen, opened, handle } = setup()
    handle.dispose()
    fire(screen, 'mousedown', 0, 8)
    fire(screen, 'contextmenu', 0, 8)
    expect(opened).toEqual([])
  })

  it('does not swallow a path while file links are off (the modal terminal, a standalone ssh node)', () => {
    const { screen, opened, reached } = setup({ fileEnabled: () => false })
    fire(screen, 'mousedown', 0, 8)
    fire(screen, 'contextmenu', 0, 8)
    expect(opened).toEqual([])
    expect(reached).toMatchObject({ mousedown: 1, contextmenu: 1 })
  })

  it('does not throw when the pointer is outside the grid', () => {
    const { host, opened } = setup()
    const spy = vi.fn()
    host.addEventListener('contextmenu', spy)
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: -5, clientY: -5 }))
    host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: -5, clientY: -5 }))
    expect(opened).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
