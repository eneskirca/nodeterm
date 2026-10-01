import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { testTmpDir } from '../test-tmp'
import {
  createWatchLinkService,
  registerWatchLinkIpc,
  sendToOwners,
  shutdownWithin,
  workspaceNodeState,
  type WatchLinkNodeState,
  type WatchLinkService,
  type WatchLinkServiceDeps
} from './service'
import { WatchLinkStore, WatchLinkStoreUnreadable, type WatchLinkRecord, type SaveOutcome } from './store'
import type { WatchLinkApi as ApiClient } from './api'
import type { LinkHost, LinkHostDeps, LinkRuntimeStatus, LinkViewer, WatchPty } from './link-host'
import type { WatchChatMessage } from '../../shared/watch-link/protocol'
import type { WatchLinkNotice, WatchLinkView } from '../../shared/watch-link-types'
import { IPC } from '../../shared/ipc'
import { fakePlatform } from '../platform-fake'

const services: WatchLinkService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  vi.useRealTimers()
})

const HOUR = 3600_000

function fakeApi(over: Partial<ApiClient> = {}) {
  const calls: string[] = []
  let n = 0
  const api: ApiClient = {
    create: async () => {
      calls.push('create')
      n++
      return { ok: true, linkId: `Link${String(n).padStart(18, '0')}`, expiresAt: Date.now() + HOUR }
    },
    hostToken: async (id) => {
      calls.push(`hostToken ${id}`)
      return { ok: true, pairingToken: 't', hostId: '', ttlMs: 120_000 }
    },
    status: async () => 'live',
    revoke: async (id) => {
      calls.push(`revoke ${id}`)
      return true
    },
    revokeAll: async () => {
      calls.push('revokeAll')
      return true
    },
    ...over
  }
  return { api, calls }
}

interface FakeHost {
  record: WatchLinkRecord
  deps: LinkHostDeps
  stopped: string[]
  starts: number
  status: LinkRuntimeStatus
  viewers: LinkViewer[]
  chat: WatchChatMessage[]
}
function fakeHosts() {
  const made: FakeHost[] = []
  const createHost = (record: WatchLinkRecord, deps: LinkHostDeps): LinkHost => {
    const h: FakeHost = { record, deps, stopped: [], starts: 0, status: 'live', viewers: [], chat: [] }
    made.push(h)
    return {
      start: () => {
        h.starts++
      },
      stop: (r) => {
        h.stopped.push(r)
      },
      kick: (id) => h.viewers.some((v) => v.viewerId === id),
      postSharerChat: (text) => ({ id: 'm1', name: record.label, text, at: 1, from: 'sharer' }),
      chatHistory: () => h.chat,
      status: () => h.status,
      viewers: () => h.viewers
    }
  }
  return { made, createHost }
}

const fakePty = (over: Partial<WatchPty> = {}): WatchPty => ({
  join: async () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: true }),
  leave: () => {},
  captureVisible: async () => ({ screen: '', cursor: null }),
  syncSize: async () => true,
  alive: () => true,
  ...over
})

type Store = WatchLinkServiceDeps['store']

interface Opts {
  api?: Partial<ApiClient>
  nodes?: Map<string, WatchLinkNodeState>
  entitlement?: string | null
  relayAllowed?: boolean
  store?: Store
  pty?: WatchPty
  workspaceReady?: () => Promise<unknown>
  unsupported?: boolean
  persistTimeoutMs?: number
  workspaceWaitMs?: number
  now?: () => number
}
function service(o: Opts = {}) {
  const file = join(testTmpDir('wls-'), 'watch-links.json')
  const { api, calls } = fakeApi(o.api)
  const hosts = fakeHosts()
  const nodes = o.nodes ?? new Map<string, WatchLinkNodeState>([['n1', 'present'], ['n2', 'present']])
  const emitted: [string, unknown[]][] = []
  const store = o.store ?? new WatchLinkStore({ file })
  const ent = { value: o.entitlement === undefined ? 'ent' : o.entitlement }
  const s = createWatchLinkService({
    api,
    relayUrl: 'wss://r',
    store,
    entitlement: () => ent.value,
    relayAllowed: () => o.relayAllowed ?? true,
    nodeState: (id) => nodes.get(id) ?? 'absent',
    ...(o.workspaceReady ? { workspaceReady: o.workspaceReady } : {}),
    clients: { attach: () => 1, detach: () => {} },
    pty: o.pty ?? fakePty(),
    emit: (ch, ...a) => emitted.push([ch, a]),
    createHost: hosts.createHost,
    ...(o.unsupported ? { unsupported: true } : {}),
    ...(o.persistTimeoutMs ? { persistTimeoutMs: o.persistTimeoutMs } : {}),
    ...(o.workspaceWaitMs ? { workspaceWaitMs: o.workspaceWaitMs } : {}),
    ...(o.now ? { now: o.now } : {})
  })
  services.push(s)
  const notices = () => emitted.filter(([ch]) => ch === IPC.watchLinkNotice).map(([, a]) => a[0] as WatchLinkNotice)
  const states = () => emitted.filter(([ch]) => ch === IPC.watchLinkState).map(([, a]) => a[0] as WatchLinkView[])
  return { s, calls, api, hosts, nodes, emitted, notices, states, store, file, ent }
}
const req = (over: Record<string, unknown> = {}) => ({ nodeId: 'n1', role: 'viewer', ttlSeconds: 3600, label: 'Ada', title: 'build', ...over })
const record = (over: Partial<WatchLinkRecord> = {}): WatchLinkRecord => ({
  linkId: 'Good000000000000000000', nodeId: 'n1', role: 'viewer', label: 'A', title: 't', createdAt: 0,
  expiresAt: Date.now() + 60_000, secret: new Uint8Array(32).fill(3), ...over
})
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
/** A store that records every save and answers the outcomes a test chose. */
function fakeStore(o: { load?: () => Promise<WatchLinkRecord[]>; save?: (r: readonly WatchLinkRecord[]) => Promise<SaveOutcome>; opaque?: number } = {}) {
  const saves: WatchLinkRecord[][] = []
  let discarded = 0
  const store: Store = {
    load: o.load ?? (async () => []),
    save: (r) => {
      saves.push([...r])
      return o.save ? o.save(r) : Promise.resolve('saved')
    },
    discardOpaque: () => {
      discarded++
    },
    opaqueCount: () => o.opaque ?? 0
  }
  return { store, saves, discarded: () => discarded }
}

