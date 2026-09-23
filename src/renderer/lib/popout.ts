/**
 * Pop-out project windows — the pure decisions (docs/popout-windows.md).
 *
 * A pop-out shows ONE project in its own OS window. The main window keeps a ghosted tab for it
 * (click = bring that window forward) and never edits it; the pop-out can never switch away from
 * it. Everything that decides "may this tab be torn off", "what does the main canvas show once it
 * is", and "was that drag a tear-off or a reorder" lives here, so TabBar and Canvas only wire.
 */
import type { Project } from '@shared/types'

export type PopoutRefusal =
  | 'browser' // Server Edition / a browser tab: no app windows to spawn
  | 'popout' // already inside a pop-out: one project per window, no nesting
  | 'relay' // a relay tab is a live view of another machine, not a workspace here
  | 'unavailable' // a greyed placeholder has no canvas to show
  | 'closed' // a parked project is reopened first, not torn off
  | 'detached' // already in its own window — focus it instead

export interface PopoutContext {
  browser: boolean
  /** True inside a pop-out window (this renderer already owns one project). */
  popout: boolean
  detached: ReadonlySet<string>
}

/** Why `project` cannot be torn off right now, or null when it can. */
export function popoutRefusal(
  project: Pick<Project, 'id' | 'remote' | 'unavailable' | 'closed'>,
  ctx: PopoutContext
): PopoutRefusal | null {
  if (ctx.browser) return 'browser'
  if (ctx.popout) return 'popout'
  if (ctx.detached.has(project.id)) return 'detached'
  if (project.remote) return 'relay'
  if (project.unavailable) return 'unavailable'
  if (project.closed) return 'closed'
  return null
}

/**
 * Which project the MAIN canvas shows once `id` leaves for its own window: the nearest open,
 * not-detached neighbour in tab order (searching outward, the rule `closeProject` uses), or ''
 * for the start screen. Unchanged when `id` was not the active project.
 */
export function nextActiveAfterDetach(
  projects: readonly Pick<Project, 'id' | 'closed'>[],
  activeProjectId: string,
  id: string,
  detached: ReadonlySet<string>
): string {
  if (activeProjectId !== id) return activeProjectId
  const index = projects.findIndex((p) => p.id === id)
  const candidates = projects
    .map((p, i) => ({ id: p.id, d: Math.abs(i - index) }))
    .filter((c) => c.id !== id && !detached.has(c.id))
    .filter((c) => !projects.find((p) => p.id === c.id)?.closed)
    .sort((a, b) => a.d - b.d)
  return candidates[0]?.id ?? ''
}

export interface TabDragEnd {
  /** Pointer position at `dragend`, in the window's client space (negative / past the window
   *  size when released outside it — Chromium keeps reporting client coordinates). */
  clientX: number
  clientY: number
  /** The strip's own drop handlers ran (a reorder landed): never a tear-off. */
  handledByStrip: boolean
  /** The tab strip's bottom edge in client space (the `--tabbar-h` token). */
  stripBottom: number
  /** The window's client size — a release beyond it is a release outside the window. */
  innerWidth: number
  innerHeight: number
  /** The pointer left the window during the drag and did not come back (a document-level
   *  `dragleave` with no `relatedTarget`, cleared by the next `dragenter`). */
  leftWindow?: boolean
  /** Where the pointer last was INSIDE the window (the last document `dragover`), or null. */
  lastInside?: { x: number; y: number } | null
}

/**
 * Whether a finished tab drag was a TEAR-OFF. The strip's drop targets (another tab, the end
 * zone) reorder and mark the drag handled; anything else — the canvas below the strip, or outside
 * the window entirely — pops the project out, the way a browser tab dragged off its strip opens
 * a new window. A release INSIDE the strip that no target claimed (the brand area, a gap) is a
 * cancelled drag, not a tear-off: it is where a fumbled reorder ends, and popping a window there
 * would punish exactly the gesture the user was making.
 */
export function isTabTearOff(drag: TabDragEnd): boolean {
  if (drag.handledByStrip) return false
  // The coordinates on `dragend` are only reliable on macOS. Chromium on Linux (and, reportedly,
  // Windows) can report a release OUTSIDE the window as (0, 0) — inside the strip, i.e. a cancelled
  // drag, so the gesture this exists for would silently do nothing there. Two platform-neutral
  // signals come first: the pointer having left the window, and failing that, the last position the
  // document saw it at. (0, 0) itself is the brand logo corner, never a place anyone releases a tab.
  if (drag.leftWindow) return true
  const zero = drag.clientX === 0 && drag.clientY === 0
  const { clientX, clientY } = zero && drag.lastInside ? { clientX: drag.lastInside.x, clientY: drag.lastInside.y } : drag
  const { innerWidth, innerHeight, stripBottom } = drag
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
  const outsideWindow = clientX < 0 || clientY < 0 || clientX > innerWidth || clientY > innerHeight
  if (outsideWindow) return true
  return clientY > stripBottom
}

/**
 * Whether THIS window raises the alert (unread, chime, OS notification) for an agent event on
 * `nodeId`. Agent status reaches every app window, so each keeps the state bookkeeping, but only
 * the window that shows the node interrupts the user: otherwise a popped-out node chimes twice and
 * the main window marks unread a finish the user watched in the pop-out. A node no project knows
 * yet (spawned since the last commit) is the active canvas's, i.e. this window's.
 */
export function alertsHere(
  projects: readonly Pick<Project, 'id' | 'nodes'>[],
  nodeId: string,
  ownsHere: (projectId: string) => boolean
): boolean {
  const owner = projects.find((p) => p.nodes.some((n) => n.id === nodeId))
  return !owner || ownsHere(owner.id)
}
