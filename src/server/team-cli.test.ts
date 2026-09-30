import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTeamArgv, runTeamCli, describeStatus, teamArgv } from './team-cli'
import { startTeamAdmin, adminSocketPath, type AdminStatusResult } from '../core/relay/team-admin'
import { genKeyPair, publicKeyToB64 } from '../core/relay/e2ee'
import type { HostedService, HostedStatus } from '../core/relay/hosted-service'
import { POP_REFUSED_MESSAGE } from '../core/relay/relay-pop'

const KEY = publicKeyToB64(genKeyPair().publicKey)

describe('team argv', () => {
  it('parses every command', () => {
    expect(parseTeamArgv(['init'])).toEqual({ cmd: 'init' })
    expect(parseTeamArgv(['add-owner', KEY, '--label', 'Enes'])).toEqual({ cmd: 'add-owner', pubkey: KEY, label: 'Enes' })
    expect(parseTeamArgv(['add-owner', KEY, '--label=Enes K'])).toEqual({ cmd: 'add-owner', pubkey: KEY, label: 'Enes K' })
    expect(parseTeamArgv(['add-owner', KEY])).toEqual({ cmd: 'add-owner', pubkey: KEY, label: '' })
    expect(parseTeamArgv(['remove', 'K', '--force'])).toEqual({ cmd: 'remove', pubkey: 'K', force: true })
    expect(parseTeamArgv(['remove', 'K'])).toEqual({ cmd: 'remove', pubkey: 'K' })
    expect(parseTeamArgv(['share', 'P'])).toEqual({ cmd: 'share', projectId: 'P', on: true })
    expect(parseTeamArgv(['unshare', 'P'])).toEqual({ cmd: 'share', projectId: 'P', on: false })
    expect(parseTeamArgv(['info', '--json'])).toEqual({ cmd: 'info' })
    expect(parseTeamArgv(['status'])).toEqual({ cmd: 'status' })
    expect(parseTeamArgv(['status', '--json'])).toEqual({ cmd: 'status' })
    expect(parseTeamArgv(['rotate-key'])).toEqual({ cmd: 'rotate-key' })
  })

  it('refuses junk with a usage line', () => {
    expect(parseTeamArgv([])).toEqual({ error: expect.stringMatching(/usage/i) })
    expect(parseTeamArgv(['add-owner'])).toEqual({ error: expect.stringMatching(/usage/i) })
    expect(parseTeamArgv(['nuke'])).toEqual({ error: expect.stringMatching(/unknown command "nuke"[\s\S]*usage/i) })
    expect(parseTeamArgv(['init', 'extra'])).toEqual({ error: expect.stringMatching(/usage/i) })
    expect(parseTeamArgv(['remove', 'K', '--forse'])).toEqual({ error: expect.stringMatching(/unknown option --forse[\s\S]*usage/i) })
    expect(parseTeamArgv(['add-owner', KEY, '--label'])).toEqual({ error: expect.stringMatching(/--label needs a value/) })
    expect(parseTeamArgv(['add-owner', KEY, '--label', '--json'])).toEqual({ error: expect.stringMatching(/--label needs a value/) })
    expect(parseTeamArgv(['share'])).toEqual({ error: expect.stringMatching(/usage/i) })
    expect(parseTeamArgv(['rotate-key', '--json'])).toEqual({ error: expect.stringMatching(/unknown option --json/) })
    expect(parseTeamArgv(['remove', 'K', '--force=yes'])).toEqual({ error: expect.stringMatching(/--force takes no value/) })
  })

  it('add-owner names what is wrong with a bad key or label (not the generic usage line)', () => {
    const bad = parseTeamArgv(['add-owner', 'K', '--label', 'Enes'])
    expect(bad).toEqual({ error: expect.stringMatching(/32 bytes/) })
    expect((bad as { error: string }).error).not.toMatch(/usage/i)
    expect(parseTeamArgv(['add-owner', KEY.replace(/=$/, '')])).toEqual({ error: expect.stringMatching(/canonical/) })
    expect(parseTeamArgv(['add-owner', KEY, '--label', 'x'.repeat(61)])).toEqual({ error: expect.stringMatching(/60/) })
    expect(parseTeamArgv(['add-owner', KEY, '--label', 'a\u001bb'])).toEqual({ error: expect.stringMatching(/control/) })
  })

  it('share names a bad project id', () => {
    expect(parseTeamArgv(['share', 'x'.repeat(129)])).toEqual({ error: expect.stringMatching(/128/) })
  })
})

