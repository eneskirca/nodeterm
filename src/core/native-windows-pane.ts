import type { TextDeliveryResult } from '../shared/text-delivery'
import { randomUUID } from 'crypto'
import { TerminalEmulator } from '../session-host/terminal-emulator'
import { readWindowsConsoleOwner, sameNativeProcess } from '../session-host/windows-pane-owner'
import { sendTextWhenSettled } from './settled-text'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sanitizePasteText } from './paste-injection'
import { pasteThenSubmitWhenSettled, type SettleOptions } from './settled-submit'
import { validSleepingWakeInput } from '../session-host/sleeping-wake'
import { ComposedPty, waitForComposedEnter } from './composed-pty'
import { COMPOSED_INPUT_UNCERTAIN, type ComposedInput, type ComposedInputResult } from '../shared/composed-input'
import type { NativeScrollResult } from '../shared/history-scroll'

export { sameNativeProcess } from '../session-host/windows-pane-owner'

/** Core-owned screen and generation for a direct Windows PTY. This is neither a persisted
 * agent label nor the "deepest descendant" restart heuristic. The caller still checks
 * project consent, verified idle status, agent binary and a receipt after delivery. */
export class NativeWindowsPane {
  private readonly generation = randomUUID()
  private readonly screen: TerminalEmulator
  private tail: Promise<void> = Promise.resolve()
  private alive = true
  private readonly composed = new ComposedPty({
    bracketed: () => this.pasteAware(),
    write: (data) => this.proc.write(data)
  })

  constructor(
    private readonly proc: { pid: number; write(data: string): void },
    size: { cols: number; rows: number; scrollback: number },
    private readonly probe = readWindowsConsoleOwner,
    private readonly settle: SettleOptions = {}
  ) {
    this.screen = new TerminalEmulator(size)
  }

  recordOutput(data: string): void {
    if (!this.alive) return
    this.tail = this.tail.then(() => this.screen.write(data)).catch(() => { this.alive = false })
  }

  resize(cols: number, rows: number): void {
    this.tail = this.tail.then(() => { if (this.alive) this.screen.resize(cols, rows) })
  }

  async capture(full: boolean): Promise<string> {
    await this.tail
    return this.alive ? this.screen.serialize(full ? undefined : 200) : ''
  }

  async historyText(): Promise<string> {
    await this.tail
    if (!this.alive) throw new Error('This terminal has exited.')
    return this.screen.historyText()
  }

  /** Decide behind actual output/geometry, then write only to this still-owned native pane. */
  scrollForHistory(up: boolean, lines: number, capture: boolean, current: () => boolean): Promise<NativeScrollResult> {
    const refused = (): NativeScrollResult => ({ status: 'refused', message: 'This terminal viewer is no longer current or its mouse state is unavailable.' })
    const uncertain = (): NativeScrollResult => ({ status: 'uncertain', message: 'Wheel input may have reached the terminal. It was not sent again.' })
    const valid = (): boolean => this.alive && current()
    const scrolling = this.tail.then((): NativeScrollResult => {
      if (!valid()) return refused()
      let attempted = false
      try {
        const plan = this.screen.scrollPlan(up, lines, capture)
        if (!valid()) return refused()
        if (plan.status !== 'wheel') return plan
        for (const data of plan.data) {
          if (!valid()) return attempted ? uncertain() : refused()
          attempted = true
          this.proc.write(data)
        }
        return valid() ? { status: 'input' } : uncertain()
      } catch { return attempted ? uncertain() : refused() }
    }, () => { this.alive = false; return refused() })
    // Later output and geometry follow this turn; failed wheel writes do not poison raw input.
    this.tail = scrolling.then(() => {}, () => { this.alive = false })
    return scrolling
  }

  async owner(): Promise<PaneOwner | null> {
    if (!this.alive) return null
    const owner = await this.probe(this.proc.pid, this.generation)
    return this.alive ? owner : null
  }

  async pasteAware(): Promise<boolean> {
    await this.tail
    return this.alive && this.screen.bracketedPasteRequested()
  }

  async wakeSleeping(data: string, expected: PaneOwner): Promise<boolean> {
    if (!this.alive || !validSleepingWakeInput(data)) return false
    if (!sameNativeProcess(expected, await this.owner()) || !this.alive) return false
    try {
      this.proc.write(data)
      return true
    } catch { return false }
  }

  async sendEnvelope(envelope: string, expected?: PaneOwner): Promise<boolean> {
    if (!envelope || !expected || !(await this.pasteAware())) return false
    // Re-check the exact process immediately before typing. A replacement with the same
    // PID but a different OS birth time, or a shell returned to the console, refuses.
    if (!sameNativeProcess(expected, await this.owner()) || !(await this.pasteAware())) return false
    const text = sanitizePasteText(envelope)
    if (!text) return false
    // Paste, let the composer install the block, then submit in a second write
    // (core/settled-submit.ts). Two synchronous writes arrive as one read on the other side.
    return pasteThenSubmitWhenSettled(text, {
      capture: async () => (this.alive ? this.capture(false) : null),
      paste: async () => {
        if (!this.alive || !(await this.pasteAware())) return false
        try {
          this.proc.write(`\x1b[200~${text}\x1b[201~`)
          return true
        } catch { return false }
      },
      submit: async () => {
        try {
          if (!sameNativeProcess(expected, await this.owner()) || !(await this.pasteAware()) || !this.alive) return
          this.proc.write('\r')
        } catch { /* paste landed; receipt reports stalled */ }
      }
    }, this.settle)
  }

  /**
   * `PtyManager.sendText` for a direct Windows PTY — the `paste-buffer -p` contract: framed only
   * when the app in the pane asked for bracketed paste, then Enter when requested. Unlike
   * `sendEnvelope` there is no process attestation: this is the user-confirmed `write` verb and the
   * app's own writers (rename, note push, dictation), which have always typed into whatever owns
   * the pane. Without it those callers fell through to the session-host backend, which has no
   * session for a direct PTY, and failed every time.
   */
  async sendText(text: string, enter: boolean): Promise<TextDeliveryResult> {
    return sendTextWhenSettled(this, text, enter, {
      current: () => this.alive,
      bracketed: () => this.pasteAware(),
      capture: () => this.capture(false),
      write: (chunk) => this.proc.write(chunk)
    }, this.settle)
  }

  /** Explicit phone Send, distinct from the observed-screen agent-message delivery above. */
  async submitComposed(input: ComposedInput, current: () => boolean): Promise<ComposedInputResult> {
    const valid = (): boolean => this.alive && current()
    const prepared = this.composed.prepare(this, input, valid)
    if (prepared.status !== 'prepared') return prepared
    try {
      const result = await this.composed.write(this, prepared.ticket, 'paste', valid)
      if (result.status !== 'awaiting-enter') return result.status === 'delivered' && !valid()
        ? { status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN } : result
      await waitForComposedEnter()
      const entered = await this.composed.write(this, prepared.ticket, 'enter', valid)
      return entered.status === 'delivered' && valid() ? entered : { status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN }
    } finally { this.composed.cancel(this, prepared.ticket) }
  }

  dispose(): void {
    this.alive = false
    this.composed.dispose()
    void this.tail.finally(() => this.screen.dispose())
  }
}
