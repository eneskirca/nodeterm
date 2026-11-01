import type { PopupAnnouncement } from '@shared/types'

/**
 * One-time popups from the check feed (`popups` in the reply; components/AnnouncementPopup.tsx).
 *
 * "Once" is this install's record, kept in localStorage like the banner's dismissed ids — but a
 * popup is recorded the moment it is SHOWN, not when it is closed: a reload, a crash or a quit with
 * it on screen must not bring it back, and the feed keeps listing it for as long as it is active.
 */
export const SEEN_POPUPS_KEY = 'nodeterm.seenPopups'

/** No keystroke for this long before a popup may take the screen (see `popupMayShow`). */
export const KEY_QUIET_MS = 4000

/** While a popup waits its turn, the feed is read again this often, so one the admin has
 *  deactivated in the meantime is dropped instead of shown hours later. */
export const PENDING_RECHECK_MS = 5 * 60 * 1000

export function loadSeenPopups(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_POPUPS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function markPopupSeen(id: string): void {
  try {
    const seen = loadSeenPopups()
    seen.add(id)
    localStorage.setItem(SEEN_POPUPS_KEY, JSON.stringify([...seen]))
  } catch {
    // ignore quota / serialization errors — at worst the popup shows once more
  }
}

/**
 * The popup to show from one feed read: the newest (the feed is newest-first) not shown before. An
 * upgrade popup is skipped for a Pro user — its button would be a checkout for what they already
 * have — and is NOT recorded, so it is still there if they lapse.
 */
export function pickPopup(
  items: readonly PopupAnnouncement[],
  seen: ReadonlySet<string>,
  isPremium: boolean
): PopupAnnouncement | null {
  return items.find((p) => !seen.has(p.id) && !(isPremium && p.action === 'upgrade')) ?? null
}

/**
 * May a popup take the screen now? Not over another modal (it would bury the question the user is
 * answering) — one on the dialog stack (`openDialogs`) or one of the surfaces that are not
 * (`blocked`: the setup tour, Settings, the command palette, …) — and not under typing hands: a
 * modal that appears mid-keystroke catches the next keys, and the user never reads what they just
 * dismissed.
 */
export function popupMayShow(now: number, lastKeyAt: number, openDialogs: number, blocked: boolean): boolean {
  return !blocked && openDialogs === 0 && now - lastKeyAt >= KEY_QUIET_MS
}

export type PopupCta = { kind: 'url'; label: string; url: string } | { kind: 'upgrade'; label: string }

/** The popup's one button besides Close, or null for none (no link and no action). */
export function popupCta(p: PopupAnnouncement): PopupCta | null {
  if (p.action === 'upgrade') return { kind: 'upgrade', label: p.ctaLabel ?? 'Upgrade to Pro' }
  if (p.url) return { kind: 'url', label: p.ctaLabel ?? 'Learn more', url: p.url }
  return null
}
