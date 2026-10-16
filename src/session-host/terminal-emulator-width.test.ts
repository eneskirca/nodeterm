/**
 * The session host's emulator is what a reattaching viewer is repainted from, so it must size
 * characters the way the viewer and the pane's program do (`@shared/terminal-width`).
 *
 * MUTATION: remove the `activateTerminalWidths(this.term)` call in terminal-emulator.ts → the
 * emulator sizes the stopwatch + VS16 as one cell, its buffer holds "111%", and this reddens.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TerminalEmulator } from './terminal-emulator'
import { activateTerminalWidths } from '../shared/terminal-width'

// U+23F1 STOPWATCH + U+FE0F VS16 (invisible, hence the escapes): claude-hud's status line prefix.
const STOPWATCH_EMOJI = '\u{23f1}\u{fe0f}'

describe('the session host emulator width table', () => {
  it('replays a VS16 emoji status line the way the program painted it', async () => {
    const emu = new TerminalEmulator({ cols: 40, rows: 4, scrollback: 100 })
    await emu.write(`${STOPWATCH_EMOJI} 100%\x1b[1;4H11%\x1b[K`)
    const viewer = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    activateTerminalWidths(viewer)
    await new Promise<void>((r) => viewer.write(emu.serialize(), r))
    expect(viewer.buffer.active.getLine(0)!.translateToString(true)).toBe(`${STOPWATCH_EMOJI} 11%`)
    emu.dispose()
    viewer.dispose()
  })
})
