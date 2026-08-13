// Atomic-write behaviour of the two files a revoke rewrites: ~/.nodeterm/agent.json and
// ~/.ssh/authorized_keys.
//
// The service serializes its two entry points through one mutate chain (pinned in
// pairing-service.test.ts), and `writeAgentJson` / `removeAuthorizedKeysForDevice` live inside the
// factory below `serialize`, so no code path outside the closure can reach them unchained. What
// the chain cannot see: the host agent is a separate PROCESS writing the same files, and a crash
// between tmp-write and rename is possible regardless. Both files were once written through a
// fixed `<file>.tmp`, where one writer's rename could publish the other's half-written file, or
// move the tmp out from under it and make the loser's rename fail — unique per-call names are the
// defense this file pins.
//
// agent.json is the credential case: each device entry carries the `agentToken` bearer the phone
// uses on the host-agent WebSocket, so a temp left behind IS a leaked credential — hence the
// orphan sweep pinned below, which agent.json needs and authorized_keys (public keys) does not.
//
// AGENT_DIR / AUTH_KEYS_PATH are derived from `os.homedir()` at MODULE LOAD, so the homedir mock
// must be in place before the import: `vi.mock('os')` plus a dynamic import per test, with
// `vi.resetModules()` between them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { PairingService } from './pairing-service'

let home = ''

vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os')
  // pairing-service does `import os from 'os'`, so the DEFAULT export is the object it reads —
  // patching only the named export would leave it on the developer's real home directory.
  const patched = { ...real, homedir: () => home }
  return { ...patched, default: patched }
})

const agentDir = (): string => path.join(home, '.nodeterm')
const agentJson = (): string => path.join(agentDir(), 'agent.json')
const sshDir = (): string => path.join(home, '.ssh')
const authKeys = (): string => path.join(sshDir(), 'authorized_keys')

const device = (id: string): Record<string, unknown> => ({
  id, name: `phone-${id}`, token: `agent-token-${id}`, pairedAt: 1, lastSeenAt: 0
})

const KEY_A = `ssh-ed25519 AAAA${'a'.repeat(64)} nodeterm-ios-a`
const KEY_B = `ssh-ed25519 AAAA${'b'.repeat(64)} nodeterm-ios-b`
const OTHER = 'ssh-rsa AAAAsomeoneelseskey someone@example.com'

