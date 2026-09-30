// @vitest-environment jsdom
// Hit-testing and underline ranges for the new token kinds, against a buffer that reports CELLS the
// way xterm does: a wide (CJK) glyph is one character over two cells, the second a width-0
// placeholder. Before the cell map, string index = cell index was assumed everywhere, so any wide
// glyph before a path shifted its underline and its click target left by one cell per glyph.
import { describe, expect, it } from 'vitest'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createFileLinkProvider,
  installLinkClickFallback,
  installLinkContextMenu,
  linkAtCell,
  type LinkHit,
  type LinkHitDeps
} from './file-links'
import { resolveLinkTarget } from './link-menu'

const CELL_W = 10
const CELL_H = 20
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u

interface FakeCell {
  chars: string
  width: number
}

function toCells(row: string, cols: number): FakeCell[] {
  const out: FakeCell[] = []
  for (const ch of row) {
    if (WIDE.test(ch)) out.push({ chars: ch, width: 2 }, { chars: '', width: 0 })
    else out.push({ chars: ch, width: 1 })
  }
  while (out.length < cols) out.push({ chars: '', width: 1 })
  return out.slice(0, cols)
}

/** A terminal whose buffer answers per cell (getChars/getWidth), plus the DOM the listeners use. */
function fakeTerm(rows: string[], cols = 40) {
  const cellRows = rows.map((r) => toCells(r, cols))
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: cols * CELL_W, height: rows.length * CELL_H }) as DOMRect
  host.appendChild(screen)
  document.body.appendChild(host)
  const term = {
    cols,
    rows: rows.length,
    element: host,
    modes: { mouseTrackingMode: 'vt200' },
    clearSelection: () => {},
    buffer: {
      active: {
        viewportY: 0,
        length: rows.length,
        getLine: (r: number) => {
          const cells = cellRows[r]
          if (!cells) return undefined
          const str = cells
            .filter((c) => c.width !== 0)
            .map((c) => c.chars || ' ')
            .join('')
          return {
            isWrapped: false,
            length: cols,
            translateToString: (trim: boolean) => (trim ? str.replace(/ +$/, '') : str),
            getCell: (x: number) => {
              const c = cells[x]
              return c && { getChars: () => c.chars, getWidth: () => c.width }
            }
          }
        }
      }
    },
    _core: { _oscLinkService: { getLinkData: () => undefined } }
  } as unknown as Terminal
  return { term, host, screen }
}

const deps = (over: Partial<LinkHitDeps> = {}): LinkHitDeps => ({
  getCwd: () => '/home/me/proj',
  convention: () => ({}),
  fileEnabled: () => true,
  ...over
})

const provide = (term: Terminal, row: number, exists: (abs: string) => boolean): Promise<ILink[]> =>
  new Promise((resolve) => {
    createFileLinkProvider(term, {
      getCwd: () => '/home/me/proj',
      lookup: async (abs) => ({ exists: exists(abs), dir: false }),
      activate: () => {}
    }).provideLinks(row, (links) => resolve(links ?? []))
  })

describe('wide glyphs before a path', () => {
  //  cells: 日0-1 本2-3 語4-5 ␠6 s7 r8 c9 /10 a11 .12 t13 s14
  const { term } = fakeTerm(['日本語 src/a.ts done'])

  it('hit-tests the path at its real cells', () => {
    const hit = { kind: 'path', token: 'src/a.ts', abs: '/home/me/proj/src/a.ts' }
    expect(linkAtCell(term, 0, 7, deps())).toEqual(hit)
    expect(linkAtCell(term, 0, 14, deps())).toEqual(hit) // the last `s`
    expect(linkAtCell(term, 0, 15, deps())).toBeNull() // the space after it
    expect(linkAtCell(term, 0, 4, deps())).toBeNull() // 語, not the path
  })

  it('underlines exactly the path cells', async () => {
    const links = await provide(term, 1, () => true)
    expect(links.map((l) => l.range)).toEqual([{ start: { x: 8, y: 1 }, end: { x: 15, y: 1 } }])
  })

  it('underlines a wide glyph inside the path through its second cell', async () => {
    //  cells: s0 r1 c2 /3 報4-5 告6-7 .8 m9 d10
    const { term: t } = fakeTerm(['src/報告.md'])
    const links = await provide(t, 1, () => true)
    expect(links[0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 11, y: 1 } })
    expect(linkAtCell(t, 0, 5, deps())).toMatchObject({ token: 'src/報告.md' })
  })

  it('joins a hard-wrapped row that ends in a wide glyph', async () => {
    // Row 0 is full: `abc/` (4 cells) + 日本語 (6 cells) = 10. The old text read was 7 characters
    // long, so the row never counted as full and the path was cut at the seam.
    const { term: t } = fakeTerm(['abc/日本語', 'x.txt'], 10)
    const links = await provide(t, 2, () => true)
    expect(links.map((l) => [l.text, l.range])).toEqual([
      ['abc/日本語x.txt', { start: { x: 1, y: 1 }, end: { x: 5, y: 2 } }]
    ])
    expect(linkAtCell(t, 1, 2, deps())).toMatchObject({ token: 'abc/日本語x.txt' })
  })
})

