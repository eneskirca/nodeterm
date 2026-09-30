import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  startTeamAdmin,
  callTeamAdmin,
  adminSocketPath,
  socketPathProblem,
  ownerKeyProblem,
  ownerLabelProblem,
  projectIdProblem,
  parseAdminRequest,
  ADMIN_REQUEST_MAX,
  type AdminReply
} from './team-admin'
import { createHostKey } from './host-key'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import type { HostedService, HostedStatus } from './hosted-service'

// A unix socket path is limited to ~107 bytes, and a long mkdtemp path (macOS's /var/folders/…)
// alone can eat most of that, so every socket test lives under a SHORT base.
const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()
const made: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(SHORT_BASE, 'nta-'))
  made.push(d)
  return d
}
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const relayDir = (dataDir: string): string => path.join(dataDir, 'relay')
const writeTeam = (dataDir: string): void => {
  fs.mkdirSync(relayDir(dataDir), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(relayDir(dataDir), 'team.json'), JSON.stringify({ v: 1, peers: [], sharedProjects: [] }))
}
const validKey = (): string => publicKeyToB64(genKeyPair().publicKey)

const INFO = { relayEndpoint: 'wss://r', hostId: 'H', hostPublicKeyB64: 'P', hostDeviceId: 'D', label: 'box' }
const offStatus: HostedStatus = { enabled: false, scheduler: null, peers: [], pending: [] }
const onStatus: HostedStatus = {
  enabled: true,
  scheduler: { state: 'running', lastError: null, mintsLastHour: 1, idle: 1, bridged: 0 },
  peers: [],
  pending: []
}

interface FakeOpts {
  running?: boolean
  start?: string
  rotate?: string
  remove?: 'removed' | 'last-owner' | 'unknown'
  initThrows?: Error
}
function fakeService(o: FakeOpts = {}): { svc: HostedService; calls: string[] } {
  const calls: string[] = []
  let running = o.running ?? false
  const svc = {
    init: async () => {
      calls.push('init')
      if (o.initThrows) throw o.initThrows
      return { created: true }
    },
    start: async () => {
      calls.push('start')
      const r = o.start ?? 'started'
      if (r === 'started') running = true
      return r
    },
    stop: () => {
      calls.push('stop')
      running = false
    },
    addOwner: async (k: string, label: string) => {
      calls.push(`owner:${k}:${label}`)
    },
    remove: async (k: string, force: boolean) => {
      calls.push(`remove:${k}:${force}`)
      return o.remove ?? 'removed'
    },
    share: async (p: string, on: boolean) => {
      calls.push(`share:${p}:${on}`)
    },
    info: () => (running ? INFO : null),
    joinCode: () => (running ? 'nodeterm://join/CODE' : null),
    status: () => (running ? onStatus : offStatus),
    rotateKey: async () => {
      calls.push('rotate')
      const r = o.rotate ?? (running ? 'started' : 'not-running')
      return r
    }
  } as unknown as HostedService
  return { svc, calls }
}

async function boot(dataDir: string, svc: HostedService): Promise<void> {
  const admin = await startTeamAdmin(dataDir, svc)
  closers.push(() => admin.close())
}

/** Send raw bytes over the socket and collect whatever comes back until the server ends it. */
function rawExchange(dataDir: string, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(adminSocketPath(dataDir))
    let buf = ''
    c.setEncoding('utf8')
    c.on('connect', () => c.write(payload))
    c.on('data', (d) => (buf += d))
    c.on('close', () => resolve(buf))
    c.on('error', () => resolve(buf))
  })
}

// Trojan Source: a raw bidi control character in source is invisible in review and can make code read
// differently from how it runs. The admin/CLI sources name these characters, so they must do it with
// \u escapes only.
describe('no raw bidi control characters in the admin and CLI sources', () => {
  it('every one is written as an escape', () => {
    const bidi = new RegExp('[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]')
    const files = [
      path.join(__dirname, 'team-admin.ts'),
      path.join(__dirname, 'team-admin.test.ts'),
      path.join(__dirname, '../../server/team-cli.ts'),
      path.join(__dirname, '../../server/team-cli.test.ts')
    ]
    for (const f of files) expect(bidi.test(fs.readFileSync(f, 'utf8')), f).toBe(false)
  })
})

