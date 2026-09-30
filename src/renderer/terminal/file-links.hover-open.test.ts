// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createFileLinkProvider,
  createOsc8LinkHandler,
  createUrlLinkProvider,
  installLinkClickFallback,
  type LinkHoverTarget
} from './file-links'

const COLS = 40
const CELL_W = 10
const CELL_H = 20

/** The slice of xterm the providers and the click fallback read (see file-links.context-menu.test). */
function fakeTerm(rows: string[], opts: { tracking?: string; selection?: boolean } = {}) {
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: COLS * CELL_W, height: rows.length * CELL_H }) as DOMRect
  host.appendChild(screen)
  document.body.appendChild(host)
  let cleared = 0
  const term = {
    cols: COLS,
    rows: rows.length,
    element: host,
    modes: { mouseTrackingMode: opts.tracking ?? 'vt200' },
    hasSelection: () => !!opts.selection,
    clearSelection: () => void cleared++,
    buffer: {
      active: {
        viewportY: 0,
        length: rows.length,
        getLine: (r: number) =>
          r < rows.length
            ? {
                isWrapped: false,
                translateToString: (trim: boolean) => (trim ? rows[r].trimEnd() : rows[r].padEnd(COLS)),
                getCell: () => ({ extended: { urlId: 0 } })
              }
            : undefined
      }
    },
    _core: { _oscLinkService: { getLinkData: () => undefined } }
  } as unknown as Terminal
  return { term, host, screen, cleared: () => cleared }
}

const mouse = (o: Partial<MouseEventInit> = {}): MouseEvent => new MouseEvent('mouseup', { button: 0, ...o })

const EXISTS = new Set(['/p/out/report.csv', '/p/out'])
const lookup = async (abs: string) => ({ exists: EXISTS.has(abs), dir: abs === '/p/out' })

async function fileLinks(selection = false) {
  const { term } = fakeTerm(['wrote out/report.csv and out/ ok'], { selection })
  const calls: string[] = []
  const hovers: Array<LinkHoverTarget | 'leave'> = []
  const provider = createFileLinkProvider(term, {
    getCwd: () => '/p',
    lookup,
    convention: () => ({}),
    activate: (abs, dir) => calls.push(`open ${abs} ${dir}`),
    openWithSystem: (abs, dir) => calls.push(`system ${abs} ${dir}`),
    hoverSink: { hover: (t) => hovers.push(t), leave: () => hovers.push('leave') }
  })
  const links = await new Promise<ILink[]>((resolve) =>
    provider.provideLinks(1, (l) => resolve(l ?? []))
  )
  return { links, calls, hovers }
}

describe('file link provider: modifier routing', () => {
  it('Cmd/Ctrl opens in the editor; Shift+Cmd/Ctrl opens with the OS app; a plain click does nothing', async () => {
    const { links, calls } = await fileLinks()
    const file = links.find((l) => l.text === 'out/report.csv')!
    file.activate(mouse(), file.text)
    file.activate(mouse({ shiftKey: true }), file.text)
    expect(calls).toEqual([])
    file.activate(mouse({ metaKey: true }), file.text)
    file.activate(mouse({ ctrlKey: true, shiftKey: true }), file.text)
    expect(calls).toEqual(['open /p/out/report.csv false', 'system /p/out/report.csv false'])
  })

  it('a Shift+Cmd click that extended an xterm selection is a selection, not an open', async () => {
    const { links, calls } = await fileLinks(true)
    links[0].activate(mouse({ metaKey: true, shiftKey: true }), links[0].text)
    expect(calls).toEqual([])
  })

  it('without an openWithSystem, Shift+Cmd falls back to the plain open (old hosts unchanged)', async () => {
    const { term } = fakeTerm(['wrote out/report.csv ok'])
    const calls: string[] = []
    const provider = createFileLinkProvider(term, {
      getCwd: () => '/p',
      lookup,
      convention: () => ({}),
      activate: (abs) => calls.push(abs)
    })
    const links = await new Promise<ILink[]>((r) => provider.provideLinks(1, (l) => r(l ?? [])))
    links[0].activate(mouse({ metaKey: true, shiftKey: true }), links[0].text)
    expect(calls).toEqual(['/p/out/report.csv'])
    expect(links[0].hover).toBeUndefined()
  })

  it('hover names the RESOLVED path and dir-ness; leave and an open both hide it', async () => {
    const { links, hovers } = await fileLinks()
    const dir = links.find((l) => l.text === 'out/')
    // `out/` alone is not a path token (no internal slash); the file is.
    expect(dir).toBeUndefined()
    const file = links[0]
    file.hover!(mouse(), file.text)
    file.leave!(mouse(), file.text)
    file.hover!(mouse(), file.text)
    file.activate(mouse({ metaKey: true }), file.text)
    expect(hovers).toEqual([
      { kind: 'file', abs: '/p/out/report.csv', dir: false },
      'leave',
      { kind: 'file', abs: '/p/out/report.csv', dir: false },
      'leave'
    ])
  })
})

