import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sanitizePasteText } from '../core/paste-injection'
import { pasteThenSubmitWhenSettled, type SettleOptions } from '../core/settled-submit'
import { readWindowsConsoleOwner, sameNativeProcess } from './windows-pane-owner'

export interface MessagePaneSession {
  generation: string
  exited: boolean
  proc: { pid: number; write(data: string): void }
  messagePasteReady(): Promise<boolean>
  /** The host emulator's screen (`HostSession.serialize`), read to see the envelope land. */
  serialize(scrollback?: number): Promise<string>
}

/** Recent lines are enough to find the envelope footer; the whole scrollback is not needed. */
const SETTLE_CAPTURE_LINES = 200

/** The persistent host owns both the emulator and the generation. Never route this through the
 * main process's direct-PTY adapter: that object cannot observe a replacement inside this host.
 * Project grants, verified hooks, agent binary checks and receipts still belong to core. */
export function hostMessagePane(
  lookup: () => MessagePaneSession | undefined,
  probe = readWindowsConsoleOwner,
  settle: SettleOptions = {}
) {
  const current = (s: MessagePaneSession): boolean => !s.exited && lookup() === s
  return {
    async owner(): Promise<PaneOwner | null> {
      const s = lookup()
      if (!s || !current(s)) return null
      const owner = await probe(s.proc.pid, s.generation)
      return current(s) ? owner : null
    },
    async pasteReady(): Promise<boolean> {
      const s = lookup()
      return !!s && current(s) && await s.messagePasteReady() && current(s)
    },
    async send(envelope: string, expected: PaneOwner | undefined): Promise<boolean> {
      const s = lookup()
      if (!s || !current(s) || !expected || typeof envelope !== 'string') return false
      const text = sanitizePasteText(envelope)
      if (!text || !(await s.messagePasteReady()) || !current(s)) return false
      const owner = await probe(s.proc.pid, s.generation)
      if (!current(s) || !sameNativeProcess(expected, owner)) return false
      // Paste, let the composer install the block, then submit in a second write
      // (core/settled-submit.ts): an Enter in the same write was swallowed by the paste.
      return pasteThenSubmitWhenSettled(text, {
        capture: async () => {
          if (!current(s)) return null
          try {
            const screen = await s.serialize(SETTLE_CAPTURE_LINES)
            return current(s) ? screen : null
          } catch { return null }
        },
        paste: async () => {
          // Cross the emulator barrier again after the OS probe and the baseline capture: paste
          // mode may have changed meanwhile. No await between this check and the write.
          if (!(await s.messagePasteReady()) || !current(s)) return false
          try {
            s.proc.write(`\x1b[200~${text}\x1b[201~`)
            return true
          } catch { return false }
        },
        submit: async () => {
          // A replaced or exited generation gets nothing: a bare Enter into a stranger's pane.
          try {
            const owner = await probe(s.proc.pid, s.generation)
            if (!sameNativeProcess(expected, owner) || !(await s.messagePasteReady()) || !current(s)) return
            s.proc.write('\r')
          } catch { /* the paste already landed; receipt reports stalled */ }
        }
      }, settle)
    }
  }
}
