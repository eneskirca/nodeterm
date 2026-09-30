import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { promises as fs, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'

const TEMP_HOME_MARKER = 'nt-revoke-'

// Same hoisted redirect as pairing-service.test.ts: the service resolves AGENT_JSON_PATH /
// AUTH_KEYS_PATH from `os.homedir()` at MODULE LOAD, so the temp home has to exist before the
// import. Everything else about `os` stays real.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  // Literal, not TEMP_HOME_MARKER: this factory is hoisted above every module-level binding.
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-revoke-'))
  const homedir = (): string => home
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  return { ...actual, homedir, default: { ...base, homedir } }
})

vi.mock('../core/device-id', () => ({ getDeviceId: () => 'test-host-device-id' }))

import os from 'os'
import {
  createPairingService,
  revokeRelayDevice,
  type PairingRelayDeps
} from './pairing-service'
import { rewriteKeyComment, type DeviceEntry } from './pairing-core'
import type { Settings } from '../shared/types'

const HOME = os.homedir()
const AGENT_JSON = path.join(HOME, '.nodeterm', 'agent.json')
const AUTH_KEYS = path.join(HOME, '.ssh', 'authorized_keys')

/** Refuse to run (and to delete anything) unless HOME is demonstrably our mkdtemp dir. */
function assertTempHome(): void {
  if (!path.basename(HOME).startsWith(TEMP_HOME_MARKER)) {
    throw new Error(
      `pairing-revoke.test refuses to run: homedir() is "${HOME}", not a ${TEMP_HOME_MARKER}* ` +
        'temp dir. The os mock is not in effect and this file would delete the real ~/.ssh.'
    )
  }
}
assertTempHome()

const KEY_A = rewriteKeyComment('ssh-ed25519 AAAAblobAAAA phone-a@ios', 'dev-a')
const KEY_OTHER = 'ssh-rsa AAAAlaptopblob jdub@laptop'

const device = (id: string, relayDeviceId?: string): DeviceEntry => ({
  id,
  name: `Phone ${id}`,
  token: `agent-token-${id}`,
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 0,
  relayDeviceId
})

