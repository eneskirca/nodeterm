import { describe, expect, it } from 'vitest'
import { notificationsBlockedCopy } from './notificationsBlockedCopy'

describe('notificationsBlockedCopy', () => {
  it('keeps the macOS copy byte-identical', () => {
    expect(notificationsBlockedCopy('mac')).toEqual({
      message: 'macOS is blocking notifications for this app.',
      button: 'Open System Settings'
    })
  })
  it('names Windows and its Notification settings page', () => {
    expect(notificationsBlockedCopy('windows')).toEqual({
      message: 'Windows is blocking notifications for this app.',
      button: 'Open Notification settings'
    })
  })
  it('offers no button where main has no settings page to open', () => {
    expect(notificationsBlockedCopy('other').button).toBeNull()
  })
})
