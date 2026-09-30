import { platform } from '../core/platform'
import type { CanvasAuthority } from '../core/canvas-authority'
import type { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceWatcher } from '../core/workspace-watcher'
import { IPC } from '../shared/ipc'
import type { Project } from '../shared/types'

type WatchedWorkspaceStore = Pick<
  WorkspaceStore,
  'localRefPaths' | 'isSelfWrite' | 'readLocalRefByPath'
>

export interface ServerWorkspaceWatcherOptions {
  debounceMs?: number
  publish?: (project: Project) => void
}

/**
 * Give Server Edition the desktop's live hand-edit path without importing Electron: the shared
 * watcher identifies a genuine outside write, WorkspaceStore adopts the complete project, and the
 * existing workspace broadcast replaces the browser's clean canvas wholesale. A full Project is
 * intentional here — unlike `canvas:mut`, it carries bridge and rope removals as well as nodes.
 */
export function createServerWorkspaceWatcher(
  store: WatchedWorkspaceStore,
  options: ServerWorkspaceWatcherOptions = {}
): WorkspaceWatcher {
  const publish = options.publish ?? ((project: Project) => {
    platform().broadcast(IPC.workspaceExternalChange, project)
  })
  const watcher = new WorkspaceWatcher({
    paths: () => store.localRefPaths(),
    isSelfWrite: (filePath, content) => store.isSelfWrite(filePath, content),
    onExternalChange: (filePath) => {
      void store.readLocalRefByPath(filePath)
        .then((changed) => {
          if (changed) publish(changed)
        })
        .catch((error) => {
          console.warn('[nodeterm-server] external workspace edit could not be adopted', error)
        })
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
  })
  watcher.sync()
  return watcher
}

/**
 * Where a genuine outside edit (a git pull, a hand edit) goes. A project the canvas authority
 * governs is ADOPTED by it, and its content reaches every client as canvas ops
 * (docs/hosted-team-relay.md). It is NOT also broadcast as `workspace:external-change`: that event
 * raises the Reload/Keep-mine conflict bar on a dirty canvas, and "Keep mine" would write a stale
 * copy over the shared project. Every other project keeps the whole-project broadcast. `authority`
 * is read on every edit (it is created later in boot, and absent when another server owns this data
 * directory).
 *
 * The ops carry only the content. The edit's other fields (name, colour, icon, layouts, the
 * permission default, the capability flags, the board's `github` mapping and `pullLinks`) follow as
 * the persisted project on `workspace:server-change` (`serverChange`), the channel and three-way
 * merge server canvas control already uses: the renderer adopts it without a conflict bar, so a tab
 * that still held the old copy saves the pulled values instead of writing its own back. Some of
 * those fields are security-relevant (a pull that drops a `bypassPermissions` default or turns a
 * capability off must not be undone by the next autosave). The ops go out first, so a client
 * merging the project already holds its content.
 *
 * An edit the authority could not turn into ops is NOT swallowed (N5). With no baseline held before
 * it (the file was unreadable until this edit, say a pull that resolved conflict markers) the
 * adoption reads the edited file itself and finds no difference, so the project goes out WHOLE on
 * `workspace:external-change`, as for an ungoverned project: the clients hold content the authority
 * never saw, so only the whole project can bring them up to date, and that channel reloads a clean
 * canvas. Its conflict bar is safe here: the project is adopted now, so a "Keep mine" save is
 * overlaid and cannot write stale content back. When nothing adopted it at all (still unreadable, or
 * no longer governed), the raw project goes out exactly as for an ungoverned one.
 */
export function outsideEditPublisher(
  authority: () => Pick<CanvasAuthority, 'governs' | 'adoptOutsideEdit'> | null,
  broadcast: (project: Project) => void,
  serverChange: (project: Project) => void
): (project: Project) => void {
  return (project) => {
    const a = authority()
    if (a?.governs(project.id)) {
      void a
        .adoptOutsideEdit(project)
        .then((adopted) => {
          if (!adopted) broadcast(project)
          else if (adopted.asOps) serverChange(adopted.project)
          else broadcast(adopted.project)
        })
        .catch((error: unknown) => {
          console.warn('[nodeterm-server] the canvas authority could not adopt an outside edit', error)
        })
      return
    }
    broadcast(project)
  }
}
