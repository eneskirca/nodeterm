import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { testTmpDir } from '../test-tmp'
import {
  createFifoGate,
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
import { WRONG_PER_LINK, type LinkHost, type LinkHostDeps, type LinkRuntimeStatus, type LinkViewer, type WatchPty } from './link-host'
import type { WatchChatMessage } from '../../shared/watch-link/protocol'
import type { ControlSupport, WatchLinkNotice, WatchLinkView } from '../../shared/watch-link-types'
import { verifyControlPassword, type ControlPasswordHash } from './password'
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
  const ttls: number[] = []
  let n = 0
  const api: ApiClient = {
    create: async (_ent, _hash, ttl) => {
      calls.push('create')
      ttls.push(ttl)
      n++
      // Like the server: Unlimited (0) answers no end time.
      return { ok: true, linkId: `Link${String(n).padStart(18, '0')}`, expiresAt: ttl === 0 ? null : Date.now() + HOUR }
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
  return { api, calls, ttls }
}

interface FakeHost {
  record: WatchLinkRecord
  deps: LinkHostDeps
  stopped: string[]
  /** controlChanged / passwordChanged / allowControl, in call order. */
  hooks: string[]
  starts: number
  status: LinkRuntimeStatus
  viewers: LinkViewer[]
  chat: WatchChatMessage[]
}
function fakeHosts() {
  const made: FakeHost[] = []
  const createHost = (record: WatchLinkRecord, deps: LinkHostDeps): LinkHost => {
    const h: FakeHost = { record, deps, stopped: [], hooks: [], starts: 0, status: 'live', viewers: [], chat: [] }
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
      viewers: () => h.viewers,
      controlChanged: () => {
        h.hooks.push('controlChanged')
      },
      passwordChanged: () => {
        h.hooks.push('passwordChanged')
      },
      allowControl: () => {
        h.hooks.push('allowControl')
      }
    }
  }
  return { made, createHost }
}

const fakePty = (over: Partial<WatchPty> = {}): WatchPty => ({
  join: async () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: true, input: 'tmux' }),
  leave: () => {},
  captureVisible: async () => ({ screen: '', cursor: null }),
  syncSize: async () => true,
  alive: () => true,
  input: async () => true,
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
  controlSupport?: (nodeId: string) => ControlSupport
  hashPassword?: (pw: string) => Promise<ControlPasswordHash>
  verifyPassword?: (pw: string, h: ControlPasswordHash) => Promise<boolean>
  /** The REAL link host (and a relay transport no test reaches) instead of the fake. */
  realHost?: boolean
}
function service(o: Opts = {}) {
  const file = join(testTmpDir('wls-'), 'watch-links.json')
  const { api, calls, ttls } = fakeApi(o.api)
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
    ...(o.realHost
      ? {
          transport: () => {
            throw new Error('no relay in this test')
          }
        }
      : { createHost: hosts.createHost }),
    ...(o.controlSupport ? { controlSupport: o.controlSupport } : {}),
    ...(o.hashPassword ? { hashPassword: o.hashPassword } : {}),
    ...(o.verifyPassword ? { verifyPassword: o.verifyPassword } : {}),
    ...(o.unsupported ? { unsupported: true } : {}),
    ...(o.persistTimeoutMs ? { persistTimeoutMs: o.persistTimeoutMs } : {}),
    ...(o.workspaceWaitMs ? { workspaceWaitMs: o.workspaceWaitMs } : {}),
    ...(o.now ? { now: o.now } : {})
  })
  services.push(s)
  const notices = () => emitted.filter(([ch]) => ch === IPC.watchLinkNotice).map(([, a]) => a[0] as WatchLinkNotice)
  const states = () => emitted.filter(([ch]) => ch === IPC.watchLinkState).map(([, a]) => a[0] as WatchLinkView[])
  return { s, calls, ttls, api, hosts, nodes, emitted, notices, states, store, file, ent }
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

