// Release-notes highlights for the update card, and the one-time "Updated to vX" decision. Pure,
// apart from the storage accessor, which is injected and wrapped (it can throw in a private window
// or with blocked site data).
import { isNewerVersion } from '@shared/update-gate'
import { RELEASES_URL } from '../state/pendingUpdate'

const HIGHLIGHT_MAX = 140

/** Strip inline markdown down to readable text. Rendered as plain text — never as HTML. */
function plain(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first `max` bullet points of a release's notes (markdown `-`/`*`/`•`/`1.` lists, or the
 * `<li>` items of HTML notes — GitHub-style feeds carry HTML), as plain text. HTML goes through
 * DOMParser's `textContent` (inert: a parsed document runs no scripts and loads nothing), never
 * through a tag-stripping regex. Empty when the notes carry no list — the card then shows only its
 * link.
 */
export function releaseHighlights(notes: unknown, max = 3): string[] {
  if (typeof notes !== 'string' || !notes.trim()) return []
  const out: string[] = []
  const push = (raw: string): boolean => {
    const t = plain(raw)
    if (t) out.push(t.length > HIGHLIGHT_MAX ? `${t.slice(0, HIGHLIGHT_MAX - 1)}…` : t)
    return out.length >= max
  }
  if (/<li[\s>]/i.test(notes)) {
    if (typeof DOMParser === 'undefined') return []
    const doc = new DOMParser().parseFromString(notes, 'text/html')
    for (const li of Array.from(doc.querySelectorAll('li'))) if (push(li.textContent ?? '')) break
    return out
  }
  for (const line of notes.split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (m && push(m[1])) break
  }
  return out
}

/** The releases page, anchored at one version when it is known. */
export function releaseNotesUrl(version?: string | null): string {
  return version ? `${RELEASES_URL}#v${encodeURIComponent(version)}` : RELEASES_URL
}

export const LAST_SEEN_VERSION_KEY = 'nodeterm.lastSeenVersion'

/**
 * Whether this launch is the first of a newer version than the last one seen — and whether to
 * record the current version. A fresh install (nothing recorded) is silent: there is nothing it
 * was "updated" from. A downgrade is recorded but never announced.
 */
export function lastSeenDecision(prev: string | null, current: string): { show: boolean; write: boolean } {
  if (!current) return { show: false, write: false }
  if (prev === current) return { show: false, write: false }
  if (prev === null) return { show: false, write: true }
  return { show: isNewerVersion(current, prev), write: true }
}

export interface VersionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Apply `lastSeenDecision` against storage; every access is guarded and a failure is silence. */
export function noteVersionSeen(current: string, storage: () => VersionStorage | null): boolean {
  let prev: string | null = null
  let store: VersionStorage | null = null
  try {
    store = storage()
    prev = store?.getItem(LAST_SEEN_VERSION_KEY) ?? null
  } catch {
    return false // unreadable: announcing on every launch would be worse than never
  }
  if (!store) return false
  const d = lastSeenDecision(prev, current)
  if (d.write) {
    try {
      store.setItem(LAST_SEEN_VERSION_KEY, current)
    } catch {
      return false // could not record it: stay quiet rather than repeat it every launch
    }
  }
  return d.show
}
