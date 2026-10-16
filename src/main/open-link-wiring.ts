// The Electron half of `nodeterm://` links: real fs/PATH/launch-prompt dependencies for the service
// in ./open-link, and its three raw ipcMain handlers. Raw ipcMain, never the platform handler
// table: no relay peer or Server Edition client may answer this machine's link sheet, and every
// handler refuses a sender that is not the main window (host-control lists the prefix too).

import { ipcMain } from 'electron'
import { constants as fsConstants } from 'fs'
import { open as fsOpen, stat } from 'fs/promises'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import { AGENT_CONFIG, type BuiltinAgentId } from '../shared/agents/config'
import { LAUNCH_PROMPT_FILE_PREFIX } from '../shared/launch-prompt'
import type { LinkProjectEntry } from '../shared/open-link'
import { findInLoginPath } from '../core/exec-path'
import { findAgy } from '../core/agents/hooks/antigravity'
import { saveUpload } from '../core/uploads'
import { getMainWindow, sendToMain } from './main-window'
import {
  createOpenLinkService,
  type OpenLinkChannel,
  type OpenLinkService,
  type PathKind,
  type ReadTextResult
} from './open-link'

const CHANNEL: Record<OpenLinkChannel, string> = {
  request: IPC.openLinkRequest,
  pair: IPC.openLinkPair,
  notice: IPC.openLinkNotice
}

export interface OpenLinkWiringDeps {
  userDataDir(): string
  /** The workspace index's projects, or undefined before it is loaded. */
  indexEntries(): LinkProjectEntry[] | undefined
  /** Load the index (only when it is not loaded yet). */
  loadIndex(): Promise<unknown>
  /** Bring the main window forward (a link click is a user action). */
  raise(): void
  /** `settings.allowOpenLinks`. */
  enabled(): boolean
}

async function statPath(p: string): Promise<{ kind: PathKind; size: number }> {
  try {
    const st = await stat(p)
    return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size }
  } catch {
    return { kind: 'missing', size: 0 }
  }
}

// O_NONBLOCK so opening a FIFO returns at once instead of parking a threadpool thread until a writer
// appears (POSIX only; Windows has no FIFOs at a path and Node defines no such flag there).
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)

/** Read at most `maxBytes + 1` bytes from ONE open, so an oversized file is detected without
 *  reading all of it. No stat beforehand: the handle that is read is the handle that is checked. */
async function readText(p: string, maxBytes: number): Promise<ReadTextResult> {
  let fh
  try {
    fh = await fsOpen(p, READ_FLAGS)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : code === 'EISDIR' ? { kind: 'not-file' } : { kind: 'error' }
  }
  try {
    if (!(await fh.stat()).isFile()) return { kind: 'not-file' }
    const buf = Buffer.alloc(maxBytes + 1)
    let filled = 0
    // A single read may return fewer bytes than asked; loop to EOF or the cap.
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return { kind: 'ok', text: buf.subarray(0, filled).toString('utf8') }
  } catch {
    return { kind: 'error' }
  } finally {
    await fh.close().catch(() => undefined)
  }
}

export function installOpenLinks(deps: OpenLinkWiringDeps): OpenLinkService {
  const service = createOpenLinkService({
    statPath,
    readText,
    storePrompt: (text) =>
      saveUpload(
        deps.userDataDir(),
        `${LAUNCH_PROMPT_FILE_PREFIX}link-${Date.now().toString(36)}.md`,
        Buffer.from(text, 'utf8').toString('base64')
      ),
    projects: async () => {
      const now = deps.indexEntries()
      if (now) return now
      await deps.loadIndex().catch(() => undefined)
      return deps.indexEntries() ?? []
    },
    agentInstalled: async (agent) => {
      const cfg = AGENT_CONFIG[agent as BuiltinAgentId]
      if (!cfg) return undefined
      const bin = cfg.launchCmd.trim().split(/\s+/)[0]
      if (!bin) return undefined
      if (await findInLoginPath(bin).catch(() => null)) return true
      if (agent === 'antigravity' && findAgy()) return true
      return false
    },
    send: (channel, payload) => sendToMain(CHANNEL[channel], payload),
    raise: () => deps.raise(),
    enabled: () => deps.enabled(),
    homeDir: () => homedir(),
    newId: () => randomUUID(),
    now: () => Date.now()
  })

  // The main window's top frame only: a subframe or a <webview> guest is another webContents/frame.
  const fromMainWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
    const win = getMainWindow()
    return !!win && event.sender.id === win.webContents.id && event.senderFrame === event.sender.mainFrame
  }

  ipcMain.on(IPC.openLinkReady, (event) => {
    if (!fromMainWindow(event)) return
    service.ready()
  })
  ipcMain.handle(IPC.openLinkAccept, async (event, msg: { id?: unknown; choice?: unknown }) => {
    if (!fromMainWindow(event)) return { ok: false, reason: 'Not allowed.' }
    return service.accept(msg?.id, msg?.choice)
  })
  ipcMain.on(IPC.openLinkCancel, (event, id: unknown) => {
    if (!fromMainWindow(event)) return
    service.cancel(id)
  })
  return service
}
