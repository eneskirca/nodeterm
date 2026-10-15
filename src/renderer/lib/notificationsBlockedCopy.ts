// Copy for Settings → Notifications' "the OS refused our notification" repair row. The button
// opens `notificationSettingsTarget(platform)` main-side (src/main/app-identity.ts), which exists
// on macOS and Windows only — so `button` is null exactly where that handler would open nothing.

export type CopyPlatform = 'mac' | 'windows' | 'other'

export function notificationsBlockedCopy(p: CopyPlatform): { message: string; button: string | null } {
  if (p === 'mac') return { message: 'macOS is blocking notifications for this app.', button: 'Open System Settings' }
  if (p === 'windows') return { message: 'Windows is blocking notifications for this app.', button: 'Open Notification settings' }
  return { message: 'The system is blocking notifications for this app.', button: null }
}
