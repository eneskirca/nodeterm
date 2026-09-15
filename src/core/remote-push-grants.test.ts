import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  REMOTE_GRANT_SCAN_CMD,
  createRemoteGrantsCache,
  parseRemoteGrants
} from './remote-push-grants'

const grantFile = (grant: string, connectionId?: string): string =>
  JSON.stringify({ v: 1, grant, ...(connectionId ? { connectionId } : {}) })

describe('parseRemoteGrants', () => {
  it('tags every grant with the host it was swept from, and leaves it untagged without one', () => {
    const line = `phone\t${grantFile('tok', 'conn-1')}`
    expect(parseRemoteGrants(line, 'u@host1')).toEqual([
      { deviceId: 'phone', grant: 'tok', connectionId: 'conn-1', host: 'u@host1' }
    ])
    expect(parseRemoteGrants(line)).toEqual([{ deviceId: 'phone', grant: 'tok', connectionId: 'conn-1' }])
  })

  it('parses `<deviceId>\\t<json>` lines', () => {
    const out = parseRemoteGrants(
      `dev-a\t${grantFile('tok-a', 'conn-a')}\ndev-b\t${grantFile('tok-b')}\n`
    )
    expect(out).toEqual([
      { deviceId: 'dev-a', grant: 'tok-a', connectionId: 'conn-a' },
      { deviceId: 'dev-b', grant: 'tok-b' }
    ])
  })

  it('skips junk without throwing: no tab, bad JSON, wrong version, empty/absent grant', () => {
    const out = parseRemoteGrants(
      [
        '',
        'no-tab-here',
        `dev-a\t{"v":1,"grant":`, // half-written file
        `dev-b\t${JSON.stringify({ v: 2, grant: 'tok' })}`,
        `dev-c\t${JSON.stringify({ v: 1, grant: '' })}`,
        `dev-d\t${JSON.stringify({ v: 1 })}`,
        `dev-e\t"a string, not an object"`,
        `\t${grantFile('tok-no-device')}`,
        `${'x'.repeat(200)}\t${grantFile('tok-long-device')}`,
        `dev-ok\t${grantFile('tok-ok')}`
      ].join('\n')
    )
    expect(out).toEqual([{ deviceId: 'dev-ok', grant: 'tok-ok' }])
  })
})

describe('createRemoteGrantsCache', () => {
  it('is empty until a sweep lands', () => {
    expect(createRemoteGrantsCache().get()).toEqual([])
  })

  // One phone that reaches two hosts drops a DIFFERENT grant on each, each signed for that host's
  // connectionId — the scope the phone's per-host mute is keyed by. Both must survive, tagged with
  // their host, so push-notify can route a host's events under that host's grant (issue #435).
  // Collapsing them per device here sent host 2's events under host 1's grant.
  it('keeps every host\u2019s grant for one phone, each tagged with the host it came from', () => {
    const c = createRemoteGrantsCache()
    c.set([
      ...parseRemoteGrants(`phone\t${grantFile('tok-host1', 'conn-1')}`, 'u@host1'),
      ...parseRemoteGrants(`phone\t${grantFile('tok-host2', 'conn-2')}\nother\t${grantFile('tok-other')}`, 'u@host2')
    ])
    expect(c.get()).toEqual([
      { deviceId: 'phone', grant: 'tok-host1', connectionId: 'conn-1', host: 'u@host1' },
      { deviceId: 'phone', grant: 'tok-host2', connectionId: 'conn-2', host: 'u@host2' },
      { deviceId: 'other', grant: 'tok-other', host: 'u@host2' }
    ])
  })

  it('dedupes only WITHIN a host: the same device listed twice for one host keeps the first', () => {
    const c = createRemoteGrantsCache()
    c.set([
      { deviceId: 'phone', grant: 'tok-a', host: 'u@host1' },
      { deviceId: 'phone', grant: 'tok-b', host: 'u@host1' }
    ])
    expect(c.get()).toEqual([{ deviceId: 'phone', grant: 'tok-a', host: 'u@host1' }])
  })

  it('a 401 on one host\u2019s token drops that grant and leaves the other host\u2019s standing', () => {
    const c = createRemoteGrantsCache()
    c.set([
      { deviceId: 'phone', grant: 'tok-host1', host: 'u@host1' },
      { deviceId: 'phone', grant: 'tok-host2', host: 'u@host2' }
    ])
    c.markDead('tok-host1')
    expect(c.get()).toEqual([{ deviceId: 'phone', grant: 'tok-host2', host: 'u@host2' }])
  })

  it('a dead mark survives later sweeps while the token is still there', () => {
    const c = createRemoteGrantsCache()
    c.set([{ deviceId: 'phone', grant: 'tok' }])
    c.markDead('tok')
    c.set([{ deviceId: 'phone', grant: 'tok' }])
    expect(c.get()).toEqual([])
  })

  it('forgets the dead mark once the token is gone, so a re-minted grant is used again', () => {
    const c = createRemoteGrantsCache()
    c.set([{ deviceId: 'phone', grant: 'tok-old' }])
    c.markDead('tok-old')
    c.set([{ deviceId: 'phone', grant: 'tok-new' }])
    expect(c.get()).toEqual([{ deviceId: 'phone', grant: 'tok-new' }])
    // ...and re-appearance of the OLD token is a fresh start too (the mark was dropped).
    c.set([{ deviceId: 'phone', grant: 'tok-old' }])
    expect(c.get()).toEqual([{ deviceId: 'phone', grant: 'tok-old' }])
  })
})

