import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { promises as fs, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import path from 'path'

const TEMP_HOME_MARKER = 'nt-pairing-'

// pairing-service computes AGENT_DIR / AGENT_JSON_PATH / AUTH_KEYS_PATH from `os.homedir()` at
// MODULE LOAD time, so the redirect has to be in place before the import — hence the mock factory
// (hoisted by vitest) minting the temp home itself. `networkInterfaces` is faked too so start()
// finds a LAN IP on a CI box with none. Everything else about `os` stays real.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-pairing-'))
  const homedir = (): string => home
  const networkInterfaces = (): NodeJS.Dict<import('os').NetworkInterfaceInfo[]> => ({
    eth0: [
      {
        address: '192.168.1.42',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '02:00:00:00:00:01',
        internal: false,
        cidr: '192.168.1.42/24'
      }
    ]
  })
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  return {
    ...actual,
    homedir,
    networkInterfaces,
    default: { ...base, homedir, networkInterfaces }
  }
})

// The relay mint stamps this host's anonymous device id, which is read out of the CorePlatform's
// userData dir — uninitialized here, and its throw would be swallowed into a silent LAN-only
// pairing. Pinned to a constant so the mint body is fully assertable.
vi.mock('../core/device-id', () => ({ getDeviceId: () => 'test-host-device-id' }))

import os from 'os'
import { createPairingService, type PairingRelayDeps } from './pairing-service'
import { rewriteKeyComment, type DeviceEntry } from './pairing-core'
import { decrypt, deriveSharedKey, encrypt, genKeyPair, publicKeyToB64, type KeyPair } from './remote/e2ee'
import type { Settings } from '../shared/types'

const HOME = os.homedir()
const AGENT_JSON = path.join(HOME, '.nodeterm', 'agent.json')
const AUTH_KEYS = path.join(HOME, '.ssh', 'authorized_keys')

/**
 * This file deletes directories under HOME. If the `os` mock above ever breaks or is dropped,
 * HOME becomes the developer's REAL home and those deletes take out `~/.ssh` — silently, because
 * nothing else in the suite can tell the difference. Refuse to run unless HOME is demonstrably one
 * of our mkdtemp dirs. Called at module scope (so nothing runs at all) and again before the
 * afterAll wipe.
 */
function assertTempHome(): void {
  if (!path.basename(HOME).startsWith(TEMP_HOME_MARKER)) {
    throw new Error(
      `pairing-service.test refuses to run: homedir() is "${HOME}", not a ${TEMP_HOME_MARKER}* ` +
        'temp dir. The os mock is not in effect and this file would delete the real ~/.ssh.'
    )
  }
}
assertTempHome()

// Stamped exactly the way pairing minted them, so `filterAuthorizedKeys` really matches.
// dev-a is an iPhone paired BEFORE the rename (legacy `nodeterm-ios-` stamp, written literally);
// dev-b was paired after it (stamped exactly the way pairing mints keys now). A revoke must find
// both — the first is what every existing user's authorized_keys looks like.
const KEY_A = 'ssh-ed25519 AAAAblobAAAA nodeterm-ios-dev-a'
const KEY_B = rewriteKeyComment('ssh-ed25519 AAAAblobBBBB phone-b@ios', 'dev-b')
// Not ours: no revoke may ever touch it (a fix that "passes" by truncating the file must fail).
const KEY_OTHER = 'ssh-rsa AAAAlaptopblob jdub@laptop'

const device = (id: string, name: string): DeviceEntry => ({
  id,
  name,
  token: `agent-token-${id}`,
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 0
})

