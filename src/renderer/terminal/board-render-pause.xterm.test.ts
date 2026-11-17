// @vitest-environment jsdom
// The board pause against a REAL xterm 5.5: the unit tests drive structural fakes, which cannot tell
// us whether xterm still has these private methods at these places, or still reaches them through
// `this.` (an instance property shadows only a call made that way). An xterm upgrade that renames
// one of them makes the hold a silent no-op; this file is what fails instead.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installBoardRenderPause } from './board-render-pause'

let host: HTMLDivElement | undefined
afterEach(() => host?.remove())

interface CoreLike {
  _syncTextArea(): void
  viewport: { syncScrollArea(immediate?: boolean): void }
  _renderService: { handleSelectionChanged(...args: unknown[]): void }
}

function open(): { term: Terminal; core: CoreLike } {
  ;(window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 40, rows: 5 })
  term.open(host)
  return { term, core: (term as unknown as { _core: CoreLike })._core }
}

const write = (term: Terminal, data: string): Promise<void> => new Promise((r) => term.write(data, r))
/** SelectionService.refresh defers its redraw to an animation frame. */
const frames = (n: number): Promise<void> =>
  new Promise((r) => {
    const step = (left: number): void => (left === 0 ? r() : void requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

/** A stream that moves the cursor and scrolls the buffer, like an agent's output. */
const STREAM = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join('')

function spies(core: CoreLike): Record<'textarea' | 'scrollArea' | 'selection', ReturnType<typeof vi.fn>> {
  return {
    textarea: vi.spyOn(core, '_syncTextArea') as never,
    scrollArea: vi.spyOn(core.viewport, 'syncScrollArea') as never,
    selection: vi.spyOn(core._renderService, 'handleSelectionChanged') as never
  }
}

describe('board render pause — real xterm 5.5', () => {
  it('control: an uncovered terminal reaches all three paths while streaming', async () => {
    const { term, core } = open()
    const s = spies(core)
    const pause = installBoardRenderPause(term as never, { covered: () => false })!
    await write(term, STREAM)
    await frames(2)
    expect(s.textarea).toHaveBeenCalled()
    expect(s.scrollArea).toHaveBeenCalled()
    expect(s.selection).toHaveBeenCalled()
    pause.dispose()
    term.dispose()
  })

  it('a covered terminal reaches none of them while streaming, and each exactly once on uncover', async () => {
    const { term, core } = open()
    const s = spies(core)
    let covered = true
    const pause = installBoardRenderPause(term as never, { covered: () => covered })!
    await write(term, STREAM)
    await frames(2)
    expect(s.textarea).not.toHaveBeenCalled()
    expect(s.scrollArea).not.toHaveBeenCalled()
    expect(s.selection).not.toHaveBeenCalled()

    covered = false
    pause.sync()
    expect(s.textarea).toHaveBeenCalledTimes(1)
    expect(s.scrollArea).toHaveBeenCalledTimes(1)
    expect(s.scrollArea).toHaveBeenCalledWith(true)
    expect(s.selection).toHaveBeenCalledTimes(1)
    pause.dispose()
    term.dispose()
  })
})
