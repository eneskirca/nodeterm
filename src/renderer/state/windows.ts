import { create } from 'zustand'
import { popoutProjectIdFromHash } from '@shared/popout-window'

/**
 * Which window THIS renderer is, and which projects live in other windows.
 *
 * Runtime-only, never persisted: window identity comes from the page hash main loaded the window
 * with (`@shared/popout-window`), and the detached set is a MIRROR of main's registry
 * (`windows.detached()` at boot, `windows.onDetachedChange` after) — main is the single authority,
 * because it is the process that owns the windows and scopes the saves. The renderer only asks.
 *
 * Read `popoutProjectId` through `isPopoutWindow()` / `popoutProjectId()` — module-level and
 * synchronous, because the projects store consults it inside `setActive` and a hook would be the
 * wrong shape there.
 */
interface WindowsState {
  /** The one project this window owns when it is a pop-out; null in the main window. */
  popoutProjectId: string | null
  /** Projects shown in their own windows (main window only; always empty inside a pop-out). */
  detached: ReadonlySet<string>
  setDetached(ids: readonly string[]): void
  /** Optimistic local mark while main creates the window — confirmed by the next `setDetached`. */
  markDetached(id: string): void
}

export const useWindows = create<WindowsState>((set) => ({
  popoutProjectId: typeof location === 'undefined' ? null : popoutProjectIdFromHash(location.hash),
  detached: new Set(),
  // Inside a pop-out the set is ALWAYS empty: main's registry lists every popped-out project, this
  // window's own included, and mirroring it would ghost the one tab the window exists to show.
  // A pop-out never ghosts anything — it owns exactly its project and knows of no others.
  setDetached: (ids) => set((s) => ({ detached: new Set(s.popoutProjectId === null ? ids : []) })),
  markDetached: (id) =>
    set((s) =>
      s.popoutProjectId !== null || s.detached.has(id) ? s : { detached: new Set([...s.detached, id]) }
    )
}))

export function isPopoutWindow(): boolean {
  return useWindows.getState().popoutProjectId !== null
}

export function popoutProjectId(): string | null {
  return useWindows.getState().popoutProjectId
}

/** Whether THIS window may edit `projectId`: a pop-out owns exactly its project, the main window
 *  everything not popped out. The renderer-side twin of core's `ownsProject` — used to ignore
 *  external-change broadcasts (which reach every window) for projects another window owns. */
export function ownsProjectHere(projectId: string): boolean {
  const { popoutProjectId: own, detached } = useWindows.getState()
  if (own !== null) return own === projectId
  return !detached.has(projectId)
}

/** Test seam: pretend this renderer is (or is not) a pop-out. */
export function setPopoutProjectIdForTests(id: string | null): void {
  useWindows.setState({ popoutProjectId: id })
}