describe('createWatchLinkService — create', () => {
  it('creates a link, persists it, starts a host and answers the URL', async () => {
    const t = service()
    const r = await t.s.create(req())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link.url).toMatch(/^https:\/\/nodeterm\.dev\/s\/Link0+1#1\.[A-Za-z0-9_-]{43}$/)
    expect(r.link).toMatchObject({ nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build', status: 'live', viewers: [] })
    expect(t.hosts.made).toHaveLength(1)
    expect(t.hosts.made[0].starts).toBe(1)
    expect(await t.store.load()).toHaveLength(1)
    expect(t.states().at(-1)?.map((l) => l.linkId)).toEqual([r.link.linkId])
    expect(t.notices()).toEqual([]) // persisted: no not-persistent notice
  })

  it('refuses bad input, a node no project holds, no relay, no entitlement and a sixth link — before any request', async () => {
    const t = service({ nodes: new Map([['n1', 'present'], ['maybe', 'unknown'], ['gone', 'absent']]) })
    const bad = { ok: false, error: 'bad-request' }
    expect(await t.s.create(req({ ttlSeconds: 7200 }))).toEqual(bad)
    expect(await t.s.create(req({ ttlSeconds: '3600' }))).toEqual(bad)
    expect(await t.s.create(req({ role: 'editor' }))).toEqual(bad)
    expect(await t.s.create(req({ nodeId: '../x' }))).toEqual(bad)
    expect(await t.s.create(req({ nodeId: 12 }))).toEqual(bad)
    expect(await t.s.create(req({ label: '' }))).toEqual(bad)
    expect(await t.s.create(req({ label: '\u0007\u202e ' }))).toEqual(bad)
    expect(await t.s.create(req({ label: 5 }))).toEqual(bad)
    expect(await t.s.create(null)).toEqual(bad)
    expect(await t.s.create('x')).toEqual(bad)
    // Create requires PRESENT: "unknown" is not "there" (R40).
    expect(await t.s.create(req({ nodeId: 'gone' }))).toEqual({ ok: false, error: 'node-missing' })
    expect(await t.s.create(req({ nodeId: 'maybe' }))).toEqual({ ok: false, error: 'node-missing' })
    expect(await service({ relayAllowed: false }).s.create(req())).toEqual({ ok: false, error: 'relay-unavailable' })
    expect(await service({ entitlement: null }).s.create(req())).toEqual({ ok: false, error: 'not-entitled' })
    for (let i = 0; i < 5; i++) expect((await t.s.create(req())).ok).toBe(true)
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-machine' })
    expect(t.calls.filter((c) => c === 'create')).toHaveLength(5)
  })

  it('cleans the label and title: controls and bidi overrides stripped, capped in UTF-16 units without splitting a pair', async () => {
    const t = service()
    const r = await t.s.create(req({ label: ' A\u202eda\u0000\u200f ', title: `x\u2066${'😀'.repeat(50)}` }))
    if (!r.ok) throw new Error(r.error)
    expect(r.link.label).toBe('Ada')
    expect(r.link.title).toBe(`x${'😀'.repeat(39)}`) // 1 + 78 units; one more pair would be 81 > 80
    expect(r.link.title.length).toBeLessThanOrEqual(80)
    const blank = await t.s.create(req({ title: '\u0001' }))
    expect(blank.ok && blank.link.title).toBe('Terminal')
    // What was written reloads (the store refuses a label over 40 / a title over 80 units).
    expect(await t.store.load()).toHaveLength(2)
  })

  it('passes API refusals through without starting or persisting anything', async () => {
    const t = service({ api: { create: async () => ({ ok: false, error: 'limit-daily' }) } })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-daily' })
    expect(t.hosts.made).toHaveLength(0)
    expect(t.s.list()).toEqual([])
  })

  it('a failed local write revokes the server row and leaves nothing behind (spec: no half-created link)', async () => {
    const f = fakeStore({ save: async () => 'failed' })
    const t = service({ store: f.store })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'persist-failed' })
    expect(t.calls).toContain('revoke Link000000000000000001')
    expect(t.hosts.made).toHaveLength(0)
    expect(t.s.list()).toEqual([])
  })

  it('a local write that HANGS is bounded: persist-failed, the row revoked, and the corrected list queued behind it', async () => {
    const held = deferred<SaveOutcome>()
    const f = fakeStore({ save: () => held.promise })
    const t = service({ store: f.store, persistTimeoutMs: 20 })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'persist-failed' })
    expect(t.calls).toContain('revoke Link000000000000000001')
    expect(t.hosts.made).toHaveLength(0)
    // The write that hangs carries the link; the one queued after it does not, so when the disk
    // recovers the file ends without it.
    expect(f.saves.map((s) => s.length)).toEqual([1, 0])
    held.resolve('saved')
  })

  it('two concurrent creates at four links: one is created, the other answers limit-machine (G17)', async () => {
    const gate = deferred<void>()
    let n = 0
    const t = service({
      api: {
        create: async () => {
          n++
          const id = `Race${String(n).padStart(18, '0')}`
          if (n === 5) await gate.promise // the fifth create is in flight while the sixth asks
          return { ok: true, linkId: id, expiresAt: Date.now() + HOUR }
        }
      }
    })
    for (let i = 0; i < 4; i++) expect((await t.s.create(req())).ok).toBe(true)
    const fifth = t.s.create(req())
    await flush()
    const sixth = await t.s.create(req())
    expect(sixth).toEqual({ ok: false, error: 'limit-machine' })
    gate.resolve()
    expect((await fifth).ok).toBe(true)
    expect(n).toBe(5)
    expect(t.s.list()).toHaveLength(5)
  })

  it('a create whose write is pending counts ONCE against the cap', async () => {
    const held = deferred<SaveOutcome>()
    let saves = 0
    const f = fakeStore({ save: () => (++saves === 4 ? held.promise : Promise.resolve('saved')) })
    const t = service({ store: f.store })
    for (let i = 0; i < 3; i++) expect((await t.s.create(req())).ok).toBe(true)
    const fourth = t.s.create(req()) // its write is held: created server-side, not yet answered
    await vi.waitFor(() => expect(saves).toBe(4))
    expect((await t.s.create(req())).ok).toBe(true) // the fifth: 4 links + this one = 5
    held.resolve('saved')
    expect((await fourth).ok).toBe(true)
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-machine' })
  })

  it('a link being written is no link yet: not listed, and no stop can end it half-way; a concurrent write keeps it on disk', async () => {
    const held = deferred<SaveOutcome>()
    let saves = 0
    const f = fakeStore({ save: () => (++saves === 2 ? held.promise : Promise.resolve('saved')) })
    const t = service({ store: f.store })
    expect((await t.s.create(req({ nodeId: 'n2' }))).ok).toBe(true)
    const creating = t.s.create(req())
    await vi.waitFor(() => expect(saves).toBe(2))
    expect(t.s.list().map((l) => l.nodeId)).toEqual(['n2'])
    await t.s.revoke('Link000000000000000001') // the other link ends meanwhile…
    expect(f.saves.at(-1)?.map((r) => r.linkId)).toEqual(['Link000000000000000002']) // …and its write keeps this one
    held.resolve('saved')
    const r = await creating
    expect(r.ok).toBe(true)
    expect(t.s.list().map((l) => l.linkId)).toEqual(['Link000000000000000002'])
    expect(t.hosts.made.map((h) => h.record.linkId)).toEqual(['Link000000000000000001', 'Link000000000000000002'])
  })

  it('links the keychain could not unseal this run count against the cap (R46/M3)', async () => {
    const f = fakeStore({ opaque: 3 })
    const t = service({ store: f.store })
    expect((await t.s.create(req())).ok).toBe(true)
    expect((await t.s.create(req())).ok).toBe(true)
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-machine' }) // 2 + 3 opaque = 5
    expect(t.calls.filter((c) => c === 'create')).toHaveLength(2)
  })

  it('a node that leaves every project while the record is being written: node-missing, revoked, off disk (R46/M4)', async () => {
    const held = deferred<SaveOutcome>()
    let saves = 0
    const f = fakeStore({ save: () => (++saves === 1 ? held.promise : Promise.resolve('saved')) })
    const t = service({ store: f.store })
    const creating = t.s.create(req())
    await vi.waitFor(() => expect(saves).toBe(1))
    t.nodes.set('n1', 'absent') // deleted during the write; no workspace change could see this record
    held.resolve('saved')
    expect(await creating).toEqual({ ok: false, error: 'node-missing' })
    expect(t.calls).toContain('revoke Link000000000000000001')
    expect(t.hosts.made).toEqual([])
    expect(t.s.list()).toEqual([])
    expect(f.saves.at(-1)).toEqual([]) // the list without it, queued behind the write that carried it
  })

  it('a create is not blocked by a workspace load that never finishes: init decides after its own bound (R46/M5)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeStore({ load: async () => [record({ nodeId: 'n2' })] })
    const t = service({
      store: f.store,
      workspaceReady: () => new Promise(() => {}),
      workspaceWaitMs: 20,
      nodes: new Map([['n1', 'present'], ['n2', 'unknown']])
    })
    expect((await t.s.create(req())).ok).toBe(true)
    expect(t.s.list().map((l) => l.nodeId).sort()).toEqual(['n1', 'n2']) // the resumed link is kept (unknown)
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
    expect(warn.mock.calls.filter(([l]) => /did not finish loading/.test(String(l)))).toHaveLength(1)
    warn.mockRestore()
  })

  it('waits for init: a create during the boot load counts the resumed links and never hosts one twice (G11)', async () => {
    const loading = deferred<WatchLinkRecord[]>()
    const f = fakeStore({ load: () => loading.promise })
    const t = service({ store: f.store })
    void t.s.init()
    const loaded = Array.from({ length: 5 }, (_, i) => record({ linkId: `Boot${String(i).padStart(18, '0')}` }))
    const creating = t.s.create(req())
    await flush()
    expect(t.calls).not.toContain('create') // nothing asked before the load settled
    loading.resolve(loaded)
    expect(await creating).toEqual({ ok: false, error: 'limit-machine' })
    expect(t.hosts.made.map((h) => h.record.linkId)).toEqual(loaded.map((r) => r.linkId))
    await t.s.init() // idempotent: the same promise, no second start
    expect(t.hosts.made).toHaveLength(5)
  })

  it('a create waiting on an init that never settles is bounded too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeStore({ load: () => new Promise(() => {}) })
    const t = service({ store: f.store, persistTimeoutMs: 20, workspaceWaitMs: 20 })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'persist-failed' })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'persist-failed' })
    expect(t.calls).not.toContain('create')
    // Diagnosable, once: it is the links file that did not load, not a failed write.
    expect(warn.mock.calls.filter(([l]) => /links file did not load/.test(String(l)))).toHaveLength(1)
    warn.mockRestore()
  })

  it('the Server Edition (unsupported): create answers unsupported, list is empty, nothing is loaded or hosted (R43)', async () => {
    const load = vi.fn(async () => [record()])
    const f = fakeStore({ load })
    const t = service({ store: f.store, unsupported: true })
    await t.s.init()
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'unsupported' })
    expect(t.s.list()).toEqual([])
    expect(await t.s.revokeAll()).toBe('unsupported')
    t.s.onWorkspaceChanged()
    await flush()
    expect(load).not.toHaveBeenCalled()
    expect(f.saves).toEqual([])
    expect(t.hosts.made).toEqual([])
    expect(t.calls).toEqual([])
  })
})

