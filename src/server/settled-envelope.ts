import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import type { EnvelopeDeliveryResult } from '../shared/agents/agent-messaging'
import type { SettleOptions } from '../core/settled-submit'
export { ENVELOPE_SETTLE_POLL_MS, ENVELOPE_SETTLE_POLLS } from '../core/settled-submit'

export interface SettledEnvelopePty {
  sendEnvelope(nodeId: string, envelope: string, expected?: PaneOwner, options?: SettleOptions): Promise<EnvelopeDeliveryResult>
}
export type SettledEnvelopeOptions = SettleOptions

/** The server uses the same serialized, owner-checked backend as desktop messaging. Never
 * reimplement it as two generic sendText calls: that loses process identity before bare Enter.
 */
export async function sendSettledEnvelope(
  pty: SettledEnvelopePty,
  nodeId: string,
  envelope: string,
  expected: PaneOwner | undefined,
  options?: SettledEnvelopeOptions
): Promise<EnvelopeDeliveryResult> {
  if (!expected || !envelope) return false
  return pty.sendEnvelope(nodeId, envelope, expected, options)
}
