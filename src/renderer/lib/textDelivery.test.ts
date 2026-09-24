// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { reportTextDelivery } from './textDelivery'

describe('partial text delivery notice', () => {
  it('shows a no-resend warning for accepted but unsubmitted input', () => {
    const notice = vi.fn()
    window.addEventListener('nodeterm:toast', notice)
    try {
      expect(reportTextDelivery('pasted-not-submitted')).toBe(false)
      expect(notice).toHaveBeenCalledTimes(1)
      expect((notice.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: 'error', message: expect.stringContaining('Do not resend')
      })
      expect(reportTextDelivery(true)).toBe(true)
      expect(reportTextDelivery(false)).toBe(false)
      expect(notice).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener('nodeterm:toast', notice) }
  })
})