describe('createWatchLinkService — ending a link', () => {
  it('revoke stops the host, forgets the record and revokes server-side, with no notice (the owner did it)', async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    await t.s.revoke(r.link.linkId)
    expect(t.hosts.made[0].stopped).toEqual(['revoked'])
    expect(t.s.list()).toEqual([])
    expect(await t.store.load()).toEqual([])
    expect(t.calls).toContain(`revoke ${r.link.linkId}`)
    expect(t.notices()).toEqual([])
    expect(t.states().at(-1)).toEqual([])
  })

  it('revoke is complete locally and reaches the server even when the write HANGS (Task 9 note B)', async () => {
    const f = fakeStore()
    const t = service({ store: f.store })
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    const held = deferred<SaveOutcome>()
    f.store.save = (recs) => {
      f.saves.push([...recs])
      return held.promise
    }
    await t.s.revoke(r.link.linkId) // resolves although the write never lands
    expect(t.calls).toContain(`revoke ${r.link.linkId}`)
    expect(t.hosts.made[0].stopped).toEqual(['revoked'])
    expect(t.states().at(-1)).toEqual([])
    expect(f.saves.at(-1)).toEqual([]) // the write was ISSUED before the sessions ended (spec order)
    held.resolve('saved')
  })

  it('revokeAll ends every link without a notice, discards opaque entries and calls the server ONCE (G14)', async () => {
    const f = fakeStore()
    const t = service({ store: f.store })
    await t.s.create(req())
    await t.s.create(req({ nodeId: 'n2' }))
    await t.s.revokeAll()
    expect(t.s.list()).toEqual([])
    expect(t.hosts.made.map((h) => h.stopped)).toEqual([['revoked'], ['revoked']])
    expect(t.calls.filter((c) => c === 'revokeAll')).toHaveLength(1)
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
    expect(t.notices()).toEqual([])
    expect(f.discarded()).toBe(1)
    expect(f.saves.at(-1)).toEqual([])
  })

  // R62: Stop all is the only control that reaches links on OTHER machines, so its server call is
  // awaited and its answer reported — a failed call must not look like a stop.
  it('revokeAll AWAITS the server and answers what it reached; this machine stops first, whatever the answer', async () => {
    const answer = deferred<boolean>()
    const t = service({ api: { revokeAll: () => answer.promise } })
    await t.s.create(req())
    let settled: string | null = null
    const p = t.s.revokeAll().then((o) => (settled = o))
    await flush()
    // Local first: stopped and listed as gone before the server answered.
    expect(t.hosts.made[0].stopped).toEqual(['revoked'])
    expect(t.s.list()).toEqual([])
    expect(settled).toBeNull()
    answer.resolve(true)
    await p
    expect(settled).toBe('stopped')
  })

  it("revokeAll: a refused or failed server call is 'failed', never 'stopped'", async () => {
    const refused = service({ api: { revokeAll: async () => false } })
    await refused.s.create(req())
    expect(await refused.s.revokeAll()).toBe('failed')
    expect(refused.s.list()).toEqual([]) // this machine's links are stopped all the same
    const thrown = service({
      api: {
        revokeAll: async () => {
          throw new Error('offline')
        }
      }
    })
    expect(await thrown.s.revokeAll()).toBe('failed')
  })

  it("revokeAll with no entitlement stops this machine and answers 'no-entitlement' — no request", async () => {
    const t = service({ entitlement: null })
    t.ent.value = 'ent'
    await t.s.create(req())
    t.ent.value = null
    expect(await t.s.revokeAll()).toBe('no-entitlement')
    expect(t.s.list()).toEqual([])
    expect(t.calls.filter((c) => c === 'revokeAll')).toEqual([])
  })

  it('Stop all reaches the server even when the boot load hangs (a stop never waits on the disk)', async () => {
    const f = fakeStore({ load: () => new Promise(() => {}) })
    const t = service({ store: f.store, persistTimeoutMs: 20, workspaceWaitMs: 20 })
    await t.s.revokeAll()
    await t.s.revoke('Link000000000000000001')
    expect(t.calls).toEqual(['revokeAll'])
  })

  it('a node that is ABSENT ends every link of the node, revokes each, and tells the owner', async () => {
    const t = service()
    await t.s.create(req())
    await t.s.create(req({ role: 'commenter' }))
    await t.s.create(req({ nodeId: 'n2' }))
    t.nodes.set('n1', 'absent')
    t.s.onWorkspaceChanged()
    await vi.waitFor(() => expect(t.s.list().map((l) => l.nodeId)).toEqual(['n2']))
    expect(t.hosts.made.filter((h) => h.stopped.includes('node-gone'))).toHaveLength(2)
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toHaveLength(2)
    expect(t.notices().filter((n) => n.kind === 'ended' && n.reason === 'node-gone')).toHaveLength(2)
  })

  it('a node whose state is UNKNOWN is never ended or revoked (an unread project is not evidence)', async () => {
    const t = service()
    await t.s.create(req())
    t.nodes.set('n1', 'unknown')
    t.s.onWorkspaceChanged()
    await flush()
    expect(t.s.list()).toHaveLength(1)
    expect(t.hosts.made[0].stopped).toEqual([])
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
  })

  it('a node-state check that throws reads as unknown', async () => {
    const t = service()
    await t.s.create(req())
    t.nodes.get = () => {
      throw new Error('boom')
    }
    t.s.onWorkspaceChanged()
    await flush()
    expect(t.s.list()).toHaveLength(1)
  })

  it('a server-side end (onGone) ends the link locally, tells the owner, and does not revoke again', async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].deps.onGone('revoked')
    expect(t.s.list()).toEqual([])
    expect(t.notices()).toEqual([{ kind: 'ended', linkId: r.link.linkId, nodeId: 'n1', title: 'build', reason: 'revoked' }])
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
  })

  it('expiry ends the link with an expired notice and no server revoke', async () => {
    vi.useFakeTimers()
    const t = service({ api: { create: async () => ({ ok: true, linkId: 'Exp0000000000000000000', expiresAt: Date.now() + 1000 }) } })
    expect((await t.s.create(req())).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(t.s.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.s.list()).toEqual([])
    expect(t.hosts.made[0].stopped).toEqual(['expired'])
    expect(t.notices()).toEqual([{ kind: 'ended', linkId: 'Exp0000000000000000000', nodeId: 'n1', title: 'build', reason: 'expired' }])
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
  })

  it('a host change after the link expired ends it even if its timer slept past (G24: monotonic timers across a lid-close)', async () => {
    let clock = 1_000_000
    const t = service({
      now: () => clock,
      api: { create: async () => ({ ok: true, linkId: 'Lid0000000000000000000', expiresAt: clock + HOUR }) }
    })
    expect((await t.s.create(req())).ok).toBe(true)
    clock += HOUR // the wall clock moved on; the expiry timer (monotonic) has not fired
    t.hosts.made[0].deps.onChange()
    await vi.waitFor(() => expect(t.s.list()).toEqual([]))
    expect(t.notices().at(-1)).toMatchObject({ kind: 'ended', reason: 'expired' })
  })

  it('shutdown stops hosts as host-stopping, keeps the records, and nothing ends a link after it', async () => {
    const t = service()
    await t.s.create(req())
    await t.s.shutdown()
    expect(t.hosts.made[0].stopped).toEqual(['host-stopping'])
    expect(await t.store.load()).toHaveLength(1)
    t.nodes.set('n1', 'absent')
    t.s.onWorkspaceChanged()
    await flush()
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'unsupported' })
  })
})