describe('teamArgv (main.cjs dispatch)', () => {
  it('finds `team` as the first non-flag argument, after server flags and their values', () => {
    expect(teamArgv(['team', 'status'])).toEqual(['status'])
    expect(teamArgv(['--data-dir', '/x', 'team', 'status'])).toEqual(['status', '--data-dir', '/x'])
    expect(teamArgv(['--data-dir=/x', 'team', 'info', '--json'])).toEqual(['info', '--json', '--data-dir=/x'])
    expect(teamArgv(['--insecure-http', '--port', '9000', 'team', 'status'])).toEqual(['status'])
    // Only --data-dir matters to the CLI; the other server flags configure a boot that is not happening.
    expect(teamArgv(['--port', '9000', '--data-dir', '/x', 'team', 'init'])).toEqual(['init', '--data-dir', '/x'])
  })

  it('anything else is a server boot', () => {
    expect(teamArgv([])).toBeNull()
    expect(teamArgv(['--port', '9000'])).toBeNull()
    expect(teamArgv(['--insecure-http'])).toBeNull()
    // A flag value named "team" is a value, exactly as the server's own parser reads it.
    expect(teamArgv(['--data-dir', 'team'])).toBeNull()
    expect(teamArgv(['serve', 'team'])).toBeNull()
  })
})

const idleStatus = (patch: Partial<NonNullable<HostedStatus['scheduler']>> = {}, rest: Partial<AdminStatusResult> = {}): AdminStatusResult => ({
  enabled: true,
  scheduler: { state: 'running', lastError: null, mintsLastHour: 3, idle: 1, bridged: 0, ...patch },
  peers: [],
  pending: [],
  off: null,
  ...rest
})

