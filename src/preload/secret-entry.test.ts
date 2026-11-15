import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: () => undefined }, ipcRenderer: { on: () => undefined, send: () => undefined } }))

import { IPC } from '../shared/ipc'
import { SECRET_ENTRY_CHANNELS } from './secret-entry'

describe('secret-entry preload', () => {
  it('uses the same channel names as main', () => {
    expect(SECRET_ENTRY_CHANNELS).toEqual({
      init: IPC.secretEntryInit,
      error: IPC.secretEntryError,
      submit: IPC.secretEntrySubmit,
      cancel: IPC.secretEntryCancel
    })
  })

  it('imports nothing but electron (a sandboxed preload cannot load another file)', () => {
    const src = readFileSync(join(__dirname, 'secret-entry.ts'), 'utf8')
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports).toEqual(['electron'])
  })
})
