/**
 * Server-only adapter: the tmux-backed pane is reached through PtyManager's capture + sendText.
 * The sequencing itself (paste, observe the envelope settle, submit in a second write) lives in
 * `core/settled-submit.ts`, shared with the Windows session host and the direct Windows PTY.
 */
import { pasteThenSubmitWhenSettled, type SettleOptions } from '../core/settled-submit'

export { ENVELOPE_SETTLE_POLL_MS, ENVELOPE_SETTLE_POLLS } from '../core/settled-submit'

export interface SettledEnvelopePty {
  captureSession(nodeId: string): Promise<string>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
}

export type SettledEnvelopeOptions = SettleOptions

/** Paste one complete envelope and submit only after the target pane has visibly settled. */
export async function sendSettledEnvelope(
  pty: SettledEnvelopePty,
  nodeId: string,
  envelope: string,
  options: SettledEnvelopeOptions = {}
): Promise<boolean> {
  return pasteThenSubmitWhenSettled(
    envelope,
    {
      capture: async () => {
        try {
          return await pty.captureSession(nodeId)
        } catch {
          return null
        }
      },
      paste: async () => {
        try {
          return await pty.sendText(nodeId, envelope, { enter: false })
        } catch {
          return false
        }
      },
      submit: async () => {
        try {
          // False is still a successful paste: no receipt follows, and the shared messaging path
          // reports the non-retryable `stalled` after its deadline.
          await pty.sendText(nodeId, '', { enter: true })
        } catch {
          // Same partial-delivery contract as a false return.
        }
      }
    },
    options
  )
}