/** Agent.json as the host agent leaves it: our devices plus fields we don't own. */
const seed = (): void => {
  rmSync(path.join(HOME, '.nodeterm'), { recursive: true, force: true })
  rmSync(path.join(HOME, '.ssh'), { recursive: true, force: true })
  mkdirSync(path.join(HOME, '.nodeterm'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(HOME, '.ssh'), { recursive: true, mode: 0o700 })
  writeFileSync(
    AGENT_JSON,
    JSON.stringify(
      { hostId: 'host-keep-me', devices: [device('dev-a', 'Phone A'), device('dev-b', 'Phone B')] },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  writeFileSync(AUTH_KEYS, `${KEY_OTHER}\n${KEY_A}\n${KEY_B}\n`, { mode: 0o600 })
}

const authKeys = (): string => readFileSync(AUTH_KEYS, 'utf8')
const agentJson = (): Record<string, unknown> => JSON.parse(readFileSync(AGENT_JSON, 'utf8'))
const deviceIds = (): string[] =>
  ((agentJson().devices as DeviceEntry[] | undefined) ?? []).map((d) => d.id)

/**
 * Hold the first read of each watched path until EITHER a second read of that path lands (the
 * unfixed code overlaps, so both revokes see the same stale bytes and each drops only its own
 * device) OR a short timer fires (the fixed code serializes them, so the second read never
 * overlaps and the test just runs ~150ms slower). Bytes are captured BEFORE the hold, so a
 * released writer can never hand the still-waiting reader fresh content by accident — and the
 * timer means this can never hang into an opaque vitest timeout.
 */
const OVERLAP_WAIT_MS = 150
function gateReads(watched: string[]): void {
  const captured = new Map<string, number>()
  const waiters = new Map<string, Array<() => void>>()
  const realReadFile = fs.readFile
  vi.spyOn(fs, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
    const key = String(p)
    if (!watched.includes(key)) return (realReadFile as any)(p, ...rest)
    const bytes = await (realReadFile as any)(p, ...rest)
    const n = (captured.get(key) ?? 0) + 1
    captured.set(key, n)
    if (n >= 2) {
      for (const w of waiters.get(key) ?? []) w()
      waiters.set(key, [])
    } else {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, OVERLAP_WAIT_MS)
        // Released early → drop the timer, so a killed run leaves nothing pending.
        waiters.set(key, [
          ...(waiters.get(key) ?? []),
          () => {
            clearTimeout(t)
            resolve()
          }
        ])
      })
    }
    return bytes
  }) as any)
}

/** A key line the phone could really have sent: OpenSSH wire format the validator decodes. */
function freshEd25519Line(comment = 'phone@ios'): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  const blob = Buffer.concat([len(name.length), name, len(32), randomBytes(32)])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

/** POST /pair the way the phone does (plaintext branch — no host key, so no `epk` envelope). */
function post(port: number, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/pair',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve(text))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  seed()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  assertTempHome()
  rmSync(HOME, { recursive: true, force: true })
})

describe('revokeDevice', () => {
  it('uses the phone-only relay fallback for a legacy entry and leaves a stale id out of scope', async () => {
    const revoke = vi.fn(async () => ({ persisted: true, killed: true }))
    const service = createPairingService(undefined, { revokePhoneRelayTrust: revoke })
    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'skipped', relay: 'ok' })
    expect(revoke).toHaveBeenCalledOnce()
    await service.revokeDevice('missing')
    expect(revoke).toHaveBeenCalledOnce()
    expect(deviceIds()).toEqual(['dev-b'])
  })

  it('keeps a legacy device and its SSH access retryable when relay trust cannot be revoked', async () => {
    const service = createPairingService(undefined, {
      revokePhoneRelayTrust: async () => ({ persisted: false, killed: true })
    })
    expect((await service.revokeDevice('dev-a')).local).toBe(false)
    expect(deviceIds()).toContain('dev-a')
    expect(authKeys()).toContain('nodeterm-ios-dev-a')
  })

  // revokeDevice is a read-modify-write over BOTH files (agent.json, then authorized_keys) and
  // src/main/index.ts hands every `pairing:revoke-device` invoke straight to it, unserialized. Two
  // overlapping revokes each read the ORIGINAL file and filter out only their own device, so
  // whichever write lands last republishes the other's — a revoked phone keeps its SSH key line,
  // and its agent.json entry comes back WITH the bearer token for the host-agent socket.
  it('two concurrent revokes both stick (no lost update in either file)', async () => {
    gateReads([AGENT_JSON, AUTH_KEYS])
    const service = createPairingService()

    const results = await Promise.allSettled([
      service.revokeDevice('dev-a'),
      service.revokeDevice('dev-b')
    ])

    const keys = authKeys()
    expect(keys).not.toContain('nodeterm-ios-dev-a')
    expect(keys).not.toContain('nodeterm-mobile-dev-b')
    expect(keys).toContain(KEY_OTHER) // the user's own key was never in scope
    expect(deviceIds()).toEqual([])
    expect(agentJson().hostId).toBe('host-keep-me') // fields we don't own survive the rewrite
    // Neither revoke may report failure to its caller either.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('a failed revoke reports local:false to its caller and does not block the next one', async () => {
    const service = createPairingService()
    // First rename is agent.json's, inside the failing revoke.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    // The failure is REPORTED, not thrown (the server leg still has to run, and the UI turns
    // `local:false` into a retry note — a rejection here reached nobody).
    expect((await service.revokeDevice('dev-a')).local).toBe(false)
    // A serializer that chains failures onto its successors would strand every later revoke.
    await service.revokeDevice('dev-b')

    const keys = authKeys()
    expect(keys).not.toContain('nodeterm-mobile-dev-b')
    expect(keys).toContain('nodeterm-ios-dev-a') // the failed revoke really did fail
    expect(deviceIds()).toEqual(['dev-a'])
  })

  it('revokes the SSH key first, so a mid-revoke failure leaves access cut and the device retryable', async () => {
    // Order matters on partial failure. authorized_keys is full shell access; agent.json is the
    // host-agent bearer token and the visible device list. If the SSH key is removed FIRST, a
    // failure on the second step leaves the bigger capability already revoked AND the device still
    // listed — so the owner sees it and can retry. The reverse order (drop the listing first) would
    // hide a device whose SSH key is still live, with no button left to finish the job.
    const service = createPairingService()
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('agent.json')) {
        throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
      }
      return realRename(from, to)
    })

    // …and the half-finished revoke says so (`local:false`) instead of resolving like a clean one.
    expect((await service.revokeDevice('dev-a')).local).toBe(false)

    expect(authKeys()).not.toContain('nodeterm-ios-dev-a') // SSH access really was cut
    expect(deviceIds()).toContain('dev-a') // still listed, so the owner can retry
  })

  it('a single revoke drops exactly its own device, leaving the file 0600', async () => {
    const service = createPairingService()

    await service.revokeDevice('dev-a')

    const keys = authKeys()
    expect(keys).toBe(`${KEY_OTHER}\n${KEY_B}\n`)
    expect(deviceIds()).toEqual(['dev-b'])
    expect(agentJson().hostId).toBe('host-keep-me')
    expect(statSync(AUTH_KEYS).mode & 0o777).toBe(0o600)
    expect(statSync(AGENT_JSON).mode & 0o777).toBe(0o600)
  })
})