describe('describeStatus', () => {
  it('an idle listener is healthy', () => {
    const text = describeStatus(idleStatus()).join('\n')
    expect(text).toMatch(/Hosting: ON — listening/)
    expect(text).not.toMatch(/not reachable|unhealthy/i)
  })

  it('a non-null lastError beside an idle listener is history, not an outage', () => {
    const text = describeStatus(idleStatus({ lastError: 'network' })).join('\n')
    expect(text).toMatch(/Hosting: ON — listening/)
    expect(text).toMatch(/network/)
    expect(text).not.toMatch(/not reachable|unhealthy|failing/i)
  })

  it('no idle listener and a lastError is a relay that cannot be reached yet', () => {
    const text = describeStatus(idleStatus({ idle: 0, lastError: 'network' })).join('\n')
    expect(text).toMatch(/not reachable yet/)
    expect(text).toMatch(/network/)
  })

  it('no idle listener and no error is a listener being opened', () => {
    expect(describeStatus(idleStatus({ idle: 0 })).join('\n')).toMatch(/opening a listener/)
    expect(describeStatus(idleStatus({ idle: 0, bridged: 2 })).join('\n')).toMatch(/2 sessions \(joined or awaiting approval\)/)
  })

  it('a refusing backend is named, with its error', () => {
    const text = describeStatus(idleStatus({ state: 'backend-refused', idle: 0, lastError: 'refused (403)' })).join('\n')
    expect(text).toMatch(/refused/)
    expect(text).toMatch(/403/)
    expect(text).toMatch(/restart/)
  })

  it('a refused key proof prints its advice on its own line, and says how hosting comes back', () => {
    const lines = describeStatus(idleStatus({ state: 'backend-refused', idle: 0, lastError: POP_REFUSED_MESSAGE }))
    expect(lines[0]).toBe('Hosting: STOPPED — the nodeterm API refused to issue relay tokens.')
    expect(lines[1]).toBe(`  ${POP_REFUSED_MESSAGE}`)
    expect(lines[2]).toBe('  Hosting stays off until nodeterm is updated or the key is rotated.')
    const text = lines.join('\n')
    expect(text).not.toMatch(/\.\)\./) // no "…replaced.)." double punctuation
    expect(text).not.toMatch(/until the service restarts/) // `team rotate-key` restarts hosting in place
  })

  it('off states say why, and still list the members', () => {
    const peers = [{ label: 'Enes', role: 'owner' as const, connected: false }, { label: '', role: 'viewer' as const, connected: false }]
    const unreadable = describeStatus({
      enabled: false,
      scheduler: null,
      peers,
      pending: [],
      off: { reason: 'host-key-unreadable', detail: 'The team host key could not be read (malformed).' }
    }).join('\n')
    expect(unreadable).toMatch(/Hosting: OFF/)
    expect(unreadable).toMatch(/could not be read \(malformed\)/)
    expect(unreadable).toMatch(/owner\s+Enes/)
    expect(unreadable).toMatch(/viewer\s+\(no label\)/)
    expect(describeStatus({ enabled: false, scheduler: null, peers: [], pending: [], off: { reason: 'no-team' } }).join('\n')).toMatch(
      /team init/
    )
    expect(describeStatus({ enabled: false, scheduler: null, peers: [], pending: [], off: { reason: 'stopped' } }).join('\n')).toMatch(
      /team init.*restart/
    )
  })

  it('pending join requests are listed by their SAS', () => {
    const text = describeStatus(idleStatus({}, { pending: [{ pendingId: 'x', sas: '123 456', peerKeyB64: 'k', since: 0 }] })).join('\n')
    expect(text).toMatch(/1 join request/)
    expect(text).toMatch(/123 456/)
  })

  it('tolerates a reply shape it does not know (an older or newer server)', () => {
    expect(() => describeStatus({} as never)).not.toThrow()
    expect(describeStatus({ enabled: false, off: { reason: 'constructor' } } as never).join('\n')).toMatch(/Hosting: OFF — hosting is not running\./)
  })

  it('never prints control or bidi characters from lastError, the off detail or a SAS', () => {
    const evil = 'x\u001b]0;t\u0007\u202eY\u2066'
    const running = describeStatus(idleStatus({ idle: 0, lastError: evil })).join('\n')
    const refused = describeStatus(idleStatus({ state: 'backend-refused', idle: 0, lastError: evil })).join('\n')
    const recovering = describeStatus(idleStatus({ lastError: evil })).join('\n')
    const off = describeStatus({ enabled: false, scheduler: null, peers: [], pending: [], off: { reason: 'host-key-unreadable', detail: evil } }).join('\n')
    const sas = describeStatus(idleStatus({}, { pending: [{ pendingId: 'p', sas: evil, peerKeyB64: 'k', since: 0 }] })).join('\n')
    const bad = new RegExp('[\\p{Cc}\\u202E\\u2066]', 'u')
    for (const text of [running, refused, recovering, off, sas]) {
      expect(text.replace(/\n/g, ' '), text).not.toMatch(bad)
      expect(text).toContain('x?]0;t??Y?')
    }
  })

  it('never prints control characters from a label', () => {
    const text = describeStatus({
      enabled: false,
      scheduler: null,
      peers: [{ label: 'evil\u001b]0;pwned\u0007', role: 'owner', connected: false }],
      pending: [],
      off: { reason: 'stopped' }
    }).join('\n')
    expect(text).not.toMatch(/\u001b|\u0007/)
    expect(text).toContain('evil?]0;pwned?')
  })
})

