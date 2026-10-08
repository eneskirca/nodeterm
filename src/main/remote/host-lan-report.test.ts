// Audit A74-refresh: what this computer reports about its own direct-SSH leg beside every relay
// `projects.list` answer, and that the answer carries it additively.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { createHostLanReporter, HOST_KEYS_TTL_MS, type HostLanReport } from './host-lan-report'
import { pairingNetworkIPv4, type PairingNetworkAddress } from '../../shared/pairing-network'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'

// GitHub's published host keys and the fingerprints OpenSSH prints for them (the same outside vector
// ssh-host-keys.test.ts uses): the format the sealed /pair answer already carries.
const GITHUB_ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const GITHUB_ED25519_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
const GITHUB_ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg='
const GITHUB_ECDSA_FP = 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM'

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nt-lan-report-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A laptop with loopback, a link-local leftover, Wi-Fi and a Docker bridge, in the order the OS lists them. */
const LAPTOP: Record<string, PairingNetworkAddress[]> = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
  wlan0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.42', family: 'IPv4', internal: false }
  ],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }]
}

const noKeys = (): string[] => [path.join(tempDir(), 'missing')]

describe('createHostLanReporter', () => {
  it('reports the address the pairing QR would carry and the host keys the sealed answer names', async () => {
    const keys = tempDir()
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519} root@box\n`)
    writeFileSync(path.join(keys, 'ssh_host_ecdsa_key.pub'), `${GITHUB_ECDSA} root@box\n`)
    const report = await createHostLanReporter({ platform: 'linux', interfaces: () => LAPTOP, sshHostKeyDirs: [keys] })()
    // The same pick as the QR's `host` (pairing-service.ts), not a second opinion about it.
    expect(report?.host).toBe(pairingNetworkIPv4(LAPTOP))
    expect(report).toEqual({ host: '192.168.1.42', sshHostKeyFingerprints: [GITHUB_ECDSA_FP, GITHUB_ED25519_FP] })
  })

  it('leaves out what it does not know, and answers null when it knows nothing', async () => {
    const keys = tempDir()
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519}\n`)
    const offline = { lo: LAPTOP.lo }
    expect(await createHostLanReporter({ platform: 'linux', interfaces: () => offline, sshHostKeyDirs: [keys] })()).toEqual({
      sshHostKeyFingerprints: [GITHUB_ED25519_FP]
    })
    expect(await createHostLanReporter({ platform: 'darwin', interfaces: () => LAPTOP, sshHostKeyDirs: noKeys() })()).toEqual({
      host: '192.168.1.42'
    })
    expect(await createHostLanReporter({ platform: 'linux', interfaces: () => offline, sshHostKeyDirs: noKeys() })()).toBeNull()
    // A failing interface read is "no address", never a rejection.
    const broken = createHostLanReporter({
      platform: 'linux',
      interfaces: () => {
        throw new Error('EPERM')
      },
      sshHostKeyDirs: [keys]
    })
    expect(await broken()).toEqual({ sshHostKeyFingerprints: [GITHUB_ED25519_FP] })
  })

  it('reports nothing on Windows, which pairs relay-only (no SSH leg to refresh)', async () => {
    const keys = tempDir()
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519}\n`)
    const interfaces = vi.fn(() => LAPTOP)
    expect(await createHostLanReporter({ platform: 'win32', interfaces, sshHostKeyDirs: [keys] })()).toBeNull()
    expect(interfaces).not.toHaveBeenCalled()
  })

  it('reads the host keys once a minute, the address every time', async () => {
    const keys = tempDir()
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519}\n`)
    let t = 1_000
    let addr = '192.168.1.42'
    const report = createHostLanReporter({
      platform: 'linux',
      interfaces: () => ({ wlan0: [{ address: addr, family: 'IPv4', internal: false }] }),
      sshHostKeyDirs: [keys],
      now: () => t
    })
    expect(await report()).toEqual({ host: '192.168.1.42', sshHostKeyFingerprints: [GITHUB_ED25519_FP] })
    // The keys are regenerated and the lease moves within the minute: the address is new at once…
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ECDSA}\n`)
    addr = '192.168.1.77'
    t += HOST_KEYS_TTL_MS - 1
    expect(await report()).toEqual({ host: '192.168.1.77', sshHostKeyFingerprints: [GITHUB_ED25519_FP] })
    // …and the keys are re-read once the minute is up.
    t += 1
    expect(await report()).toEqual({ host: '192.168.1.77', sshHostKeyFingerprints: [GITHUB_ECDSA_FP] })
  })

  it('prefers a LAN adapter ahead of an earlier container or tunnel address', async () => {
    const report = createHostLanReporter({ platform: 'linux', interfaces: () => ({
      docker0: LAPTOP.docker0, wg0: [{ address: '10.7.0.2', family: 4, internal: false }], wlan0: LAPTOP.wlan0
    }), sshHostKeyDirs: noKeys() })
    expect(await report()).toEqual({ host: '192.168.1.42' })
  })

  it('rereads the selected interface and DHCP address but never substitutes for an absent selection', async () => {
    const keys = tempDir()
    writeFileSync(path.join(keys, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519}\n`)
    let selected = 'wg0'
    let tunnel = '10.7.0.2'
    const report = createHostLanReporter({ platform: 'darwin', getPairingInterface: () => selected,
      interfaces: () => ({ ...LAPTOP, ...(tunnel ? { wg0: [{ address: tunnel, family: 4, internal: false }] } : {}) }),
      sshHostKeyDirs: [keys] })
    expect(await report()).toEqual({ host: '10.7.0.2', sshHostKeyFingerprints: [GITHUB_ED25519_FP] })
    tunnel = '10.7.0.9'
    expect((await report())?.host).toBe('10.7.0.9')
    tunnel = ''
    expect(await report()).toEqual({ sshHostKeyFingerprints: [GITHUB_ED25519_FP] })
    selected = 'wlan0'
    expect((await report())?.host).toBe('192.168.1.42')
    selected = ''
    expect((await report())?.host).toBe('192.168.1.42')
  })
})