describe('the new token kinds under the pointer', () => {
  it('a spaced path is one hit, with its pieces as alternatives', () => {
    const { term } = fakeTerm(['open /Users/me/My Docs/a.md'])
    for (const col of [5, 16, 20, 26]) {
      expect(linkAtCell(term, 0, col, deps())).toEqual({
        kind: 'path',
        token: '/Users/me/My Docs/a.md',
        abs: '/Users/me/My Docs/a.md',
        alternatives: col < 17 ? ['/Users/me/My'] : ['Docs/a.md']
      })
    }
  })

  it('a Unicode path is hit on any of its letters', () => {
    const { term } = fakeTerm(['wrote var/otta-aktarım/çıktı.sql'])
    expect(linkAtCell(term, 0, 25, deps())).toMatchObject({ token: 'var/otta-aktarım/çıktı.sql' })
    expect(linkAtCell(term, 0, 31, deps())).toMatchObject({ token: 'var/otta-aktarım/çıktı.sql' })
  })

  it('the provider links the longest reading that exists, and never its overlapping pieces', async () => {
    const { term } = fakeTerm(['run /usr/bin/env node'])
    const onlyEnv = await provide(term, 1, (abs) => abs === '/usr/bin/env')
    expect(onlyEnv.map((l) => l.text)).toEqual(['/usr/bin/env'])
    const both = await provide(term, 1, () => true)
    expect(both.map((l) => l.text)).toEqual(['/usr/bin/env node'])
  })

  it('a bare filename links only when it exists', async () => {
    const { term } = fakeTerm(['edit README.md and notes.txt'])
    const links = await provide(term, 1, (abs) => abs === '/home/me/proj/README.md')
    expect(links.map((l) => [l.text, l.range])).toEqual([
      ['README.md', { start: { x: 6, y: 1 }, end: { x: 14, y: 1 } }]
    ])
  })

  it('a file URI underlines the URI and resolves to its decoded path', async () => {
    const { term } = fakeTerm(['see file:///tmp/a%20b.txt'])
    const seen: string[] = []
    const links = await provide(term, 1, (abs) => (seen.push(abs), true))
    expect(links.map((l) => l.text)).toEqual(['file:///tmp/a%20b.txt'])
    expect(seen).toEqual(['/tmp/a b.txt'])
  })
})

/** A left or right click at buffer cell (row, col) on the screen element. */
function fire(target: HTMLElement, type: string, row: number, col: number, button: number, mod = false) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    metaKey: mod,
    clientX: col * CELL_W + 2,
    clientY: row * CELL_H + 2
  })
  target.dispatchEvent(ev)
  return ev
}

describe('the Cmd+click fallback walks the alternatives', () => {
  const setup = (rows: string[], exists: (abs: string) => boolean) => {
    const { term, host, screen } = fakeTerm(rows)
    const opened: string[] = []
    const missing: Array<[string, string[]]> = []
    installLinkClickFallback(term, host, {
      ...deps(),
      lookup: async (abs) => ({ exists: exists(abs), dir: false }),
      activateFile: (abs) => opened.push(abs),
      openUrl: () => {},
      onMissing: (token, miss) => missing.push([token, miss.tried])
    })
    return { screen, opened, missing }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('opens the piece that exists when the spaced reading does not', async () => {
    const { screen, opened } = setup(['run /usr/bin/env node'], (abs) => abs === '/usr/bin/env')
    fire(screen, 'mouseup', 0, 6, 0, true)
    await settle()
    expect(opened).toEqual(['/usr/bin/env'])
  })

  it('reports every place it looked when nothing exists', async () => {
    const { screen, opened, missing } = setup(['open /Users/me/My Docs/a.md'], () => false)
    fire(screen, 'mouseup', 0, 20, 0, true)
    await settle()
    expect(opened).toEqual([])
    expect(missing).toEqual([
      ['/Users/me/My Docs/a.md', ['/Users/me/My Docs/a.md', '/home/me/proj/Docs/a.md']]
    ])
  })
})

describe('the right-click menu', () => {
  it('does not claim a bare filename, which is most likely prose', () => {
    const { term, host, screen } = fakeTerm(['see README.md or src/a.ts'])
    const opened: LinkHit[] = []
    let reached = 0
    screen.addEventListener('mousedown', () => reached++)
    installLinkContextMenu(term, host, { ...deps(), openMenu: (hit) => opened.push(hit) })
    fire(screen, 'mousedown', 0, 6, 2)
    fire(screen, 'contextmenu', 0, 6, 2)
    expect(opened).toEqual([])
    expect(reached).toBe(1)
    fire(screen, 'mousedown', 0, 19, 2)
    fire(screen, 'contextmenu', 0, 19, 2)
    expect(opened).toEqual([{ kind: 'path', token: 'src/a.ts', abs: '/home/me/proj/src/a.ts' }])
  })

  it('resolves a spaced hit to the piece that exists', async () => {
    const hit: LinkHit = { kind: 'path', token: '/a/My Docs', abs: '/a/My Docs', alternatives: ['/a/My'] }
    const target = await resolveLinkTarget(hit, async (token) =>
      token === '/a/My' ? { found: true, abs: '/a/My', dir: true } : { found: false, tried: [token] }
    )
    expect(target).toEqual({ kind: 'file', abs: '/a/My', dir: true })
  })
})