describe('pairing POST vs revoke', () => {
  // The pairing POST mutates the same two files: it APPENDS to authorized_keys and upserts into
  // agent.json. Overlapping a revoke, an unserialized pairing either appends onto the inode the
  // revoke is about to rename over, or loses its agent.json entry to the revoke's stale read —
  // and the revoke can equally be undone by the pairing's. Both mutations must share ONE queue.
  it('a pairing landing mid-revoke keeps both changes', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as {
        token: string
        pairPort: number
      }
      gateReads([AGENT_JSON, AUTH_KEYS])

      const [respText] = await Promise.all([
        post(pairPort, { token, publicKey: freshEd25519Line(), deviceName: 'New Phone' }),
        service.revokeDevice('dev-a')
      ])

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      const keys = authKeys()
      expect(keys).not.toContain('nodeterm-ios-dev-a') // the revoke stuck
      expect(keys).toContain(`nodeterm-mobile-${deviceId}`) // …and so did the pairing
      expect(keys).toContain(KEY_OTHER)
      expect(deviceIds()).toEqual(['dev-b', deviceId])
    } finally {
      service.stop()
    }
  })
})

describe('pairing remembers the phone’s relay device id', () => {
  // Two ids are in play and only ONE of them means anything to the relay backend: the desktop
  // mints a local `deviceId` (it stamps the authorized_keys comment), while `relay_devices` is
  // keyed on the id the PHONE sends. agent.json used to keep only the local one — the phone's was
  // computed for the mint and thrown away — so "Remove device" had no way to name the row the
  // server holds.
  const hostKeys = genKeyPair()
  const relayDeps = (): PairingRelayDeps => ({
    getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
    getEntitlement: () => null,
    loadHostKeyPair: async () => hostKeys,
    relayEndpoint: 'wss://relay.example/ws',
    apiBase: 'https://api.example',
    relayAllowed: () => true
  })

  const devices = (): DeviceEntry[] => (agentJson().devices as DeviceEntry[] | undefined) ?? []
  const paired = (id: string): DeviceEntry => {
    const entry = devices().find((d) => d.id === id)
    if (!entry) throw new Error(`no agent.json entry for ${id}`)
    return entry
  }

  it('persists the id the phone sent, alongside the local one it does not replace', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'New Phone',
        deviceId: 'phone-abc'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe('phone-abc')
      // The local id still stamps the key line and still identifies the entry — the new field is
      // an addition, not a rename.
      expect(deviceId).not.toBe('phone-abc')
      expect(authKeys()).toContain(`nodeterm-mobile-${deviceId}`)
    } finally {
      service.stop()
    }
  })

  it('falls back to the local id when the phone sent none, so the two coincide', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'Quiet Phone'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe(deviceId)
    } finally {
      service.stop()
    }
  })

  it('sends the SAME id to /v1/relay/device that it records, and sends nothing else new', async () => {
    // Computing `phoneDeviceId` earlier (so persistDevice can have it) must not change one byte
    // of the mint body — this pins the whole body, so a reorder that accidentally passed the
    // LOCAL id, or added a field, fails here rather than in production.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
    const service = createPairingService(relayDeps())
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'Relay Phone',
        deviceId: 'phone-relay-1'
      })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.example/v1/relay/device')
      expect(JSON.parse(String(init.body))).toEqual({
        deviceId: 'phone-relay-1',
        hostDeviceId: 'test-host-device-id',
        hostPublicKeyB64: publicKeyToB64(hostKeys.publicKey),
        label: 'Relay Phone'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe('phone-relay-1')
    } finally {
      service.stop()
    }
  })
})