// An Unlimited link's record has `expiresAt: null`: no expiry timer, never swept or ended for time.
// (Creating one is Task 6's; these resume it from the store, which is where a null first appears.)
describe('createWatchLinkService — a link with no expiry (expiresAt: null)', () => {
  const ended = (t: ReturnType<typeof service>) => t.notices().filter((n) => n.kind === 'ended')

  it('is resumed at launch and never pruned for time, however late the clock reads', async () => {
    const f = fakeStore({ load: async () => [record({ expiresAt: null })] })
    const t = service({ store: f.store, now: () => Number.MAX_SAFE_INTEGER })
    await t.s.init()
    expect(t.s.list().map((l) => [l.linkId, l.expiresAt])).toEqual([['Good000000000000000000', null]])
    expect(t.hosts.made.map((h) => h.record.linkId)).toEqual(['Good000000000000000000'])
    expect(f.saves).toEqual([]) // nothing was pruned, so nothing is written
  })

  it('arms no expiry timer: still listed and hosted after any amount of time', async () => {
    vi.useFakeTimers()
    const f = fakeStore({ load: async () => [record({ expiresAt: null })] })
    const t = service({ store: f.store })
    await t.s.init()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(400 * 24 * HOUR)
    expect(t.s.list()).toHaveLength(1)
    expect(t.hosts.made[0].stopped).toEqual([])
    expect(ended(t)).toEqual([])
  })

  it('a host change never ends it as expired (the G24 check has no end time to compare)', async () => {
    let clock = 1_000_000
    const f = fakeStore({ load: async () => [record({ expiresAt: null })] })
    const t = service({ store: f.store, now: () => clock })
    await t.s.init()
    clock = Number.MAX_SAFE_INTEGER
    t.hosts.made[0].deps.onChange()
    await flush()
    expect(t.s.list()).toHaveLength(1)
    expect(t.hosts.made[0].stopped).toEqual([])
    expect(ended(t)).toEqual([])
  })

  it('still ends for every other reason (a revoke)', async () => {
    const f = fakeStore({ load: async () => [record({ expiresAt: null })] })
    const t = service({ store: f.store })
    await t.s.init()
    await t.s.revoke('Good000000000000000000')
    expect(t.s.list()).toEqual([])
    expect(t.hosts.made[0].stopped).toEqual(['revoked'])
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
    const join = vi.fn(async () => ({ sessionId: 's1', cols: 80, rows: 24, altScreen: true, input: 'tmux' as const }))
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
    h.viewers = [{ viewerId: 'v-1', name: 'E\u202eve', joinedAt: 5, waiting: false, controlling: false, typing: false }]
    expect(t.s.list()[0].viewers).toEqual([{ viewerId: 'v-1', name: 'Eve', joinedAt: 5, waiting: false, controlling: false, typing: false }])
  })

  // R63: a viewer the host could not join to a session reaches the owner's view as `waiting`.
  it("a viewer's waiting state reaches the owner's view", async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].viewers = [
      { viewerId: 'v-1', name: null, joinedAt: 5, waiting: true, controlling: false, typing: false },
      { viewerId: 'v-2', name: null, joinedAt: 6, waiting: false, controlling: false, typing: false }
    ]
    expect(t.s.list()[0].viewers.map((v) => v.waiting)).toEqual([true, false])
  })

  it('kick, owner chat and history go to the link host; an unknown link answers nothing', async () => {
    const t = service()
    const r = await t.s.create(req({ role: 'commenter' }))
    if (!r.ok) throw new Error('create failed')
    t.hosts.made[0].viewers = [{ viewerId: 'v-1', name: null, joinedAt: 1, waiting: false, controlling: false, typing: false }]
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

  it('registers exactly the eleven request channels', () => {
    const p = fakePlatform({ isOwnerClient: () => true })
    registerWatchLinkIpc(p, service().s)
    expect(Object.keys(p.handlers).sort()).toEqual(
      [
        IPC.watchLinkCreate, IPC.watchLinkList, IPC.watchLinkRevoke, IPC.watchLinkRevokeAll, IPC.watchLinkKick,
        IPC.watchLinkChatSend, IPC.watchLinkChatHistory, IPC.watchLinkSetControl, IPC.watchLinkSetPassword,
        IPC.watchLinkAllowControl, IPC.watchLinkControlSupport
      ].sort()
    )
  })

  it('the Control channels answer owners only, and refuse arguments of the wrong type', async () => {
    const t = service({ controlSupport: () => 'ok', hashPassword: fastHash })
    const p = fakePlatform({ isOwnerClient: (id) => id === 1 })
    registerWatchLinkIpc(p, t.s)
    const made = (await p.handlers[IPC.watchLinkCreate](1, ctlReq())) as { ok: true; link: WatchLinkView }
    const id = made.link.linkId
    const h = t.hosts.made[0]
    // A client that is not the machine's owner reaches nothing.
    expect(await p.handlers[IPC.watchLinkSetControl](2, id, false)).toBe(false)
    expect(await p.handlers[IPC.watchLinkSetPassword](2, id, 'another password')).toBe(false)
    expect(await p.handlers[IPC.watchLinkAllowControl](2, id)).toBe(false)
    expect(await p.handlers[IPC.watchLinkControlSupport](2, 'n1')).toBe('unknown')
    // Wrong types.
    expect(await p.handlers[IPC.watchLinkSetControl](1, id, 'false')).toBe(false)
    expect(await p.handlers[IPC.watchLinkSetControl](1, 7, false)).toBe(false)
    expect(await p.handlers[IPC.watchLinkSetPassword](1, id, 12345678)).toBe(false)
    expect(await p.handlers[IPC.watchLinkAllowControl](1, null)).toBe(false)
    expect(await p.handlers[IPC.watchLinkControlSupport](1, 5)).toBe('unknown')
    expect(h.hooks).toEqual([])
    // The owner.
    expect(await p.handlers[IPC.watchLinkControlSupport](1, 'n1')).toBe('ok')
    expect(await p.handlers[IPC.watchLinkSetControl](1, id, false)).toBe(true)
    expect(await p.handlers[IPC.watchLinkSetPassword](1, id, 'another password')).toBe(true)
    h.deps.onControlLocked()
    expect(await p.handlers[IPC.watchLinkAllowControl](1, id)).toBe(true)
    expect(h.hooks).toEqual(['controlChanged', 'passwordChanged', 'allowControl'])
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

// --- Control links and Unlimited links ------------------------------------------------------------------

const PW = 'correct horse battery'
const NEW_PW = 'staple gun ninety'
const ctlReq = (over: Record<string, unknown> = {}) => req({ role: 'controller', password: PW, ...over })
/** A hash shaped like scrypt's (16-byte salt, 32-byte key) without its ~80 ms: for the tests that
 *  are about the plumbing, not the password. Different every call, like a fresh salt. */
let fastN = 0
const fastHash = async (): Promise<ControlPasswordHash> => {
  fastN++
  return {
    salt: Buffer.alloc(16, fastN % 256).toString('base64'),
    hash: Buffer.alloc(32, (fastN * 7) % 256).toString('base64')
  }
}
const allLogged = (spies: ReturnType<typeof vi.spyOn>[]) => spies.flatMap((sp) => sp.mock.calls.flat().map(String)).join('\n')

describe('createWatchLinkService — creating a Control link', () => {
  it('hashes the password, keeps only {salt, hash} in the record, and the host checks against it', async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    expect(r.link).toMatchObject({ role: 'controller', control: { enabled: true, locked: false } })
    const text = readFileSync(t.file, 'utf8')
    expect(text).not.toContain(PW)
    expect(text).not.toContain(Buffer.from(PW).toString('base64'))
    expect(text).not.toContain(Buffer.from(PW).toString('hex'))
    const [loaded] = await t.store.load()
    expect(Object.keys(loaded.control ?? {}).sort()).toEqual(['enabled', 'hash', 'locked', 'salt', 'wrong'])
    expect(loaded.control).toMatchObject({ enabled: true, locked: false })
    expect(await verifyControlPassword(PW, loaded.control!)).toBe(true)
    const h = t.hosts.made[0]
    expect(await h.deps.verifyPassword(PW)).toBe(true)
    expect(await h.deps.verifyPassword('not the password')).toBe(false)
  })

  it('a viewer or commenter link ignores a password field: no control, nothing of it on disk', async () => {
    const t = service()
    for (const role of ['viewer', 'commenter']) {
      const r = await t.s.create(req({ role, password: PW }))
      if (!r.ok) throw new Error(r.error)
      expect(r.link.control).toBeNull()
    }
    expect(readFileSync(t.file, 'utf8')).not.toContain(PW)
    expect((await t.store.load()).map((l) => l.control)).toEqual([undefined, undefined])
    expect(await t.hosts.made[0].deps.verifyPassword(PW)).toBe(false)
  })

  it('a Control link without an acceptable password is bad-password, and nothing is asked of the server', async () => {
    const t = service()
    for (const password of [undefined, '', 'short', 12345678, 'abcdefg\n', 'x'.repeat(129), null, {}]) {
      expect(await t.s.create(ctlReq({ password })), JSON.stringify(password)).toEqual({ ok: false, error: 'bad-password' })
    }
    // A request that is malformed otherwise is bad-request, whatever its password.
    expect(await t.s.create(ctlReq({ password: 'short', ttlSeconds: 7 }))).toEqual({ ok: false, error: 'bad-request' })
    expect(t.calls).toEqual([])
    expect(t.hosts.made).toEqual([])
  })

  it('a Control link on a terminal that cannot take input (Zellij) is control-unsupported, before any request', async () => {
    const answers = new Map<string, ControlSupport>([['n1', 'unsupported'], ['n2', 'unknown']])
    const t = service({ controlSupport: (id) => answers.get(id) ?? 'ok' })
    expect(await t.s.create(ctlReq())).toEqual({ ok: false, error: 'control-unsupported' })
    expect(t.calls).toEqual([])
    // Only a Control link is asked about; unknown leaves the create to decide.
    expect((await t.s.create(req({ role: 'commenter' }))).ok).toBe(true)
    expect((await t.s.create(ctlReq({ nodeId: 'n2' }))).ok).toBe(true)
    // A check that throws reads as unknown.
    const u = service({
      controlSupport: () => {
        throw new Error('boom')
      }
    })
    expect((await u.s.create(ctlReq())).ok).toBe(true)
    // A shell that wires no check: unknown.
    expect((await service().s.create(ctlReq())).ok).toBe(true)
  })

  it('the password is hashed BEFORE the server create: a hash that fails creates no server row, and logs nothing of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = service({
      hashPassword: async (pw) => {
        throw new Error(`scrypt said no about ${pw}`)
      }
    })
    // `unsupported`: the one kind whose desktop copy names no cause ("can't be created here right now");
    // `network` would say nodeterm's service could not be reached, which is not what happened.
    expect(await t.s.create(ctlReq())).toEqual({ ok: false, error: 'unsupported' })
    expect(t.calls).toEqual([])
    expect(t.hosts.made).toEqual([])
    expect(allLogged([warn])).not.toContain(PW)
    warn.mockRestore()
  })
})

