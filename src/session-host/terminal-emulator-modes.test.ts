// `TerminalEmulator.mouseTrackingMode` — the session host's answer to "did the APP in this pane ask
// for the mouse?", read off @xterm/headless fed the pane's own output. The relay's scroll routing
// (`PtyManager.scrollRoute`, via `paneModesV1`) writes a wheel event into a session-host pane only
// when this is not 'none': with no tmux in front, an unrequested wheel is raw text in the prompt.
import { describe, it, expect } from 'vitest'
import { TerminalEmulator } from './terminal-emulator'

describe('TerminalEmulator.mouseTrackingMode', () => {
  it('follows the app’s DECSET / DECRST', async () => {
    const t = new TerminalEmulator({ cols: 80, rows: 24, scrollback: 100 })
    try {
      expect(t.mouseTrackingMode()).toBe('none')
      await t.write('\x1b[?1000h\x1b[?1006h')
      expect(t.mouseTrackingMode()).toBe('vt200')
      await t.write('\x1b[?1002h')
      expect(t.mouseTrackingMode()).toBe('drag')
      await t.write('\x1b[?1002l\x1b[?1000l')
      expect(t.mouseTrackingMode()).toBe('none')
    } finally {
      t.dispose()
    }
  })
})