describe('validation helpers (platform-neutral)', () => {
  it('accepts a canonical 32-byte base64 key and says what is wrong with anything else', () => {
    expect(ownerKeyProblem(validKey())).toBeNull()
    expect(ownerKeyProblem('K')).toMatch(/32 bytes/)
    expect(ownerKeyProblem(Buffer.alloc(31).toString('base64'))).toMatch(/32 bytes.*31/)
    const k = validKey()
    // Missing padding still decodes to 32 bytes, but would never equal the key a peer presents.
    expect(ownerKeyProblem(k.replace(/=$/, ''))).toMatch(/canonical/)
    expect(ownerKeyProblem(` ${k}`)).toMatch(/canonical/)
    expect(ownerKeyProblem(k.replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, ''))).not.toBeNull()
  })

  it('labels are at most 60 characters and control-free', () => {
    expect(ownerLabelProblem('')).toBeNull()
    expect(ownerLabelProblem('Enes Kırca')).toBeNull()
    expect(ownerLabelProblem('x'.repeat(60))).toBeNull()
    expect(ownerLabelProblem('x'.repeat(61))).toMatch(/61.*60/)
    expect(ownerLabelProblem('a\nb')).toMatch(/control/)
    expect(ownerLabelProblem('a\u001b[31m')).toMatch(/control/)
    expect(ownerLabelProblem('a\u202eb')).toMatch(/control/)
  })

  it('project ids are non-empty, bounded and control-free', () => {
    expect(projectIdProblem('p-123')).toBeNull()
    expect(projectIdProblem('')).toMatch(/empty/)
    expect(projectIdProblem('x'.repeat(129))).toMatch(/128/)
    expect(projectIdProblem('a\tb')).toMatch(/control/)
  })

  it('parses only well-formed requests', () => {
    const k = validKey()
    expect(parseAdminRequest({ cmd: 'init' })).toEqual({ cmd: 'init' })
    expect(parseAdminRequest({ cmd: 'add-owner', pubkey: k, label: 'E' })).toEqual({ cmd: 'add-owner', pubkey: k, label: 'E' })
    expect(parseAdminRequest({ cmd: 'add-owner', pubkey: 'K', label: 'E' })).toMatch(/32 bytes/)
    expect(parseAdminRequest({ cmd: 'remove', pubkey: 'K', force: true })).toEqual({ cmd: 'remove', pubkey: 'K', force: true })
    expect(parseAdminRequest({ cmd: 'remove', pubkey: 'K', force: 'yes' })).toMatch(/force/)
    expect(parseAdminRequest({ cmd: 'share', projectId: 'P', on: true })).toEqual({ cmd: 'share', projectId: 'P', on: true })
    expect(parseAdminRequest({ cmd: 'share', projectId: 7, on: true })).toMatch(/project/)
    expect(parseAdminRequest({ cmd: 'share', projectId: 'P' })).toMatch(/on/)
    expect(parseAdminRequest({ cmd: 'nuke' })).toMatch(/unknown command/)
    expect(parseAdminRequest(null)).toMatch(/bad request/)
    expect(parseAdminRequest([1])).toMatch(/bad request/)
  })

  it('a socket path longer than a unix socket allows is refused by name, per platform', () => {
    expect(socketPathProblem('/s/' + 'x'.repeat(104), 'linux')).toBeNull() // 107 bytes
    expect(socketPathProblem('/s/' + 'x'.repeat(105), 'linux')).toMatch(/108 bytes.*107/)
    expect(socketPathProblem('/s/' + 'x'.repeat(100), 'darwin')).toBeNull() // 103 bytes
    expect(socketPathProblem('/s/' + 'x'.repeat(101), 'darwin')).toMatch(/104 bytes.*103/)
    expect(socketPathProblem('/short', 'win32')).toMatch(/Windows/)
  })
})

