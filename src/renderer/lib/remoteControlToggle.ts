import type { AgentState } from '@shared/agents/normalize'
import type { TextDeliveryResult } from '@shared/text-delivery'

/**
 * The header's Remote Control button, as a pure plan + a small runner.
 *
 * Claude Code has ONE command for both directions (`/remote-control`, measured on 2.1.325):
 * - while OFF it connects (the first time ever it asks "Enable Remote Control?" in the terminal —
 *   that consent is the user's to give, so we never answer it);
 * - while ON it opens a dialog whose first row is "Disconnect this session".
 *
 * So turning it OFF needs an Enter on that dialog. We press it ONLY after reading the pane and
 * seeing the selection cursor on that exact row. Anything else on screen (the consent dialog,
 * whose first row is "Enable Remote Control"; a permission prompt; a dialog drawn differently
 * by a newer CLI) gets no key from us — the dialog simply stays open for the user to answer.
 * The dialog's row text comes from the CLI's source; its live rendering has not been captured,
 * which is exactly why the Enter is gated on what the pane shows rather than on a timer.
 */
export const REMOTE_CONTROL_COMMAND = '/remote-control'

/** True when the pane shows the disconnect dialog with the cursor on "Disconnect this session". */
export function disconnectRowSelected(paneText: string): boolean {
  return paneText.split('\n').some((line) => /❯\s*(\d+\.\s*)?Disconnect this session/.test(line))
}

/**
 * Why the button must not type right now, or null. A command typed into a permission prompt or a
 * question ANSWERS it (same rule as the in-place restart). A working session is fine: the command
 * is one Claude runs immediately, mid-turn.
 */
export function remoteControlRefusal(state: AgentState | undefined): string | null {
  if (state === 'blocked' || state === 'waiting')
    return 'Claude is waiting for your answer — respond in the terminal first, then toggle Remote Control.'
  return null
}

export interface RemoteControlToggleDeps {
  sendText(text: string): Promise<TextDeliveryResult>
  /** The pane's visible text. */
  capture(): Promise<string>
  /** Write raw bytes to the live pty (only used for the gated Enter). Absent ⇒ the disconnect
   *  dialog is left open for the user. */
  write?: (data: string) => void
  sleep(ms: number): Promise<void>
}

export type RemoteControlToggleResult =
  /** The command was delivered; Claude connects (or asks its one-time consent in the terminal). */
  | 'sent'
  /** Disconnect dialog seen and confirmed. */
  | 'disconnected'
  /** Command delivered but the disconnect row was not seen — the dialog is left for the user. */
  | 'dialog-left-open'
  /** Nothing could be written (session unavailable). */
  | 'undelivered'

export const DISCONNECT_POLL_MS = 250
export const DISCONNECT_POLL_ATTEMPTS = 12

export async function toggleRemoteControl(
  deps: RemoteControlToggleDeps,
  currentlyOn: boolean
): Promise<RemoteControlToggleResult> {
  const delivered = await deps.sendText(REMOTE_CONTROL_COMMAND)
  if (delivered !== true) return 'undelivered'
  if (!currentlyOn) return 'sent'
  if (!deps.write) return 'dialog-left-open'
  for (let i = 0; i < DISCONNECT_POLL_ATTEMPTS; i++) {
    await deps.sleep(DISCONNECT_POLL_MS)
    let pane = ''
    try {
      pane = await deps.capture()
    } catch {
      continue
    }
    if (disconnectRowSelected(pane)) {
      deps.write('\r')
      return 'disconnected'
    }
  }
  return 'dialog-left-open'
}