describe('createWatchLinkService — creating an Unlimited link', () => {
  it('asks for ttlSeconds 0 and records expiresAt: null, with no expiry timer: still live after any time', async () => {
    vi.useFakeTimers()
    const t = service()
    const r = await t.s.create(req({ ttlSeconds: 0 }))
    if (!r.ok) throw new Error(r.error)
    expect(t.ttls).toEqual([0])
    expect(r.link.expiresAt).toBeNull()
    expect((await t.store.load())[0].expiresAt).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(400 * 24 * HOUR)
    expect(t.s.list().map((l) => l.expiresAt)).toEqual([null])
    expect(t.hosts.made[0].stopped).toEqual([])
  })

  it('an older server (ttl-unsupported) creates nothing here', async () => {
    const t = service({ api: { create: async () => ({ ok: false, error: 'ttl-unsupported' }) } })
    expect(await t.s.create(req({ ttlSeconds: 0 }))).toEqual({ ok: false, error: 'ttl-unsupported' })
    expect(t.hosts.made).toEqual([])
    expect(t.s.list()).toEqual([])
    expect(await t.store.load()).toEqual([])
  })

  // The backend checks an Unlimited link's license daily at its host-token mint and answers 402 once
  // the owner's Pro lapsed. That is the same refusal as any other: the REAL host stops minting (no
  // retry loop) and the owner's view reads `status: 'refused'`.
  it("a 402 at the mint (Pro lapsed) stops minting for good and the view reads status 'refused'", async () => {
    const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
    vi.useFakeTimers()
    let mints = 0
    const t = service({
      realHost: true,
      api: {
        hostToken: async () => {
          mints++
          return { ok: false, kind: 'refused', status: 402 }
        }
      }
    })
    const r = await t.s.create(req({ ttlSeconds: 0 }))
    if (!r.ok) throw new Error(r.error)
    await vi.waitFor(() => expect(mints).toBe(1))
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(mints).toBe(1)
    expect(t.s.list()[0]).toMatchObject({ status: 'refused', expiresAt: null })
    expect(t.states().at(-1)?.[0].status).toBe('refused')
    for (const q of quiet) q.mockRestore()
  })
})

