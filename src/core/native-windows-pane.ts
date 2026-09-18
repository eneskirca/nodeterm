import { randomUUID } from 'crypto'
import { TerminalEmulator } from '../session-host/terminal-emulator'
import { readWindowsConsoleOwner, sameNativeProcess } from '../session-host/windows-pane-owner'
import { sendKeysWrites } from '../session-host/send-keys-delivery'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sanitizePasteText } from './paste-injection'
import { pasteThenSubmitWhenSettled, type SettleOptions } from './settled-submit'

export { sameNativeProcess } from '../session-host/windows-pane-owner'

/** Core-owned screen and generation for a direct Windows PTY. This is neither a persisted
 * agent label nor the "deepest descendant" restart heuristic. The caller still checks
 * project consent, verified idle status, agent binary and a receipt after delivery. */
export class NativeWindowsPane {
  private readonly generation = randomUUID()
  private readonly screen: TerminalEmulator
  private tail: Promise<void> = Promise.resolve()
  private alive = true

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

  async owner(): Promise<PaneOwner | null> {
    if (!this.alive) return null
    const owner = await this.probe(this.proc.pid, this.generation)
    return this.alive ? owner : null
  }

  async pasteAware(): Promise<boolean> {
    await this.tail
    return this.alive && this.screen.bracketedPasteRequested()
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
        if (!this.alive) return
        try { this.proc.write('\r') } catch { /* paste landed; receipt reports stalled */ }
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
  async sendText(text: string, enter: boolean): Promise<boolean> {
    if (!this.alive) return false
    // The write plan is the session host's `sendKeysWrites` — one rule for both Windows backends,
    // so the direct PTY cannot drift from the host on where the Enter goes or what gets stripped.
    const bracketed = sanitizePasteText(text) ? await this.pasteAware() : false
    if (!this.alive) return false
    try {
      for (const chunk of sendKeysWrites(text, enter, bracketed)) this.proc.write(chunk)
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    this.alive = false
    void this.tail.finally(() => this.screen.dispose())
  }
}