// --- the projects.list answer --------------------------------------------------------------------

function fakes() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  return { socket, responses, fs, pty: {} as HostPtyManager }
}

/** Every pending promise chain settles before a macrotask runs. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** createHostHandlers' positional arguments up to and including `lanReport`. */
function handlersWith(
  f: ReturnType<typeof fakes>,
  listProjects: () => Promise<string>,
  lanReport?: () => Promise<HostLanReport | null>
) {
  return createHostHandlers(
    f.pty,
    f.socket,
    f.fs,
    () => [],
    listProjects,
    () => null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lanReport
  )
}

describe('projects.list carries the LAN report beside the blob (A74-refresh)', () => {
  it('adds `lan` next to `output`, leaving the blob as it was', async () => {
    const f = fakes()
    const lan = { host: '192.168.1.42', sshHostKeyFingerprints: [GITHUB_ED25519_FP] }
    handlersWith(f, async () => 'BLOB', async () => lan).onRpc({ id: '1', method: 'projects.list', params: undefined })
    await settle()
    expect(f.responses).toEqual([{ id: '1', ok: true, body: { output: 'BLOB', lan } }])
  })

  it('reads the report per request, so a moved lease reaches the next listing', async () => {
    const f = fakes()
    let host = '192.168.1.42'
    const h = handlersWith(f, async () => 'BLOB', async () => ({ host }))
    h.onRpc({ id: '1', method: 'projects.list', params: undefined })
    await settle()
    host = '10.0.0.9'
    h.onRpc({ id: '2', method: 'projects.list', params: undefined })
    await settle()
    expect(f.responses.map((r) => (r.body as { lan?: { host: string } }).lan?.host)).toEqual(['192.168.1.42', '10.0.0.9'])
  })

  it('leaves `lan` out when there is nothing to report, the report fails, or nobody wired one', async () => {
    const f = fakes()
    handlersWith(f, async () => 'A', async () => null).onRpc({ id: '1', method: 'projects.list', params: undefined })
    handlersWith(f, async () => 'B', async () => {
      throw new Error('boom')
    }).onRpc({ id: '2', method: 'projects.list', params: undefined })
    handlersWith(f, async () => 'C', () => {
      throw new Error('sync boom')
    }).onRpc({ id: '3', method: 'projects.list', params: undefined })
    handlersWith(f, async () => 'D').onRpc({ id: '4', method: 'projects.list', params: undefined })
    await settle()
    expect([...f.responses].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: '1', ok: true, body: { output: 'A' } },
      { id: '2', ok: true, body: { output: 'B' } },
      { id: '3', ok: true, body: { output: 'C' } },
      { id: '4', ok: true, body: { output: 'D' } }
    ])
  })

  it('still reports the computer when the blob could not be built', async () => {
    const f = fakes()
    handlersWith(f, async () => {
      throw new Error('workspace unreadable')
    }, async () => ({ host: '192.168.1.42' })).onRpc({ id: '1', method: 'projects.list', params: undefined })
    await settle()
    expect(f.responses).toEqual([{ id: '1', ok: true, body: { output: '', lan: { host: '192.168.1.42' } } }])
  })
})
