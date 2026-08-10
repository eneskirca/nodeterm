// Atomic-write behaviour of <userData>/remote-approved-devices.json.
//
// Three writers reach `saveApprovedDevices` from the main process with nothing queueing them:
// the standing host's fire-and-forget pin (standing-host.ts, `void loadApprovedDevices().then(...)`),
// relay-trust's un-awaited settle pin (relay-trust.ts's `settle()`), and the revoke IPC
// (src/main/index.ts → revocation.ts). A phone approved on one path while another is settling is
// exactly two overlapping saves.
//
// The list is PUBLIC keys, not credentials, so there is no orphan sweep here — unlike the PAT stores
// (src/main/github-control.ts, src/server/github-control.ts) or agent.json (src/main/pairing-service.ts),
// whose orphan temps hold live credentials — but a failed save must still leave the OLD file
// byte-for-byte intact, because revocation.ts's `persisted:false` contract is built on precisely that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { loadApprovedDevices, saveApprovedDevices } from './approved-devices'
import type { ApprovedDevices } from './approved-devices-core'

// `file()` resolves <userData> through `app.getPath` on every call, so a mutable dir set in
// beforeEach is enough here — the factory only reads it when the getter is invoked.
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

describe('approved-devices atomic write', () => {
  let target: string

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'nt-approved-'))
    target = path.join(userData, 'remote-approved-devices.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(userData)).filter((f) => f.endsWith('.tmp'))

  it('two overlapping saves never share a tmp file (no torn write, no leftovers)', async () => {
    // Payloads that differ in LENGTH and in every byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const many: ApprovedDevices = { pubkeys: Array.from({ length: 64 }, (_, i) => `A${'a'.repeat(42)}${i}`) }
    const one: ApprovedDevices = { pubkeys: ['B'] }
    // Hold every writer between its tmp write and its rename, so BOTH tmp files are on disk
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
        timer.unref?.()
      })
    ])
    bothWritten.catch(() => {}) // the writers below surface it; this only keeps it "handled"
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      const out = await (realWriteFile as any)(p, ...rest)
      if (String(p).startsWith(target)) {
        tmps.push(String(p))
        if (tmps.length >= 2) {
          clearTimeout(timer)
          open()
        }
        await bothWritten
      }
      return out
    }) as any)

    await Promise.all([saveApprovedDevices(many), saveApprovedDevices(one)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each writer owned its own tmp file
    // One COMPLETE list won — parsing at all proves it is not a prefix of the other, and the deep
    // compare proves it is not a splice that happens to parse.
    const final = JSON.parse(await fs.readFile(target, 'utf-8')) as ApprovedDevices
    expect([many.pubkeys, one.pubkeys]).toContainEqual(final.pubkeys)
    // …and nothing is left for the next writer to inherit.
    expect(await tmpsLeft()).toEqual([])
  })

  it('a failed rename removes its own temp, rejects, and leaves the OLD pinned list intact', async () => {
    const pinned: ApprovedDevices = { pubkeys: ['already-approved-phone'] }
    writeFileSync(target, JSON.stringify(pinned), { mode: 0o600 })
    const before = await fs.readFile(target, 'utf-8')
    // EXDEV is the realistic one: the userData dir on another filesystem than the temp.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(saveApprovedDevices({ pubkeys: [] })).rejects.toThrow(/EXDEV/)

    // revocation.ts's RevokeResult.persisted documents exactly this: a failed write leaves the OLD
    // still-pinned file byte-for-byte intact, so the caller must report persisted:false and retry.
    // If a failed save could half-publish, that contract (and the "Removed" UI) would be a lie.
    expect(await fs.readFile(target, 'utf-8')).toBe(before)
    await expect(loadApprovedDevices()).resolves.toEqual(pinned)
    // A unique tmp name is never written again, so only this save's own cleanup collects it.
    expect(await tmpsLeft()).toEqual([])
  })
})
