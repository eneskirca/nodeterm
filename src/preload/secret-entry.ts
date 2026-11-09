// Preload of the window a person pastes a project secret into (src/main/secret-entry-window.ts).
// Four channels and nothing else: it never gets `window.nodeTerminal`. Sandboxed, contextIsolation.
//
// It imports NOTHING but 'electron': a sandboxed preload cannot require another file, and importing
// `@shared/ipc` makes the bundler move it into a shared chunk this preload would then fail to load
// (a blank window). The channel names are therefore written out here and pinned equal to IPC's by
// `secret-entry.test.ts`.

import { contextBridge, ipcRenderer } from 'electron'

export const SECRET_ENTRY_CHANNELS = {
  init: 'secret-entry:init',
  error: 'secret-entry:error',
  submit: 'secret-entry:submit',
  cancel: 'secret-entry:cancel'
} as const
const IPC = {
  secretEntryInit: SECRET_ENTRY_CHANNELS.init,
  secretEntryError: SECRET_ENTRY_CHANNELS.error,
  secretEntrySubmit: SECRET_ENTRY_CHANNELS.submit,
  secretEntryCancel: SECRET_ENTRY_CHANNELS.cancel
}

export interface SecretEntryInitPayload {
  projectName: string
  env: string
  /** A value is already held for this name: the window says the paste replaces it. */
  replacing?: boolean
}

export interface SecretEntryApi {
  /** Called once main says which project and variable this window asks for. */
  onInit(cb: (init: SecretEntryInitPayload) => void): void
  /** Called when main refuses a value (the window stays open). */
  onError(cb: (message: string) => void): void
  submit(value: string): void
  cancel(): void
}

let init: SecretEntryInitPayload | null = null
let initCb: ((init: SecretEntryInitPayload) => void) | null = null

ipcRenderer.on(IPC.secretEntryInit, (_e, payload: unknown) => {
  const p = payload as Partial<SecretEntryInitPayload> | null
  if (!p || typeof p.projectName !== 'string' || typeof p.env !== 'string') return
  init = { projectName: p.projectName, env: p.env, replacing: p.replacing === true }
  initCb?.(init)
})

const api: SecretEntryApi = {
  onInit(cb) {
    initCb = cb
    if (init) cb(init)
  },
  onError(cb) {
    ipcRenderer.on(IPC.secretEntryError, (_e, message: unknown) => {
      if (typeof message === 'string') cb(message)
    })
  },
  submit(value) {
    ipcRenderer.send(IPC.secretEntrySubmit, typeof value === 'string' ? value : '')
  },
  cancel() {
    ipcRenderer.send(IPC.secretEntryCancel)
  }
}

contextBridge.exposeInMainWorld('secretEntry', api)
