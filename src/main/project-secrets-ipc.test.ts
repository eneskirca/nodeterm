import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0 })))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  dialog: { showMessageBox }
}))

import { IPC } from '../shared/ipc'
import { confirmText, readDeclarationsFrom, registerProjectSecretsIpc } from './project-secrets-ipc'

const MAIN = 7
function workspace(over: Partial<Record<string, unknown>> = {}) {
  return {
    projectTargetInfo: (id: string) => (id === 'p1' ? { cwd: '/repo', name: 'Repo' } : null),
    readProjectSettings: async () => ({
      shared: { version: 1 as const, rev: 1, savedAt: '', agents: { secrets: [{ env: 'API_TOKEN', command: ['print-token'] }] } },
      local: undefined
    }),
    openProjectFolders: () => new Map([['p1', '/repo']]),
    onSaved: () => () => undefined,
    ...over
  } as never
}

describe('readDeclarationsFrom', () => {
  it('reads the declarations with their source from this process\'s own index', async () => {
    expect(await readDeclarationsFrom(workspace(), 'p1')).toEqual({
      kind: 'ok',
      cwd: '/repo',
      secrets: [{ decl: { env: 'API_TOKEN', command: ['print-token'] }, source: 'shared' }]
    })
  })
  it('refuses an SSH project, a cwd-less canvas and an unknown project by name', async () => {
    const ws = (info: unknown) => workspace({ projectTargetInfo: () => info })
    expect(await readDeclarationsFrom(ws({ ssh: {}, name: 'x' }), 'p1')).toEqual({ kind: 'unavailable', reason: 'ssh' })
    expect(await readDeclarationsFrom(ws({ name: 'x' }), 'p1')).toEqual({ kind: 'unavailable', reason: 'no-folder' })
    expect(await readDeclarationsFrom(ws(null), 'p1')).toEqual({ kind: 'unavailable', reason: 'unknown-project' })
  })
})

describe('confirmText — the native confirmation lists exactly what will run', () => {
  it('names every variable and command, and warns when the file is shared', () => {
    const t = confirmText('Repo', [{ decl: { env: 'API_TOKEN', command: ['op', 'read', 'op://a b'] }, source: 'shared' }])
    expect(t.message).toContain('Repo')
    expect(t.detail).toContain('API_TOKEN  ←  op read "op://a b"')
    expect(t.detail).toContain('shared with everyone who has the repository')
    expect(t.detail).toContain('never written to disk')
  })
})

describe('registerProjectSecretsIpc', () => {
  beforeEach(() => {
    handlers.clear()
    showMessageBox.mockClear()
  })
  const win = { isDestroyed: () => false, webContents: { id: MAIN, send: vi.fn() } }

  it('refuses any sender that is not the main window, before asking anyone', async () => {
    registerProjectSecretsIpc({ workspace: workspace(), settings: () => ({ projectSecretsCrossProject: 'deny' }), mainWindow: () => win as never })
    const r = await handlers.get(IPC.projectSecretsAuthorize)!({ sender: { id: 99 } }, 'p1')
    expect(r).toMatchObject({ kind: 'refused', reason: 'unsupported' })
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('runs nothing when the person answers Cancel in the native confirmation', async () => {
    const svc = registerProjectSecretsIpc({ workspace: workspace(), settings: () => ({ projectSecretsCrossProject: 'deny' }), mainWindow: () => win as never })
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const r = await handlers.get(IPC.projectSecretsAuthorize)!({ sender: { id: MAIN } }, 'p1')
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ kind: 'cancelled' })
    expect(svc.holdsAny()).toBe(false)
  })

  it('the native dialog defaults to Cancel', async () => {
    registerProjectSecretsIpc({ workspace: workspace(), settings: () => ({ projectSecretsCrossProject: 'deny' }), mainWindow: () => win as never })
    await handlers.get(IPC.projectSecretsAuthorize)!({ sender: { id: MAIN } }, 'p1')
    const opts = (showMessageBox.mock.calls[0] as unknown[])[1] as { defaultId: number; cancelId: number; buttons: string[] }
    expect(opts.buttons[opts.defaultId]).toBe('Cancel')
    expect(opts.cancelId).toBe(opts.defaultId)
  })
})