describe('createWatchLinkService — the Control host seams', () => {
  it('a lock is set on the record SYNCHRONOUSLY, then written, and the owner is told', async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    h.deps.onControlLocked()
    expect(h.record.control?.locked).toBe(true) // before any await: the host's lock rests on it
    expect(t.notices().at(-1)).toEqual({ kind: 'control-locked', linkId: r.link.linkId, nodeId: 'n1', title: 'build' })
    expect((await t.store.load())[0].control?.locked).toBe(true)
    await flush()
    expect(t.states().at(-1)?.[0].control).toEqual({ enabled: true, locked: true })
  })

  it('a lock whose write fails still holds in memory, and the failure is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let outcome: SaveOutcome = 'saved'
    const f = fakeStore({ save: async () => outcome })
    const t = service({ store: f.store })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    outcome = 'failed'
    t.hosts.made[0].deps.onControlLocked()
    await vi.waitFor(() => expect(warn.mock.calls.some(([l]) => /lock/.test(String(l)))).toBe(true))
    expect(t.s.list()[0].control).toEqual({ enabled: true, locked: true })
    const c = t.hosts.made[0].record.control!
    for (const secret of [PW, c.salt, c.hash]) expect(allLogged([warn])).not.toContain(secret)
    warn.mockRestore()
  })

  // Final review, Minor 2: the link-wide wrong count is persisted beside `locked`, so an app restart
  // no longer resets it toward the lock (with Unlimited links that was 9 fresh guesses per restart).
  it('each wrong attempt puts the link-wide count on the record and writes it — at most 10 writes, the 10th rides the lock', async () => {
    const written: (WatchLinkRecord['control'] | undefined)[] = []
    const f = fakeStore({
      save: async (recs) => {
        written.push(recs[0]?.control ? { ...recs[0].control } : undefined)
        return 'saved'
      }
    })
    const t = service({ store: f.store, hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    expect(h.record.control?.wrong).toBe(0)
    const saves = f.saves.length
    for (let n = 1; n <= WRONG_PER_LINK; n++) {
      h.deps.onWrongAttempt(n)
      expect(h.record.control?.wrong).toBe(n) // synchronously: the record is the count's home
      if (n === WRONG_PER_LINK) h.deps.onControlLocked() // what the host does at the 10th
    }
    await flush()
    expect(f.saves.length - saves).toBe(WRONG_PER_LINK)
    expect(written.slice(saves).map((c) => c?.wrong)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(written.at(-1)).toMatchObject({ wrong: WRONG_PER_LINK, locked: true })
  })

  it('a count outside 0..10 is clamped onto the record (the store would refuse to write it)', async () => {
    const t = service({ hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    h.deps.onWrongAttempt(99)
    expect(h.record.control?.wrong).toBe(WRONG_PER_LINK)
    h.deps.onWrongAttempt(-3)
    expect(h.record.control?.wrong).toBe(0)
    h.deps.onWrongAttempt(Number.NaN)
    expect(h.record.control?.wrong).toBe(0)
    await flush()
    expect((await t.store.load())[0].control?.wrong).toBe(0)
  })

  it('the count survives a restart: a host resumed from the saved record starts from it', async () => {
    const t = service({ hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    for (let n = 1; n <= 9; n++) t.hosts.made[0].deps.onWrongAttempt(n)
    await flush()
    expect((await t.store.load())[0].control?.wrong).toBe(9)
    await t.s.shutdown()
    const again = service({ store: new WatchLinkStore({ file: t.file }) })
    await again.s.init()
    expect(again.hosts.made[0].record.control?.wrong).toBe(9)
  })

  it('a new password and Allow control again reset the count, on the record and on disk', async () => {
    const t = service({ hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    for (let n = 1; n <= 5; n++) h.deps.onWrongAttempt(n)
    expect(await t.s.setPassword(r.link.linkId, NEW_PW)).toBe(true)
    expect(h.record.control?.wrong).toBe(0)
    expect((await t.store.load())[0].control?.wrong).toBe(0)
    for (let n = 1; n <= WRONG_PER_LINK; n++) h.deps.onWrongAttempt(n)
    h.deps.onControlLocked()
    expect(await t.s.allowControl(r.link.linkId)).toBe(true)
    expect(h.record.control).toMatchObject({ locked: false, wrong: 0 })
    expect((await t.store.load())[0].control).toMatchObject({ locked: false, wrong: 0 })
  })

  it('a viewer taking control tells the owner, under the name it gave (bidi stripped)', async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    t.hosts.made[0].deps.onControlTaken('E\u202eve')
    expect(t.notices().at(-1)).toEqual({ kind: 'control-taken', linkId: r.link.linkId, nodeId: 'n1', title: 'build', name: 'Eve' })
    await flush()
    expect(t.states().length).toBeGreaterThan(0)
  })

  it("the owner's view carries each viewer's controlling and typing from the host, and the link's control state", async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    t.hosts.made[0].viewers = [
      { viewerId: 'v-1', name: 'Ada', joinedAt: 5, waiting: false, controlling: true, typing: true },
      { viewerId: 'v-2', name: null, joinedAt: 6, waiting: false, controlling: false, typing: false }
    ]
    expect(t.s.list()[0].viewers.map((v) => [v.controlling, v.typing])).toEqual([[true, true], [false, false]])
    expect(t.s.list()[0].control).toEqual({ enabled: true, locked: false })
  })
})

describe('createWatchLinkService — the owner controls a Control link', () => {
  it('setControl writes enabled, persists it and tells the host; refused for anything but a live Control link', async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    const v = await t.s.create(req({ role: 'commenter', nodeId: 'n2' }))
    if (!r.ok || !v.ok) throw new Error('create failed')
    const h = t.hosts.made[0]
    expect(await t.s.setControl(r.link.linkId, false)).toBe(true)
    expect(h.hooks).toEqual(['controlChanged'])
    expect((await t.store.load()).find((l) => l.linkId === r.link.linkId)?.control?.enabled).toBe(false)
    await flush()
    expect(t.states().at(-1)?.find((l) => l.linkId === r.link.linkId)?.control).toEqual({ enabled: false, locked: false })
    expect(await t.s.setControl(r.link.linkId, true)).toBe(true)
    expect(h.hooks).toEqual(['controlChanged', 'controlChanged'])
    // Not a Control link, an unknown link, an ended one.
    expect(await t.s.setControl(v.link.linkId, false)).toBe(false)
    expect(await t.s.setControl('Nope000000000000000000', false)).toBe(false)
    await t.s.revoke(r.link.linkId)
    expect(await t.s.setControl(r.link.linkId, false)).toBe(false)
    expect(t.hosts.made[1].hooks).toEqual([])
  })

  it('setPassword checks the new password, swaps the hash, persists, and demotes every controller; the old one stops working', async () => {
    const t = service()
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    const before = { ...(await t.store.load())[0].control! }
    for (const bad of ['short', 'abcdefg\n', 'x'.repeat(129), 12345678]) {
      expect(await t.s.setPassword(r.link.linkId, bad as string)).toBe(false)
    }
    expect(h.hooks).toEqual([])
    expect(await t.s.setPassword(r.link.linkId, NEW_PW)).toBe(true)
    expect(h.hooks).toEqual(['passwordChanged'])
    const after = (await t.store.load())[0].control!
    expect(after.salt).not.toBe(before.salt)
    expect(after.hash).not.toBe(before.hash)
    expect(readFileSync(t.file, 'utf8')).not.toContain(NEW_PW)
    // The host checks against the CURRENT hash.
    expect(await h.deps.verifyPassword(NEW_PW)).toBe(true)
    expect(await h.deps.verifyPassword(PW)).toBe(false)
    const v = await t.s.create(req({ role: 'viewer', nodeId: 'n2' }))
    if (!v.ok) throw new Error(v.error)
    expect(await t.s.setPassword(v.link.linkId, NEW_PW)).toBe(false)
  })

  it('allowControl clears the lock, persists it and tells the host', async () => {
    const t = service({ hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    h.deps.onControlLocked()
    expect(await t.s.allowControl(r.link.linkId)).toBe(true)
    expect(h.hooks).toEqual(['allowControl'])
    expect((await t.store.load())[0].control?.locked).toBe(false)
    expect(t.s.list()[0].control).toEqual({ enabled: true, locked: false })
    expect(await t.s.allowControl('Nope000000000000000000')).toBe(false)
  })

  // THE BRAKE HOLDS (final review, Important 1): a change that NARROWS access is the owner's emergency
  // brake. It stays in force whatever the disk does, and the owner is told 'unsaved' (applied now, gone
  // at a restart); the next write that lands carries it. A widening still changes nothing on a failure.
  function snapStore(o: { save: () => Promise<SaveOutcome> }) {
    /** What each write carried for the first record, copied AT CALL TIME (the store snapshots then). */
    const written: (WatchLinkRecord['control'] | undefined)[] = []
    const f = fakeStore({
      save: (recs) => {
        written.push(recs[0]?.control ? { ...recs[0].control } : undefined)
        return o.save()
      }
    })
    return { ...f, written }
  }

  it("typing OFF whose write fails stays off at the host and in memory, answers 'unsaved', and the next write that lands carries it", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let outcome: SaveOutcome = 'saved'
    const f = snapStore({ save: async () => outcome })
    const t = service({ store: f.store, hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const id = r.link.linkId
    const h = t.hosts.made[0]
    outcome = 'failed'
    const saves = f.saves.length
    expect(await t.s.setControl(id, false)).toBe('unsaved')
    // Never undone: the record the host reads, the owner's view, and the host told once.
    expect(h.record.control?.enabled).toBe(false)
    expect(t.s.list()[0].control).toEqual({ enabled: false, locked: false })
    expect(h.hooks).toEqual(['controlChanged'])
    expect(f.saves.length).toBe(saves + 1) // no "corrected" list queued behind it
    expect(f.written.at(-1)?.enabled).toBe(false)
    // The next write that lands (any change: here a second link) carries the narrowed state.
    outcome = 'saved'
    const other = await t.s.create(req({ nodeId: 'n2' }))
    expect(other.ok).toBe(true)
    expect(f.written.at(-1)?.enabled).toBe(false)
    expect(t.s.list().find((l) => l.linkId === id)?.control).toEqual({ enabled: false, locked: false })
    expect(allLogged([warn])).not.toContain(PW)
    warn.mockRestore()
  })

  it("a new password whose write fails is in force — the old one refused, the new one opens — answers 'unsaved', and the next write that lands carries its hash", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let outcome: SaveOutcome = 'saved'
    const f = snapStore({ save: async () => outcome })
    const t = service({ store: f.store })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const id = r.link.linkId
    const h = t.hosts.made[0]
    const before = { ...h.record.control! }
    outcome = 'failed'
    expect(await t.s.setPassword(id, NEW_PW)).toBe('unsaved')
    expect(h.hooks).toEqual(['passwordChanged']) // every controller demoted, never re-told
    expect(await h.deps.verifyPassword(PW)).toBe(false)
    expect(await h.deps.verifyPassword(NEW_PW)).toBe(true)
    const now = h.record.control!
    expect(now.hash).not.toBe(before.hash)
    outcome = 'saved'
    h.deps.onControlLocked() // any later write: this one is the lock's
    await flush()
    expect(f.written.at(-1)).toMatchObject({ salt: now.salt, hash: now.hash, locked: true })
    for (const secret of [PW, NEW_PW, now.salt, now.hash]) expect(allLogged([warn])).not.toContain(secret)
    warn.mockRestore()
  })

  it("a narrowing whose write HANGS is bounded: 'unsaved' at the bound, still in force, and the next write that lands carries it", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let held: ReturnType<typeof deferred<SaveOutcome>> | null = null
    const f = snapStore({ save: () => (held ? held.promise : Promise.resolve('saved')) })
    const t = service({ store: f.store, persistTimeoutMs: 20, hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const id = r.link.linkId
    const h = t.hosts.made[0]
    held = deferred<SaveOutcome>()
    expect(await t.s.setControl(id, false)).toBe('unsaved')
    expect(h.record.control?.enabled).toBe(false)
    expect(h.hooks).toEqual(['controlChanged'])
    expect(await t.s.setPassword(id, NEW_PW)).toBe('unsaved')
    expect(h.hooks).toEqual(['controlChanged', 'passwordChanged'])
    const after = { ...h.record.control! }
    expect(t.s.list()[0].control).toEqual({ enabled: false, locked: false })
    // The disk answers again: the hung writes land, and the next write carries both changes.
    const d = held
    held = null
    d.resolve('failed')
    await flush()
    const other = await t.s.create(req({ nodeId: 'n2' }))
    expect(other.ok).toBe(true)
    expect(f.written.at(-1)).toMatchObject({ enabled: false, salt: after.salt, hash: after.hash })
    expect(h.record.control).toMatchObject({ enabled: false, salt: after.salt, hash: after.hash })
  })

  it('a widening whose write fails changes nothing and answers false; a lock is never undone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let outcome: SaveOutcome = 'saved'
    const f = fakeStore({ save: async () => outcome })
    const t = service({ store: f.store, hashPassword: fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const id = r.link.linkId
    const h = t.hosts.made[0]
    outcome = 'failed'
    h.deps.onControlLocked() // its own write fails too: the lock holds
    expect(await t.s.allowControl(id)).toBe(false)
    expect(h.hooks).toEqual([]) // a widening the write refused never reached the host
    expect(t.s.list()[0].control).toEqual({ enabled: true, locked: true })
    warn.mockRestore()
  })
})

// A change that NARROWS access (typing off, a new password) reaches the host at once, before the write.
// One that WIDENS it (typing on, allow again) reaches it only once the write landed: a viewer must never
// unlock and type during a write the owner is then told failed.
describe('createWatchLinkService — owner changes, by direction', () => {
  async function heldWrites(o: { hashPassword?: Opts['hashPassword'] } = {}) {
    let held: ReturnType<typeof deferred<SaveOutcome>> | null = null
    // What each write carried, copied AT CALL TIME (the store snapshots then; the record objects in
    // `f.saves` are the live ones and would show later changes).
    const written: (WatchLinkRecord['control'] | undefined)[] = []
    const f = fakeStore({
      save: (recs) => {
        written.push(recs[0]?.control ? { ...recs[0].control } : undefined)
        return held ? held.promise : Promise.resolve('saved')
      }
    })
    const t = service({ store: f.store, hashPassword: o.hashPassword ?? fastHash })
    const r = await t.s.create(ctlReq())
    if (!r.ok) throw new Error(r.error)
    const h = t.hosts.made[0]
    return {
      t, f, h, written, id: r.link.linkId,
      hold: () => (held = deferred<SaveOutcome>()),
      release: (o: SaveOutcome) => {
        const d = held!
        held = null
        d.resolve(o)
      }
    }
  }

  it('typing OFF reaches the host before the write lands', async () => {
    const x = await heldWrites()
    x.hold()
    const off = x.t.s.setControl(x.id, false)
    await flush()
    expect(x.h.record.control?.enabled).toBe(false)
    expect(x.h.hooks).toEqual(['controlChanged'])
    x.release('saved')
    expect(await off).toBe(true)
  })

  it('typing ON waits for the write: the record the host reads stays off throughout, and a failed write never turns it on', async () => {
    const x = await heldWrites()
    expect(await x.t.s.setControl(x.id, false)).toBe(true)
    x.h.hooks.length = 0
    x.hold()
    const on = x.t.s.setControl(x.id, true)
    await flush()
    // What an unlock checks (the host reads the record live): still off while the write is in flight.
    expect(x.h.record.control?.enabled).toBe(false)
    expect(x.h.hooks).toEqual([])
    expect(x.t.s.list()[0].control).toEqual({ enabled: false, locked: false })
    // …and yet the write carries the change.
    expect(x.written.at(-1)?.enabled).toBe(true)
    x.release('failed')
    expect(await on).toBe(false)
    expect(x.h.record.control?.enabled).toBe(false)
    expect(x.h.hooks).toEqual([])
    expect(x.written.at(-1)?.enabled).toBe(false) // the list as it is, queued behind
  })

  it('typing ON that lands: applied, then the host is told', async () => {
    const x = await heldWrites()
    expect(await x.t.s.setControl(x.id, false)).toBe(true)
    x.h.hooks.length = 0
    x.hold()
    const on = x.t.s.setControl(x.id, true)
    await flush()
    expect(x.h.hooks).toEqual([])
    x.release('saved')
    expect(await on).toBe(true)
    expect(x.h.record.control?.enabled).toBe(true)
    expect(x.h.hooks).toEqual(['controlChanged'])
    expect(x.t.s.list()[0].control).toEqual({ enabled: true, locked: false })
  })

  it('allowControl waits for the write too: still locked throughout, and a failed write never unlocks it', async () => {
    const x = await heldWrites()
    x.h.deps.onControlLocked()
    await flush()
    x.hold()
    const allow = x.t.s.allowControl(x.id)
    await flush()
    expect(x.h.record.control?.locked).toBe(true)
    expect(x.h.hooks).toEqual([])
    x.release('failed')
    expect(await allow).toBe(false)
    expect(x.h.record.control?.locked).toBe(true)
    expect(x.h.hooks).toEqual([])
    x.hold()
    const again = x.t.s.allowControl(x.id)
    await flush()
    expect(x.h.record.control?.locked).toBe(true)
    x.release('saved')
    expect(await again).toBe(true)
    expect(x.h.record.control?.locked).toBe(false)
    expect(x.h.hooks).toEqual(['allowControl'])
  })

  it('typing ON then OFF while the ON is still being written: OFF wins, and the disk ends off', async () => {
    const x = await heldWrites()
    expect(await x.t.s.setControl(x.id, false)).toBe(true)
    x.h.hooks.length = 0
    x.hold()
    const on = x.t.s.setControl(x.id, true)
    await flush()
    expect(await x.t.s.setControl(x.id, false)).toBe(true) // the later click
    x.release('saved')
    expect(await on).toBe(true) // written, then replaced by the later change
    expect(x.h.record.control?.enabled).toBe(false)
    expect(x.h.hooks).toEqual([])
    await vi.waitFor(() => expect(x.written.at(-1)?.enabled).toBe(false))
  })

  it('a write issued while a widening is in flight cannot leave the disk behind memory', async () => {
    const x = await heldWrites()
    expect(await x.t.s.setControl(x.id, false)).toBe(true)
    x.hold()
    const on = x.t.s.setControl(x.id, true)
    await flush()
    const n = x.written.length
    // A lock writes the LIVE record (still off) behind the write that carries ON — and touches
    // another field, so the ON keeps its turn and is applied once its write lands.
    x.h.deps.onControlLocked()
    expect(x.written.length).toBe(n + 1)
    expect(x.written.at(-1)).toMatchObject({ enabled: false, locked: true })
    x.release('saved')
    expect(await on).toBe(true)
    expect(x.h.record.control).toMatchObject({ enabled: true, locked: true })
    // The last write is the record as memory holds it, not the lock's older snapshot.
    await vi.waitFor(() => expect(x.written.at(-1)).toEqual({ ...x.h.record.control }))
  })
})

describe('createWatchLinkService — one bound on scrypt', () => {
  it('a FIFO gate: a third task waits for a slot, slots go in arrival order, a failure frees its slot', async () => {
    const gate = createFifoGate(2)
    const started: string[] = []
    const held = new Map<string, ReturnType<typeof deferred<string>>>()
    const run = (k: string) =>
      gate(() => {
        started.push(k)
        const d = deferred<string>()
        held.set(k, d)
        return d.promise
      })
    const out = ['a', 'b', 'c', 'd', 'e'].map((k) => run(k).catch((e: Error) => `x${e.message}`))
    await flush()
    expect(started).toEqual(['a', 'b'])
    held.get('b')!.reject(new Error('b'))
    await flush()
    expect(started).toEqual(['a', 'b', 'c'])
    held.get('a')!.resolve('a')
    await flush()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    held.get('c')!.resolve('c')
    held.get('d')!.resolve('d')
    await flush()
    held.get('e')!.resolve('e')
    expect(await Promise.all(out)).toEqual(['a', 'xb', 'c', 'd', 'e'])
    // A task that throws synchronously frees its slot too.
    const t2 = createFifoGate(1)
    await expect(
      t2(() => {
        throw new Error('sync')
      })
    ).rejects.toThrow('sync')
    expect(await t2(async () => 'next')).toBe('next')
  })

  it("every link host's password check goes through ONE 2-slot gate, in order; a new password's hash waits its turn too", async () => {
    const started: string[] = []
    const held = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const t = service({
      hashPassword: async (pw) => {
        started.push(`hash:${pw}`)
        return fastHash()
      },
      verifyPassword: (pw) => {
        started.push(pw)
        const d = deferred<boolean>()
        held.set(pw, d)
        return d.promise
      }
    })
    for (const nodeId of ['n1', 'n2', 'n1']) expect((await t.s.create(ctlReq({ nodeId }))).ok).toBe(true)
    started.length = 0
    const [a, b, c] = t.hosts.made
    const results = [a.deps.verifyPassword('pa'), b.deps.verifyPassword('pb'), c.deps.verifyPassword('pc')]
    const changed = t.s.setPassword(a.record.linkId, NEW_PW)
    await flush()
    expect(started).toEqual(['pa', 'pb'])
    held.get('pb')!.resolve(false)
    await flush()
    expect(started).toEqual(['pa', 'pb', 'pc'])
    held.get('pa')!.resolve(true)
    await flush()
    expect(started).toEqual(['pa', 'pb', 'pc', `hash:${NEW_PW}`])
    held.get('pc')!.resolve(true)
    expect(await Promise.all(results)).toEqual([true, false, true])
    expect(await changed).toBe(true)
  })
})

describe('createWatchLinkService — a password check queued behind a new password', () => {
  it('reads the NEW hash when it runs: the old password fails, the new one opens', async () => {
    const holds = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const seen: { pw: string; hash: string }[] = []
    const t = service({
      verifyPassword: (pw, h) => {
        seen.push({ pw, hash: h.hash })
        if (pw.startsWith('hold-')) {
          const d = deferred<boolean>()
          holds.set(pw, d)
          return d.promise
        }
        return verifyControlPassword(pw, h)
      }
    })
    for (const nodeId of ['n1', 'n2', 'n1']) expect((await t.s.create(ctlReq({ nodeId }))).ok).toBe(true)
    const [a, b, c] = t.hosts.made
    const oldHash = a.record.control!.hash
    // Both slots busy; then the new password's hash, then two checks on link A, queue in that order.
    const busy = [b.deps.verifyPassword('hold-b'), c.deps.verifyPassword('hold-c')]
    await flush()
    const changed = t.s.setPassword(a.record.linkId, NEW_PW)
    const oldTry = a.deps.verifyPassword(PW)
    const newTry = a.deps.verifyPassword(NEW_PW)
    await flush()
    expect(seen.map((x) => x.pw)).toEqual(['hold-b', 'hold-c'])
    // One slot frees: the hash runs in it while the other stays busy, so both checks are still queued
    // when the new password lands; the first takes the hash's slot after it.
    holds.get('hold-b')!.resolve(false)
    expect(await changed).toBe(true)
    expect(await oldTry).toBe(false)
    holds.get('hold-c')!.resolve(false)
    expect(await newTry).toBe(true)
    const newHash = a.record.control!.hash
    expect(newHash).not.toBe(oldHash)
    expect(seen.filter((x) => x.pw === PW || x.pw === NEW_PW).map((x) => x.hash)).toEqual([newHash, newHash])
    await Promise.all(busy)
  })
})

describe('createWatchLinkService — controlSupport', () => {
  it("answers the shell's check; anything else, a throw, an unsafe id or no check at all is unknown", () => {
    const answers: Record<string, unknown> = { n1: 'ok', n2: 'unsupported', n3: 'maybe' }
    const t = service({ controlSupport: (id) => answers[id] as ControlSupport })
    expect(t.s.controlSupport('n1')).toBe('ok')
    expect(t.s.controlSupport('n2')).toBe('unsupported')
    expect(t.s.controlSupport('n3')).toBe('unknown')
    expect(t.s.controlSupport('../x')).toBe('unknown')
    expect(t.s.controlSupport(7 as unknown as string)).toBe('unknown')
    const boom = service({
      controlSupport: () => {
        throw new Error('x')
      }
    })
    expect(boom.s.controlSupport('n1')).toBe('unknown')
    expect(service().s.controlSupport('n1')).toBe('unknown')
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
