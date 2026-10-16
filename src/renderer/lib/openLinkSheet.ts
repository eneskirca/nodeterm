// The `nodeterm://open` confirm sheet's decisions, pure (components/OpenLinkSheet.tsx renders them,
// canvas/Canvas.tsx owns the sheet's lifetime). Main already resolved the candidates; nothing here
// can widen them — the sheet only ever answers with one of them or "new project".

import type { LinkProjectCandidate, OpenLinkChoice, OpenLinkPrompt } from '@shared/open-link'
import { pathWithin } from '@shared/open-link'

/** The picker's value: a candidate id, or the "open the link's folder as a new project" row. */
export const NEW_PROJECT_KEY = '__new-project__'

/**
 * The preselection, in order: main's suggestion; else the project on screen when it is offerable;
 * else the new-project row when offered; else the first candidate. Null only when nothing at all
 * can be offered (the Open button then stays disabled with the reason).
 */
export function initialProjectKey(req: OpenLinkPrompt, activeProjectId: string | null | undefined): string | null {
  const { candidates, preselectId, newProjectCwd } = req.resolution
  if (preselectId && candidates.some((c) => c.id === preselectId)) return preselectId
  // A link that named a project we could not use says so in the sheet; falling back to the
  // project on screen there would read as "it found your project".
  const named = req.resolution.note === 'not-found' || req.resolution.note === 'unsupported' || req.resolution.note === 'no-match'
  if (!named && activeProjectId && candidates.some((c) => c.id === activeProjectId)) return activeProjectId
  if (newProjectCwd) return NEW_PROJECT_KEY
  return candidates[0]?.id ?? null
}

export function candidateFor(req: OpenLinkPrompt, key: string | null): LinkProjectCandidate | undefined {
  return key && key !== NEW_PROJECT_KEY ? req.resolution.candidates.find((c) => c.id === key) : undefined
}

/** Where the node will run, as the sheet shows it — the same rule main applies on accept. */
export function sheetCwd(req: OpenLinkPrompt, key: string | null): string | undefined {
  if (req.cwd) return req.cwd
  if (key === NEW_PROJECT_KEY) return req.resolution.newProjectCwd
  return candidateFor(req, key)?.cwd
}

/** The link's cwd is outside the chosen project's folder (or the project has none). */
export function cwdOutsideProject(req: OpenLinkPrompt, key: string | null): boolean {
  if (!req.cwd || key === NEW_PROJECT_KEY) return false
  const c = candidateFor(req, key)
  if (!c) return false
  return !c.cwd || !pathWithin(req.cwd, c.cwd)
}

/** The sentence under the picker when the link named a project we could not use. */
export function projectNoteText(req: OpenLinkPrompt): string | null {
  switch (req.resolution.note) {
    case 'not-found':
      return 'The link named a project that is not on this machine. Pick one below.'
    case 'unsupported':
      return 'The link named an SSH project, which links cannot open yet. Pick another below.'
    case 'no-match':
      return 'No project uses the folder the link named. Pick one below.'
    default:
      return null
  }
}

export function choiceFor(key: string | null, title: string): OpenLinkChoice | null {
  if (!key) return null
  const t = title.trim()
  return key === NEW_PROJECT_KEY
    ? { newProject: true, ...(t ? { title: t } : {}) }
    : { projectId: key, ...(t ? { title: t } : {}) }
}

/** How long the Open button stays disabled after the sheet appears: a click or key already on its
 *  way when a link arrived must not approve it. */
export const OPEN_LINK_ARM_MS = 1000

/**
 * A second link while a sheet is up. It replaces the sheet only while that sheet is brand new (shown
 * for less than the arm time) and untouched — a double-fired link, a redirect. After that the human
 * may be reading it (reading fires no event), and a page could otherwise swap the request under
 * someone who has already decided, so the newcomer is dropped.
 */
export function nextSheetAction(
  current: { touched: boolean; shownAt: number } | null,
  now: number
): 'show' | 'replace' | 'drop' {
  if (!current) return 'show'
  return !current.touched && now - current.shownAt < OPEN_LINK_ARM_MS ? 'replace' : 'drop'
}

/** "12 lines · 1.4 KB" — so a long prompt cannot pass for a short one in a scrolled box. */
export function promptSizeText(text: string): string {
  const lines = text.split('\n').length
  const bytes = new TextEncoder().encode(text).length
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
  return `${lines} ${lines === 1 ? 'line' : 'lines'} · ${size}`
}

/** What the sheet says about the permission mode the session would start in. */
export interface LinkPermissionView {
  label: string
  /** The mode runs tools without asking. */
  bypass: boolean
  /** Still reading the folder's committed project file (a new project): Open waits. */
  pending?: boolean
}
