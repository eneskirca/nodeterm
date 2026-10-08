import { describe, expect, it } from 'vitest'
import { TerminalEmulator } from './terminal-emulator'

describe('retained backend history text', () => {
  it('reads actual rendered cursor edits, colors, Unicode and joined soft wraps', async () => {
    const screen = new TerminalEmulator({ cols: 12, rows: 3, scrollback: 1000 })
    try {
      await screen.write('old needle\r\n' + 'row\r\n'.repeat(30) + '\x1b[31mΩ 😀\x1b[0m\r\nabcdefghijklmno\r\nwrong\r\x1b[2Kright')
      const text = screen.historyText()
      expect(text).toContain('old needle')
      expect(text).toContain('Ω 😀')
      expect(text).toContain('abcdefghijklmno')
      expect(text).toContain('right')
      expect(text).not.toContain('wrong')
      expect(text).not.toContain('\x1b')
    } finally { screen.dispose() }
  })
  it('includes retained normal history while an alternate-screen app is active', async () => {
    const screen = new TerminalEmulator({ cols: 80, rows: 3, scrollback: 1000 })
    try {
      await screen.write('older normal\r\n' + 'row\r\n'.repeat(10) + '\x1b[?1049hcurrent alternate')
      expect(screen.historyText()).toContain('older normal')
      expect(screen.historyText()).toContain('current alternate')
    } finally { screen.dispose() }
  })
})
