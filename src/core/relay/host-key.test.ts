// src/core/relay/host-key.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostKey, loadHostKey, rotateHostKey, hostAddress, HostKeyUnreadableError, HostKeyExistsError } from './host-key'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { hostIdFromPublicKeyB64 } from './relay-id'

const made: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkey-'))
  made.push(d)
  return d
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const keyFile = (dir: string) => path.join(dir, 'host-key.json')
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

describe('server host key', () => {
  it('absent → null; create → stable across loads', async () => {
    const dir = tmp()
    expect(await loadHostKey(dir)).toBeNull()
    const k = await createHostKey(dir)
    const again = await loadHostKey(dir)
    expect(publicKeyToB64(again!.publicKey)).toBe(publicKeyToB64(k.publicKey))
    expect(b64(again!.secretKey)).toBe(b64(k.secretKey))
  })

  // POSIX permission bits: Windows reports its own mode bits here, not the 0600/0700 we asked for.
  it.skipIf(process.platform === 'win32')('file is 0600 and a fresh directory 0700, on create and on rotate', async () => {
    const dir = path.join(tmp(), 'relay')
    await createHostKey(dir)
    expect((fs.statSync(keyFile(dir)).mode & 0o777).toString(8)).toBe('600')
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700')
    await rotateHostKey(dir)
    expect((fs.statSync(keyFile(dir)).mode & 0o777).toString(8)).toBe('600')
  })

  // POSIX permission bits: chmod is skipped on Windows, where the bits do not apply.
  it.skipIf(process.platform === 'win32')('tightens an existing, looser directory to 0700 on write', async () => {
    const dir = path.join(tmp(), 'relay')
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.chmodSync(dir, 0o755) // the umask may have narrowed it; make it genuinely loose
    await createHostKey(dir)
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700')
  })

  it('corrupt → throws, and the file is NOT replaced (not by load, not by create)', async () => {
    const dir = tmp()
    fs.writeFileSync(keyFile(dir), '{"publicKey":"short"}')
    await expect(loadHostKey(dir)).rejects.toBeInstanceOf(HostKeyUnreadableError)
    await expect(loadHostKey(dir)).rejects.toMatchObject({ code: 'E_HOST_KEY_UNREADABLE' })
    await expect(createHostKey(dir)).rejects.toBeInstanceOf(HostKeyUnreadableError)
    expect(fs.readFileSync(keyFile(dir), 'utf-8')).toBe('{"publicKey":"short"}')
  })

  it('a read error other than "missing" is unreadable, never "none yet"', async () => {
    const dir = tmp()
    fs.mkdirSync(keyFile(dir)) // readFile → EISDIR: present, but cannot be read
    await expect(loadHostKey(dir)).rejects.toBeInstanceOf(HostKeyUnreadableError)
    await expect(createHostKey(dir)).rejects.toBeInstanceOf(HostKeyUnreadableError)
    expect(fs.statSync(keyFile(dir)).isDirectory()).toBe(true)
  })

  it('a keyring-encrypted secret is unreadable here and left intact', async () => {
    const dir = tmp()
    const k = genKeyPair()
    const raw = JSON.stringify({ publicKey: b64(k.publicKey), secretKeyEnc: 'c2VhbGVk' })
    fs.writeFileSync(keyFile(dir), raw)
    await expect(loadHostKey(dir)).rejects.toThrow(/keyring/)
    await expect(createHostKey(dir)).rejects.toBeInstanceOf(HostKeyUnreadableError)
    expect(fs.readFileSync(keyFile(dir), 'utf-8')).toBe(raw)
  })

  it('a public key that does not belong to the secret key is corrupt', async () => {
    const dir = tmp()
    const a = genKeyPair()
    const b = genKeyPair()
    const raw = JSON.stringify({ publicKey: b64(a.publicKey), secretKey: b64(b.secretKey) })
    fs.writeFileSync(keyFile(dir), raw)
    await expect(loadHostKey(dir)).rejects.toThrow(/does not match/)
    expect(fs.readFileSync(keyFile(dir), 'utf-8')).toBe(raw)
  })

  it('create refuses to overwrite an existing key; rotate is the explicit path', async () => {
    const dir = tmp()
    const a = await createHostKey(dir)
    await expect(createHostKey(dir)).rejects.toThrow(/already exists/)
    // A typed code, so a caller that lost an init race recognises it without matching message text.
    await expect(createHostKey(dir)).rejects.toMatchObject({ code: 'E_HOST_KEY_EXISTS' })
    await expect(createHostKey(dir)).rejects.toBeInstanceOf(HostKeyExistsError)
    expect(publicKeyToB64((await loadHostKey(dir))!.publicKey)).toBe(publicKeyToB64(a.publicKey))
    const b = await rotateHostKey(dir)
    expect(publicKeyToB64(b.publicKey)).not.toBe(publicKeyToB64(a.publicKey))
    expect(publicKeyToB64((await loadHostKey(dir))!.publicKey)).toBe(publicKeyToB64(b.publicKey))
  })

  it('two creates racing each other: one key wins, the other is refused, nothing is replaced', async () => {
    const dir = tmp()
    const results = await Promise.allSettled([createHostKey(dir), createHostKey(dir), createHostKey(dir)])
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createHostKey>>> => r.status === 'fulfilled')
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(refused).toHaveLength(2)
    for (const r of refused) expect(String(r.reason)).toMatch(/already exists/)
    expect(publicKeyToB64((await loadHostKey(dir))!.publicKey)).toBe(publicKeyToB64(won[0].value.publicKey))
  })

  it('rotate is the recovery from a corrupt key', async () => {
    const dir = tmp()
    fs.writeFileSync(keyFile(dir), 'not json')
    const k = await rotateHostKey(dir)
    expect(publicKeyToB64((await loadHostKey(dir))!.publicKey)).toBe(publicKeyToB64(k.publicKey))
  })

  it('hostAddress derives the broker room id', async () => {
    const k = await createHostKey(tmp())
    const addr = hostAddress(k)
    expect(addr.hostPublicKeyB64).toBe(publicKeyToB64(k.publicKey))
    expect(addr.hostId).toBe(hostIdFromPublicKeyB64(addr.hostPublicKeyB64))
    expect(addr.hostId).toHaveLength(22)
  })
})
