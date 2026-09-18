// Pop-out project windows: one project torn off the tab strip into its own OS window.
//
// Electron-free, like main-window.ts — a structural view of BrowserWindow so the ownership rules
// below can be pressed by a test. The Electron half (creating the window, its close/flush
// handshake, the IPC handlers) lives in index.ts next to `createWindow`.
//
// THE RULE: a project is shown by exactly one window at a time. The main window owns every project
// except the ones registered here; a pop-out owns exactly one. That ownership is what `saveScopeFor`
// hands the workspace store (core/workspace-scope.ts) so a window can only ever WRITE what it
// owns — the whole reason two renderers can share one workspace without overwriting each other.
// Full write-up: docs/popout-windows.md.
import type { SaveScope } from '../core/workspace-scope'
import { getMainWindow, sendToMain, type MainWindowLike } from './main-window'

export interface PopoutWindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  close(): void
  on(event: 'closed', cb: () => void): void
  webContents: { id: number; send(channel: string, ...args: unknown[]): void }
}

const byProject = new Map<string, PopoutWindowLike>()
const changeListeners = new Set<(ids: string[]) => void>()

function notifyChange(): void {
  const ids = detachedProjectIds()
  for (const cb of changeListeners) cb(ids)
}

/** Track a freshly created pop-out for `projectId`. A late `closed` from a REPLACED window must
 *  not unregister its successor (same guard as setMainWindow). */
export function registerPopout(projectId: string, win: PopoutWindowLike): void {
  byProject.set(projectId, win)
  win.on('closed', () => {
    if (byProject.get(projectId) === win) {
      byProject.delete(projectId)
      notifyChange()
    }
  })
  notifyChange()
}

/** The live pop-out showing `projectId`, or null (none, or destroyed). */
export function popoutForProject(projectId: string): PopoutWindowLike | null {
  const win = byProject.get(projectId)
  return win && !win.isDestroyed() ? win : null
}

/** The project a webContents id shows, if that id is a pop-out. */
export function popoutProjectOf(webContentsId: number): string | null {
  for (const [projectId, win] of byProject) {
    if (!win.isDestroyed() && win.webContents.id === webContentsId) return projectId
  }
  return null
}

/** Project ids currently shown in their own windows, in registration order. */
export function detachedProjectIds(): string[] {
  const ids: string[] = []
  for (const [projectId, win] of byProject) if (!win.isDestroyed()) ids.push(projectId)
  return ids
}

/** The pop-outs' webContents ids — joined to `mainWindowClientIds()` for CorePlatform.clientIds().
 *  A pop-out MUST count as an attached client: the pty manager decides "attached" against that
 *  list, and a subscriber missing from it reads as detached to the session reaper. */
export function popoutClientIds(): number[] {
  const ids: number[] = []
  for (const win of byProject.values()) if (!win.isDestroyed()) ids.push(win.webContents.id)
  return ids
}

export function sendToPopouts(channel: string, ...args: unknown[]): void {
  for (const win of byProject.values()) if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Every app window — the main window plus each pop-out. For the channels that carry PER-NODE
 *  facts (agent status, unread clears, external changes): a node lives in whichever window shows
 *  its project, and the sender does not know which. Resolved at send time, like sendToMain. */
export function sendToAppWindows(channel: string, ...args: unknown[]): void {
  sendToMain(channel, ...args)
  sendToPopouts(channel, ...args)
}

/** The window that shows `projectId`: its pop-out, else the main window. `null` while the main
 *  window is closed (macOS) and the project is not popped out. */
export function windowShowingProject(projectId: string | undefined): PopoutWindowLike | MainWindowLike | null {
  if (projectId) {
    const popout = popoutForProject(projectId)
    if (popout) return popout
  }
  return getMainWindow()
}

/** Subscribe to the set of popped-out projects changing (register / closed). */
export function onDetachedChange(cb: (ids: string[]) => void): () => void {
  changeListeners.add(cb)
  return () => {
    changeListeners.delete(cb)
  }
}

/**
 * The workspace-save scope for a sender: a pop-out owns its one project; ANY other sender owns
 * everything except the popped-out ones. "Any other" rather than "the main window only" on
 * purpose — a relay peer's `workspace.save` (a guest editing the host's canvas) must not be able
 * to write a project a pop-out is editing either, and an unknown sender treated as unscoped would
 * be exactly the stale-copy overwrite the scope exists to prevent. With no pop-out open the main
 * scope's `detached` is empty, which the store treats as owning everything: byte-identical saves.
 */
export function saveScopeFor(senderId: number): SaveScope {
  const own = popoutProjectOf(senderId)
  if (own) return { kind: 'popout', projectId: own }
  return { kind: 'main', detached: detachedProjectIds() }
}

/** Test seam: forget every registration (a destroyed window is already gone by its own event). */
export function resetPopoutsForTests(): void {
  byProject.clear()
  changeListeners.clear()
}