// Generated shell no compiler checks: run the real command under /bin/sh against a fake $HOME,
// the same discipline as the canvas-control shim and the remote-usage command.
describe('REMOTE_GRANT_SCAN_CMD, executed under /bin/sh', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error
  const dir = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-remote-grants-')) : ''
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const run = (home: string): { status: number | null; stdout: string } => {
    const r = spawnSync('sh', ['-c', REMOTE_GRANT_SCAN_CMD], {
      encoding: 'utf8',
      env: { HOME: home, PATH: process.env.PATH ?? '' }
    })
    return { status: r.status, stdout: r.stdout ?? '' }
  }

  it.skipIf(!shAvailable)('exits 0 with no output when the directory does not exist', () => {
    const home = join(dir, 'bare')
    mkdirSync(home, { recursive: true })
    const r = run(home)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it.skipIf(!shAvailable)('exits 0 with no output when the directory is empty (no-glob case)', () => {
    const home = join(dir, 'empty')
    mkdirSync(join(home, '.nodeterm', 'push-grants'), { recursive: true })
    const r = run(home)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it.skipIf(!shAvailable)('emits one parseable line per grant, ignoring other files', () => {
    const home = join(dir, 'full')
    const gd = join(home, '.nodeterm', 'push-grants')
    mkdirSync(gd, { recursive: true })
    writeFileSync(join(gd, 'dev-a.grant'), grantFile('tok-a', 'conn-a'), 'utf8')
    // Pretty-printed + trailing newline: the flatten is what keeps it one line.
    writeFileSync(
      join(gd, 'dev-b.grant'),
      JSON.stringify({ v: 1, grant: 'tok-b' }, null, 2) + '\n',
      'utf8'
    )
    writeFileSync(join(gd, 'README.txt'), 'not a grant', 'utf8')
    const r = run(home)
    expect(r.status).toBe(0)
    const grants = parseRemoteGrants(r.stdout)
    expect(grants).toEqual([
      { deviceId: 'dev-a', grant: 'tok-a', connectionId: 'conn-a' },
      { deviceId: 'dev-b', grant: 'tok-b' }
    ])
  })

  it.skipIf(!shAvailable)('bounds a huge file instead of streaming it back', () => {
    const home = join(dir, 'huge')
    const gd = join(home, '.nodeterm', 'push-grants')
    mkdirSync(gd, { recursive: true })
    writeFileSync(join(gd, 'dev-big.grant'), 'x'.repeat(200_000), 'utf8')
    const r = run(home)
    expect(r.status).toBe(0)
    expect(r.stdout.length).toBeLessThan(4200)
    // Truncated junk parses to nothing — tolerated, never thrown.
    expect(parseRemoteGrants(r.stdout)).toEqual([])
  })
})
