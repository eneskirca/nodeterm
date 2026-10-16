import { describe, expect, it } from 'vitest'
import { DaReplyGate, DA_REPLY_TTL_TMUX_MS } from './da-reply-gate'

const DA1_Q = '\x1b[c'
const DA2_Q = '\x1b[>c'
const DA1_R = '\x1b[?1;2c' // xterm.js
const DA2_R = '\x1b[>0;276;0c' // xterm.js

/** tmux 3.4's client handshake as it reaches the viewer (DA1, DA2, XTVERSION, OSC 10/11). */
const HANDSHAKE = `${DA1_Q}${DA2_Q}\x1b[>q\x1b]10;?\x1b\\\x1b]11;?\x1b\\`

describe('DaReplyGate', () => {
  it('two viewers answer one handshake: the first answer of each kind passes, the copies are dropped', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput(HANDSHAKE, 0)
    // Viewer A, then viewer B — each emits DA1 and DA2 as separate writes (xterm.js does).
    expect(g.filterInput(DA1_R, 50)).toBe(DA1_R)
    expect(g.filterInput(DA2_R, 50)).toBe(DA2_R)
    expect(g.filterInput(DA1_R, 60)).toBe('')
    expect(g.filterInput(DA2_R, 60)).toBe('')
  })

  it('a lone answer that arrives after tmux stopped waiting is dropped instead of typed into the pane', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput(HANDSHAKE, 0)
    expect(g.filterInput(DA1_R, DA_REPLY_TTL_TMUX_MS + 1)).toBe('')
    expect(g.filterInput(DA2_R, DA_REPLY_TTL_TMUX_MS + 1)).toBe('')
  })

  it('an answer nobody asked for is dropped', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    expect(g.filterInput(DA1_R, 0)).toBe('')
    expect(g.filterInput(DA2_R, 0)).toBe('')
  })

  it('every reattach (a new handshake) gets its answer again — the gate never closes for good', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput(HANDSHAKE, 0)
    expect(g.filterInput(DA1_R, 10)).toBe(DA1_R)
    g.noteOutput(`hello\r\n${DA1_Q}`, 60_000) // e.g. a pane app querying through DCS passthrough
    expect(g.filterInput(DA1_R, 60_010)).toBe(DA1_R)
    expect(g.filterInput(DA1_R, 60_020)).toBe('')
  })

  it('a query split across output chunks still counts, once', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput('text\x1b[', 0)
    g.noteOutput('>', 1)
    g.noteOutput('0c more', 2)
    expect(g.filterInput(DA2_R, 3)).toBe(DA2_R)
    expect(g.filterInput(DA2_R, 4)).toBe('')
  })

  it('a reply in the output stream is not a query', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput(`${DA1_R}${DA2_R}\x1b[0m\x1b[2J`, 0)
    expect(g.filterInput(DA1_R, 1)).toBe('')
  })

  it('a write that is not purely DA replies is never touched — keystrokes, Shift+F3, CPR, pastes', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    for (const input of [
      'claude --resume x\r',
      'c',
      '\x1b[1;2R', // Shift+F3 == a cursor-position report
      '\x1b[12;40R',
      '\x1b]11;rgb:0000/0000/0000\x1b\\',
      `\x1b[200~${DA1_R}\x1b[201~`, // a bracketed paste that happens to contain the bytes
      `${DA1_R}x`,
      '\x1b[A'
    ]) {
      expect(g.filterInput(input, 0)).toBe(input)
    }
  })

  it('a batched write of several replies keeps only the answered ones', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput(DA1_Q, 0)
    expect(g.filterInput(`${DA1_R}${DA2_R}${DA1_R}`, 1)).toBe(DA1_R)
  })

  it('DA1 (CSI 0 c) and DA2 (CSI > 0 c) explicit-parameter queries count too', () => {
    const g = new DaReplyGate(DA_REPLY_TTL_TMUX_MS)
    g.noteOutput('\x1b[0c\x1b[>0c', 0)
    expect(g.filterInput(DA1_R, 1)).toBe(DA1_R)
    expect(g.filterInput(DA2_R, 1)).toBe(DA2_R)
  })
})
