import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { Socket } from 'node:net'
import { NativeWindowsPane } from './native-windows-pane'
import { HostSession } from '../session-host/session'
import { TerminalEmulator } from '../session-host/terminal-emulator'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach((close) => close()); vi.restoreAllMocks() })
function pane(kind: 'native' | 'session-host') {
  const write = vi.fn(), proc = { pid: 42, write, resize: vi.fn(), pause: vi.fn(), resume: vi.fn() }
  const size = { cols: 20, rows: 5, scrollback: 100 }
  if (kind === 'native') {
    const value = new NativeWindowsPane(proc, size)
    cleanup.push(() => value.dispose())
    return { value, write, output: (text: string) => value.recordOutput(text), retire: () => value.dispose() }
  }
  const value = new HostSession('ours', { shell: 'fixture', args: [], cwd: '.', env: {}, ...size }, 100,
    { proc: proc as unknown as IPty, term: new TerminalEmulator(size) })
  cleanup.push(() => value.dispose())
  return { value, write, output: (text: string) => value.recordOutput(text), retire: () => { value.retiring = true } }
}

describe.each(['native', 'session-host'] as const)('%s actual emulator history routing', (kind) => {
  it('crosses split mode output, reads retained normal/alternate history, and writes no bytes with mouse off', async () => {
    const p = pane(kind)
    p.output('older pre-attach line\r\n' + 'retained history\r\n'.repeat(15))
    p.output('\x1b[?1049hcurrent alternate\x1b[?100'); p.output('0l\x1b[?1006l')
    const result = await p.value.scrollForHistory(true, 3, true, () => true)
    expect(result.status).toBe('history')
    if (result.status !== 'history') throw new Error('history expected')
    expect(result.capture?.rows.some((row) => row.text.includes('older pre-attach'))).toBe(true)
    expect(result.capture?.rows.some((row) => row.section === 'alternate' && row.text.includes('current alternate'))).toBe(true)
    expect(await p.value.scrollForHistory(false, 2, false, () => true)).toEqual({ status: 'history' })
    expect(p.write).not.toHaveBeenCalled()
  })
  it('uses the application requested default and SGR encodings, then observes a later disabled mode', async () => {
    const p = pane(kind)
    p.output('\x1b[?100'); p.output('0h\x1b[?1006l')
    expect(await p.value.scrollForHistory(true, 2, true, () => true)).toEqual({ status: 'input' })
    expect(p.write.mock.calls).toEqual([['\x1b[M`!!'], ['\x1b[M`!!']])
    p.write.mockClear(); p.output('\x1b[?1006h')
    expect(await p.value.scrollForHistory(false, 1, false, () => true)).toEqual({ status: 'input' })
    expect(p.write.mock.calls).toEqual([['\x1b[<65;1;1M']])
    p.write.mockClear(); p.output('\x1b[?1000l')
    expect((await p.value.scrollForHistory(true, 1, true, () => true)).status).toBe('history')
    expect(p.write).not.toHaveBeenCalled()
  })
  it('refuses retirement while real terminal output is queued', async () => {
    const p = pane(kind), original = TerminalEmulator.prototype.write
    let admitted!: () => void, release!: () => void
    const entered = new Promise<void>((done) => { admitted = done })
    const gate = new Promise<void>((done) => { release = done })
    vi.spyOn(TerminalEmulator.prototype, 'write').mockImplementationOnce(async function (this: TerminalEmulator, data) {
      admitted(); await gate; return original.call(this, data)
    })
    p.output('\x1b[?1000h\x1b[?1006h')
    let current = true
    const scrolling = p.value.scrollForHistory(true, 2, true, () => current)
    await entered; current = false; release()
    expect((await scrolling).status).toBe('refused'); expect(p.write).not.toHaveBeenCalled()
  })
  it('does not write after plan construction retires the viewer', async () => {
    for (const mouse of [false, true]) {
      const p = pane(kind); if (mouse) p.output('\x1b[?1000h\x1b[?1006h')
      const original = TerminalEmulator.prototype.scrollPlan; let current = true
      vi.spyOn(TerminalEmulator.prototype, 'scrollPlan').mockImplementationOnce(function (this: TerminalEmulator, up, lines, capture) {
        const result = original.call(this, up, lines, capture); current = false; return result
      })
      expect((await p.value.scrollForHistory(true, 2, true, () => current)).status).toBe('refused')
      expect(p.write).not.toHaveBeenCalled(); vi.restoreAllMocks()
    }
  })
  it('reports uncertainty and never repeats remaining wheel bytes after retirement or a possible write', async () => {
    for (const failure of ['retire', 'throw'] as const) {
      const p = pane(kind); p.output('\x1b[?1000h\x1b[?1006h'); let current = true
      p.write.mockImplementationOnce(() => { if (failure === 'throw') throw new Error('write accepted, receipt lost'); current = false })
      expect((await p.value.scrollForHistory(true, 3, false, () => current)).status).toBe('uncertain')
      expect(p.write.mock.calls).toEqual([['\x1b[<64;1;1M']])
    }
  })
  it('refuses dead panes, malformed distances and unknown emulator state before input', async () => {
    const p = pane(kind); p.output('\x1b[?1000h')
    for (const lines of [0, 21, 1.5, NaN]) expect((await p.value.scrollForHistory(true, lines, false, () => true)).status).toBe('refused')
    vi.spyOn(TerminalEmulator.prototype, 'scrollPlan').mockImplementationOnce(() => { throw new Error('unknown native encoding') })
    expect((await p.value.scrollForHistory(true, 1, false, () => true)).status).toBe('refused')
    p.retire(); expect((await p.value.scrollForHistory(true, 1, false, () => true)).status).toBe('refused')
    expect(p.write).not.toHaveBeenCalled()
  })
})

it('captures actual geometry only after its queued resize, without writing mouse-off input', async () => {
  const p = pane('session-host'), value = p.value as HostSession, socket = new Socket()
  const prepared = await value.prepareAttachment(socket, 15, 4, false); expect(prepared.commit()).toBe(true)
  const resizing = value.resizeFor(socket, 12, 3)
  const scrolling = value.scrollForHistory(true, 1, true, () => value.subscribers.has(socket))
  await resizing; const result = await scrolling
  expect(result.status).toBe('history')
  if (result.status === 'history') expect(result.capture).toMatchObject({ cols: 12, viewportRows: 3 })
  expect(p.write).not.toHaveBeenCalled(); socket.destroy()
})

it('does not trust mouse state after a rejected session-host emulator output even though its shared tail heals', async () => {
  const p = pane('session-host'), value = p.value as HostSession
  vi.spyOn(TerminalEmulator.prototype, 'write').mockRejectedValueOnce(new Error('partial output parse'))
  await expect(value.recordOutput('\x1b[?1000h')).rejects.toThrow('partial output')
  expect((await value.scrollForHistory(true, 1, true, () => true)).status).toBe('refused')
  expect(p.write).not.toHaveBeenCalled()
})
