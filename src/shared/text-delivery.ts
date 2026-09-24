/** A partial or transport-uncertain paste must never be retried or represented as submitted. */
export type TextDeliveryResult = boolean | 'pasted-not-submitted'
export const TEXT_NOT_SUBMITTED = 'Text may already be pasted, but submission could not be confirmed. Do not resend it. Inspect the terminal before taking further action.'
