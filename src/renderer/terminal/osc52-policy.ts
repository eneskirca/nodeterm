// Who may write THIS machine's clipboard through OSC 52.
//
// OSC 52 is the terminal's clipboard-write sequence: whatever byte stream the pane emits can put
// text on the system clipboard, with no gesture from the person at the keyboard. For a LOCAL core
// and for an SSH project that stream comes from the user's own machines, and it is the primary copy
// path (tmux copy-mode emits OSC 52 on a drag-select), so it stays exactly as it was.
//
// A relay tab is different: the stream comes from ANOTHER person's core. A hostile or compromised
// host can write the clipboard silently — the classic paste-jacking setup, where a harmless-looking
// copy is replaced by a command that runs when the user pastes it into a shell. So for any
// non-local source the write is REFUSED, and the user is told once per burst, because a copy that
// silently does nothing reads as broken. Chosen over a confirm prompt because the prompt would
// fire on every tmux drag in a relay tab and train the user to click Allow without reading — the
// consent would be worth nothing. The escape is the emulator's own selection (hold Option / Shift
// while dragging, then Cmd+C / Ctrl+Shift+C), which is a gesture on this machine.

import { isMacPlatform } from '@shared/platform-utils'
import type { SessionSource } from '../session/session'

export type Osc52Decision = 'write' | 'block'

export function osc52Decision(source: SessionSource): Osc52Decision {
  return source === 'local' ? 'write' : 'block'
}

export function osc52BlockedMessage(mac: boolean = isMacPlatform()): string {
  const mod = mac ? '⌥' : 'Shift'
  const copy = mac ? '⌘C' : 'Ctrl+Shift+C'
  return `Blocked a clipboard write from the remote host. To copy from this terminal, hold ${mod} while selecting, then press ${copy}.`
}

/** At most one notice per terminal in this window, so a burst of writes is one toast. */
export const OSC52_NOTICE_INTERVAL_MS = 10_000

/** Build the per-terminal notice throttle. `now` is a test seam. */
export function createOsc52Notice(now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < OSC52_NOTICE_INTERVAL_MS) return false
    last = t
    return true
  }
}

/** Apply the policy to one decoded OSC 52 write. Returns true when the clipboard was written. */
export function handleOsc52Write(
  text: string,
  source: SessionSource,
  deps: { write(text: string): void; notifyCopied(text: string): void; shouldNotify(): boolean; toast(message: string): void }
): boolean {
  if (osc52Decision(source) === 'write') {
    deps.write(text)
    deps.notifyCopied(text)
    return true
  }
  if (deps.shouldNotify()) deps.toast(osc52BlockedMessage())
  return false
}

export function dispatchOsc52Toast(message: string): void {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}