describe('createWatchLinkService — init (resume at launch)', () => {
  it('resumes live and UNKNOWN records, drops expired ones, and revokes only an ABSENT one', async () => {
    const t = service({ nodes: new Map([['n1', 'present'], ['maybe', 'unknown']]) })
    const good = record()
    await t.store.save([
      good,
      record({ linkId: 'Maybe00000000000000000', nodeId: 'maybe' }),
      record({ linkId: 'Old0000000000000000000', expiresAt: Date.now() - 1 }),
      record({ linkId: 'Orph000000000000000000', nodeId: 'gone' })
    ])
    await t.s.init()
    expect(t.s.list().map((l) => l.linkId)).toEqual(['Good000000000000000000', 'Maybe00000000000000000'])
    expect(t.hosts.made.map((h) => h.record.linkId)).toEqual(['Good000000000000000000', 'Maybe00000000000000000'])
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual(['revoke Orph000000000000000000'])
    expect((await t.store.load()).map((r) => r.linkId)).toEqual(['Good000000000000000000', 'Maybe00000000000000000'])
  })

  it('the launch-time empty workspace revokes NOTHING: every node reads unknown until the index is read', async () => {
    // What `workspaceNodeState` answers before the workspace store has loaded its index.
    const t = service({ nodes: new Map([['n1', 'unknown'], ['n2', 'unknown']]) })
    await t.store.save([record(), record({ linkId: 'Two0000000000000000000', nodeId: 'n2' })])
    await t.s.init()
    expect(t.s.list()).toHaveLength(2)
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toEqual([])
  })

  it('decides nothing before the workspace load it is handed has settled (R40)', async () => {
    const ready = deferred<void>()
    const nodes = new Map<string, WatchLinkNodeState>([['n1', 'unknown']])
    const f = fakeStore({ load: async () => [record()] })
    const t = service({ store: f.store, nodes, workspaceReady: () => ready.promise })
    const init = t.s.init()
    await flush()
    expect(t.hosts.made).toEqual([])
    nodes.set('n1', 'absent') // the load completed and the node is really gone
    ready.resolve()
    await init
    expect(t.s.list()).toEqual([])
    expect(t.calls).toEqual(['revoke Good000000000000000000'])
  })

  it('a workspace load that fails still lets init run (every answer is then unknown)', async () => {
    const f = fakeStore({ load: async () => [record()] })
    const t = service({ store: f.store, nodes: new Map([['n1', 'unknown']]), workspaceReady: () => Promise.reject(new Error('x')) })
    await t.s.init()
    expect(t.s.list()).toHaveLength(1)
  })

  it('writes the file only when it pruned something (R42a)', async () => {
    const f = fakeStore({ load: async () => [record()] })
    const t = service({ store: f.store })
    await t.s.init()
    expect(f.saves).toEqual([])
    const g = fakeStore({ load: async () => [record(), record({ linkId: 'Old0000000000000000000', expiresAt: 1 })] })
    const u = service({ store: g.store })
    await u.s.init()
    expect(g.saves.map((s) => s.map((r) => r.linkId))).toEqual([['Good000000000000000000']])
  })

  it('an unreadable links file: init resolves, runs memory-only, never writes, and says so on every create (R22/R42c)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeStore({ load: async () => Promise.reject(new WatchLinkStoreUnreadable('unknown-version', 'watch-links.json has version 2, expected 1')) })
    const t = service({ store: f.store })
    await expect(t.s.init()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/unknown-version/)
    expect((await t.s.create(req())).ok).toBe(true)
    expect((await t.s.create(req())).ok).toBe(true)
    await t.s.revoke('Link000000000000000001')
    expect(f.saves).toEqual([])
    expect(t.notices().filter((n) => n.kind === 'not-persistent')).toHaveLength(3) // boot + each create
    warn.mockRestore()
  })

  it('a keychain that refuses to seal: created links work, and every create says they are not persisted (R42c)', async () => {
    const f = fakeStore({ save: async () => 'memory-only' })
    const t = service({ store: f.store })
    expect((await t.s.create(req())).ok).toBe(true)
    expect((await t.s.create(req())).ok).toBe(true)
    expect(t.notices().filter((n) => n.kind === 'not-persistent')).toHaveLength(2)
    expect(t.hosts.made).toHaveLength(2)
  })

  it('in a build that may not relay, resumed links are kept and listed refused, and nothing is hosted (G21)', async () => {
    const f = fakeStore({ load: async () => [record()] })
    const t = service({ store: f.store, relayAllowed: false })
    await t.s.init()
    expect(t.hosts.made).toEqual([])
    expect(t.s.list().map((l) => l.status)).toEqual(['refused'])
  })

  it('keeps at most five resumed links; the rest are pruned and revoked', async () => {
    const recs = Array.from({ length: 7 }, (_, i) => record({ linkId: `Many${String(i).padStart(18, '0')}` }))
    const f = fakeStore({ load: async () => recs })
    const t = service({ store: f.store })
    await t.s.init()
    expect(t.s.list()).toHaveLength(5)
    expect(t.calls.filter((c) => c.startsWith('revoke '))).toHaveLength(2)
  })
})

