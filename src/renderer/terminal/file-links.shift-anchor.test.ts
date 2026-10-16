// @vitest-environment jsdom
// Issue #1176 — "Cmd+Shift+click does nothing until I Cmd+click the same filename first."
//
// With mouse reporting OFF (no tmux, tmux disabled, the Windows session host) xterm's own
// SelectionService handles the press, and a Shift press EXTENDS the selection from the last click's
// anchor (`_handleIncrementalClick`) — an anchor every plain click leaves behind, invisible because a
// click selects nothing. So a Shift+Cmd click on a link created a selection from wherever the user
// last clicked to the link, and the provider's "a selection means this was a selection gesture"
// guard aborted the open in silence. A Cmd-click on the same cell first moved the anchor there, so
// the extension was empty and the next Shift+Cmd click opened — exactly the report. This drives a
// REAL xterm so the anchor behaviour is xterm's, not a stub's.
import { afterEach, describe, expect, it } from 'vitest'
import { Terminal, type ILink } from '@xterm/xterm'
import { createFileLinkProvider } from './file-links'

const CW = 10
const CH = 20
const LINE = 'wrote out/report.csv and more'

let host: HTMLDivElement | undefined
afterEach(() => host?.remove())

async function setup() {
  ;(window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {}
  })
  // jsdom has no layout: give xterm's DOM char measurement a size, and the screen a rect.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 32 * CW })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => CH })
  host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 40, rows: 5 })
  term.open(host)
  await new Promise<void>((r) => term.write(LINE + '\r\n', r))
  const screen = host.querySelector('.xterm-screen') as HTMLElement
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 100, width: 400, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect
  const calls: string[] = []
  const provider = createFileLinkProvider(term, {
    getCwd: () => '/p',
    lookup: async (abs) => ({ exists: abs === '/p/out/report.csv', dir: false }),
    convention: () => ({}),
    activate: (abs) => calls.push(`open ${abs}`),
    openWithSystem: (abs) => calls.push(`system ${abs}`)
  })
  const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(1, (l) => resolve(l ?? [])))
  const link = links.find((l) => l.text === 'out/report.csv')!
  const at = (col: number, o: MouseEventInit = {}): MouseEventInit => ({
    clientX: col * CW + 2,
    clientY: 5,
    button: 0,
    bubbles: true,
    cancelable: true,
    detail: 1,
    ...o
  })
  /** One click as xterm sees it: press on the screen, release on the document, then the link's
   *  activate (xterm's linkifier calls it on a click that started and ended on the link). */
  const click = (col: number, mods: MouseEventInit = {}, onLink = false) => {
    screen.dispatchEvent(new MouseEvent('mousedown', at(col, mods)))
    document.dispatchEvent(new MouseEvent('mouseup', at(col, mods)))
    if (onLink) link.activate(new MouseEvent('mouseup', at(col, mods)), link.text)
  }
  return { term, link, calls, click }
}

describe('Shift+Cmd click on a file link with mouse reporting off (#1176)', () => {
  it('xterm itself turns the Shift press into a selection from the last click', async () => {
    const { term, click } = await setup()
    click(26) // a plain click somewhere else on the line
    expect(term.hasSelection()).toBe(false)
    click(8, { shiftKey: true, metaKey: true })
    expect(term.hasSelection()).toBe(true) // the stale anchor, extended to the link
  })

  it('opens with the system app after a plain click elsewhere, and leaves no selection', async () => {
    const { term, calls, click } = await setup()
    click(26)
    click(8, { shiftKey: true, metaKey: true }, true)
    expect(calls).toEqual(['system /p/out/report.csv'])
    expect(term.hasSelection()).toBe(false)
  })

  it('still treats a Shift+Cmd click that extends a REAL selection as a selection gesture', async () => {
    const { term, calls, click } = await setup()
    term.select(22, 0, 4) // the user had selected "and " before the click
    click(8, { shiftKey: true, metaKey: true }, true)
    expect(calls).toEqual([])
  })
})
