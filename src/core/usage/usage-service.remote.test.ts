// The `usage:remote` RPC surface: caching, invalidation and failure containment. The command
// itself is covered in remote-claude-usage.test.ts; this is about what the service does with it,
// because a popover row is only as good as the cache behind it — a stale row from a host that
// disconnected an hour ago is worse than no row at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import { startUsageService, type RemoteUsageDeps, type UsageService } from './usage-service'
import type { RemoteAccountUsage } from '../../shared/types'
import type { RemoteUsageTarget } from './remote-claude-usage'

const OK_REPLY = [
  '__NTU_BEGIN__',
  '__NTU_EMAIL__me@example.com',
  JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 60 }] }),
  '__NTU_HTTP__200',
  '__NTU_END__'
].join('\n')

function target(hostKey: string, accountId: string | null = null): RemoteUsageTarget {
  return {
    key: `${hostKey}#${accountId ?? ''}`,
    hostKey,
    projectId: 'p1',
    accountId,
    label: accountId ?? hostKey
  }
}

let platform: FakePlatform
let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})

afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
  vi.useRealTimers()
})

/** Start the service with the poll gate shut, so nothing but the remote path is exercised. */
function start(remote?: RemoteUsageDeps): void {
  service = startUsageService({ shouldPoll: () => false, remote })
}

const callRemote = (query?: { hostKey?: string; force?: boolean }): Promise<RemoteAccountUsage[]> =>
  platform.handlers[IPC.usageRemote](query) as Promise<RemoteAccountUsage[]>

describe('usage:remote', () => {
  it('answers empty — never rejects — on a shell with no SSH deps', async () => {
    start()
    // This is the Server Edition's permanent answer, so the UI needs no capability check.
    await expect(callRemote()).resolves.toEqual([])
  })

  it('reads each target and labels the rows by host', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@alpha', 'acc-1')], run })
    const rows = await callRemote()
    expect(rows.map((r) => r.accountId)).toEqual([null, 'acc-1'])
    expect(rows[0].hostKey).toBe('root@alpha')
    expect(rows[0].usage.limits[0].usedPercent).toBe(60)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('serves a repeat call from cache, and re-reads on force', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha')], run })
    await callRemote()
    await callRemote()
    expect(run).toHaveBeenCalledTimes(1)
    await callRemote({ force: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retires a host that has disconnected instead of serving its last numbers', async () => {
    const run = vi.fn(async () => OK_REPLY)
    let connected = [target('root@alpha')]
    start({ targets: () => connected, run })
    expect(await callRemote()).toHaveLength(1)
    connected = []
    expect(await callRemote()).toEqual([])
    // Reconnecting must produce a FRESH read — the evicted entry cannot come back from the cache.
    connected = [target('root@alpha')]
    await callRemote()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent reads of the same target into one ssh round-trip', async () => {
    let resolveRun: ((v: string) => void) | undefined
    const run = vi.fn(() => new Promise<string>((res) => (resolveRun = res)))
    start({ targets: () => [target('root@alpha')], run })
    const both = Promise.all([callRemote(), callRemote()])
    resolveRun?.(OK_REPLY)
    const [a, b] = await both
    expect(run).toHaveBeenCalledTimes(1)
    expect(a[0].usage.status).toBe('ok')
    expect(b[0].usage.status).toBe('ok')
  })

  it('does not let one unreachable host withhold the others', async () => {
    const run = vi.fn(async (t: RemoteUsageTarget) => {
      if (t.hostKey === 'root@beta') throw new Error('master gone')
      return OK_REPLY
    })
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    const rows = await callRemote()
    expect(rows.map((r) => r.usage.status)).toEqual(['ok', 'error'])
  })

  it('reads only the named host — the scoped indicator shows one machine', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    const rows = await callRemote({ hostKey: 'root@beta' })
    expect(rows.map((r) => r.hostKey)).toEqual(['root@beta'])
    // The other host is not read at all: an ssh exec per connected project, every time the
    // popover opened, is the cost this scoping exists to avoid.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps the other host’s cache while you look at this one', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    await callRemote({ hostKey: 'root@alpha' })
    await callRemote({ hostKey: 'root@beta' })
    // Switching back must not re-read: eviction is against the FULL target list, not the query.
    await callRemote({ hostKey: 'root@alpha' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('survives a throwing target provider', async () => {
    start({
      targets: () => {
        throw new Error('settings blew up')
      },
      run: async () => OK_REPLY
    })
    await expect(callRemote()).resolves.toEqual([])
  })
})


const CODEX_REPLY = '__NT_CODEX_USAGE_BEGIN__' + JSON.stringify({ status: 'ok',
  rate_limit: { primary_window: { used_percent: 42 } } }) + '__NT_CODEX_USAGE_END__'

describe('usage:remote Codex identity and connection cache', () => {
  it('separates Claude/Codex rows with the same host and account id, caching each provider independently', async () => {
    const run = vi.fn(async (t: RemoteUsageTarget) => t.provider === 'codex' ? CODEX_REPLY : OK_REPLY)
    start({ targets: () => [target('u@h', 'same'), { ...target('u@h', 'same'), provider: 'codex', remoteHome: '/home/u' }], run })
    const rows = await callRemote()
    expect(rows.map(r => [r.provider ?? 'claude', r.usage.limits[0].usedPercent])).toEqual([['claude', 60], ['codex', 42]])
    await callRemote(); expect(run).toHaveBeenCalledTimes(2)
  })

  it('invalidates a replaced connection/home and cannot cache its late old reply', async () => {
    const codex = { ...target('u@h'), provider: 'codex' as const, remoteHome: '/old', connectionKey: 'generation1' }
    let connected: RemoteUsageTarget[] = [codex]
    let finish: ((s: string) => void) | undefined
    const run = vi.fn((t: RemoteUsageTarget) => t.connectionKey === 'generation1'
      ? new Promise<string>(r => { finish = r }) : Promise.resolve(CODEX_REPLY))
    start({ targets: () => connected, run })
    const old = callRemote()
    connected = [{ ...codex, remoteHome: '/new', connectionKey: 'generation2' }]
    expect((await callRemote())[0].usage.limits[0].usedPercent).toBe(42)
    finish?.(CODEX_REPLY.replace('42', '99')); await old
    expect((await callRemote())[0].usage.limits[0].usedPercent).toBe(42)
    expect(run).toHaveBeenCalledTimes(2)
    connected = []; expect(await callRemote()).toEqual([])
    connected = [{ ...codex, connectionKey: 'generation3' }]
    await callRemote(); expect(run).toHaveBeenCalledTimes(3)
  })

  it('limits remote Codex to the requested host and keeps errors as errors rather than zero', async () => {
    const run = vi.fn(async () => null)
    start({ targets: () => ['u@a', 'u@b'].map(h => ({ ...target(h), provider: 'codex' })), run })
    const rows = await callRemote({ hostKey: 'u@b' })
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ provider: 'codex', hostKey: 'u@b', usage: { status: 'error', limits: [] } })
    expect(run).toHaveBeenCalledTimes(1)
  })
})


it('retains Codex discrimination when the target registry fails during late cache validation', async () => {
  let calls = 0
  start({ targets: () => {
    if (++calls > 1) throw new Error('registry replaced')
    return [{ ...target('u@h'), provider: 'codex' }]
  }, run: async () => CODEX_REPLY })
  expect(await callRemote()).toEqual([expect.objectContaining({ provider: 'codex', usage: expect.objectContaining({ provider: 'codex', status: 'error', limits: [] }) })])
})
