import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import {
  HISTORY_CAPTURE_MAX_BYTES, HISTORY_CAPTURE_MAX_ROWS, HISTORY_PAGE_MAX_ROWS,
  type HistoryScrollCapture, type HistoryScrollRow, type NativeScrollPlan
} from '../shared/history-scroll'
import { mouseEncodingRestore, mouseState, wheelReport } from './emulator-mouse'

// @xterm/addon-serialize's published types are written against @xterm/xterm's (browser) Terminal,
// which has a superset of DOM-specific members @xterm/headless's Terminal lacks. The addon only
// ever touches buffer/modes/cols/rows at runtime — all present on the headless Terminal — so this
// is a real type mismatch between two packages that are runtime-compatible, not a runtime risk.

/**
 * One session's server-side screen. This is the piece that makes the session host able to
 * reconstruct a fresh client's screen on attach WITHOUT itself being a "painter" the way a real
 * tmux client is — see docs/windows-session-host.md ("The seeding trap") before touching any of
 * this, and CLAUDE.md's "Seeding a fresh xterm" section for why a tmux-shaped answer here
 * (seed nothing on warm attach) would ship a blank terminal or duplicated screens depending on
 * which half you got wrong.
 *
 * MODE RESTORATION, VERIFIED NOT ASSUMED: xterm.js's own `SerializeAddon` already restores most
 * DEC private modes as part of its `serialize()` output (bracketed paste, application cursor
 * keys, origin mode, insert mode, reverse-wraparound, send-focus, wraparound, and — when the
 * active buffer is the alternate screen — the `?1049h` switch). Read directly from the compiled
 * `_serializeModes()` in the installed addon's primary source rather than assumed from docs.
 * It does not restore coordinate ENCODING: public modes expose only the tracking PROTOCOL.
 * Native applications can independently request DEFAULT, SGR or SGR_PIXELS, even while tracking
 * is off. The guarded headless mouse adapter restores that actual state without assuming tmux.
 */
export class TerminalEmulator {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private readonly defaultScrollback: number

