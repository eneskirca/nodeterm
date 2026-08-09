import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { IPC } from '../shared/ipc'
import {
  ElectronGitHubSecretStore,
  registerElectronGitHubControl,
  type SafeStorageLike
} from './github-control'

let userDataDir: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-electron-github-secret-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

function safeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'keychain',
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
    decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, '')
  }
}

describe('ElectronGitHubSecretStore', () => {
  it('encrypts a token and reads it only inside the host', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    await store.save('github_pat_secret')

    const raw = await fs.readFile(path.join(userDataDir, 'github-issues-token.json'), 'utf-8')
    expect(raw).not.toContain('github_pat_secret')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, kind: 'safe-storage' })
    expect(await store.readForHost()).toBe('github_pat_secret')
    expect(store.availability).toBe('encrypted')
  })

  it('uses a restricted 0600 file for basic_text and reports the warning state', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage({ backend: 'basic_text' }))
    await store.save('github_pat_secret')

    expect(store.availability).toBe('restricted-file')
    expect((await fs.stat(path.join(userDataDir, 'github-issues-token.json'))).mode & 0o777).toBe(0o600)
    expect(await store.readForHost()).toBe('github_pat_secret')
  })

  it('does not overwrite an encrypted token while the keyring is locked', async () => {
    const unlocked = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    await unlocked.save('original-token')
    const before = await fs.readFile(path.join(userDataDir, 'github-issues-token.json'), 'utf-8')

    const locked = new ElectronGitHubSecretStore(userDataDir, safeStorage({ available: false }))
    await expect(locked.save('replacement-token')).rejects.toMatchObject({ code: 'keyring-locked' })
    expect(await fs.readFile(path.join(userDataDir, 'github-issues-token.json'), 'utf-8')).toBe(before)
    expect(await locked.readForHost()).toBeNull()
  })

  it('clears only the stored token file', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    await store.save('github_pat_secret')
    await store.clear()
    expect(await store.readForHost()).toBeNull()
  })
})

describe('registerElectronGitHubControl', () => {
  it('accepts only the current local main window and wires every control action', async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: any[]) => unknown>()
    const view = {
      control: { revision: 0, authProvider: 'auto' as const },
      auth: {
        selectedProvider: 'auto' as const,
        activeProvider: null,
        ghAuthenticated: false,
        tokenPresent: false,
        storage: 'encrypted' as const
      }
    }
    const controller = {
      status: vi.fn(async () => view),
      approve: vi.fn(async () => view),
      revoke: vi.fn(async () => view),
      selectProvider: vi.fn(async () => view),
      saveToken: vi.fn(async () => view),
      clearToken: vi.fn(async () => view)
    }
    registerElectronGitHubControl(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      () => 7,
      controller
    )
    expect([...handlers.keys()].sort()).toEqual([
      IPC.githubControlApprove,
      IPC.githubControlClearToken,
      IPC.githubControlRevoke,
      IPC.githubControlSaveToken,
      IPC.githubControlSelectProvider,
      IPC.githubControlStatus
    ].sort())
    await expect(Promise.resolve().then(() =>
      handlers.get(IPC.githubControlStatus)!({ sender: { id: 8 } }, 'p1')))
      .rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    await expect(handlers.get(IPC.githubControlStatus)!({ sender: { id: 7 } }, 'p1'))
      .resolves.toEqual(view)
    expect(controller.status).toHaveBeenCalledWith('p1')
  })
})
