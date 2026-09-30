import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'
import { useSettings } from './settings'
import { issueUrl, type IssueRef } from '@shared/github-issue-ref'

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
  /** Set a project's view explicitly (stored, so it overrides the default like `toggle`). */
  setView(projectId: string, view: ProjectView): void
  /** The board's SCOPE: true = all projects as swimlanes (Omni), false = the active project's
   *  board. Omni is a scope of the kanban side, not a third view — see `toggleBoardView`. */
  globalKanban: boolean
  setGlobalKanban(on: boolean): void
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
  /**
   * A GitHub issue whose summary should open on the board — set by a node's `#N` chip (canvas
   * header or session card). One-shot like `requestedCardNodeId`: KanbanView opens the issue's
   * summary once the issue lane has loaded, or the issue on GitHub when the board does not show it
   * (no GitHub sync, another repository, a page not fetched), and clears it either way.
   */
  requestedIssue: IssueRef | null
  requestIssue(ref: IssueRef): void
  clearIssueRequest(): void
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
  requestedIssue: null,
  requestIssue: (ref) => set({ requestedIssue: ref }),
  clearIssueRequest: () => set({ requestedIssue: null }),
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
      return { viewByProject: next, requestedCardNodeId: null, requestedIssue: null }
    }),
  setView: (projectId, view) =>
    set((s) => {
      if (s.viewByProject[projectId] === view) return s
      const next: Record<string, ProjectView> = { ...s.viewByProject, [projectId]: view }
      save(next)
      return { viewByProject: next, requestedCardNodeId: null, requestedIssue: null }
    }),
  setGlobalKanban: (on) =>
    set((s) => {
      if (s.globalKanban === on) return s
      saveGlobalKanban(on)
      // Changing scope drops any unconsumed request, for the same reason `toggle` does.
      return { globalKanban: on, requestedCardNodeId: null, requestedIssue: null, highlightedSwimlaneId: null }
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

/**
 * OMNI IS A SCOPE OF THE KANBAN SIDE, NOT A THIRD VIEW. The view toggle (tab icon, ⌘⇧B, the
 * menu) flips canvas ⇄ board, and the board shows either this project or all projects. So:
 * leaving Omni through the scope switch lands on THIS project's board, and the view toggle from
 * Omni lands on the canvas. It used to be an overlay independent of the per-project view, so its
 * close fell through to whatever the project's view happened to be — "Canvas view" from Omni
 * could land on a board, and closing Omni opened from a board could land on the canvas.
 *
 * `globalKanban` stays independent of which project is active on purpose: Omni spans every
 * project, and a project switch made from a lane (create a card there, open one) must not drop
 * the user out of it because the new project's own view is the canvas.
 *
 * These are the only writers of `globalKanban`; TabBar, the menu IPC and the registry commands
 * all come through here, so the decision exists once.
 */

/** Show the board with every project (Omni). No-op while the feature is off. */
export function showAllProjectsBoard(): boolean {
  if (!isOmniKanbanEnabled(useSettings.getState().settings)) return false
  useViewMode.getState().setGlobalKanban(true)
  return true
}

/** Show `projectId`'s own board — the scope switch's "This project", and where closing Omni lands. */
export function showProjectBoard(projectId: string): void {
  const vm = useViewMode.getState()
  vm.setGlobalKanban(false)
  if (projectId) vm.setView(projectId, 'kanban')
}

/** Leave the board entirely, whichever scope it shows, for `projectId`'s canvas. */
export function showCanvas(projectId: string): void {
  const vm = useViewMode.getState()
  vm.setGlobalKanban(false)
  if (projectId) vm.setView(projectId, 'canvas')
}

/**
 * The view toggle (canvas ⇄ board). From any board it goes to the canvas; from the canvas it
 * opens the board in the scope `omniKanbanAsDefault` picks. Returns false when there is nothing
 * to toggle (no project and no Omni).
 */
export function toggleBoardView(projectId: string): boolean {
  if (isGlobalKanbanOpen() || (projectId && isKanbanOpen(projectId))) {
    showCanvas(projectId)
    return true
  }
  const settings = useSettings.getState().settings
  if (isOmniKanbanEnabled(settings) && settings.omniKanbanAsDefault === true) return showAllProjectsBoard()
  if (!projectId) return false
  showProjectBoard(projectId)
  return true
}

/**
 * The dedicated "All projects" command: from Omni back to this project's board, from anywhere
 * else into Omni. False while the feature is off.
 */
export function toggleAllProjectsBoard(projectId: string): boolean {
  if (!isOmniKanbanEnabled(useSettings.getState().settings)) return false
  if (isGlobalKanbanOpen()) showProjectBoard(projectId)
  else showAllProjectsBoard()
  return true
}

/**
 * Show a GitHub issue from a node's `#N` chip. Only a board with GitHub sync can show it, so only
 * then is the board brought up (the issue lane lives there) and asked to open it — toggling FIRST,
 * because leaving or entering the board drops any unconsumed request. A project whose board has no
 * GitHub sync does not get its saved view flipped to a board that cannot show the issue: the issue
 * opens on GitHub instead (`openExternal`, the caller's session shell). An invalid reference opens
 * nothing.
 */
export function openIssueOnBoard(
  projectId: string,
  ref: IssueRef,
  boardShowsIssues: boolean,
  openExternal: (url: string) => void
): void {
  if (!boardShowsIssues) {
    const url = issueUrl(ref)
    if (url) openExternal(url)
    return
  }
  const vm = useViewMode.getState()
  if (projectId && !isKanbanOpen(projectId)) vm.toggle(projectId)
  useViewMode.getState().requestIssue(ref)
}