describe('createWatchLinkService — the host seams', () => {
  it('never mints with an empty entitlement: a local refusal, no request (R41b)', async () => {
    const t = service()
    await t.s.create(req())
    t.ent.value = null
    expect(await t.hosts.made[0].deps.mint()).toEqual({ ok: false, kind: 'refused', status: 402 })
    expect(t.calls.filter((c) => c.startsWith('hostToken'))).toEqual([])
    expect(await t.hosts.made[0].deps.status()).toBe('unknown')
    t.ent.value = 'ent2'
    expect((await t.hosts.made[0].deps.mint()).ok).toBe(true)
  })

  it('an entitlement change re-arms ONLY the refused hosts (R41a)', async () => {
    const t = service()
    await t.s.create(req())
    await t.s.create(req({ nodeId: 'n2' }))
    t.hosts.made[0].status = 'refused'
    t.s.onEntitlementChanged()
    expect(t.hosts.made.map((h) => h.starts)).toEqual([2, 1])
  })

  it('checks the node before every join: absent ends the link (node-gone + revoke), unknown joins (R29/G8)', async () => {
    const join = vi.fn(async () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: true }))
    const t = service({ pty: fakePty({ join }) })
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    const pty = t.hosts.made[0].deps.pty
    t.nodes.set('n1', 'unknown')
    expect(await pty.join(1, 'n1', 'v-1')).toMatchObject({ sessionId: 's1' })
    t.nodes.set('n1', 'absent')
    expect(await pty.join(1, 'n1', 'v-2')).toBeNull()
    expect(join).toHaveBeenCalledTimes(1)
    expect(t.s.list()).toEqual([])
    expect(t.hosts.made[0].stopped).toEqual(['node-gone'])
    expect(t.calls).toContain(`revoke ${r.link.linkId}`)
    // The other members pass straight through.
    expect(pty.alive('s1')).toBe(true)
    expect(await pty.syncSize('s1')).toBe(true)
    expect(await pty.captureVisible('s1')).toEqual({ screen: '', cursor: null })
  })

  it('tells the owner when someone starts watching', async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].deps.onViewerJoined(2)
    expect(t.notices()).toEqual([{ kind: 'joined', linkId: r.link.linkId, nodeId: 'n1', title: 'build', viewers: 2 }])
  })

  it('strips bidi controls from everything a viewer wrote before the owner sees it', async () => {
    const t = service()
    const r = await t.s.create(req({ role: 'commenter' }))
    if (!r.ok) throw new Error('create failed')
    const h = t.hosts.made[0]
    h.deps.onChat({ id: 'x', name: 'E\u202eve\u061c', text: 'hi\u2066 there \u{1F468}\u200d\u{1F469}', at: 1, from: 'viewer' })
    const chat = t.emitted.find(([ch]) => ch === IPC.watchLinkChat)
    // Bidi (ALM included) gone; the ZWJ joining an emoji sequence stays.
    expect(chat?.[1]).toEqual([r.link.linkId, { id: 'x', name: 'Eve', text: 'hi there \u{1F468}\u200d\u{1F469}', at: 1, from: 'viewer' }])
    h.chat = [{ id: 'y', name: '\u200fMal', text: 'a\u202ab', at: 2, from: 'viewer' }]
    expect(t.s.chatHistory(r.link.linkId)).toEqual([{ id: 'y', name: 'Mal', text: 'ab', at: 2, from: 'viewer' }])
    h.viewers = [{ viewerId: 'v-1', name: 'E\u202eve', joinedAt: 5, waiting: false }]
    expect(t.s.list()[0].viewers).toEqual([{ viewerId: 'v-1', name: 'Eve', joinedAt: 5, waiting: false }])
  })

  // R63: a viewer the host could not join to a session reaches the owner's view as `waiting`.
  it("a viewer's waiting state reaches the owner's view", async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].viewers = [
      { viewerId: 'v-1', name: null, joinedAt: 5, waiting: true },
      { viewerId: 'v-2', name: null, joinedAt: 6, waiting: false }
    ]
    expect(t.s.list()[0].viewers.map((v) => v.waiting)).toEqual([true, false])
  })

  it('kick, owner chat and history go to the link host; an unknown link answers nothing', async () => {
    const t = service()
    const r = await t.s.create(req({ role: 'commenter' }))
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].viewers = [{ viewerId: 'v-1', name: null, joinedAt: 1, waiting: false }]
    expect(t.s.kick(r.link.linkId, 'v-1')).toBe(true)
    expect(t.s.kick(r.link.linkId, 'v-9')).toBe(false)
    expect(t.s.sendChat(r.link.linkId, 'hello')).toMatchObject({ text: 'hello', from: 'sharer' })
    expect(t.s.kick('Nope000000000000000000', 'v-1')).toBe(false)
    expect(t.s.sendChat('Nope000000000000000000', 'x')).toBeNull()
    expect(t.s.chatHistory('Nope000000000000000000')).toEqual([])
  })
})

