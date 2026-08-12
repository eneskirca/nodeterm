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

  // Nothing serializes `usage:set-provider-cookie`: it is reachable from the preload bridge and,
  // on the Server Edition, from any WS client's frame (src/renderer/bridge/ws-bridge.ts over the
  // concurrent dispatch in src/server/ws.ts). One fixed `${file}.tmp` name means two writers share
  // a single tmp file: one writer's rename publishes the other's half-written credential, or moves
  // the file out from under it entirely and the loser's rename fails.
  it('two overlapping cookie writes never share a tmp file (no torn write, no leftovers)', async () => {
    // Payloads that differ in LENGTH and in every byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const long = 'a'.repeat(4096)
    const short = 'b'.repeat(17)
    // Hold every cookie writer between its tmp write and its rename, so BOTH tmp files are on disk
    // before either rename runs — the overlap window a real crash tears open.
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
      if (String(p).startsWith(cookiePath)) {
        tmps.push(String(p))
        if (tmps.length >= 2) {
          clearTimeout(timer)
          open()
        }
        await bothWritten
      }
      return out
    }) as any)

    await Promise.all([
      writeProviderCookie('minimax', long),
      writeProviderCookie('minimax', short)
    ])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each writer owned its own tmp file
    const final = JSON.parse(await fs.readFile(cookiePath, 'utf-8'))
    expect([long, short]).toContain(final.cookie) // one COMPLETE credential won, not a splice
    // …and no tmp survives: a leaked one here is a live cookie nothing will ever overwrite.
    expect(await tmpsLeft()).toEqual([])
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
