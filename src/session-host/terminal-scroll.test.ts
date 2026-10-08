import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_CAPTURE_MAX_BYTES, HISTORY_CAPTURE_MAX_ROWS, type HistoryScrollCapture } from '../shared/history-scroll'
import { TerminalEmulator } from './terminal-emulator'

const screens: TerminalEmulator[] = []
const terminals: Terminal[] = []
const screen = (cols = 16, rows = 3, scrollback = 1000): TerminalEmulator => {
  const term = new TerminalEmulator({ cols, rows, scrollback }); screens.push(term); return term
}
const inner = (term: TerminalEmulator): Terminal => (term as unknown as { term: Terminal }).term
interface CoreMouse {
  activeEncoding: string
  activeProtocol: string
  triggerMouseEvent(e: { col: number; row: number; x: number; y: number; button: number; action: number; ctrl: boolean; alt: boolean; shift: boolean }): boolean
  addEncoding(name: string, encoder: () => string): void
  _encodings: Record<string, unknown>
}
const coreMouse = (term: Terminal): CoreMouse =>
  (term as unknown as { _core: { coreMouseService: CoreMouse } })._core.coreMouseService
async function put(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve))
}
function capture(term: TerminalEmulator): HistoryScrollCapture {
  const result = term.scrollPlan(true, 1, true)
  expect(result.status).toBe('history')
  if (result.status !== 'history' || !result.capture) throw new Error('Expected captured history')
  return result.capture
}
afterEach(() => {
  screens.splice(0).forEach((s) => s.dispose())
  terminals.splice(0).forEach((t) => t.dispose())
  vi.restoreAllMocks()
})

describe('native emulator scroll decisions', () => {
  it('returns history without emitting input when tracking is off or X10 disallows wheel', async () => {
    const s = screen(); const received: string[] = []
    inner(s).onData((data) => received.push(data)); inner(s).onBinary((data) => received.push(data))
    await s.write('pre-attach old\r\n' + 'tail\r\n'.repeat(12))
    expect(s.scrollPlan(true, 20, false)).toEqual({ status: 'history' })
    expect(capture(s).rows.some((row) => row.text === 'pre-attach old')).toBe(true)
    await s.write('\x1b[?9h\x1b[?1006h')
    expect(inner(s).modes.mouseTrackingMode).toBe('x10')
    expect(s.scrollPlan(false, 2, false)).toEqual({ status: 'history' })
    expect(received).toEqual([])
  })

  it.each([
    ['VT200', '\x1b[?1000h', '', '\x1b[M`!!', '\x1b[Ma!!'],
    ['DRAG SGR', '\x1b[?1002h', '\x1b[?1006h', '\x1b[<64;1;1M', '\x1b[<65;1;1M'],
    ['ANY pixels', '\x1b[?1003h', '\x1b[?1016h', '\x1b[<64;0;0M', '\x1b[<65;0;0M']
  ])('uses the actual %s requested encoder, matching genuine xterm wheel reports without emitter side effects', async (_name, protocol, encoding, up, down) => {
    const s = screen(); const actual = new Terminal({ cols: 16, rows: 3, allowProposedApi: true }); terminals.push(actual)
    await s.write(protocol + encoding); await put(actual, protocol + encoding)
    const reference: string[] = []; const sideEffects: string[] = []
    actual.onData((data) => reference.push(data)); actual.onBinary((data) => reference.push(data))
    inner(s).onData((data) => sideEffects.push(data)); inner(s).onBinary((data) => sideEffects.push(data))
    for (const [isUp, expected] of [[true, up], [false, down]] as const) {
      expect(coreMouse(actual).triggerMouseEvent({ col: 0, row: 0, x: 0, y: 0, button: 4,
        action: isUp ? 0 : 1, ctrl: false, alt: false, shift: false })).toBe(true)
      expect(reference.at(-1)).toBe(expected)
      expect(s.scrollPlan(isUp, 3, true)).toEqual({ status: 'wheel', data: [expected, expected, expected] })
    }
    expect(sideEffects).toEqual([])
  })

  it('reads each applied tracking/encoding transition rather than caching prior mouse mode', async () => {
    const s = screen()
    await s.write('\x1b[?1000h\x1b[?1006h')
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'wheel', data: ['\x1b[<64;1;1M'] })
    await s.write('\x1b[?1006l')
    expect(s.scrollPlan(false, 1, false)).toEqual({ status: 'wheel', data: ['\x1b[Ma!!'] })
    await s.write('\x1b[?1000l')
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'history' })
    await s.write('\x1b[?1016h\x1b[?1000h')
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'wheel', data: ['\x1b[<64;0;0M'] })
  })

  it.each([0, -1, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid notch count %s before encoding', async (lines) => {
    const s = screen(); await s.write('\x1b[?1000h')
    expect(s.scrollPlan(true, lines, true).status).toBe('refused')
  })

  it('fails closed for unsupported encoding, missing private shape, empty/throwing encoder and bad geometry', async () => {
    const s = screen(); await s.write('\x1b[?1000h')
    const mouse = coreMouse(inner(s)); const saved = mouse._encodings.DEFAULT
    mouse.addEncoding('CUSTOM', () => 'unsafe'); mouse.activeEncoding = 'CUSTOM'
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    expect(() => s.serialize()).toThrow('Unsupported terminal mouse state')
    mouse.activeEncoding = 'DEFAULT'; mouse._encodings.DEFAULT = undefined
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    mouse._encodings.DEFAULT = () => ''
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    mouse._encodings.DEFAULT = () => { throw new Error('unsupported encoder') }
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    mouse._encodings.DEFAULT = () => 'x'.repeat(65)
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    mouse._encodings.DEFAULT = saved
    const core = (inner(s) as unknown as { _core: { coreMouseService?: CoreMouse } })._core
    const original = core.coreMouseService; core.coreMouseService = undefined
    expect(s.scrollPlan(true, 1, true).status).toBe('refused'); core.coreMouseService = original
    vi.spyOn(inner(s), 'cols', 'get').mockReturnValue(65_536)
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
  })
})

