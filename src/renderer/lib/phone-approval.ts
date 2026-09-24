import type { PhoneApprovalResult } from '@shared/types'

/** A cast cannot tell a stale request from missing IPC or failed persistence (#819). */
export async function approvePhoneWithFeedback(
  approve: () => Promise<PhoneApprovalResult>,
  report: (message: string) => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      approve(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('approval response timeout')), 15_000)
      })
    ])
    if (result.status === 'stale') {
      report('This phone approval expired or was replaced. Reconnect the phone and compare the new code.')
    } else if (result.status === 'persistence-failed') {
      report('The phone approval could not be saved. Access was not granted. Reconnect the phone to try again.')
    } else if (result.status === 'saved-disconnected') {
      report('Phone approval saved. The phone disconnected; retry browsing projects on the phone.')
    }
  } catch {
    report('No phone approval response was received. Approval is unconfirmed; reconnect the phone to check.')
  } finally {
    clearTimeout(timer)
  }
}
