import { describe, expect, it } from 'vitest'
import { stripTerminalControls } from './terminal-text'

const ESC = '\x1b'

describe('stripTerminalControls', () => {
  it('removes colour and cursor sequences (CSI) and keeps the text', () => {
    expect(stripTerminalControls(`${ESC}[1;32mPASS${ESC}[0m 3 tests${ESC}[K`)).toBe('PASS 3 tests')
    expect(stripTerminalControls(`${ESC}[?2004hPS C:\\> ${ESC}[38;2;10;20;30mok`)).toBe('PS C:\\> ok')
  })

  it('removes OSC sequences ended by BEL or ST, a clipboard write included', () => {
    expect(stripTerminalControls(`a${ESC}]0;title\x07b`)).toBe('ab')
    expect(stripTerminalControls(`a${ESC}]52;c;cm0gLXJmIH4=${ESC}\\b`)).toBe('ab')
    expect(stripTerminalControls(`a${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\b`)).toBe('alinkb')
  })

  it('removes DCS, APC, PM and SOS strings and the C1 forms of CSI and OSC', () => {
    expect(stripTerminalControls(`a${ESC}Pq#0;2;0;0;0${ESC}\\b${ESC}_x${ESC}\\c${ESC}^y${ESC}\\d${ESC}Xz${ESC}\\e`)).toBe('abcde')
    expect(stripTerminalControls('a\x9b31mb\x9d0;t\x07c')).toBe('abc')
  })

  it('keeps line feeds and tabs, turns CR LF into LF and drops lone CRs and other controls', () => {
    expect(stripTerminalControls('one\r\ntwo\tthree\rx\x00\x08\x7f')).toBe('one\ntwo\tthreex')
  })

  it('removes bidi controls that make text read differently from what it says', () => {
    expect(stripTerminalControls('safe\u202edelete\u202c \u2066x\u2069')).toBe('safedelete x')
  })

  it('an unterminated sequence runs to the end instead of leaking its body', () => {
    expect(stripTerminalControls(`ok${ESC}]52;c;bm90IHRleHQ=`)).toBe('ok')
    expect(stripTerminalControls(`ok${ESC}`)).toBe('ok')
  })

  it('stays linear on a screen full of unterminated sequences', () => {
    const hostile = `${ESC}]`.repeat(200_000)
    const started = Date.now()
    expect(stripTerminalControls(hostile)).toBe('')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('leaves ordinary text, emoji and non-Latin scripts alone', () => {
    const text = 'Ünïcode ✓ 日本語 👨‍💻 — ok'
    expect(stripTerminalControls(text)).toBe(text)
  })
})
