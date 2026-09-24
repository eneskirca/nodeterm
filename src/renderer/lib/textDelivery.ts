import { TEXT_NOT_SUBMITTED, type TextDeliveryResult } from '@shared/text-delivery'

export function reportTextDelivery(result: TextDeliveryResult): boolean {
  if (result === 'pasted-not-submitted') {
    window.dispatchEvent(new CustomEvent('nodeterm:toast', {
      detail: { kind: 'error', message: TEXT_NOT_SUBMITTED }
    }))
  }
  return result === true
}
