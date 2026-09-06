import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'
import { useSettings } from './settings'

// Which view each project shows (canvas or kanban) — PERSONAL, per machine: persisted in
// localStorage, deliberately never in the git-shared .nodeterm/project.json (spec rule).
//
// A project with an EXPLICIT entry uses it; a project with NONE follows `defaultView` (the
// Settings → "Default view" choice, synced in from settings). So changing the default flips every
// project the user hasn't explicitly toggled, while their explicit choices stick.

export const PROJECT_VIEW_KEY = 'nodeterm.projectView'
export const GLOBAL_KANBAN_KEY = 'nodeterm.globalKanban'

export type ProjectView = 'canvas' | 'kanban'

/** Parses the persisted map, keeping only valid canvas/kanban entries. Exported for tests. */
export function parseViewMap(raw: string | null): Record<string, ProjectView> {
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ProjectView> = {}
    for (const [id, v] of Object.entries(parsed)) if (v === 'kanban' || v === 'canvas') out[id] = v
    return out
  } catch {
    return {}
  }
}

function save(v: Record<string, ProjectView>): void {
  try {
    writeLocal(PROJECT_VIEW_KEY, JSON.stringify(v))
  } catch {
    /* quota/private-mode: the view choice is a nicety, never fail the UI */
  }
}

interface ViewModeState {
  viewByProject: Record<string, ProjectView>
  /** The fallback view for projects with no explicit entry (Settings → Default view). */
  defaultView: ProjectView
  setDefaultView(v: ProjectView): void
  toggle(projectId: string): void
  /** Global swimlane overview — when true, kanban shows all projects as swimlanes instead of per-project tabs. */
  globalKanban: boolean
  toggleGlobalKanban(): void
  /** Which swimlane is currently highlighted in the global overview (jump target). */
  highlightedSwimlaneId: string | null
  setHighlightedSwimlaneId(id: string | null): void
  /**
   * A node whose CARD should be opened on the board, set by anything that "goes to" a node while
   * the board is up — the notch HUD's Go, a notification click, ⌘K, the sessions sidebar. Those
   * all funnel through `focusNodeById`, which frames the node on the CANVAS; with the board's
   * opaque overlay on top, that looked like the button did nothing at all (field report: "kanban
   * view'de notch'ın Go tuşu işe yaramıyor").
   *
   * KanbanView consumes it and clears it (one-shot, so re-requesting the same node works).
   */
  requestedCardNodeId: string | null
  requestCard(nodeId: string): void
  clearCardRequest(): void
}

/** The resolved view for a project: its explicit entry, or the default. */
export function viewFor(s: Pick<ViewModeState, 'viewByProject' | 'defaultView'>, projectId: string): ProjectView {
  return s.viewByProject[projectId] ?? s.defaultView
}

/**
 * Feature flag: does the global swimlane overview exist at all?
 * `settings.omniKanbanEnabled` is the *feature* toggle (Settings → Behavior → Omni Kanban,
 * default OFF — no silent behavior change for existing users). `globalKanban` below is the
 * *view* toggle (whether the overview is currently shown). Use this helper instead of
 * spelling the check inline.
 */
export function isOmniKanbanEnabled(settings: { omniKanbanEnabled?: boolean }): boolean {
  return settings.omniKanbanEnabled === true
}

function readGlobalKanban(): boolean {
  try {
    const raw = readLocal(GLOBAL_KANBAN_KEY)
    return raw === '1' || raw === 'true'
  } catch { return false }
}
function saveGlobalKanban(v: boolean): void {
  try { writeLocal(GLOBAL_KANBAN_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

export const useViewMode = create<ViewModeState>((set) => ({
  viewByProject: parseViewMap(readLocal(PROJECT_VIEW_KEY)),
  defaultView: 'canvas',
  globalKanban: readGlobalKanban(),
  highlightedSwimlaneId: null,
  setHighlightedSwimlaneId: (id) => set({ highlightedSwimlaneId: id }),
  setDefaultView: (v) => set((s) => (s.defaultView === v ? s : { defaultView: v })),
  requestedCardNodeId: null,
  requestCard: (nodeId) => set({ requestedCardNodeId: nodeId }),
  clearCardRequest: () => set({ requestedCardNodeId: null }),
  toggle: (projectId) =>
    set((s) => {
      // Flip the RESOLVED view and store it EXPLICITLY, so this choice now overrides the default.
      const cur = s.viewByProject[projectId] ?? s.defaultView
      const next: Record<string, ProjectView> = {
        ...s.viewByProject,
        [projectId]: cur === 'kanban' ? 'canvas' : 'kanban'
      }
      save(next)
      // Leaving the board (or entering it) drops any unconsumed request — it belonged to the view
      // the user just left, and firing it later would pop a card out of nowhere.
      return { viewByProject: next, requestedCardNodeId: null }
    }),
  toggleGlobalKanban: () =>
    set((s) => {
      const next = !s.globalKanban
      saveGlobalKanban(next)
      return { globalKanban: next, requestedCardNodeId: null, highlightedSwimlaneId: null }
    })
}))

/** True when the given project currently shows the kanban board (read outside React —
 *  keydown handlers use this so they need no store subscription/deps). */
export function isKanbanOpen(projectId: string): boolean {
  return !!projectId && viewFor(useViewMode.getState(), projectId) === 'kanban'
}

/**
 * True when the global swimlane overview is *currently shown* (all projects as swimlanes).
 * Gated by the feature flag `omniKanbanEnabled` — when the feature is off, the view flag is
 * ignored and per-project tabs remain. `globalKanban` itself is persisted in localStorage
 * (`nodeterm.globalKanban`) so an explicit "open overview" survives a restart; this is
 * intentional (like `viewByProject`), not transient: a canvas lock that survives restart would
 * read as "frozen" (which is why `lib/canvasLock.ts` keeps it opt-in and default off), but a
 * board that survives restart reads as "you left it open". If that proves surprising, make this
 * transient; the call site is this one helper.
 */
export function isGlobalKanbanOpen(): boolean {
  try {
    if (!isOmniKanbanEnabled(useSettings.getState().settings)) return false
  } catch {
    // Fail closed — default OFF, so an unreadable settings store must not enable Omni.
    return false
  }
  return useViewMode.getState().globalKanban
}
