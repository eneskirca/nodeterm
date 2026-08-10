import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
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
  vi.restoreAllMocks()
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

describe('ServerGitHubSecretStore atomic write', () => {
  const tokenFile = (): string => path.join(userDataDir, 'github-issues-token.json')

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(userDataDir)).filter((file) => file.endsWith('.tmp'))

  // Nothing serializes `IPC.githubControlSaveToken` on the server either: it is registered through
  // `platform.handle` and reached over the concurrent WS dispatch in src/server/ws.ts, with no
  // queue in front of it — and GitHubHostController.saveToken awaits a NETWORK validateToken before
  // it calls secret.save (src/core/github/host.ts), so the overlap window is as wide as a round
  // trip to github.com. One fixed `${file}.tmp` name means two writers share a single tmp file: one
  // writer's rename publishes the other's half-written PAT, or moves the file out from under it
  // entirely and the loser's rename fails.
  it('two overlapping token saves never share a tmp file (no torn write, no leftovers)', async () => {
    const store = new ServerGitHubSecretStore(userDataDir)
    // Payloads that differ in LENGTH and in every byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const long = `github_pat_${'a'.repeat(600)}`
    const short = `github_pat_${'b'.repeat(7)}`
    // Hold every writer between its tmp write and its rename, so BOTH tmp files are on disk before
    // either rename runs — the overlap window a real crash tears open.
    const tmps: string[] = []
    let open!: () => void
    let timer!: ReturnType<typeof setTimeout>
    // If a future change serializes the writers, the second write never arrives and the barrier
    // would hang to an opaque 5s vitest timeout. Fail loudly, naming what this test pins.
    const bothWritten = Promise.race([
      new Promise<void>((r) => (open = r)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('second concurrent tmp write never arrived — writers appear ' +
            'serialized; this test pins the unique-tmp-name design')),
          2000
        )
      })
    ])
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      const out = await (realWriteFile as any)(p, ...rest)
      if (String(p).startsWith(tokenFile())) {
        tmps.push(String(p))
        if (tmps.length >= 2) {
          clearTimeout(timer)
          open()
        }
        await bothWritten
      }
      return out
    }) as any)

    // allSettled, not all: with a shared name the LOSER's rename fails (ENOENT — the winner already
    // moved the file away), and letting that reject here would report the symptom before the cause.
    const settled = await Promise.allSettled([store.save(long), store.save(short)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each writer owned its own tmp file
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']) // …so neither lost it
    // One COMPLETE document won — parsing at all proves it is not a prefix of the other.
    expect(JSON.parse(await fs.readFile(tokenFile(), 'utf-8'))).toMatchObject({ version: 1 })
    expect([long, short]).toContain(await store.readForHost())
    // …and no tmp survives: a leaked one here is a live PAT at 0600 that nothing overwrites.
    expect(await tmpsLeft()).toEqual([])
  })

  it('sweeps orphan temps left by dead writers, but never one bearing our own pid', async () => {
    const store = new ServerGitHubSecretStore(userDataDir)
    const legacy = `${tokenFile()}.tmp` // a build from before per-call tmp names
    const foreign = `${tokenFile()}.${process.pid + 1}.7.tmp` // a run that died before its rename
    const ours = `${tokenFile()}.${process.pid}.999.tmp`
    for (const file of [legacy, foreign, ours]) {
      await fs.writeFile(file, JSON.stringify({ version: 1, token: 'stale-secret' }), {
        encoding: 'utf-8',
        mode: 0o600
      })
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
    const store = new ServerGitHubSecretStore(userDataDir)
    await store.save('github_pat_secret')
    for (const file of [`${tokenFile()}.tmp`, `${tokenFile()}.${process.pid + 1}.7.tmp`]) {
      await fs.writeFile(file, JSON.stringify({ version: 1, token: 'stale-secret' }), {
        encoding: 'utf-8',
        mode: 0o600
      })
    }

    await store.clear()

    expect(await store.readForHost()).toBeNull()
    expect(existsSync(tokenFile())).toBe(false)
    expect(await tmpsLeft()).toEqual([])
  })

  it('a failed rename removes its own temp and still rejects (a leaked temp here is a live PAT)', async () => {
    const store = new ServerGitHubSecretStore(userDataDir)
    await store.save('original-token')
    // EXDEV is the realistic one: the data dir on another filesystem than the temp.
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

describe('registerServerGitHubControl', () => {
  it('registers control methods on the authenticated server RPC platform', async () => {
    const platform = new ServerPlatform({ userDataDir, appVersion: '0' })
    const view = {
      control: { revision: 0, authProvider: 'auto' as const },
      auth: {
        selectedProvider: 'auto' as const,
        activeProvider: null,
        ghAuthenticated: false,
        tokenPresent: false,
        storage: 'restricted-file' as const
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
    registerServerGitHubControl(platform, controller)
    const response = await platform.dispatch(1, {
      t: 'req', id: 1, method: IPC.githubControlStatus, args: ['p1']
    })
    expect(response).toMatchObject({ ok: true, result: view })
    expect(controller.status).toHaveBeenCalledWith('p1')
  })
})
