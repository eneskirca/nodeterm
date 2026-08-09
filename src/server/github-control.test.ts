import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import { ServerPlatform } from './platform-server'
import { registerServerGitHubControl, ServerGitHubSecretStore } from './github-control'

let userDataDir: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-server-github-secret-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('ServerGitHubSecretStore', () => {
  it('stores the token atomically at mode 0600 and reports restricted storage', async () => {
    const store = new ServerGitHubSecretStore(userDataDir)
    await store.save('github_pat_secret')

    expect(store.availability).toBe('restricted-file')
    expect(await store.readForHost()).toBe('github_pat_secret')
    expect((await fs.stat(path.join(userDataDir, 'github-issues-token.json'))).mode & 0o777).toBe(0o600)
    await expect(fs.access(path.join(userDataDir, 'github-issues-token.json.tmp'))).rejects.toThrow()
  })

  it('rejects empty or oversized token values without changing the stored token', async () => {
    const store = new ServerGitHubSecretStore(userDataDir)
    await store.save('original-token')
    await expect(store.save('')).rejects.toMatchObject({ code: 'invalid-token' })
    await expect(store.save('x'.repeat(4097))).rejects.toMatchObject({ code: 'invalid-token' })
    expect(await store.readForHost()).toBe('original-token')
  })
})

describe('registerServerGitHubControl', () => {
  it('registers control methods on the authenticated server RPC platform', async () => {
    const platform = new ServerPlatform({ userDataDir, appVersion: '0' })
    const controller = {
      status: vi.fn(async () => ({ action: 'status' })),
      approve: vi.fn(async () => ({ action: 'approve' })),
      revoke: vi.fn(async () => ({ action: 'revoke' })),
      selectProvider: vi.fn(async () => ({ action: 'provider' })),
      saveToken: vi.fn(async () => ({ action: 'save' })),
      clearToken: vi.fn(async () => ({ action: 'clear' }))
    }
    registerServerGitHubControl(platform, controller)
    const response = await platform.dispatch(1, {
      t: 'req', id: 1, method: IPC.githubControlStatus, args: ['p1']
    })
    expect(response).toMatchObject({ ok: true, result: { action: 'status' } })
    expect(controller.status).toHaveBeenCalledWith('p1')
  })
})