describe('physical native history capture', () => {
  it('preserves translated Unicode, soft wraps and normal/alternate section boundaries', async () => {
    const s = screen(6, 3)
    await s.write('abcdefghij\r\n\x1b[31mΩ 😀\x1b[0m\r\n' + 'line\r\n'.repeat(8))
    await s.write('\x1b[?1049hALTNOW')
    const c = capture(s)
    expect(c.cols).toBe(6); expect(c.viewportRows).toBe(3); expect(c.olderTruncated).toBe(false)
    expect(c.rows).toContainEqual({ text: 'abcdef', isWrapped: false, section: 'normal' })
    expect(c.rows).toContainEqual({ text: 'ghij', isWrapped: true, section: 'normal' })
    expect(c.rows.some((r) => r.text.includes('Ω 😀') && r.section === 'normal')).toBe(true)
    expect(c.rows).toContainEqual({ text: 'ALTNOW', isWrapped: false, section: 'alternate' })
    expect(c.rows.map((r) => r.text).join('')).not.toContain('\x1b')
    await s.write('\x1b[?1049l')
    expect(capture(s).rows.every((r) => r.section === 'normal')).toBe(true)
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'history' })
  })

  it('keeps only the latest 8192 retained physical rows and marks removed older rows', async () => {
    const s = screen(16, 3, 12_000)
    await s.write(Array.from({ length: 9000 }, (_, i) => 'M'+String(i).padStart(4, '0')).join('\r\n'))
    const c = capture(s)
    expect(c.rows).toHaveLength(HISTORY_CAPTURE_MAX_ROWS)
    expect(c.olderTruncated).toBe(true)
    expect(c.rows.at(-1)?.text).toBe('M8999')
    expect(c.rows.some((r) => r.text === 'M0000')).toBe(false)
  })

  it('bounds the full escaped UTF-8 JSON body to 1 MiB while retaining newest complete rows', async () => {
    const s = screen(1900, 2, 400)
    await s.write(('\\'.repeat(1800)+'\r\n').repeat(350)+'LAST Ω')
    const c = capture(s)
    expect(Buffer.byteLength(JSON.stringify(c), 'utf8')).toBeLessThanOrEqual(HISTORY_CAPTURE_MAX_BYTES)
    expect(c.olderTruncated).toBe(true)
    expect(c.rows.at(-1)?.text).toBe('LAST Ω')
    expect(c.rows.length).toBeGreaterThan(1)
    expect(c.rows.length).toBeLessThan(351)
  })

  it('bounds viewport height while preserving actual buffer rows and has no capture work when capture is false', () => {
    const s = screen(12, 250)
    expect(capture(s).viewportRows).toBe(200)
    expect(capture(s).rows).toHaveLength(250)
    const spy = vi.spyOn(inner(s).buffer.normal, 'getLine')
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'history' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses an oversized newest combining-character row rather than fabricating empty history', async () => {
    const s = screen(2, 1, 0)
    await s.write('x'+'\u0301'.repeat(600_000))
    expect(s.scrollPlan(true, 1, true).status).toBe('refused')
    expect(s.scrollPlan(true, 1, false)).toEqual({ status: 'history' })
  })
})

describe('snapshot coordinate encoding restoration', () => {
  it('preserves truly cold empty snapshots', () => {
    expect(screen().serialize()).toBe('')
  })

  it('restores a mode-only encoding request before any screen text', async () => {
    const source = screen(); await source.write('\x1b[?1016h')
    const fresh = screen(); await fresh.write(source.serialize())
    expect(coreMouse(inner(fresh)).activeEncoding).toBe('SGR_PIXELS')
    expect(inner(fresh).modes.mouseTrackingMode).toBe('none')
  })

  it.each([
    ['DEFAULT', '\x1b[?1000h', '\x1b[?1016h'],
    ['SGR', '\x1b[?1000h\x1b[?1006h', '\x1b[?1016h'],
    ['SGR_PIXELS', '\x1b[?1000h\x1b[?1016h', '\x1b[?1006h'],
    ['SGR with tracking off', '\x1b[?1006h', '\x1b[?1016h'],
    ['pixels with tracking off', '\x1b[?1016h', '\x1b[?1006h']
  ])('restores actual %s encoding without assuming active mouse implies SGR', async (_name, modes, oldModes) => {
    const source = screen(); await source.write('seed\r\n'+modes)
    const fresh = screen(); await fresh.write(oldModes)
    await fresh.write(source.serialize())
    expect(coreMouse(inner(fresh)).activeEncoding).toBe(coreMouse(inner(source)).activeEncoding)
    expect(inner(fresh).modes.mouseTrackingMode).toBe(inner(source).modes.mouseTrackingMode)
  })
})