// Exercising runTeamCli end to end needs the admin unix socket: POSIX only.
const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()
const made: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(SHORT_BASE, 'ntc-'))
  made.push(d)
  return d
}
const INFO = { relayEndpoint: 'wss://relay.example', hostId: 'HOSTID', hostPublicKeyB64: 'HPK', hostDeviceId: 'DEV', label: 'box' }

function fake(o: { running?: boolean; rotate?: string } = {}): { svc: HostedService; calls: string[] } {
  const calls: string[] = []
  let running = o.running ?? false
  const svc = {
    init: async () => ({ created: true }),
    start: async () => {
      running = true
      return 'started'
    },
    stop: () => {},
    addOwner: async (k: string, l: string) => {
      calls.push(`owner:${k}:${l}`)
    },
    remove: async () => 'removed',
    share: async (p: string, on: boolean) => {
      calls.push(`share:${p}:${on}`)
    },
    info: () => (running ? INFO : null),
    joinCode: () => (running ? 'nodeterm://join/CODE' : null),
    status: (): HostedStatus =>
      running
        ? { enabled: true, scheduler: { state: 'running', lastError: null, mintsLastHour: 1, idle: 1, bridged: 0 }, peers: [], pending: [] }
        : { enabled: false, scheduler: null, peers: [], pending: [] },
    rotateKey: async () => o.rotate ?? (running ? 'started' : 'not-running')
  } as unknown as HostedService
  return { svc, calls }
}

async function served(o: Parameters<typeof fake>[0] = {}, withTeam = true): Promise<{ dataDir: string; calls: string[] }> {
  const dataDir = tmp()
  if (withTeam) {
    fs.mkdirSync(path.join(dataDir, 'relay'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dataDir, 'relay', 'team.json'), JSON.stringify({ v: 1, peers: [], sharedProjects: [] }))
  }
  const f = fake(o)
  const admin = await startTeamAdmin(dataDir, f.svc)
  closers.push(() => admin.close())
  return { dataDir, calls: f.calls }
}

