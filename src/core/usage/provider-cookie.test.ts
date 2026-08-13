import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { readProviderCookie, writeProviderCookie } from './provider-cookie'

describe('provider cookie atomic write', () => {
  let dir: string
  let cookiePath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nt-cookie-race-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
    cookiePath = path.join(dir, 'minimax-cookie.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))

  // `usage:set-provider-cookie` writes are serialized per provider by the writeChain, so their
  // writes arrive one after the other — uniqueness is carried by the `<pid>.<seq>` name alone.
  // That name is what protects writers that bypass the chain (a second server process on the same
  // data dir) and the crash window between tmp-write and rename, so it stays pinned here.
  it('overlapping cookie writes never reuse a tmp name (no torn write, no leftovers)', async () => {
    // Payloads that differ in LENGTH and in every byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const long = 'a'.repeat(4096)
    const short = 'b'.repeat(17)
    const tmps: string[] = []
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(cookiePath)) tmps.push(String(p))
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    await Promise.all([
      writeProviderCookie('minimax', long),
      writeProviderCookie('minimax', short)
    ])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each write owned its own tmp file
    const final = JSON.parse(await fs.readFile(cookiePath, 'utf-8'))
    expect(final.cookie).toBe(short) // one COMPLETE credential won — FIFO makes it the last call
    // …and no tmp survives: a leaked one here is a live cookie nothing will ever overwrite.
    expect(await tmpsLeft()).toEqual([])
  })

  it('a clear is never undone by an in-flight set — writes run in call order per provider', async () => {
    // Park the set's rename: unserialized, the clear's rm runs while the set sits between its tmp
    // write and its rename — then the parked rename lands and resurrects the credential the UI
    // just reported cleared. Chained per provider, the clear waits its turn and the last call is
    // the last word.
    const realRename = fs.rename
    let delayed = false
    vi.spyOn(fs, 'rename').mockImplementation((async (a: any, b: any) => {
      if (String(b).startsWith(cookiePath) && !delayed) {
        delayed = true
        await new Promise((r) => setTimeout(r, 50))
      }
      return (realRename as any)(a, b)
    }) as any)

    await Promise.all([
      writeProviderCookie('minimax', 'secret'),
      writeProviderCookie('minimax', '')
    ])
    vi.restoreAllMocks()

    expect(await readProviderCookie('minimax')).toBeNull() // cleared means CLEARED
    expect(existsSync(cookiePath)).toBe(false)
  })

  it('sweeps orphan temps left by dead writers, but never one bearing our own pid', async () => {
    const legacy = `${cookiePath}.tmp` // a build from before per-call tmp names
    const foreign = `${cookiePath}.${process.pid + 1}.7.tmp` // a run that died before its rename
    const ours = `${cookiePath}.${process.pid}.999.tmp`
    for (const f of [legacy, foreign, ours]) {
      writeFileSync(f, JSON.stringify({ cookie: 'stale-secret' }), { mode: 0o600 })
    }

    await writeProviderCookie('minimax', 'fresh')

    await expect(readProviderCookie('minimax')).resolves.toBe('fresh')
    // Unique names are never reused, so an orphan is a 0600 file holding a live cookie forever.
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(foreign)).toBe(false)
    // Our own pid is off limits: it may be a CONCURRENT writer sitting between its write and its
    // rename, and deleting it would reintroduce the very race the unique names fixed.
    expect(existsSync(ours)).toBe(true)
  })

  it('sweeps orphan temps on the clear path too — a "cleared" cookie must leave nothing behind', async () => {
    await writeProviderCookie('minimax', 'secret')
    writeFileSync(`${cookiePath}.tmp`, JSON.stringify({ cookie: 'stale-secret' }), { mode: 0o600 })
    writeFileSync(`${cookiePath}.${process.pid + 1}.7.tmp`, JSON.stringify({ cookie: 'stale' }), {
      mode: 0o600
    })

    await writeProviderCookie('minimax', '')

    await expect(readProviderCookie('minimax')).resolves.toBeNull()
    expect(existsSync(cookiePath)).toBe(false)
    expect(await tmpsLeft()).toEqual([])
  })

  it('a failed rename removes its own temp and still rejects (a leaked temp here is a live cookie)', async () => {
    // EXDEV is the realistic one: the userData dir on another filesystem than the temp.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(writeProviderCookie('minimax', 'secret')).rejects.toThrow(/EXDEV/)
    expect(await tmpsLeft()).toEqual([])
    // …and nothing was published: a failed write leaves the previous state (here, none).
    await expect(readProviderCookie('minimax')).resolves.toBeNull()
  })
})