/** POST /pair SEALED, the way the Android/iOS app does: `{epk, box}` to the QR's host key. */
async function postSealedTo(hostKeys: KeyPair, port: number, body: unknown): Promise<Record<string, unknown>> {
  const eph = genKeyPair()
  const shared = deriveSharedKey(publicKeyToB64(hostKeys.publicKey), eph.secretKey)
  const box = encrypt(Uint8Array.from(Buffer.from(JSON.stringify(body), 'utf8')), shared)
  const text = await post(port, { epk: publicKeyToB64(eph.publicKey), box: Buffer.from(box).toString('base64') })
  const outer = JSON.parse(text) as { box: string }
  const plain = decrypt(Uint8Array.from(Buffer.from(outer.box, 'base64')), shared)
  return JSON.parse(Buffer.from(plain!).toString('utf8'))
}

describe('pairing pins the phone relay key it sent sealed (audit A07)', () => {
  // Pin-once used to mean "approve on the first relay connect", which the Auto route makes happen
  // away from the desk. The scan is already the human's approval — the same one-time token that
  // installs an SSH key — so the phone's box key, sent INSIDE the sealed body, is pinned here.
  const hostKeys = genKeyPair()
  const phoneBox = publicKeyToB64(genKeyPair().publicKey)
  const pins: string[] = []
  // Every key handed to `revokeRelayKey` — in the app, the peer revoker that unpins it AND closes
  // the relay sessions it has open (peer-revoker.ts; the cut itself is tested in standing-host.test).
  const revokes: string[] = []
  let revokeOutcome: () => Promise<{ persisted: boolean; killed: boolean }> = async () => ({ persisted: true, killed: true })
  const relayDeps = (withPin = true): PairingRelayDeps => ({
    getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
    getEntitlement: () => null,
    loadHostKeyPair: async () => hostKeys,
    relayEndpoint: 'wss://relay.example/ws',
    apiBase: 'https://api.example',
    relayAllowed: () => true,
    ...(withPin
      ? {
          pinRelayKey: async (pub: string) => void pins.push(pub),
          revokeRelayKey: async (pub: string) => (revokes.push(pub), revokeOutcome())
        }
      : {})
  })

  const postSealed = (port: number, body: unknown): Promise<Record<string, unknown>> => postSealedTo(hostKeys, port, body)

  beforeEach(() => {
    pins.length = 0
    revokes.length = 0
    revokeOutcome = async () => ({ persisted: true, killed: true })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
  })

  it('pins the sealed box key, says so, records it, and revokes it (pin and session) on revoke', async () => {
    const service = createPairingService(relayDeps())
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const resp = await postSealed(pairPort, { token, publicKey: freshEd25519Line(), deviceId: 'p1', boxPublicKey: phoneBox })
      expect(resp.relayPinned).toBe(true)
      expect(pins).toEqual([phoneBox])
      const entry = ((agentJson().devices as DeviceEntry[]) ?? []).find((d) => d.id === resp.deviceId)!
      expect(entry.relayBoxKey).toBe(phoneBox)
      await service.revokeDevice(String(resp.deviceId))
      expect(revokes).toEqual([phoneBox])
    } finally {
      service.stop()
    }
  })

  it('keeps the pin while another pairing of the same phone is still listed', async () => {
    const fallback = vi.fn(async () => ({ persisted: true, killed: true }))
    const service = createPairingService(relayDeps(), { revokePhoneRelayTrust: fallback })
    try {
      const first = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const a = await postSealed(first.pairPort, { token: first.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      const second = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      await postSealed(second.pairPort, { token: second.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      // Neither unpinned nor cut: the remaining pairing still authorizes this phone's relay session.
      expect(await service.revokeDevice(String(a.deviceId))).toEqual({ local: true, server: 'skipped', relay: 'retained' })
      expect(revokes).toEqual([])
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })

  it('revokes only the forgotten phone’s key; another phone keeps its pin and its session', async () => {
    const otherBox = publicKeyToB64(genKeyPair().publicKey)
    const service = createPairingService(relayDeps())
    try {
      const s1 = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const a = await postSealed(s1.pairPort, { token: s1.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      const s2 = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const b = await postSealed(s2.pairPort, { token: s2.token, publicKey: freshEd25519Line(), boxPublicKey: otherBox })
      await service.revokeDevice(String(a.deviceId))
      expect(revokes).toEqual([phoneBox])
      await service.revokeDevice(String(b.deviceId))
      expect(revokes).toEqual([phoneBox, otherBox])
    } finally {
      service.stop()
    }
  })

  it('reports the relay leg: done, or unpinned with a session it could not confirm closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = createPairingService(relayDeps())
    try {
      const pair = async () => {
        const s = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
        return String((await postSealed(s.pairPort, { token: s.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })).deviceId)
      }
      const clean = await pair()
      expect(await service.revokeDevice(clean)).toEqual({ local: true, server: 'skipped', relay: 'ok' })
      // The pin is gone, so the phone cannot come back; the UI must not call that a clean removal.
      revokeOutcome = async () => ({ persisted: true, killed: false })
      const halfCut = await pair()
      expect(await service.revokeDevice(halfCut)).toEqual({ local: true, server: 'skipped', relay: 'cut-unconfirmed' })
      expect(deviceIds()).not.toContain(halfCut)
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[pairing] could not close the phone relay session')
    } finally {
      service.stop()
      warn.mockRestore()
    }
  })

  // revocation.ts: `persisted:false` means the pin may SURVIVE, so the phone's next relay connect would
  // be approved with no dialog; the caller MUST retry and MUST NOT show "Removed". The device stays
  // listed (in its place) with `local:false`, and Revoke retries the whole revoke.
  it('a relay key it could not unpin keeps the device listed, so Revoke can be retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = createPairingService(relayDeps())
    try {
      for (const failed of [
        async () => ({ persisted: false, killed: true }),
        async () => ({ persisted: false, killed: false }),
        // A revoker that throws said nothing about the pin.
        async (): Promise<never> => {
          throw new Error('fixture')
        }
      ]) {
        seed()
        revokes.length = 0
        const s = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
        const resp = await postSealed(s.pairPort, { token: s.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
        const id = String(resp.deviceId)
        expect(deviceIds()).toEqual(['dev-a', 'dev-b', id])
        // The entry is gone from agent.json BEFORE the unpin is queued (the A07-late late pin must
        // not find it), whatever happens after.
        let listedDuringUnpin: string[] | null = null
        revokeOutcome = async () => {
          listedDuringUnpin = deviceIds()
          return failed()
        }
        // Moved to the front, so putting it back must restore its place, not append it.
        const reordered = agentJson()
        const all = reordered.devices as DeviceEntry[]
        writeFileSync(AGENT_JSON, JSON.stringify({ ...reordered, devices: [all[2], all[0], all[1]] }), { mode: 0o600 })

        expect(await service.revokeDevice(id)).toEqual({ local: false, server: 'skipped', relay: 'unpin-failed' })
        expect(listedDuringUnpin).toEqual(['dev-a', 'dev-b'])
        expect(deviceIds()).toEqual([id, 'dev-a', 'dev-b'])
        const kept = (agentJson().devices as DeviceEntry[])[0]
        expect(kept.relayBoxKey).toBe(phoneBox) // the record a retry needs
        expect(authKeys()).not.toContain(`nodeterm-ios-${id}`) // the SSH leg did go
        expect(statSync(AGENT_JSON).mode & 0o777).toBe(0o600)

        revokeOutcome = async () => ({ persisted: true, killed: true })
        expect(await service.revokeDevice(id)).toEqual({ local: true, server: 'skipped', relay: 'ok' })
        expect(deviceIds()).toEqual(['dev-a', 'dev-b'])
        expect(revokes).toEqual([phoneBox, phoneBox])
      }
    } finally {
      service.stop()
      warn.mockRestore()
    }
  })

  it('distinguishes an unconfirmed legacy relay identity from access retained by another pairing', async () => {
    const service = createPairingService(relayDeps())
    try {
      expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'skipped', relay: 'unconfirmed' })
      const first = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const a = await postSealed(first.pairPort, { token: first.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      const second = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      await postSealed(second.pairPort, { token: second.token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      expect(await service.revokeDevice(String(a.deviceId))).toEqual({ local: true, server: 'skipped', relay: 'retained' })
      expect(revokes).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('never pins a key from the PLAINTEXT body (it could be rewritten on the LAN)', async () => {
    const service = createPairingService(relayDeps())
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const resp = JSON.parse(await post(pairPort, { token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox }))
      expect(resp.ok).toBe(true)
      expect(resp.relayPinned).toBeUndefined()
      expect(pins).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('ignores a malformed key, and an older phone that sends none still pairs unchanged', async () => {
    const service = createPairingService(relayDeps())
    try {
      const s1 = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const bad = await postSealed(s1.pairPort, { token: s1.token, publicKey: freshEd25519Line(), boxPublicKey: 'not-a-key' })
      expect(bad.ok).toBe(true)
      expect(bad.relayPinned).toBeUndefined()
      const s2 = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const old = await postSealed(s2.pairPort, { token: s2.token, publicKey: freshEd25519Line() })
      expect(old.ok).toBe(true)
      expect(old.relayPinned).toBeUndefined()
      expect(pins).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('does not pin when the relay leg failed (nothing to connect through yet)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
    const service = createPairingService(relayDeps())
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const resp = await postSealed(pairPort, { token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox })
      expect(resp.relayPinned).toBeUndefined()
      expect(pins).toEqual([])
    } finally {
      service.stop()
    }
  })
})

describe('a paired phone whose relay key was recorded, not pinned, is approved on its first relay handshake (audit A07-late)', () => {
  // A phone paired while remote access was off gets no relay leg, so pairing records its sealed box
  // key without pinning it. Turning remote access on later lets the phone adopt the relay over SSH
  // (relay-advertise.ts), and its first relay connect used to raise the SAS dialog, typically at an
  // empty desk. The standing host now asks `approvePairedRelayKey` first.
  const hostKeys = genKeyPair()
  const phoneBox = publicKeyToB64(genKeyPair().publicKey)
  const stranger = publicKeyToB64(genKeyPair().publicKey)
  const pins: string[] = []
  const latePins: string[] = []
  const revokes: string[] = []
  let phoneAccess = false
  let pinThrows = false
  // The app asks `stillPaired` INSIDE the pin store's queue (pinApprovedDeviceIf, approved-devices.test).
  const latePin: NonNullable<PairingRelayDeps['pinRelayKeyIfPaired']> = async (pub, stillPaired) => {
    if (!(await stillPaired())) return false
    latePins.push(pub)
    return true
  }
  // `null` = not wired (a default parameter would replace `undefined`).
  const relayDeps = (late: PairingRelayDeps['pinRelayKeyIfPaired'] | null = latePin): PairingRelayDeps => ({
    getSettings: () => ({ phoneAccessEnabled: phoneAccess }) as unknown as Settings,
    getEntitlement: () => null,
    loadHostKeyPair: async () => hostKeys,
    relayEndpoint: 'wss://relay.example/ws',
    apiBase: 'https://api.example',
    relayAllowed: () => true,
    pinRelayKey: async (pub: string) => {
      if (pinThrows) throw new Error('fixture')
      pins.push(pub)
    },
    revokeRelayKey: async (pub: string) => (revokes.push(pub), { persisted: true, killed: true }),
    ...(late ? { pinRelayKeyIfPaired: late } : {})
  })
  const pairSealed = async (service: ReturnType<typeof createPairingService>, body: Record<string, unknown>) => {
    const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
    return postSealedTo(hostKeys, pairPort, { token, publicKey: freshEd25519Line(), ...body })
  }

  beforeEach(() => {
    pins.length = 0
    latePins.length = 0
    revokes.length = 0
    phoneAccess = false
    pinThrows = false
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
  })

  it('remote access off: records the key, pins nothing at the scan, promises approval, and pins it on the handshake', async () => {
    const service = createPairingService(relayDeps())
    try {
      const resp = await pairSealed(service, { deviceId: 'p1', boxPublicKey: phoneBox })
      expect(resp.relayDeviceToken).toBeUndefined()
      expect(resp.relayPinned).toBeUndefined()
      expect(resp.relayApproved).toBe(true)
      expect(pins).toEqual([]) // a LAN-only phone is not a relay phone until it connects through it
      const entry = ((agentJson().devices as DeviceEntry[]) ?? []).find((d) => d.id === resp.deviceId)!
      expect(entry.relayBoxKey).toBe(phoneBox)

      expect(await service.approvePairedRelayKey(phoneBox)).toBe(true)
      expect(latePins).toEqual([phoneBox])
      // A key no pairing recorded is the SAS dialog's, as before.
      expect(await service.approvePairedRelayKey(stranger)).toBe(false)
      expect(latePins).toEqual([phoneBox])
    } finally {
      service.stop()
    }
  })

  it('a revoked pairing no longer approves its key, unless another pairing of the same phone is listed', async () => {
    const service = createPairingService(relayDeps())
    try {
      const a = await pairSealed(service, { boxPublicKey: phoneBox })
      const b = await pairSealed(service, { boxPublicKey: phoneBox })
      await service.revokeDevice(String(a.deviceId))
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(true)
      await service.revokeDevice(String(b.deviceId))
      expect(revokes).toEqual([phoneBox]) // the A07-revoke unpin + cut, once the last pairing went
      latePins.length = 0
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(false)
      expect(latePins).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('a relay leg whose pin failed at the scan is still approved on the handshake', async () => {
    phoneAccess = true
    pinThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = createPairingService(relayDeps())
    try {
      const resp = await pairSealed(service, { boxPublicKey: phoneBox })
      expect(resp.relayDeviceToken).toBe('device-token')
      expect(resp.relayPinned).toBeUndefined()
      expect(resp.relayApproved).toBe(true)
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(true)
    } finally {
      service.stop()
      warn.mockRestore()
    }
  })

  it('a pinned pairing answers both fields', async () => {
    phoneAccess = true
    const service = createPairingService(relayDeps())
    try {
      const resp = await pairSealed(service, { boxPublicKey: phoneBox })
      expect(resp.relayPinned).toBe(true)
      expect(resp.relayApproved).toBe(true)
      expect(pins).toEqual([phoneBox])
    } finally {
      service.stop()
    }
  })

  it('a key from the PLAINTEXT body is never recorded, promised or approved', async () => {
    const service = createPairingService(relayDeps())
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const resp = JSON.parse(await post(pairPort, { token, publicKey: freshEd25519Line(), boxPublicKey: phoneBox }))
      expect(resp.ok).toBe(true)
      expect(resp.relayApproved).toBeUndefined()
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(false)
      expect(latePins).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('without the late pin wired, the answer promises nothing the standing host would not keep', async () => {
    const service = createPairingService(relayDeps(null))
    try {
      const resp = await pairSealed(service, { boxPublicKey: phoneBox })
      expect(resp.relayApproved).toBeUndefined()
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('a key no pairing recorded is answered without the pin store (review of A07-late)', async () => {
    // The standing host asks on EVERY unpinned handshake, and most of those keys were never recorded
    // (iOS phones, pre-A07 pairings, strangers). Their "no" must not queue behind, read or write the
    // pin store before the dialog: the browse socket could close inside that window.
    const asked: string[] = []
    const service = createPairingService(relayDeps(async (pub, stillPaired) => (asked.push(pub), latePin(pub, stillPaired))))
    try {
      expect(await service.approvePairedRelayKey(stranger)).toBe(false)
      expect(asked).toEqual([])
      await pairSealed(service, { boxPublicKey: phoneBox })
      expect(await service.approvePairedRelayKey(stranger)).toBe(false)
      expect(asked).toEqual([])
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(true)
      expect(asked).toEqual([phoneBox]) // a recorded key is still asked again inside the queue
    } finally {
      service.stop()
    }
  })

  it('a malformed key never reaches the pin store, and a failed check falls back to the dialog', async () => {
    const asked: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = createPairingService(
      relayDeps(async (pub) => {
        asked.push(pub)
        throw new Error('fixture')
      })
    )
    try {
      expect(await service.approvePairedRelayKey('not-a-key')).toBe(false)
      expect(await service.approvePairedRelayKey('')).toBe(false)
      expect(asked).toEqual([])
      await pairSealed(service, { boxPublicKey: phoneBox }) // recorded, so the pin store is asked
      expect(await service.approvePairedRelayKey(phoneBox)).toBe(false)
      expect(asked).toEqual([phoneBox])
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[pairing] could not pin a paired phone relay key:')
    } finally {
      service.stop()
      warn.mockRestore()
    }
  })
})

describe('the sealed answer carries this computer’s SSH host key fingerprints (audit A49-anchor)', () => {
  // The phone's first SSH connect used to pin whichever key answered at the paired address (once that
  // server had accepted the phone's key). The `/pair` exchange is already bound to the host key on
  // this screen, so the answer it seals now names the computer's own SSH host keys, and the first
  // connect is checked against them.
  const hostKeys = genKeyPair()
  // GitHub's published ed25519 host key and the fingerprint OpenSSH prints for it (an outside vector;
  // ssh-host-keys.test.ts has the format cases).
  const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl root@box'
  const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
  const relayDeps = (): PairingRelayDeps => ({
    getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
    getEntitlement: () => null,
    loadHostKeyPair: async () => hostKeys,
    relayEndpoint: 'wss://relay.example/ws',
    apiBase: 'https://api.example',
    relayAllowed: () => true
  })
  let keyDir = ''
  const withKeys = (): string => {
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(path.join(keyDir, 'ssh_host_ed25519_key.pub'), `${PUB}\n`)
    return keyDir
  }

  beforeEach(() => {
    keyDir = path.join(HOME, `etc-ssh-${randomBytes(4).toString('hex')}`)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
  })

  it('a sealed answer names them; the QR does not', async () => {
    const service = createPairingService(relayDeps(), { sshHostKeyDirs: [withKeys()] })
    try {
      const { payload } = await service.start(() => {})
      expect(payload).not.toContain(FP)
      expect(payload).not.toContain('sshHostKey')
      const { token, pairPort } = JSON.parse(payload) as { token: string; pairPort: number }
      const resp = await postSealedTo(hostKeys, pairPort, { token, publicKey: freshEd25519Line(), deviceId: 'p1' })
      expect(resp.ok).toBe(true)
      expect(resp.sshHostKeyFingerprints).toEqual([FP])
    } finally {
      service.stop()
    }
  })

  it('a plaintext answer never does (it could be rewritten on the LAN)', async () => {
    const service = createPairingService(relayDeps(), { sshHostKeyDirs: [withKeys()] })
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const text = await post(pairPort, { token, publicKey: freshEd25519Line(), deviceId: 'p2' })
      const resp = JSON.parse(text) as Record<string, unknown>
      expect(resp.ok).toBe(true)
      expect('sshHostKeyFingerprints' in resp).toBe(false)
      expect(text).not.toContain(FP)
    } finally {
      service.stop()
    }
  })

  it('keys it cannot read are left out, and the pairing goes on without the field', async () => {
    const junkDir = path.join(HOME, `etc-ssh-junk-${randomBytes(4).toString('hex')}`)
    mkdirSync(junkDir, { recursive: true })
    writeFileSync(path.join(junkDir, 'ssh_host_x_key.pub'), 'not a key\n')
    // No such directory, then one whose only "key" is not a key.
    for (const dir of [keyDir, junkDir]) {
      const service = createPairingService(relayDeps(), { sshHostKeyDirs: [dir] })
      try {
        const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
        const resp = await postSealedTo(hostKeys, pairPort, { token, publicKey: freshEd25519Line() })
        expect(resp.ok).toBe(true)
        expect('sshHostKeyFingerprints' in resp).toBe(false)
      } finally {
        service.stop()
      }
    }
  })

  it('a Windows desktop sends none: the phone has no SSH leg there', async () => {
    const service = createPairingService(relayDeps(), {
      sshHostKeyDirs: [withKeys()],
      platform: 'win32',
      detectKeyFile: async () => 'administrators',
      defaultRouteAddress: async () => null
    })
    try {
      const { token, pairPort } = JSON.parse((await service.start(() => {})).payload) as { token: string; pairPort: number }
      const resp = await postSealedTo(hostKeys, pairPort, { token, publicKey: freshEd25519Line(), deviceId: 'pw' })
      expect(resp.relayDeviceToken).toBe('device-token')
      expect('sshHostKeyFingerprints' in resp).toBe(false)
    } finally {
      service.stop()
    }
  })
})

describe('pairing names the phone platform-neutrally', () => {
  const nameOf = (id: string): string | undefined =>
    ((agentJson().devices as DeviceEntry[] | undefined) ?? []).find((d) => d.id === id)?.name

  async function pairWith(body: Record<string, unknown>): Promise<string> {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }
      const respText = await post(pairPort, { token, ...body })
      return (JSON.parse(respText) as { deviceId: string }).deviceId
    } finally {
      service.stop()
    }
  }

  it('an iOS app pairing (no deviceName, nodeterm-ios key) is still listed as iPhone', async () => {
    const deviceId = await pairWith({ publicKey: freshEd25519Line('nodeterm-ios') })
    expect(nameOf(deviceId)).toBe('iPhone')
    // ...and its key is stamped with the NEW comment, not the phone's own one.
    expect(authKeys()).toContain(`nodeterm-mobile-${deviceId}`)
    expect(authKeys()).not.toContain(`nodeterm-ios-${deviceId}`)
  })

  it('an Android pairing keeps the name it sent', async () => {
    const deviceId = await pairWith({
      publicKey: freshEd25519Line('nodeterm-android'),
      deviceName: 'Android'
    })
    expect(nameOf(deviceId)).toBe('Android')
  })

  it('a nameless pairing from an unknown client is "Phone", never "iPhone"', async () => {
    const deviceId = await pairWith({ publicKey: freshEd25519Line('someone@else') })
    expect(nameOf(deviceId)).toBe('Phone')
  })

  it('a hostile multi-line name lands as one capped line', async () => {
    const deviceId = await pairWith({
      publicKey: freshEd25519Line('nodeterm-android'),
      deviceName: `Evil\nName\r\n${'y'.repeat(500)}`
    })
    const stored = nameOf(deviceId) ?? ''
    expect(stored).not.toMatch(/[\r\n]/)
    expect(Array.from(stored).length).toBeLessThanOrEqual(64)
    expect(stored.startsWith('Evil Name y')).toBe(true)
  })
})