// The admin channel is a unix socket: POSIX only (the Server Edition targets Linux, and Windows is
// refused by name above). The mode assertions are POSIX permission bits as well.
describe.skipIf(process.platform === 'win32')('team admin socket (unix socket, POSIX only)', () => {
  it('lives in a 0700 relay dir, is 0600, and answers commands', async () => {
    const dataDir = tmp()
    writeTeam(dataDir)
    const { svc, calls } = fakeService({ running: true })
    await boot(dataDir, svc)
    expect((fs.statSync(adminSocketPath(dataDir)).mode & 0o777).toString(8)).toBe('600')
    expect((fs.statSync(relayDir(dataDir)).mode & 0o777).toString(8)).toBe('700')
    const k = validKey()
    expect(await callTeamAdmin(dataDir, { cmd: 'add-owner', pubkey: k, label: 'E' })).toEqual({ ok: true, result: null })
    expect(await callTeamAdmin(dataDir, { cmd: 'share', projectId: 'P', on: false })).toEqual({ ok: true, result: null })
    expect(await callTeamAdmin(dataDir, { cmd: 'remove', pubkey: k, force: true })).toEqual({ ok: true, result: null })
    expect(await callTeamAdmin(dataDir, { cmd: 'info' })).toEqual({
      ok: true,
      result: { enabled: true, info: INFO, joinCode: 'nodeterm://join/CODE' }
    })
    expect(calls).toEqual([`owner:${k}:E`, 'share:P:false', `remove:${k}:true`])
  })

  it('tightens an existing relay dir to 0700', async () => {
    const dataDir = tmp()
    fs.mkdirSync(relayDir(dataDir), { mode: 0o755 })
    fs.chmodSync(relayDir(dataDir), 0o755)
    await boot(dataDir, fakeService().svc)
    expect((fs.statSync(relayDir(dataDir)).mode & 0o777).toString(8)).toBe('700')
  })

  it('init creates, starts, and hands back the join code and address when hosting runs', async () => {
    const dataDir = tmp()
    const { svc, calls } = fakeService()
    await boot(dataDir, svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'init' })).toEqual({
      ok: true,
      result: { created: true, start: 'started', info: INFO, joinCode: 'nodeterm://join/CODE' }
    })
    expect(calls).toEqual(['init', 'start'])
  })

  it('init reports a start that did not happen, with no join code', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService({ start: 'stopped' }).svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'init' })).toEqual({
      ok: true,
      result: { created: true, start: 'stopped', info: null, joinCode: null }
    })
  })

  it('a service error becomes the reply, verbatim', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService({ initThrows: new Error('The team host key could not be read (malformed).') }).svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'init' })).toEqual({ ok: false, error: 'The team host key could not be read (malformed).' })
  })

  it('remove: the last owner and an unknown key are refusals with a reason', async () => {
    const dataDir = tmp()
    writeTeam(dataDir)
    await boot(dataDir, fakeService({ remove: 'last-owner' }).svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'remove', pubkey: 'K' })).toEqual({ ok: false, error: expect.stringMatching(/last owner.*--force/) })
    const other = tmp()
    writeTeam(other)
    await boot(other, fakeService({ remove: 'unknown' }).svc)
    expect(await callTeamAdmin(other, { cmd: 'remove', pubkey: 'K' })).toEqual({ ok: false, error: expect.stringMatching(/No team member/) })
  })

  it('with no team on this server it serves only init, status and info', async () => {
    const dataDir = tmp()
    const { svc, calls } = fakeService()
    await boot(dataDir, svc)
    for (const req of [
      { cmd: 'add-owner' as const, pubkey: validKey(), label: 'E' },
      { cmd: 'remove' as const, pubkey: 'K' },
      { cmd: 'share' as const, projectId: 'P', on: true },
      { cmd: 'rotate-key' as const }
    ]) {
      expect(await callTeamAdmin(dataDir, req)).toEqual({ ok: false, error: expect.stringMatching(/no hosted team.*team init/i) })
    }
    expect(calls).toEqual([])
    expect(fs.existsSync(path.join(relayDir(dataDir), 'team.json'))).toBe(false)
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
    expect((await callTeamAdmin(dataDir, { cmd: 'info' })).ok).toBe(true)
  })

  it('a host key with no team.json still counts as set up (so `team rotate-key` is never a dead end)', async () => {
    const dataDir = tmp()
    fs.mkdirSync(relayDir(dataDir), { recursive: true })
    fs.writeFileSync(path.join(relayDir(dataDir), 'host-key.json'), 'garbage')
    const { svc, calls } = fakeService()
    await boot(dataDir, svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'rotate-key' })).toEqual({
      ok: true,
      result: { result: 'not-running', info: null, joinCode: null }
    })
    expect(calls).toEqual(['rotate'])
  })

  it('a running service counts as set up even when team.json was set aside as corrupt', async () => {
    const dataDir = tmp()
    const { svc, calls } = fakeService({ running: true })
    await boot(dataDir, svc)
    const k = validKey()
    expect((await callTeamAdmin(dataDir, { cmd: 'add-owner', pubkey: k, label: '' })).ok).toBe(true)
    expect(calls).toEqual([`owner:${k}:`])
  })

  it('rotate-key reports honestly whether hosting restarted', async () => {
    const off = tmp()
    writeTeam(off)
    await boot(off, fakeService({ running: false }).svc)
    expect(await callTeamAdmin(off, { cmd: 'rotate-key' })).toEqual({
      ok: true,
      result: { result: 'not-running', info: null, joinCode: null }
    })
    const on = tmp()
    writeTeam(on)
    await boot(on, fakeService({ running: true }).svc)
    expect(await callTeamAdmin(on, { cmd: 'rotate-key' })).toEqual({
      ok: true,
      result: { result: 'started', info: INFO, joinCode: 'nodeterm://join/CODE' }
    })
  })

  it('status says WHY hosting is off, reading the relay dir', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService().svc)
    const off = async (): Promise<unknown> => {
      const r = (await callTeamAdmin(dataDir, { cmd: 'status' })) as AdminReply
      return r.ok ? (r.result as { off: unknown }).off : r
    }
    expect(await off()).toEqual({ reason: 'no-team' })
    writeTeam(dataDir)
    expect(await off()).toEqual({ reason: 'no-host-key' })
    fs.writeFileSync(path.join(relayDir(dataDir), 'host-key.json'), '{not json')
    expect(await off()).toEqual({ reason: 'host-key-unreadable', detail: expect.stringMatching(/could not be read/) })
    fs.rmSync(path.join(relayDir(dataDir), 'host-key.json'))
    await createHostKey(relayDir(dataDir))
    expect(await off()).toEqual({ reason: 'stopped' })
  })

  it('status while running carries the service status and no off reason', async () => {
    const dataDir = tmp()
    writeTeam(dataDir)
    await boot(dataDir, fakeService({ running: true }).svc)
    expect(await callTeamAdmin(dataDir, { cmd: 'status' })).toEqual({ ok: true, result: { ...onStatus, off: null } })
  })

  it('malformed lines are answered, never crash the server', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService().svc)
    expect(JSON.parse(await rawExchange(dataDir, 'not json\n'))).toEqual({ ok: false, error: expect.stringMatching(/bad request/) })
    expect(JSON.parse(await rawExchange(dataDir, '{"cmd":"nuke"}\n'))).toEqual({ ok: false, error: expect.stringMatching(/unknown command/) })
    // Still serving afterwards.
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
  })

  it('an oversized request is cut off without an answer', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService().svc)
    const reply = await rawExchange(dataDir, 'x'.repeat(ADMIN_REQUEST_MAX + 10))
    expect(reply).toBe('')
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
  })

  it('callTeamAdmin with no server says the service is not running, and names the path', async () => {
    const dataDir = tmp()
    const r = await callTeamAdmin(dataDir, { cmd: 'status' })
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not running/) })
    expect((r as { error: string }).error).toContain(adminSocketPath(dataDir))
  })

  it('a stale socket file from a crashed run is replaced', async () => {
    const dataDir = tmp()
    fs.mkdirSync(relayDir(dataDir), { recursive: true })
    const sock = adminSocketPath(dataDir)
    // A real crash: a process binds the path and is SIGKILLed, so nothing unlinks the file.
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`
    ])
    await new Promise<void>((r) => child.stdout.once('data', () => r()))
    child.kill('SIGKILL')
    await new Promise<void>((r) => child.once('exit', () => r()))
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    await boot(dataDir, fakeService().svc)
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
  })

  it('refuses to steal the socket from a live admin server', async () => {
    const dataDir = tmp()
    await boot(dataDir, fakeService().svc)
    await expect(startTeamAdmin(dataDir, fakeService().svc)).rejects.toMatchObject({
      code: 'E_ADMIN_SOCKET_BUSY',
      message: expect.stringMatching(/already answering/)
    })
    // The first one is untouched.
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
  })

  it('M5: two servers racing the bind — the loser is BUSY (it must not host), never a plain error', async () => {
    const dataDir = tmp()
    // Both pass the stale-socket check (nothing is there yet) before either binds, so the second
    // bind meets the first one's socket: EADDRINUSE.
    const results = await Promise.allSettled([startTeamAdmin(dataDir, fakeService().svc), startTeamAdmin(dataDir, fakeService().svc)])
    const won = results.filter((r): r is PromiseFulfilledResult<{ close(): Promise<void> }> => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    for (const w of won) closers.push(() => w.value.close())
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason).toMatchObject({ code: 'E_ADMIN_SOCKET_BUSY', message: expect.stringMatching(/already/) })
    // The winner is untouched and answers.
    expect((await callTeamAdmin(dataDir, { cmd: 'status' })).ok).toBe(true)
  })

  it('refuses to remove something at the socket path that is not a socket', async () => {
    const dataDir = tmp()
    fs.mkdirSync(relayDir(dataDir), { recursive: true })
    fs.writeFileSync(adminSocketPath(dataDir), 'mine')
    const err = await startTeamAdmin(dataDir, fakeService().svc).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/not a socket/) })
    expect((err as { code?: string }).code).not.toBe('E_ADMIN_SOCKET_BUSY')
    expect(fs.readFileSync(adminSocketPath(dataDir), 'utf8')).toBe('mine')
  })

  it('a data dir too long for a unix socket fails with a clear message, on both ends', async () => {
    const base = tmp()
    const dataDir = path.join(base, 'd'.repeat(Math.max(1, 110 - base.length)))
    fs.mkdirSync(dataDir, { recursive: true })
    expect(Buffer.byteLength(adminSocketPath(dataDir))).toBeGreaterThan(107)
    await expect(startTeamAdmin(dataDir, fakeService().svc)).rejects.toThrow(/shorter data directory/)
    expect(await callTeamAdmin(dataDir, { cmd: 'status' })).toEqual({ ok: false, error: expect.stringMatching(/shorter data directory/) })
  })

  it('an init still inside svc.init() when close() starts never starts hosting', async () => {
    const dataDir = tmp()
    const { svc, calls } = fakeService()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const inInit = new Promise<void>((r) => (entered = r))
    const realInit = svc.init.bind(svc)
    svc.init = async () => {
      entered()
      await gate
      return realInit()
    }
    const admin = await startTeamAdmin(dataDir, svc)
    const reply = callTeamAdmin(dataDir, { cmd: 'init' })
    await inInit
    const closed = admin.close()
    release()
    await closed
    await reply
    // Let the in-flight handler run to completion.
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(['init'])
  })

  it('close() removes the socket and does not hang on a connection that never sends a request', async () => {
    const dataDir = tmp()
    const admin = await startTeamAdmin(dataDir, fakeService().svc)
    const idle = net.connect(adminSocketPath(dataDir))
    idle.on('error', () => {})
    await new Promise<void>((r) => idle.on('connect', () => r()))
    await admin.close()
    expect(fs.existsSync(adminSocketPath(dataDir))).toBe(false)
    idle.destroy()
  })
})