describe('state pushes are coalesced (R46/M7)', () => {
  it('one push per end, although the stopped host also reports a change; one push for a whole shutdown', async () => {
    const t = service()
    for (const nodeId of ['n1', 'n2', 'n1']) expect((await t.s.create(req({ nodeId }))).ok).toBe(true)
    // Like the real link host: `stop` reports a change.
    for (const h of t.hosts.made) {
      const deps = h.deps
      h.stopped = new Proxy(h.stopped, {
        get: (arr, k) => (k === 'push' ? (...a: string[]) => (deps.onChange(), arr.push(...a)) : Reflect.get(arr, k))
      })
    }
    const before = t.states().length
    await t.s.revoke(t.s.list()[0].linkId)
    await flush()
    expect(t.states().length - before).toBe(1)
    expect(t.states().at(-1)).toHaveLength(2)
    await t.s.shutdown()
    await flush()
    expect(t.states().length - before).toBe(2)
  })
})

describe('shutdownWithin (R46/M6)', () => {
  it('answers at the bound when the last write hangs, at once when it lands, and nothing for no service', async () => {
    const hung = { shutdown: () => new Promise<void>(() => {}) } as unknown as WatchLinkService
    const t0 = Date.now()
    await shutdownWithin(hung, 30)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    const quick = { shutdown: vi.fn(async () => {}) } as unknown as WatchLinkService
    await shutdownWithin(quick, 60_000) // would time the test out if it waited for the bound
    expect((quick as unknown as { shutdown: ReturnType<typeof vi.fn> }).shutdown).toHaveBeenCalledTimes(1)
    await shutdownWithin(null, 60_000)
  })
})

