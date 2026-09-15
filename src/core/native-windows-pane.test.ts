import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeWindowsPane } from './native-windows-pane'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'

const expected: PaneOwner = { panePid: 10, paneId: 'win32:generation-a:birth-root', tty: 'win32-console:10', command: 'opencode', argv: ['opencode'], pids: [20], processBirths: ['birth-agent'] }
const panes: NativeWindowsPane[] = []
/** `render` makes the fake app draw what it is pasted, as a real composer does; off, the pane
 *  never shows the envelope. Settle polls do not wait: the test controls the screen directly. */
function fixture(render = true) {
  let pane!: NativeWindowsPane
  const write = vi.fn((data: string) => {
    const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
    if (render && paste) pane.recordOutput(paste[1].replace(/\n/g, '\r\n'))
  })
  const probe = vi.fn(async (): Promise<PaneOwner | null> => expected)
  pane = new NativeWindowsPane({ pid: 10, write }, { cols: 80, rows: 24, scrollback: 100 }, probe, {
    wait: async () => {}
  })
  panes.push(pane)
  return { pane, write, probe }
}
afterEach(() => { for (const p of panes.splice(0)) p.dispose() })

describe('native Windows envelope delivery', () => {
  it('waits for split terminal-mode output, pastes one sanitized block, then Enter once it renders', async () => {
    const { pane, write } = fixture()
    pane.recordOutput('\x1b[?20')
    pane.recordOutput('04h')
    expect(await pane.sendEnvelope('line 1\nline 2\x1b[201~', expected)).toBe(true)
    expect(write.mock.calls).toEqual([['\x1b[200~line 1\nline 2[201~\x1b[201~'], ['\r']])
  })
  it('reports the paste but sends no Enter while the pane never shows the envelope', async () => {
    // An Enter before the composer installs the block is the swallowed or doubled submit; the
    // receipt watcher reports `stalled` instead.
    const { pane, write } = fixture(false)
    pane.recordOutput('\x1b[?2004h')
    expect(await pane.sendEnvelope('line 1\nEND FOOTER', expected)).toBe(true)
    expect(write.mock.calls).toEqual([['\x1b[200~line 1\nEND FOOTER\x1b[201~']])
  })
  it('refuses before paste mode is observed, after it is disabled, and without a checked owner', async () => {
    const { pane, write } = fixture()
    expect(await pane.sendEnvelope('hello', expected)).toBe(false)
    pane.recordOutput('\x1b[?2004h')
    expect(await pane.sendEnvelope('hello')).toBe(false)
    pane.recordOutput('\x1b[?2004l')
    expect(await pane.sendEnvelope('hello', expected)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
  it.each([
    null,
    { ...expected, paneId: 'win32:replacement' },
    { ...expected, pids: [21] },
    { ...expected, processBirths: ['new-process-same-pid'] },
    { ...expected, argv: ['pwsh'] }
  ])('refuses unknown, replaced or returned-to-shell recipients', async (changed) => {
    const { pane, write, probe } = fixture()
    pane.recordOutput('\x1b[?2004h')
    probe.mockResolvedValue(changed)
    expect(await pane.sendEnvelope('hello', expected)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('refuses an exit while the identity probe is in flight', async () => {
    const { pane, write, probe } = fixture()
    pane.recordOutput('\x1b[?2004h')
    probe.mockImplementation(async () => { pane.dispose(); return expected })
    expect(await pane.sendEnvelope('hello', expected)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('native Windows sendText (the write verb and the app’s own writers)', () => {
  it('frames only when the app asked for bracketed paste, then Enter', async () => {
    const { pane, write, probe } = fixture()
    pane.recordOutput('\x1b[?2004h')
    expect(await pane.sendText('a\nb\x1b[201~', true)).toBe(true)
    expect(write.mock.calls).toEqual([['\x1b[200~a\nb[201~\x1b[201~'], ['\r']])
    // No process attestation: this path types into whatever owns the pane, like tmux send-keys.
    expect(probe).not.toHaveBeenCalled()
  })
  it('writes unframed (ESC still stripped) when paste mode was not requested', async () => {
    const { pane, write } = fixture()
    expect(await pane.sendText('ls\x1b', false)).toBe(true)
    expect(write.mock.calls).toEqual([['ls']])
  })
  it('keeps an unframed Enter inside the single write, exactly like the session host', async () => {
    const { pane, write } = fixture()
    expect(await pane.sendText('ls', true)).toBe(true)
    expect(write.mock.calls).toEqual([['ls\r']])
  })
  it('sends a bare Enter for an empty payload, and nothing at all when neither is asked', async () => {
    const { pane, write } = fixture()
    expect(await pane.sendText('', true)).toBe(true)
    expect(await pane.sendText('', false)).toBe(true)
    expect(write.mock.calls).toEqual([['\r']])
  })
  it('refuses a disposed pane', async () => {
    const { pane, write } = fixture()
    pane.dispose()
    expect(await pane.sendText('hello', true)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
