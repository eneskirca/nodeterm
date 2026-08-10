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

import os from 'os'
import { createPairingService } from './pairing-service'
import { rewriteKeyComment, type DeviceEntry } from './pairing-core'

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
const KEY_A = rewriteKeyComment('ssh-ed25519 AAAAblobAAAA phone-a@ios', 'dev-a')
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
function freshEd25519Line(): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  const blob = Buffer.concat([len(name.length), name, len(32), randomBytes(32)])
  return `ssh-ed25519 ${blob.toString('base64')} phone@ios`
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
    expect(keys).not.toContain('nodeterm-ios-dev-b')
    expect(keys).toContain(KEY_OTHER) // the user's own key was never in scope
    expect(deviceIds()).toEqual([])
    expect(agentJson().hostId).toBe('host-keep-me') // fields we don't own survive the rewrite
    // Neither revoke may report failure to its caller either.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('a failed revoke rejects to its caller and does not block the next one', async () => {
    const service = createPairingService()
    // First rename is agent.json's, inside the failing revoke.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(service.revokeDevice('dev-a')).rejects.toThrow(/EXDEV/)
    // A serializer that chains failures onto its successors would strand every later revoke.
    await service.revokeDevice('dev-b')

    const keys = authKeys()
    expect(keys).not.toContain('nodeterm-ios-dev-b')
    expect(keys).toContain('nodeterm-ios-dev-a') // the failed revoke really did fail
    expect(deviceIds()).toEqual(['dev-a'])
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
      expect(keys).toContain(`nodeterm-ios-${deviceId}`) // …and so did the pairing
      expect(keys).toContain(KEY_OTHER)
      expect(deviceIds()).toEqual(['dev-b', deviceId])
    } finally {
      service.stop()
    }
  })
})
