import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
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
  vi.restoreAllMocks()
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

describe('ElectronGitHubSecretStore atomic write', () => {
  const tokenFile = (): string => path.join(userDataDir, 'github-issues-token.json')

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(userDataDir)).filter((file) => file.endsWith('.tmp'))

  // Nothing serializes `IPC.githubControlSaveToken`: the handler is reachable from the preload
  // bridge (src/preload/index.ts) AND from a remote client over the ws bridge
  // (src/renderer/bridge/ws-bridge.ts), and GitHubHostController.saveToken awaits a NETWORK
  // validateToken before it calls secret.save (src/core/github/host.ts), so the overlap window is
  // as wide as a round trip to github.com. One fixed `${file}.tmp` name means two writers share a
  // single tmp file: one writer's rename publishes the other's half-written PAT, or moves the file
  // out from under it entirely and the loser's rename fails.
  it('overlapping token saves never reuse a tmp name (no torn write, no leftovers)', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    // The store's chain serializes its own mutations, so the writes arrive one after the other —
    // uniqueness is carried by the `<pid>.<seq>` name alone. That name is what protects writers
    // the chain cannot see (a second app process on the same userDataDir) and the crash window
    // between tmp-write and rename, so it stays pinned here.
    const long = `github_pat_${'a'.repeat(600)}`
    const short = `github_pat_${'b'.repeat(7)}`
    const tmps: string[] = []
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(tokenFile())) tmps.push(String(p))
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    await Promise.all([store.save(long), store.save(short)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each write owned its own tmp file
    // One COMPLETE document won — parsing at all proves it is not a prefix of the other — and
    // FIFO makes it the last call.
    expect(JSON.parse(await fs.readFile(tokenFile(), 'utf-8')))
      .toMatchObject({ version: 1, kind: 'safe-storage' })
    expect(await store.readForHost()).toBe(short)
    // …and no tmp survives: a leaked one here is a live PAT at 0600 that nothing overwrites.
    expect(await tmpsLeft()).toEqual([])
  })

  it('a clear is never undone by an in-flight save — mutations run in call order', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    // Park the save's rename: unserialized, the clear's rm runs while the save sits between its
    // tmp write and its rename — then the parked rename lands and resurrects the PAT the UI just
    // reported cleared. Chained, the clear waits its turn and the last call is the last word.
    const realRename = fs.rename
    let delayed = false
    vi.spyOn(fs, 'rename').mockImplementation((async (a: any, b: any) => {
      if (String(b).startsWith(tokenFile()) && !delayed) {
        delayed = true
        await new Promise((r) => setTimeout(r, 50))
      }
      return (realRename as any)(a, b)
    }) as any)

    await Promise.all([store.save(`github_pat_${'c'.repeat(30)}`), store.clear()])
    vi.restoreAllMocks()

    expect(await store.readForHost()).toBeNull() // cleared means CLEARED
    expect(existsSync(tokenFile())).toBe(false)
  })

  it('sweeps orphan temps left by dead writers, but never one bearing our own pid', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    const legacy = `${tokenFile()}.tmp` // a build from before per-call tmp names
    const foreign = `${tokenFile()}.${process.pid + 1}.7.tmp` // a run that died before its rename
    const ours = `${tokenFile()}.${process.pid}.999.tmp`
    for (const file of [legacy, foreign, ours]) {
      await fs.writeFile(file, JSON.stringify({
        version: 1, kind: 'restricted-file', token: 'stale-secret'
      }), { encoding: 'utf-8', mode: 0o600 })
    }

    await store.save('github_pat_fresh')

    expect(await store.readForHost()).toBe('github_pat_fresh')
    // Unique names are never reused, so an orphan is a 0600 file holding a live PAT forever.
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(foreign)).toBe(false)
    // Our own pid is off limits: it may be a CONCURRENT writer sitting between its write and its
    // rename, and deleting it would reintroduce the very race the unique names fixed.
    expect(existsSync(ours)).toBe(true)
  })

  it('sweeps orphan temps on the clear path too — a "cleared" token must leave nothing behind', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    await store.save('github_pat_secret')
    for (const file of [`${tokenFile()}.tmp`, `${tokenFile()}.${process.pid + 1}.7.tmp`]) {
      await fs.writeFile(file, JSON.stringify({
        version: 1, kind: 'restricted-file', token: 'stale-secret'
      }), { encoding: 'utf-8', mode: 0o600 })
    }

    await store.clear()

    expect(await store.readForHost()).toBeNull()
    expect(existsSync(tokenFile())).toBe(false)
    expect(await tmpsLeft()).toEqual([])
  })

  it('a failed rename removes its own temp and still rejects (a leaked temp here is a live PAT)', async () => {
    const store = new ElectronGitHubSecretStore(userDataDir, safeStorage())
    await store.save('original-token')
    // EXDEV is the realistic one: the userData dir on another filesystem than the temp.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(store.save('replacement-token')).rejects.toThrow(/EXDEV/)
    // A unique tmp name is never reused, so the failed write has to have cleaned up after itself.
    expect(await tmpsLeft()).toEqual([])
    // …and nothing was published: a failed save leaves the previously stored token in place.
    expect(await store.readForHost()).toBe('original-token')
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
