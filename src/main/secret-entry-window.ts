// The window a person pastes a project secret into (docs/project-secrets.md, "Pasted secrets").
//
// Why a window of its own rather than a field in the Secrets dialog: the canvas window renders agent
// output, web pages and markdown, and holds every other renderer feature; the rule "the canvas never
// sees a value" keeps it out of the one place a value can be read from. This window is a separate
// webContents with a sandboxed renderer, its own tiny preload (four channels), no devtools, no
// navigation, no pop-ups, no spellcheck, and an IN-MEMORY session (`partition` without `persist:`),
// so Chromium writes nothing of it to disk. It is modal to the main window and closes the moment a
// value is accepted.
//
// What it cannot promise: the typed text exists as a JS string in this window's renderer until the
// window is destroyed (a string cannot be zeroed), and a value copied to the clipboard stays there
// (and in Windows clipboard history, when it is on) — the person's clipboard is theirs.

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { SECRET_PASTE_MAX_CHARS } from '../shared/project-secrets'
import { normalizePasted } from '../core/project-secrets'

export interface SecretEntryRequest {
  parent: BrowserWindow
  projectName: string
  env: string
  /** Why a candidate is refused (shown in the window, which stays open), or null to accept it. */
  check: (value: Buffer) => string | null
}

/** What the paste window is told. Names only. */
export interface SecretEntryInit {
  projectName: string
  env: string
}

let open: BrowserWindow | null = null

/** Resolves the accepted value (a Buffer the caller owns), or null when the person cancels or
 *  closes the window. One window at a time: a second request while one is open resolves null. */
export function promptSecretEntry(req: SecretEntryRequest): Promise<Buffer | null> {
  if (open && !open.isDestroyed()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: req.parent,
      modal: true,
      width: 480,
      height: 260,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: 'Paste secret',
      show: false,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        preload: join(__dirname, '../preload/secret-entry.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: false,
        webviewTag: false,
        // No `persist:` prefix: an in-memory session, nothing of this window reaches the disk.
        partition: 'nodeterm-secret-entry'
      }
    })
    open = win
    win.setMenu(null)
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) {
        value?.fill(0)
        return
      }
      settled = true
      ipcMain.removeListener(IPC.secretEntrySubmit, onSubmit)
      ipcMain.removeListener(IPC.secretEntryCancel, onCancel)
      if (open === win) open = null
      if (!win.isDestroyed()) win.destroy()
      resolve(value)
    }
    const fromWin = (event: IpcMainEvent): boolean => !win.isDestroyed() && event.sender.id === win.webContents.id
    const onSubmit = (event: IpcMainEvent, raw: unknown): void => {
      if (!fromWin(event)) return
      if (typeof raw !== 'string' || raw.length > SECRET_PASTE_MAX_CHARS) {
        event.sender.send(IPC.secretEntryError, 'the value is too long')
        return
      }
      const input = Buffer.from(raw, 'utf8')
      const value = normalizePasted(input)
      input.fill(0)
      const problem = req.check(value)
      if (problem) {
        value.fill(0)
        event.sender.send(IPC.secretEntryError, problem)
        return
      }
      finish(value)
    }
    const onCancel = (event: IpcMainEvent): void => {
      if (fromWin(event)) finish(null)
    }
    ipcMain.on(IPC.secretEntrySubmit, onSubmit)
    ipcMain.on(IPC.secretEntryCancel, onCancel)
    win.on('closed', () => finish(null))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      const init: SecretEntryInit = { projectName: req.projectName, env: req.env }
      win.webContents.send(IPC.secretEntryInit, init)
    })
    // Shown only in answer to the person's click on "Paste value…" in the Secrets dialog.
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const load = devUrl
      ? win.loadURL(`${devUrl}/secret-entry.html`)
      : win.loadFile(join(__dirname, '../renderer/secret-entry.html'))
    load.catch(() => finish(null))
  })
}
