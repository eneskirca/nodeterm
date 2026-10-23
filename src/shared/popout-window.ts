/**
 * A pop-out window shows ONE project in its own OS window (desktop only). Main tells the new
 * window which project it owns through the page URL's hash — the one channel that exists before
 * any IPC does, so the renderer can decide what it is BEFORE it loads a workspace, and a reload of
 * the window (crash auto-reload, ⌘R) comes back as the same pop-out rather than a second main
 * window. Both sides read and write the hash through this module so the spelling cannot drift.
 */
export const POPOUT_HASH_KEY = 'popout'

/** The hash a pop-out window is loaded with: `#popout=<encoded project id>`. */
export function popoutHash(projectId: string): string {
  return `#${POPOUT_HASH_KEY}=${encodeURIComponent(projectId)}`
}

/**
 * The project id a page hash names, or `null` for anything else — the main window (no hash), the
 * dev-only `#glyphgrid` harness, a malformed value. A pop-out with no id is not a pop-out.
 */
export function popoutProjectIdFromHash(hash: string): string | null {
  if (typeof hash !== 'string') return null
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  for (const part of body.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq) !== POPOUT_HASH_KEY) continue
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return null
    }
    return value.trim() ? value : null
  }
  return null
}