describe('pairing-service revoke: atomic writes', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-pairing-home-'))
    mkdirSync(agentDir(), { recursive: true, mode: 0o700 })
    mkdirSync(sshDir(), { recursive: true, mode: 0o700 })
    // `hostId` stands in for the fields the HOST AGENT owns in this shared file — a rewrite must
    // carry them through untouched.
    writeFileSync(
      agentJson(),
      JSON.stringify({ hostId: 'keep-me', devices: [device('a'), device('b')] }, null, 2) + '\n',
      { mode: 0o600 }
    )
    writeFileSync(authKeys(), `${OTHER}\n${KEY_A}\n${KEY_B}\n`, { mode: 0o600 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * Import the service UNDER THE FAKE HOME, and prove the mock took before anything writes: every
   * path here is frozen from `os.homedir()` at module load, so a mock that silently failed would
   * aim these writes at the developer's real ~/.nodeterm and ~/.ssh. Fail first, not after.
   */
  const service = async (): Promise<PairingService> => {
    const { createPairingService } = await import('./pairing-service')
    const svc = createPairingService()
    expect((await svc.listDevices()).map((d) => d.id)).toEqual(['a', 'b'])
    return svc
  }

  const tmpsIn = async (dir: string): Promise<string[]> =>
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))

  it('overlapping revokes never reuse a tmp name, and publish whole files', async () => {
    const svc = await service()
    const agentSeen: string[] = []
    const keysSeen: string[] = []
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      // The entry point serializes overlapping revokes (pinned in pairing-service.test.ts), so
      // their writes arrive one after the other — uniqueness is carried by the `<pid>.<seq>` name
      // alone. That name is what protects the unchained module-level writers and the crash window
      // between tmp-write and rename, so it stays pinned even though the entry point no longer
      // produces true overlap.
      if (String(p).startsWith(agentJson())) agentSeen.push(String(p))
      else if (String(p).startsWith(authKeys())) keysSeen.push(String(p))
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    await Promise.all([svc.revokeDevice('a'), svc.revokeDevice('b')])
    vi.restoreAllMocks()

    expect(new Set(agentSeen).size).toBe(2) // each write owned its own agent.json tmp
    expect(new Set(keysSeen).size).toBe(2) // …and its own authorized_keys tmp

    // BOTH devices are gone: the serialized chain closed the lost update a pre-serialization
    // version of this test documented as a known issue. The document is whole and well-formed —
    // parsing at all proves no writer published a splice — and the host agent's own field
    // survived both rewrites.
    const final = JSON.parse(await fs.readFile(agentJson(), 'utf-8'))
    expect(final.hostId).toBe('keep-me')
    expect(final.devices).toEqual([])

    // Same for authorized_keys: both key lines removed, the foreign line intact — a spliced file
    // is a broken key line, i.e. sshd rejecting the keys that were supposed to survive.
    expect(await fs.readFile(authKeys(), 'utf-8')).toBe(`${OTHER}\n`)

    // …and nothing is left for the next writer to inherit, in either directory.
    expect(await tmpsIn(agentDir())).toEqual([])
    expect(await tmpsIn(sshDir())).toEqual([])
  })

  it('a failed agent.json rename removes its own temp, rejects, and leaves the old device list intact', async () => {
    const svc = await service()
    const before = await fs.readFile(agentJson(), 'utf-8')
    // EXDEV is the realistic one: ~/.nodeterm on another filesystem than the temp.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(svc.revokeDevice('a')).rejects.toThrow(/EXDEV/)

    // A leaked temp here is a leaked credential: it holds every device's `agentToken`, at 0600,
    // under a unique name nothing will ever write again.
    expect(await tmpsIn(agentDir())).toEqual([])
    expect(await fs.readFile(agentJson(), 'utf-8')).toBe(before) // nothing published
    // The revoke aborted before the key removal, so the line is still there — the caller sees a
    // rejection rather than a silent half-revoke.
    expect(await fs.readFile(authKeys(), 'utf-8')).toContain('nodeterm-ios-a')
  })

  it('a failed authorized_keys rename removes its own temp and still rejects', async () => {
    const svc = await service()
    const before = await fs.readFile(authKeys(), 'utf-8')
    const realRename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation((async (from: any, to: any) => {
      // Only the key-file publish fails; agent.json is rewritten for real, as it would be in the
      // field when ~/.ssh is the unwritable half (a locked-down or root-owned home).
      if (String(to) === authKeys()) {
        throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
      }
      return (realRename as any)(from, to)
    }) as any)

    await expect(svc.revokeDevice('a')).rejects.toThrow(/EACCES/)
    vi.restoreAllMocks()

    expect(await tmpsIn(sshDir())).toEqual([])
    expect(await fs.readFile(authKeys(), 'utf-8')).toBe(before) // the key file is untouched
  })

  it('sweeps orphan agent.json temps left by dead writers, but never one bearing our own pid', async () => {
    const svc = await service()
    const legacy = `${agentJson()}.tmp` // a build from before per-call tmp names
    const foreign = `${agentJson()}.${process.pid + 1}.7.tmp` // a run that died before its rename
    const ours = `${agentJson()}.${process.pid}.999.tmp`
    for (const f of [legacy, foreign, ours]) {
      writeFileSync(f, JSON.stringify({ devices: [device('ghost')] }), { mode: 0o600 })
    }

    await svc.revokeDevice('a')

    expect((await svc.listDevices()).map((d) => d.id)).toEqual(['b'])
    // ~/.nodeterm is shared with the HOST AGENT — other processes write here — and a unique name is
    // never written again, so an orphan is a 0600 file holding live `agentToken`s forever.
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(foreign)).toBe(false)
    // Our own pid is off limits: it may be a CONCURRENT writer sitting between its write and its
    // rename, and deleting it would reintroduce the very race the unique names fixed.
    expect(existsSync(ours)).toBe(true)
  })
})