  constructor(opts: { cols: number; rows: number; scrollback: number }) {
    this.defaultScrollback = Math.max(0, opts.scrollback)
    this.term = new Terminal({
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      scrollback: this.defaultScrollback,
      allowProposedApi: true
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon)
  }

  /**
   * Feed one chunk of PTY output. Resolves once xterm has fully applied it — `Terminal.write`'s
   * own write queue can defer processing of a large chunk past the current tick, and a caller
   * that called `serialize()` without waiting for this would race a partially-applied write (the
   * screen it hands back could be missing the tail of what just arrived).
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows)
  }

  /**
   * The reconstructed screen: serialized content (scrollback capped at `scrollback`, defaulting
   * to this emulator's construction-time cap — smaller for `captureSession`'s "recent lines"
   * callers) plus the mode-restore/alt-buffer/cursor tail `SerializeAddon` already produces, with
   * the actual coordinate encoding restored. Returns '' for a session that has never painted
   * anything (a cold session moments after spawn) — callers treat '' the same way the rest of
   * this app already treats an empty tmux capture: "nothing to seed", never a screen reset.
   */
  serialize(scrollback = this.defaultScrollback): string {
    const out = this.serializer.serialize({ scrollback: Math.max(0, scrollback) })
    const state = mouseState(this.term)
    if (!state) throw new Error('Unsupported terminal mouse state')
    if (!out && state.encoding === 'DEFAULT') return ''
    return out + mouseEncodingRestore(state)
  }

  /** Called synchronously only after the owning backend's output/geometry barrier. */
  scrollPlan(up: boolean, lines: number, capture: boolean): NativeScrollPlan {
    if (typeof up !== 'boolean' || typeof capture !== 'boolean' ||
        !Number.isInteger(lines) || lines < 1 || lines > 20 ||
        !Number.isInteger(this.term.cols) || this.term.cols < 1 || this.term.cols > 65_535 ||
        !Number.isInteger(this.term.rows) || this.term.rows < 1) {
      return { status: 'refused', message: 'Invalid terminal scroll request.' }
    }
    const state = mouseState(this.term)
    if (!state) return { status: 'refused', message: 'This terminal does not support native scrolling.' }
    if (state.protocol === 'NONE' || state.protocol === 'X10') {
      if (!capture) return { status: 'history' }
      const snapshot = this.historyCapture()
      return snapshot ? { status: 'history', capture: snapshot } :
        { status: 'refused', message: 'This terminal history exceeds the capture size limit.' }
    }
    const report = wheelReport(state, up)
    if (!report) return { status: 'refused', message: 'This terminal does not support native scrolling.' }
    return { status: 'wheel', data: Array.from({ length: lines }, () => report) }
  }

  private historyCapture(): HistoryScrollCapture | undefined {
    const capture: HistoryScrollCapture = { cols: this.term.cols,
      viewportRows: Math.min(HISTORY_PAGE_MAX_ROWS, this.term.rows), rows: [], olderTruncated: false }
    // Count JSON bytes, including escaped controls/backslashes, row metadata and separators.
    let bytes = Buffer.byteLength(JSON.stringify(capture), 'utf8')
    const newest: HistoryScrollRow[] = []
    const buffers = [this.term.buffer.normal]
    if (this.term.buffer.active.type === 'alternate') buffers.push(this.term.buffer.alternate)
    for (let b = buffers.length - 1; b >= 0; b--) {
      const buffer = buffers[b]
      for (let i = buffer.length - 1; i >= 0; i--) {
        const line = buffer.getLine(i)
        if (!line) continue
        const row: HistoryScrollRow = { text: line.translateToString(true), isWrapped: line.isWrapped,
          section: b === 0 ? 'normal' : 'alternate' }
        const added = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
        if (newest.length >= HISTORY_CAPTURE_MAX_ROWS || bytes + added > HISTORY_CAPTURE_MAX_BYTES) {
          // A combining-character cell can exceed the budget even in a narrow grid.
          // Never misrepresent its newest physical row as an empty captured history.
          if (!newest.length) return undefined
          capture.olderTruncated = true
          capture.rows = newest.reverse()
          return capture
        }
        newest.push(row); bytes += added
      }
    }
    capture.rows = newest.reverse()
    return capture
  }

  /** Plain retained normal history plus the current alternate screen, joining soft wraps. */
  historyText(): string {
    const lines: string[] = []
    const append = (buffer: typeof this.term.buffer.normal): void => {
      for (let i = 0; i < buffer.length; i++) {
        const row = buffer.getLine(i)
        if (!row) continue
        const text = row.translateToString(true)
        if (row.isWrapped && lines.length) lines[lines.length - 1] += text
        else lines.push(text)
      }
    }
    append(this.term.buffer.normal)
    if (this.term.buffer.active.type === 'alternate') append(this.term.buffer.alternate)
    return lines.join('\n')
  }

  /**
   * Has the app running in this session REQUESTED bracketed paste (`CSI ?2004h`)?
   *
   * This is the session host's answer to the question `paste-buffer -p` asks tmux's pane state,
   * and it is answerable here for a reason the tmux side cannot claim: the emulator is fed the
   * session's OWN pty output, so a `?2004h` it saw was written by the app in the pane. (The
   * tombstone in `pty-manager.ts` for `bracketPasteRequested` and CLAUDE.md's "the emulator is
   * NOT the answer here" both concern a RENDERER xterm attached as a tmux CLIENT, where the mode
   * it observes is tmux's own paste-through on the outer terminal and reads true for every pane.
   * No tmux sits between this emulator and the pane's app.)
   *
   * Read through `HostSession.bracketedPasteRequested()`, never directly: emulator writes are
   * queued, so the answer is only current behind `outputTail`.
   */
  bracketedPasteRequested(): boolean {
    return this.term.modes.bracketedPasteMode
  }

  dispose(): void {
    try {
      this.serializer.dispose()
    } catch {
      /* already disposed */
    }
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }
}