describe('registerWatchLinkIpc / sendToOwners', () => {
  it('the IPC answers owners only', async () => {
    const t = service()
    const p = fakePlatform({ isOwnerClient: (id) => id === 1 })
    registerWatchLinkIpc(p, t.s)
    expect(await p.handlers[IPC.watchLinkCreate](2, req())).toEqual({ ok: false, error: 'unsupported' })
    expect(await p.handlers[IPC.watchLinkList](2)).toEqual([])
    expect(await p.handlers[IPC.watchLinkKick](2, 'x', 'y')).toBe(false)
    expect(await p.handlers[IPC.watchLinkChatSend](2, 'x', 'y')).toBeNull()
    expect(await p.handlers[IPC.watchLinkChatHistory](2, 'x')).toEqual([])
    const made = (await p.handlers[IPC.watchLinkCreate](1, req())) as { ok: boolean; link: WatchLinkView }
    expect(made.ok).toBe(true)
    expect(await p.handlers[IPC.watchLinkRevoke](2, made.link.linkId)).toBeUndefined()
    expect(await p.handlers[IPC.watchLinkRevokeAll](2)).toBe('unsupported')
    expect((await p.handlers[IPC.watchLinkList](1)) as WatchLinkView[]).toHaveLength(1) // a non-owner stopped nothing
    await p.handlers[IPC.watchLinkRevoke](1, made.link.linkId)
    expect(await p.handlers[IPC.watchLinkList](1)).toEqual([])
  })

  it('a platform with no owner notion answers nobody', async () => {
    const t = service()
    const p = fakePlatform()
    delete (p as { isOwnerClient?: unknown }).isOwnerClient
    registerWatchLinkIpc(p, t.s)
    expect(await p.handlers[IPC.watchLinkCreate](1, req())).toEqual({ ok: false, error: 'unsupported' })
  })

  it('registers exactly the seven request channels', () => {
    const p = fakePlatform({ isOwnerClient: () => true })
    registerWatchLinkIpc(p, service().s)
    expect(Object.keys(p.handlers).sort()).toEqual(
      [IPC.watchLinkCreate, IPC.watchLinkList, IPC.watchLinkRevoke, IPC.watchLinkRevokeAll, IPC.watchLinkKick, IPC.watchLinkChatSend, IPC.watchLinkChatHistory].sort()
    )
  })

  it('sendToOwners reaches owner clients only (the link URL carries its secret)', () => {
    const p = fakePlatform({ isOwnerClient: (id) => id === 3 })
    p.clients.push(2, 3, 4)
    sendToOwners(p, IPC.watchLinkState, [])
    expect(p.sent).toEqual([{ to: 3, channel: IPC.watchLinkState, args: [[]] }])
  })
})

