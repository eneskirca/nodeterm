// The window a person pastes a project secret into (docs/project-secrets.md). Electron is faked:
// what is pinned here is main's side of the contract — which sender it listens to, what it does with
// a refused and an accepted value, and the window's isolation settings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...a: unknown[]) => void
const ipcListeners = vi.hoisted(() => new Map<string, Set<(...a: unknown[]) => void>>())
const created = vi.hoisted(() => [] as FakeWin[])

interface FakeWin {
  options: { webPreferences: Record<string, unknown>; parent: unknown; modal: boolean }
  destroyed: boolean
  shown: boolean
  sent: [string, unknown][]
  events: Map<string, Listener[]>
  wcEvents: Map<string, Listener[]>
  webContents: { id: number; send: (ch: string, p: unknown) => void; on: (ev: string, fn: Listener) => void; setWindowOpenHandler: (fn: () => unknown) => void; openHandler?: () => unknown }
}

vi.mock('electron', () => {
  class BrowserWindow {
    private w: FakeWin
    constructor(options: FakeWin['options']) {
      const w: FakeWin = {
        options,
        destroyed: false,
        shown: false,
        sent: [],
        events: new Map(),
        wcEvents: new Map(),
        webContents: {
          id: 100 + created.length,
          send: (ch, p) => w.sent.push([ch, p]),
          on: (ev, fn) => w.wcEvents.set(ev, [...(w.wcEvents.get(ev) ?? []), fn]),
          setWindowOpenHandler(fn) {
            w.webContents.openHandler = fn
          }
        }
      }
      created.push(w)
      this.w = w
    }
    get webContents() {
      return this.w.webContents
    }
    setMenu() {}
    isDestroyed() {
      return this.w.destroyed
    }
    destroy() {
      this.w.destroyed = true
      for (const fn of this.w.events.get('closed') ?? []) fn()
    }
    show() {
      this.w.shown = true
    }
    on(ev: string, fn: Listener) {
      this.w.events.set(ev, [...(this.w.events.get(ev) ?? []), fn])
    }
    once(ev: string, fn: Listener) {
      this.on(ev, fn)
    }
    loadFile() {
      return Promise.resolve()
    }
    loadURL() {
      return Promise.resolve()
    }
  }
  return {
    BrowserWindow,
    ipcMain: {
      on: (ch: string, fn: Listener) => {
        if (!ipcListeners.has(ch)) ipcListeners.set(ch, new Set())
        ipcListeners.get(ch)!.add(fn)
      },
      removeListener: (ch: string, fn: Listener) => ipcListeners.get(ch)?.delete(fn)
    }
  }
})

import { IPC } from '../shared/ipc'
import { promptSecretEntry } from './secret-entry-window'

const emit = (ch: string, senderId: number, ...args: unknown[]): void => {
  const sender = { id: senderId, send: (c: string, p: unknown) => last().sent.push([c, p]) }
  for (const fn of [...(ipcListeners.get(ch) ?? [])]) fn({ sender }, ...args)
}
const last = (): FakeWin => created[created.length - 1]
const parent = {} as never
const check = (v: Buffer): string | null => (v.length === 0 ? 'the value is empty' : v.includes(0x0a) ? 'the value is more than one line' : null)

describe('promptSecretEntry', () => {
  beforeEach(() => {
    ipcListeners.clear()
    created.length = 0
  })
  // A window left open by a test would refuse the next prompt (one window at a time).
  afterEach(() => {
    for (const w of created) if (!w.destroyed) for (const fn of w.events.get('closed') ?? []) fn()
  })

  it('opens an isolated, modal window: sandboxed, no devtools, no spellcheck, an in-memory session', () => {
    void promptSecretEntry({ parent, projectName: 'Repo', env: 'API_TOKEN', check })
    const w = last()
    expect(w.options.modal).toBe(true)
    expect(w.options.parent).toBe(parent)
    expect(w.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      webviewTag: false
    })
    expect(String(w.options.webPreferences.partition)).not.toMatch(/^persist:/)
    expect(w.webContents.openHandler?.()).toEqual({ action: 'deny' })
  })

  it('tells the window only the project and variable names', () => {
    void promptSecretEntry({ parent, projectName: 'Repo', env: 'API_TOKEN', check })
    for (const fn of last().wcEvents.get('did-finish-load') ?? []) fn()
    expect(last().sent).toEqual([[IPC.secretEntryInit, { projectName: 'Repo', env: 'API_TOKEN', replacing: false }]])
  })

  it('ignores a value from any other sender', async () => {
    const p = promptSecretEntry({ parent, projectName: 'Repo', env: 'API_TOKEN', check })
    emit(IPC.secretEntrySubmit, 1, 'dummy-from-elsewhere')
    expect(last().destroyed).toBe(false)
    emit(IPC.secretEntryCancel, last().webContents.id)
    expect(await p).toBeNull()
  })

  it('a refused value keeps the window open and says why; an accepted one closes it', async () => {
    const p = promptSecretEntry({ parent, projectName: 'Repo', env: 'API_TOKEN', check })
    const id = last().webContents.id
    emit(IPC.secretEntrySubmit, id, 'two\nlines')
    expect(last().destroyed).toBe(false)
    expect(last().sent).toContainEqual([IPC.secretEntryError, 'the value is more than one line'])
    emit(IPC.secretEntrySubmit, id, 'dummy-pasted-value-123\r\n')
    const v = await p
    expect(v?.toString('utf8')).toBe('dummy-pasted-value-123')
    expect(last().destroyed).toBe(true)
    // Listeners are gone: a late submit reaches nobody.
    expect(ipcListeners.get(IPC.secretEntrySubmit)?.size ?? 0).toBe(0)
  })

  it('closing the window is a cancel, and only one window opens at a time', async () => {
    const p = promptSecretEntry({ parent, projectName: 'Repo', env: 'API_TOKEN', check })
    expect(await promptSecretEntry({ parent, projectName: 'Repo', env: 'OTHER', check })).toBeNull()
    expect(created).toHaveLength(1)
    for (const fn of last().events.get('closed') ?? []) fn()
    expect(await p).toBeNull()
  })
})