describe('URL links get the same tooltip', () => {
  it('the typed-URL provider reports its URL on hover', () => {
    const { term } = fakeTerm(['see https://example.com/docs now'])
    const hovers: Array<LinkHoverTarget | 'leave'> = []
    const opened: string[] = []
    const provider = createUrlLinkProvider(term, (u) => opened.push(u), {
      hover: (t) => hovers.push(t),
      leave: () => hovers.push('leave')
    })
    let links: ILink[] = []
    provider.provideLinks(1, (l) => (links = l ?? []))
    links[0].hover!(mouse(), links[0].text)
    links[0].activate(mouse({ metaKey: true, shiftKey: true }), links[0].text)
    expect(hovers).toEqual([{ kind: 'url', url: 'https://example.com/docs' }, 'leave'])
    expect(opened).toEqual(['https://example.com/docs'])
  })

  it('an OSC 8 link reports its hidden URL on hover, and never a non-http one', () => {
    const hovers: Array<LinkHoverTarget | 'leave'> = []
    const h = createOsc8LinkHandler(() => {}, {
      hover: (t) => hovers.push(t),
      leave: () => hovers.push('leave')
    })
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }
    h.hover!(mouse(), 'https://pr.example/1', range)
    h.hover!(mouse(), 'javascript:alert(1)', range)
    h.leave!(mouse(), 'https://pr.example/1', range)
    expect(hovers).toEqual([{ kind: 'url', url: 'https://pr.example/1' }, 'leave'])
  })
})

/** Dispatch a left-button event at buffer cell (row, col) on the screen, like a real click. */
function fire(target: HTMLElement, type: string, row: number, col: number, mods: MouseEventInit = {}) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: col * CELL_W + 2,
    clientY: row * CELL_H + 2,
    ...mods
  })
  target.dispatchEvent(e)
  return e
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('installLinkClickFallback (tmux mouse tracking): modifier routing', () => {
  function setup() {
    const t = fakeTerm(['wrote out/report.csv ok'])
    const calls: string[] = []
    let reached = 0
    t.screen.addEventListener('mouseup', () => reached++)
    installLinkClickFallback(t.term, t.host, {
      getCwd: () => '/p',
      lookup,
      convention: () => ({}),
      fileEnabled: () => true,
      openUrl: (u) => calls.push(`url ${u}`),
      activateFile: (abs) => calls.push(`open ${abs}`),
      openFileWithSystem: (abs) => calls.push(`system ${abs}`)
    })
    return { ...t, calls, reached: () => reached }
  }

  it('Cmd opens, Shift+Cmd opens with the OS app, and both are swallowed from tmux', async () => {
    const { screen, calls, reached } = setup()
    fire(screen, 'mouseup', 0, 8, { metaKey: true })
    fire(screen, 'mouseup', 0, 8, { metaKey: true, shiftKey: true })
    await tick()
    expect(calls).toEqual(['open /p/out/report.csv', 'system /p/out/report.csv'])
    expect(reached()).toBe(0)
  })

  it('a plain click, and a Shift-only click, reach tmux untouched', async () => {
    const { screen, calls, reached } = setup()
    fire(screen, 'mouseup', 0, 8)
    fire(screen, 'mouseup', 0, 8, { shiftKey: true })
    await tick()
    expect(calls).toEqual([])
    expect(reached()).toBe(2)
  })

  it('a Shift+Ctrl DRAG that ends on a link is a selection, never an open', async () => {
    const { screen, calls, reached } = setup()
    fire(screen, 'mousedown', 0, 1, { ctrlKey: true, shiftKey: true })
    fire(screen, 'mouseup', 0, 8, { ctrlKey: true, shiftKey: true })
    await tick()
    expect(calls).toEqual([])
    expect(reached()).toBe(1)
    // …while a press and release on the same cell is still a click.
    fire(screen, 'mousedown', 0, 8, { ctrlKey: true, shiftKey: true })
    fire(screen, 'mouseup', 0, 8, { ctrlKey: true, shiftKey: true })
    await tick()
    expect(calls).toEqual(['system /p/out/report.csv'])
  })
})
