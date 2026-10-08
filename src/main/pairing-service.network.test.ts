// Actual PairingService HTTP listener and payload; only the OS adapter list, SSH probe and
// homedir are isolated. No POST installs a key or contacts the hosted relay.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { get as httpGet } from 'http'
import { rmSync } from 'fs'
import path from 'path'

vi.mock('os', async (load) => {
  const actual = await load<typeof import('os')>()
  const { mkdtempSync } = await import('fs')
  const { join } = await import('path')
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-pairing-network-'))
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  return { ...actual, homedir: () => home, default: { ...base, homedir: () => home } }
})
vi.mock('net', async (load) => {
  const actual = await load<typeof import('net')>()
  const { EventEmitter } = await import('events')
  return { ...actual, connect: () => {
    const socket = Object.assign(new EventEmitter(), { destroy: () => {}, setTimeout: () => {} })
    queueMicrotask(() => socket.emit('error', new Error('isolated SSH probe')))
    return socket
  } }
})

import os from 'os'
import { createPairingService, type PairingService } from './pairing-service'
import type { PairingInterfaces } from '../shared/pairing-network'

const services: PairingService[] = []
const interfaces = (): PairingInterfaces => ({
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  wg0: [{ address: '10.7.0.2', family: 4, internal: false }],
  wlan0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
})
const service = (options: Parameters<typeof createPairingService>[1]): PairingService => {
  const created = createPairingService(undefined, { ...options, sshHostKeyDirs: [path.join(os.homedir(), 'fixture-no-hostkeys')] })
  services.push(created)
  return created
}
afterEach(() => services.splice(0).forEach((created) => created.stop()))
afterAll(() => {
  const home = os.homedir()
  if (!path.basename(home).startsWith('nt-pairing-network-')) throw new Error('foreign homedir')
  rmSync(home, { recursive: true, force: true })
})
const get = (port: number): Promise<number | undefined> => new Promise((resolve, reject) => {
  const request = httpGet({ host: '127.0.0.1', port, path: '/pair', agent: false }, (response) => {
    response.resume()
    response.on('end', () => resolve(response.statusCode))
  })
  request.on('error', reject)
})
async function payload(created: PairingService): Promise<{ host: string; pairPort: number; ssh?: false }> {
  return JSON.parse((await created.start(() => {})).payload)
}

describe('PairingService current adapter selection', () => {
  it('lists the real injected interfaces afresh and stores no IP snapshot', () => {
    let current = interfaces()
    const created = service({ interfaces: () => current })
    expect(created.listNetworks()).toEqual([
      { interfaceName: 'docker0', address: '172.17.0.1' },
      { interfaceName: 'wg0', address: '10.7.0.2' },
      { interfaceName: 'wlan0', address: '192.168.1.42' },
    ])
    current = { wlan0: [{ address: '192.168.1.77', family: 4, internal: false }] }
    expect(created.listNetworks()).toEqual([{ interfaceName: 'wlan0', address: '192.168.1.77' }])
  })

  it('advertises the LAN adapter ahead of earlier Docker and tunnel addresses in an actual HTTP QR', async () => {
    const route = vi.fn(async () => '10.7.0.2')
    const created = service({ platform: 'linux', interfaces, defaultRouteAddress: route })
    const qr = await payload(created)
    expect(qr.host).toBe('192.168.1.42')
    expect(await get(qr.pairPort)).toBe(404)
    expect(route).not.toHaveBeenCalled()
  })

  it('follows explicit interface selection and its current DHCP address at each actual start', async () => {
    let current = interfaces()
    let selected = 'wg0'
    const created = service({ platform: 'darwin', interfaces: () => current, getPairingInterface: () => selected })
    expect((await payload(created)).host).toBe('10.7.0.2')
    current = { ...current, wg0: [{ address: '10.7.0.9', family: 4, internal: false }] }
    expect((await payload(created)).host).toBe('10.7.0.9')
    selected = 'wlan0'
    expect((await payload(created)).host).toBe('192.168.1.42')
  })

  it('retires the old listener and refuses a missing explicit adapter instead of advertising a different one', async () => {
    let selected = 'wlan0'
    const created = service({ interfaces, getPairingInterface: () => selected })
    const prior = await payload(created)
    selected = 'en9'
    await expect(created.start(() => {})).rejects.toThrow('selected pairing network “en9” has no usable IPv4')
    await expect(get(prior.pairPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('keeps a valid Windows route hint, but an explicit adapter takes precedence', async () => {
    let selected = ''
    const route = vi.fn(async () => '10.7.0.2')
    const created = service({ platform: 'win32', interfaces, getPairingInterface: () => selected,
      defaultRouteAddress: route, detectKeyFile: async () => 'profile' })
    expect(await payload(created)).toMatchObject({ host: '10.7.0.2', ssh: false })
    selected = 'wlan0'
    expect(await payload(created)).toMatchObject({ host: '192.168.1.42', ssh: false })
    expect(route).toHaveBeenCalledTimes(1)
  })

  it('rereads the saved choice and current addresses after a slow Windows route hint', async () => {
    let selected = ''
    let current = interfaces()
    let release!: (address: string) => void
    const created = service({ platform: 'win32', interfaces: () => current, getPairingInterface: () => selected,
      defaultRouteAddress: () => new Promise((resolve) => { release = resolve }), detectKeyFile: async () => 'profile' })
    const pending = payload(created)
    selected = 'wlan0'
    current = { wlan0: [{ address: '192.168.1.77', family: 4, internal: false }] }
    release('10.7.0.2')
    expect(await pending).toMatchObject({ host: '192.168.1.77', ssh: false })
  })
})
