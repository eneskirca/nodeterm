// Settings → Behavior "Keep running when the window closes" (settings.runInBackgroundOnClose).
// Pure so the visibility + copy decisions are testable without a DOM. The policy itself is
// `resolveBackgroundOnClose` in src/main/background-mode.ts — the copy here must describe it.

/** Only a desktop window off macOS has the choice: macOS always keeps running in the Dock, and
 *  the Server Edition has no window to close (its browser tab is not the app). */
export function backgroundCloseRowVisible(isMac: boolean, isBrowser: boolean): boolean {
  return !isMac && !isBrowser
}

export function backgroundCloseDescription(isWindows: boolean): string {
  const where = isWindows ? 'notification area' : 'system tray'
  const auto = isWindows ? 'Automatic keeps it running on Windows.' : 'Automatic quits on Linux, where a tray icon depends on your desktop.'
  // Electron's `quit` menu role has NO accelerator on Windows (it is "Exit", and Alt+F4 is a window
  // close — i.e. a hide here), so Ctrl+Q is only offered where it actually quits.
  const quitVia = isWindows ? 'the tray icon or File → Exit' : 'the tray icon or Ctrl+Q'
  return `Closing the window hides nodeterm to the ${where} so phone access, agent notifications and updates keep working. Quit from ${quitVia}. ${auto}`
}