async function run(argv: string[], dataDir: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runTeamCli(argv, dataDir, (s) => out.push(s), (s) => err.push(s))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe.skipIf(process.platform === 'win32')('runTeamCli over the admin socket (unix socket, POSIX only)', () => {
  it('init prints the join code and the address when hosting runs', async () => {
    const { dataDir } = await served({}, false)
    const r = await run(['init'], dataDir)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Created/)
    expect(r.out).toMatch(/Hosting: ON/)
    expect(r.out).toContain('nodeterm://join/CODE')
    expect(r.out).toContain('HOSTID')
  })

  it('rotate-key while hosting is off says so, in exactly these words', async () => {
    const { dataDir } = await served({ running: false })
    const r = await run(['rotate-key'], dataDir)
    expect(r.code).toBe(0)
    expect(r.out).toBe('Host key rotated. Hosting is off; run `team init` (or restart the service) to start it.')
  })

  it('rotate-key while hosting was on warns that every teammate needs a new join code', async () => {
    const { dataDir } = await served({ running: true })
    const r = await run(['rotate-key'], dataDir)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Every teammate needs a NEW join code/)
    expect(r.out).toContain('nodeterm://join/CODE')
  })

  it('rotate-key that could not restart hosting exits non-zero and says so', async () => {
    const { dataDir } = await served({ running: true, rotate: 'stopped' })
    const r = await run(['rotate-key'], dataDir)
    expect(r.code).toBe(1)
    expect(r.out + r.err).toMatch(/did not restart/)
  })

  it('a bad add-owner key never reaches the socket (works with no server at all)', async () => {
    const dataDir = tmp() // nothing listening here
    const r = await run(['add-owner', 'not-a-key', '--label', 'E'], dataDir)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/32 bytes/)
    expect(r.err).not.toMatch(/not running/)
  })

  it('add-owner, share and unshare confirm what they did', async () => {
    const { dataDir, calls } = await served({ running: true })
    expect((await run(['add-owner', KEY, '--label', 'Enes'], dataDir)).out).toMatch(/Added Enes as an owner/)
    expect((await run(['share', 'P1'], dataDir)).out).toMatch(/P1 is now shared/)
    expect((await run(['unshare', 'P1'], dataDir)).out).toMatch(/P1 is no longer shared/)
    expect(calls).toEqual([`owner:${KEY}:Enes`, 'share:P1:true', 'share:P1:false'])
  })

  it('info --json prints the machine-readable reply; info prints the address', async () => {
    const { dataDir } = await served({ running: true })
    const json = await run(['info', '--json'], dataDir)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out)).toEqual({ enabled: true, info: INFO, joinCode: 'nodeterm://join/CODE' })
    const human = await run(['info'], dataDir)
    expect(human.out).toContain('HOSTID')
    expect(human.out).toContain('nodeterm://join/CODE')
  })

  it('info with hosting never started exits 1 with a pointer to init', async () => {
    const { dataDir } = await served({ running: false })
    const r = await run(['info'], dataDir)
    expect(r.code).toBe(1)
    expect(r.out + r.err).toMatch(/team init/)
  })

  it('status prints a human summary, --json the raw reply', async () => {
    const { dataDir } = await served({ running: true })
    expect((await run(['status'], dataDir)).out).toMatch(/Hosting: ON — listening/)
    expect(JSON.parse((await run(['status', '--json'], dataDir)).out)).toMatchObject({ enabled: true, off: null })
  })

  it('a refusal from the server exits 1 with its reason', async () => {
    const { dataDir } = await served({}, false)
    const r = await run(['share', 'P'], dataDir)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/team init/)
  })

  it('--data-dir (anywhere on the line) overrides the default data dir', async () => {
    const { dataDir } = await served({ running: true })
    const wrong = tmp()
    expect((await run(['status', '--data-dir', dataDir], wrong)).code).toBe(0)
    expect((await run(['--data-dir=' + dataDir, 'status'], wrong)).code).toBe(0)
    const miss = await run(['status'], wrong)
    expect(miss.code).toBe(1)
    expect(miss.err).toMatch(/not running/)
    expect(miss.err).toContain(adminSocketPath(wrong))
    expect(miss.err).toMatch(/--data-dir/)
  })

  it('--json output escapes control and bidi characters (still valid JSON, nothing raw on the terminal)', async () => {
    const dataDir = tmp()
    fs.mkdirSync(path.join(dataDir, 'relay'), { recursive: true, mode: 0o700 })
    const f = fake({ running: true })
    const evilLabel = 'box\u202e\u007f'
    f.svc.info = () => ({ ...INFO, label: evilLabel })
    const admin = await startTeamAdmin(dataDir, f.svc)
    closers.push(() => admin.close())
    const r = await run(['info', '--json'], dataDir)
    // Nothing raw but the pretty-printing newlines.
    expect(r.out).not.toMatch(new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u202E]'))
    expect(JSON.parse(r.out).info.label).toBe(evilLabel)
  })

  it('an error from the server is printed without control characters', async () => {
    const dataDir = tmp()
    const f = fake({ running: true })
    f.svc.init = async () => {
      throw new Error('bad\u001b[2Jthing\u202e')
    }
    const admin = await startTeamAdmin(dataDir, f.svc)
    closers.push(() => admin.close())
    const r = await run(['init'], dataDir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('bad?[2Jthing?')
  })

  it('usage errors exit 2; help exits 0', async () => {
    const dataDir = tmp()
    expect((await run([], dataDir)).code).toBe(2)
    const help = await run(['--help'], dataDir)
    expect(help.code).toBe(0)
    expect(help.out).toMatch(/usage/i)
  })
})
