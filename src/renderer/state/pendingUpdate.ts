import { create } from 'zustand'

// The update the user still owes, as seen by the title-bar "Update" button (Figma-style: a
// prominent pill beside the traffic lights that cannot be dismissed). UpdateCard owns the updater
// subscriptions and writes here; the card's own ✕ only hides the CARD, never this, so a dismissed
// card still leaves a way to install. Transient: a relaunch re-derives it from the updater.
//
//   downloaded → staged, click restarts into it
//   manual     → a .deb/.rpm Linux install can't self-install, click opens the download page
//   required   → below the channel minimum, click triggers a check (which downloads it)
export type PendingUpdate =
  | { kind: 'downloaded'; version: string }
  | { kind: 'manual'; version: string }
  | { kind: 'required'; minSupported: string | null }

interface PendingUpdateState {
  pending: PendingUpdate | null
  setPending: (p: PendingUpdate | null) => void
}

export const usePendingUpdate = create<PendingUpdateState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending })
}))

export const RELEASES_URL = 'https://nodeterm.dev/releases'

/**
 * A USER-initiated update check. The card listens for `nodeterm:update-checking` to know the user
 * asked — that is what makes it show progress and "You're up to date", which automatic checks
 * never do. Every button that checks goes through here.
 */
export function checkForUpdatesNow(): void {
  window.dispatchEvent(new CustomEvent('nodeterm:update-checking'))
  window.nodeTerminal.updates.check()
}

/** What clicking the title-bar button does for each pending kind. */
export function runPendingUpdate(p: PendingUpdate): void {
  if (p.kind === 'downloaded') window.nodeTerminal.updates.restart()
  else if (p.kind === 'manual') window.open(RELEASES_URL, '_blank', 'noopener')
  else checkForUpdatesNow()
}
