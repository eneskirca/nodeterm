import type { CorePlatform } from './platform'
import * as fsOps from './fs-ops'
import { saveUpload } from './uploads'
import { saveCanvasImage } from './canvas-images'
import { IPC } from '../shared/ipc'
import type { DownloadTicket } from '../shared/types'

/** The fs.* + files.quickOpen RPC surface, registered ONCE for every shell (Electron main, the
 *  Server Edition, and — through the Electron platform's handler table — a relay peer). The logic
 *  is already pure in core/fs-ops.ts; this is only the registration.
 *
 *  It lives here, and not in either shell, so the two can never drift: the desktop used to register
 *  these on raw `ipcMain`, which made them unreachable for a peer (a peer has no webContents).
 *  Threat model unchanged: whoever can reach these already has a terminal on this machine. */
export function registerFsHandlers(
  platform: CorePlatform,
  deps: {
    /**
     * Mint an HTTP download ticket for `path` — supplied ONLY by a shell that has an HTTP surface
     * to redeem it on (the Server Edition). Absent everywhere else, and the handler then answers
     * `null` rather than going unregistered: the renderer awaits this to decide whether to offer a
     * download at all, and an unregistered channel would reject instead, which reads as an error
     * rather than as "not offered here".
     */
    issueDownloadTicket?: (path: string) => Promise<DownloadTicket | null>
    /**
     * The project's LOCAL cwd, or undefined for an SSH project / relay tab / cwd-less canvas.
     * Injected rather than taken from the caller because the renderer sends only a `projectId`:
     * the write path is always derived here, from this shell's own workspace index, so a canvas
     * image can never be aimed at a directory the renderer names. (Same discipline as
     * `registerBoardLogHandlers` — see core/board-log-handlers.ts.) Absent ⇒ every project takes
     * the durable app-local fallback, which is a coherent degrade, not a failure.
     */
    localProjectCwd?: (projectId: string) => string | undefined
  } = {}
): void {
  platform.handle(IPC.fsList, (dirPath: string) => fsOps.listDir(dirPath))
  platform.handle(IPC.fsRead, (filePath: string) => fsOps.readText(filePath))
  platform.handle(IPC.fsReadBinary, (filePath: string) => fsOps.readBinary(filePath))
  platform.handle(IPC.fsWrite, (filePath: string, content: string) =>
    fsOps.writeText(filePath, content)
  )
  platform.handle(IPC.fsMkdir, (dirPath: string) => fsOps.makeDir(dirPath))
  platform.handle(IPC.fsExists, (p: string) => fsOps.pathExists(p))
  platform.handle(IPC.filesQuickOpen, (cwd: string) => fsOps.listQuickOpenFiles(cwd))
  // Bytes with no path on this machine (a clipboard paste, or a browser client's file) land in
  // the managed uploads dir so the terminal has something to name. See core/uploads.ts.
  platform.handle(IPC.filesSaveUpload, (name: string, dataBase64: string) =>
    saveUpload(platform.userDataDir, name, dataBase64)
  )
  // A canvas image node is persisted, so its bytes go somewhere equally durable — the project's
  // own `.nodeterm/images/` when it has one. See core/canvas-images.ts for the fallbacks.
  platform.handle(
    IPC.filesSaveCanvasImage,
    (projectId: string, name: string, dataBase64: string) =>
      saveCanvasImage({
        projectCwd: deps.localProjectCwd?.(projectId),
        userDataDir: platform.userDataDir,
        name,
        dataBase64
      })
  )
  platform.handle(IPC.filesDownloadTicket, (p: string) =>
    deps.issueDownloadTicket ? deps.issueDownloadTicket(p) : Promise.resolve(null)
  )
}