/** Seed a registry holding ONE device; `relayDeviceId` is what the phone called itself. */
const seed = (relayDeviceId?: string): void => {
  rmSync(path.join(HOME, '.nodeterm'), { recursive: true, force: true })
  rmSync(path.join(HOME, '.ssh'), { recursive: true, force: true })
  mkdirSync(path.join(HOME, '.nodeterm'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(HOME, '.ssh'), { recursive: true, mode: 0o700 })
  writeFileSync(
    AGENT_JSON,
    JSON.stringify({ hostId: 'host-keep-me', devices: [device('dev-a', relayDeviceId)] }, null, 2) +
      '\n',
    { mode: 0o600 }
  )
  writeFileSync(AUTH_KEYS, `${KEY_OTHER}\n${KEY_A}\n`, { mode: 0o600 })
}

const agentJson = (): { devices?: DeviceEntry[] } => JSON.parse(readFileSync(AGENT_JSON, 'utf8'))
const deviceIds = (): string[] => (agentJson().devices ?? []).map((d) => d.id)
const authKeys = (): string => readFileSync(AUTH_KEYS, 'utf8')

/** Relay deps carrying an entitlement, i.e. a Pro desktop that CAN authorize a revoke. */
const relayDeps = (entitlement: string | null): PairingRelayDeps => ({
  getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
  getEntitlement: () => entitlement,
  loadHostKeyPair: async () => {
    throw new Error('not used by revoke')
  },
  relayEndpoint: 'wss://relay.example',
  apiBase: 'https://api.x',
  relayAllowed: () => true
})

const fetchBody = (mock: ReturnType<typeof vi.fn>): unknown =>
  JSON.parse((mock.mock.calls[0][1] as { body: string }).body)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

afterAll(() => {
  assertTempHome()
  rmSync(HOME, { recursive: true, force: true })
})

describe('revokeRelayDevice', () => {
  it('posts the phone id with the host entitlement and reports ok on 204', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await revokeRelayDevice('https://api.x', 'phone-1', 'TOKEN')).toBe('ok')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string }
    ]
    // The deviceId is phone-supplied, unvalidated text: it rides the JSON BODY, never a URL.
    expect(String(url)).toBe('https://api.x/v1/relay/device/revoke')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ deviceId: 'phone-1', entitlement: 'TOKEN' })
  })

  // 403 is the route's only real refusal ("that row is someone else's"), 401 a token that did not
  // verify. Both are things we TRIED and were told no — never 'skipped', which claims we didn't ask.
  it.each([403, 401, 500])('reports failed — never a silent success — on %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })))
    expect(await revokeRelayDevice('https://api.x', 'phone-1', 'TOKEN')).toBe('failed')
  })

  it('reports failed when the request throws (offline)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      })
    )
    expect(await revokeRelayDevice('https://api.x', 'phone-1', 'TOKEN')).toBe('failed')
  })

  it('gives up on a hung server rather than hanging the revoke forever', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = revokeRelayDevice('https://api.x', 'phone-1', 'TOKEN')
    await vi.advanceTimersByTimeAsync(9000)
    expect(await pending).toBe('failed')
  })

  // 'skipped' means "we did not ask, and that is fine" — a free-tier desktop holds no entitlement
  // to sign the request with, and has no Pro of ours on that phone to reclaim.
  it('skips — without calling the server — when there is no entitlement to sign with', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await revokeRelayDevice('https://api.x', 'phone-1', null)).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips when there is no relay device id to name', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await revokeRelayDevice('https://api.x', '', 'TOKEN')).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips when there is no API base, instead of fetching a relative URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await revokeRelayDevice('', 'phone-1', 'TOKEN')).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createPairingService().revokeDevice', () => {
  beforeEach(() => {
    seed('phone-relay-1')
  })

  it('names the PHONE’s relay device id, not our local one, and reports both legs', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService(relayDeps('TOKEN'))

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'ok' })

    // 'dev-a' is OUR id; the backend keys its row on the id the phone sent.
    expect(fetchBody(fetchMock)).toEqual({ deviceId: 'phone-relay-1', entitlement: 'TOKEN' })
    expect(deviceIds()).toEqual([])
    expect(authKeys()).toBe(`${KEY_OTHER}\n`)
  })

  // A device paired before `relayDeviceId` was recorded is the population this whole task exists
  // to protect, and skipping it was a real leak: when the phone sent no id of its own, the mint
  // keyed the row on OUR per-pairing id — the same value `revokeDevice` is called with — so the
  // row can be named after all. (That id is a randomUUID per pairing, never this desktop's own
  // `getDeviceId()`, which is not a key in relay_devices at all.)
  it('falls back to our own id for a device paired before relayDeviceId was recorded', async () => {
    seed(undefined)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService(relayDeps('TOKEN'))

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'ok' })
    expect(fetchBody(fetchMock)).toEqual({ deviceId: 'dev-a', entitlement: 'TOKEN' })
    expect(deviceIds()).toEqual([])
  })

  it('skips the server on a free-tier desktop, and still removes the device locally', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService(relayDeps(null))

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'skipped' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(deviceIds()).toEqual([])
  })

  it('skips the server when the service has no relay deps at all', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService()

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'skipped' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the server leg as failed while the local removal still stuck', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))
    const service = createPairingService(relayDeps('TOKEN'))

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'failed' })
    expect(deviceIds()).toEqual([])
    expect(authKeys()).toBe(`${KEY_OTHER}\n`)
  })

  // A half-finished revoke must never render as a clean one (the discipline remote/revocation.ts
  // states in its header), and the Pro is still worth reclaiming when the local files would not
  // budge — the entitlement is what authorizes the server leg, not the local write's success.
  it('reports local:false when the registry write fails, and still reclaims the Pro', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService(relayDeps('TOKEN'))
    vi.spyOn(fs, 'rename').mockImplementation(async (_from, to) => {
      if (String(to).includes('agent.json')) {
        throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
      }
    })

    expect(await service.revokeDevice('dev-a')).toEqual({ local: false, server: 'ok' })
    expect(fetchBody(fetchMock)).toEqual({ deviceId: 'phone-relay-1', entitlement: 'TOKEN' })
  })

  // The fallback above is licensed by there BEING a device — an id that names no pairing names no
  // row either, and asking about it would be a request we cannot justify (and a 204 we would then
  // report as 'ok').
  it('skips the server for an id that is not in the registry', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const service = createPairingService(relayDeps('TOKEN'))

    expect(await service.revokeDevice('never-paired')).toEqual({ local: true, server: 'skipped' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createPairingService().revokeDevice — relay trust (pinned box key + live sessions)', () => {
  beforeEach(() => {
    seed('phone-relay-1')
  })

  it('revokes the relay trust BEFORE the SSH key and the registry entry are removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 })))
    const order: string[] = []
    const revokePhoneRelayTrust = vi.fn(async () => {
      // At this instant the device must still be listed and its key still installed.
      order.push(`relay:${deviceIds().join(',')}:${authKeys().includes('dev-a') ? 'key' : 'nokey'}`)
      return { persisted: true, killed: true }
    })
    const service = createPairingService(relayDeps('TOKEN'), { revokePhoneRelayTrust })

    expect(await service.revokeDevice('dev-a')).toEqual({ local: true, server: 'ok' })
    expect(revokePhoneRelayTrust).toHaveBeenCalledOnce()
    expect(order).toEqual(['relay:dev-a:key'])
    expect(deviceIds()).toEqual([])
  })

  it('a relay trust revoke that did not stick reports local:false and keeps the device listed to retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 })))
    for (const relay of [{ persisted: false, killed: true }, { persisted: true, killed: false }]) {
      seed('phone-relay-1')
      const service = createPairingService(relayDeps('TOKEN'), {
        revokePhoneRelayTrust: async () => relay
      })
      const result = await service.revokeDevice('dev-a')
      expect(result.local).toBe(false)
      expect(deviceIds()).toEqual(['dev-a'])
      expect(authKeys()).toContain('dev-a')
    }
  })

  it('never touches relay trust for an id that is not in the registry', async () => {
    const revokePhoneRelayTrust = vi.fn(async () => ({ persisted: true, killed: true }))
    const service = createPairingService(relayDeps('TOKEN'), { revokePhoneRelayTrust })
    await service.revokeDevice('never-paired')
    expect(revokePhoneRelayTrust).not.toHaveBeenCalled()
  })
})
