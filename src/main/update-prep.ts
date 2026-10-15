// Prepare-for-update (Windows session host, issue #829) — the desktop main-process leg. Three raw
// ipcMain handlers, each refusing any sender that is not the live main window: a `<webview>` guest
// is a webContents in this process too, and this ends every session on the machine. Not on the
// platform table, so no relay peer and no Server Edition browser can reach them (they are also in
// HOST_ONLY_CHANNELS as a belt).
//
// The only thing that ever stops the host here is the host's own `shutdown` command, and only on a
// host that advertised it. There is deliberately no taskkill/name-based fallback: a host started by
// an older build answers `host-unsupported`, and the renderer shows the manual steps.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { UpdatePrepInspection, UpdatePrepShutdown } from '../shared/update-prep'
import {
  sessionHostInspectForUpdate,
  sessionHostShutdownForUpdate,
  sessionHostSupported
} from '../core/session-host-backend'
import { mirrorEntry, pendingTicketsFor } from '../core/agent-status-mirror'

export interface UpdatePrepDeps {
  mainWebContents: () => { id?: number } | undefined
  /** `settings.tmuxEnabled` — off means no persistent backend, so no session host is in use. */
  persistentSessions: () => boolean
  /** Quit without the quit confirmation (the user already confirmed in the prepare dialog). */
  quit: () => void
  platform?: NodeJS.Platform
}

/** Is the session host the backend this app runs local terminals on? Pure for tests. */
export function updatePrepApplies(d: {
  platform: NodeJS.Platform
  persistentSessions: boolean
  bundleAvailable: boolean
}): boolean {
  return d.platform === 'win32' && d.persistentSessions && d.bundleAvailable
}

export function registerUpdatePrepIpc(deps: UpdatePrepDeps): void {
  const fromMain = (event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    deps.mainWebContents()?.id === event.sender.id
  const applies = (): boolean =>
    updatePrepApplies({
      platform: deps.platform ?? process.platform,
      persistentSessions: deps.persistentSessions(),
      bundleAvailable: sessionHostSupported()
    })

  ipcMain.handle(IPC.appUpdatePrepInspect, async (event): Promise<UpdatePrepInspection> => {
    if (!fromMain(event) || !applies()) return { kind: 'unsupported' }
    try {
      const inspection = await sessionHostInspectForUpdate()
      if (!inspection.running) return { kind: 'no-host' }
      const mirror: Record<string, { state?: string; attention: boolean }> = {}
      for (const session of inspection.sessions) {
        if (!session.startsWith('nt-')) continue
        const nodeId = session.slice(3)
        const entry = mirrorEntry(nodeId)
        mirror[session] = {
          state: entry?.state,
          attention: !!entry?.pendingQuestion || pendingTicketsFor(nodeId).length > 0
        }
      }
      return {
        kind: 'host',
        sessions: inspection.sessions,
        shutdownSupported: inspection.shutdown,
        mirror,
        staged: inspection.staging === 'staged'
      }
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.appUpdatePrepShutdown, async (event): Promise<UpdatePrepShutdown> => {
    if (!fromMain(event) || !applies()) return { kind: 'unsupported' }
    try {
      const outcome = await sessionHostShutdownForUpdate()
      return outcome.kind === 'unsupported' ? { kind: 'host-unsupported' } : outcome
    } catch (error) {
      return { kind: 'unconfirmed', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on(IPC.appUpdatePrepQuit, (event) => {
    if (!fromMain(event)) return
    deps.quit()
  })
}