describe('workspaceNodeState', () => {
  const store = (held: Record<string, string[]>, known: Set<string> | undefined) => ({
    projectIdsForNode: (id: string) => held[id] ?? [],
    knownNodeIdsStrict: () => known
  })
  it('present when a project holds it', () => {
    expect(workspaceNodeState(store({ n1: ['p1'] }, undefined), 'n1')).toBe('present')
  })
  it('absent only on a complete read that lacks it', () => {
    expect(workspaceNodeState(store({}, new Set(['n2'])), 'n1')).toBe('absent')
    expect(workspaceNodeState(store({}, new Set()), 'n1')).toBe('absent')
  })
  it('unknown when the read is incomplete (index not loaded, an unread project)', () => {
    expect(workspaceNodeState(store({}, undefined), 'n1')).toBe('unknown')
  })
  it('present when the complete read has it even if the project scan does not', () => {
    expect(workspaceNodeState(store({}, new Set(['n1'])), 'n1')).toBe('present')
  })
})

// A store round trip with the real file: the brief's end-to-end persistence claim.
describe('createWatchLinkService — real store', () => {
  it('a created link is on disk, and a revoked one is gone from it', async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    expect(JSON.parse(readFileSync(t.file, 'utf8')).links).toHaveLength(1)
    await t.s.revoke(r.link.linkId)
    await t.store.load() // queued behind the revoke's write
    expect(JSON.parse(readFileSync(t.file, 'utf8')).links).toEqual([])
  })
})

// A sanitizer whose character class renders as `[-]` cannot be reviewed by reading it (R46/M1): the
// owner-side files spell every bidi and zero-width character as an escape.
describe('no literal bidi or zero-width characters in the live-link owner sources', () => {
  const LITERAL = new RegExp('[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]')
  for (const f of ['service.ts', 'service.test.ts', 'pty-seam.ts', '../../shared/watch-link-types.ts', '../../shared/presence.ts']) {
    it(f, () => {
      expect(LITERAL.test(readFileSync(join(__dirname, f), 'utf8'))).toBe(false)
    })
  }
})
