// src/core/relay/hosted-service.test.ts
// Real relay-socket E2EE + real trust gates over an in-process transport; fake mint + fake attach.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostedService, PENDING_TTL_MS, PENDING_MAX, type HostedService, type HostedServiceDeps } from './hosted-service'
import { transportPair } from './transport-pair'
import { connectRelayClient, type RelayClientSession } from './relay-client'
import { killRelayHostsByPeerKey, type PeerAttach } from './relay-host'
import { connectRelay } from './relay-socket'
import { loadHostKey } from './host-key'
import { genKeyPair, publicKeyToB64, type KeyPair } from './e2ee'
import { decodeJoinCode } from './join-code'
import { IPC } from '../../shared/ipc'
import { encodePtyData } from '../../shared/rpc'
import type { RelayTransport } from './relay-socket'
import type { UiSink } from '../ui-sink-registry'

// The team store's disk write, holdable and failable per test: a pin write that is still in flight,
// or one that fails, is what several of the rules below are about. Pass-through unless armed.
const disk = vi.hoisted(() => ({ holdTeamWrite: false, failTeamWrite: false, held: [] as Array<() => void>, done: 0 }))
vi.mock('../fs-atomic', async (importOriginal) => {
  const real = await importOriginal<typeof import('../fs-atomic')>()
  return {
    ...real,
    writeFileAtomic: async (file: string, data: string, opts?: { mode?: number }) => {
      if (String(file).endsWith('team.json')) {
        if (disk.failTeamWrite) {
          disk.failTeamWrite = false
          throw new Error('disk full')
        }
        if (disk.holdTeamWrite) {
          disk.holdTeamWrite = false
          await new Promise<void>((r) => disk.held.push(r))
        }
      }
      await real.writeFileAtomic(file, data, opts)
      if (String(file).endsWith('team.json')) disk.done++
    }
  }
})
const releaseHeldWrites = () => { for (const r of disk.held.splice(0)) r() }

const pub = (k: KeyPair) => publicKeyToB64(k.publicKey)
const settle = () => new Promise((r) => setTimeout(r, 25))

interface Armed { ms: number; h: unknown; fn: () => void; cleared: boolean }

const live: Array<{ svc: HostedService; dataDir: string }> = []
afterEach(() => {
  releaseHeldWrites()
  disk.holdTeamWrite = false
  disk.failTeamWrite = false
  for (const w of live.splice(0)) {
    w.svc.stop()
    fs.rmSync(w.dataDir, { recursive: true, force: true })
  }
})

type WorldOpts = Partial<Pick<HostedServiceDeps, 'now' | 'monotonicNow' | 'projectsOfNode' | 'nodeOfSession' | 'killPeer' | 'onSharedChange'>> & {
  recordTimers?: boolean
  dataDir?: string
}

function world(opts: WorldOpts = {}) {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-'))
  const sinks = new Map<number, UiSink>()
  const dispatched: string[] = []
  const casts: string[] = []
  let next = 1
  const attach: PeerAttach = {
    attach: (s) => { const id = next++; sinks.set(id, s); return id },
    detach: (id) => { sinks.delete(id) },
    dispatch: async (_id, req) => {
      dispatched.push(req.method)
      if (req.method === IPC.ptyCreate) return { t: 'res', id: req.id, ok: true, result: { sessionId: 'sess-shared', fresh: false } }
      if (req.method === IPC.agentSubagentSnapshot) {
        return { t: 'res', id: req.id, ok: true, result: [{ nodeId: 'n-shared', task: 'shared task' }, { nodeId: 'n-other', task: 'SECRET other task' }] }
      }
      return { t: 'res', id: req.id, ok: true, result: { projects: [{ id: 'P' }, { id: 'Q' }], activeProjectId: 'P' } }
    },
    cast: (_id, method) => { casts.push(method) }
  }
  const peersT: RelayTransport[] = []
  let mints = 0
  let challenges = 0
  const armed: Armed[] = []
  const timerDeps: Pick<HostedServiceDeps, 'setTimeout' | 'clearTimeout'> = opts.recordTimers
    ? {
        setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); armed.push({ ms, h, fn, cleared: false }); return h },
        clearTimeout: (h) => {
          for (const a of armed) if (a.h === h) a.cleared = true
          clearTimeout(h as ReturnType<typeof setTimeout>)
        }
      }
    : {}
  const svc = createHostedService({
    dataDir, apiBase: 'https://api', relayUrl: 'ws://127.0.0.1/r', deviceId: 'host-dev', hostLabel: 'box',
    attach,
    projectsOfNode: opts.projectsOfNode ?? ((id) => (id === 'n-other' ? ['Q'] : ['P'])),
    // Terminal sessions: 'sess-shared' runs n-shared (project P), 'sess-other' runs n-other (Q).
    nodeOfSession: opts.nodeOfSession ?? ((sid) => (sid === 'sess-shared' ? 'n-shared' : sid === 'sess-other' ? 'n-other' : undefined)),
    projectCwd: () => '/srv/app',
    // Routed by URL: the key-proof challenge answers 404 (a pre-proof backend, so the legacy mint
    // follows), and only host-token calls count as mints.
    fetch: (async (u: string | URL | Request) => {
      if (String(u).endsWith('/v1/relay/challenge')) { challenges++; return new Response('{}', { status: 404 }) }
      mints++
      return new Response(JSON.stringify({ pairingToken: 'T', hostId: 'H', exp: 0 }), { status: 200 })
    }) as typeof fetch,
    transport: () => { const { hostT, peerT } = transportPair(); peersT.push(peerT); return hostT },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.monotonicNow ? { monotonicNow: opts.monotonicNow } : {}),
    ...(opts.killPeer ? { killPeer: opts.killPeer } : {}),
    ...(opts.onSharedChange ? { onSharedChange: opts.onSharedChange } : {}),
    ...timerDeps
  })
  live.push({ svc, dataDir })
  const join = (keys = genKeyPair(), auto = false, humanConfirms = true, onApproved?: (c: RelayClientSession) => void) => {
    const frames: string[] = []
    const bytes: Array<[string, string]> = []
    const denied: string[] = []
    let approved = false
    let closed = 0
    const peerT = peersT.shift()!
    const c = connectRelayClient({
      url: 'ws://127.0.0.1/r', token: 'T', hostKeyB64: svc.info()!.hostPublicKeyB64, ourKeys: keys, transport: peerT,
      // A human who confirms at once — synchronously inside onSas, which over this in-process
      // transport runs before the client holds its socket (the client defers that confirm).
      autoApprove: auto, onSas: (s) => { if (humanConfirms) s.confirm() },
      onApproved: (s) => { approved = true; onApproved?.(s) }, onFrame: (j) => frames.push(j),
      onPtyData: (sid, d) => bytes.push([sid, d]), onClose: () => { closed++ }, onDenied: (r) => denied.push(r)
    })
    const res = (id: number) => {
      const f = frames.find((x) => { const m = JSON.parse(x); return m.t === 'res' && m.id === id })
      return f ? JSON.parse(f) : undefined
    }
    const events = (channel: string) => frames.map((x) => JSON.parse(x)).filter((m) => m.t === 'ev' && m.channel === channel).map((m) => m.args[0])
    return {
      c, frames, bytes, denied, keys, res, events,
      isApproved: () => approved,
      closedCount: () => closed,
      req: (id: number, method: string, args: unknown[] = []) => c.send(JSON.stringify({ t: 'req', id, method, args })),
      cast: (method: string, args: unknown[] = []) => c.send(JSON.stringify({ t: 'cast', method, args }))
    }
  }
  /** A peer below the relay client: it finishes the handshake but never confirms, and can send
   *  tunnel frames the real client refuses to send before approval. */
  const rawPeer = (keys = genKeyPair()) => {
    const frames: string[] = []
    const socket = connectRelay({
      url: 'ws://127.0.0.1/r', token: 'T', role: 'client', ourKeys: keys, theirPubB64: svc.info()!.hostPublicKeyB64,
      transport: peersT.shift()!, onReady: () => {}, onRpc: () => {}, onFrame: () => {}, onClose: () => {},
      onTunnel: (kind, payload) => { if (kind === 'text') frames.push(new TextDecoder().decode(payload)) }
    })
    const res = (id: number) => {
      const f = frames.find((x) => { const m = JSON.parse(x); return m.t === 'res' && m.id === id })
      return f ? JSON.parse(f) : undefined
    }
    return { frames, res, req: (id: number, method: string, args: unknown[] = []) => socket.sendTunnelText(JSON.stringify({ t: 'req', id, method, args })) }
  }
  const teamOnDisk = (): Array<{ pubkeyB64: string; role: string; addedBy: string; addedAt: string; label: string }> =>
    JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'team.json'), 'utf-8')).peers
  return { svc, join, rawPeer, sinks, dispatched, casts, dataDir, armed, teamOnDisk, mints: () => mints, challenges: () => challenges }
}

async function ownerOnline(w: ReturnType<typeof world>, ownerKeys = genKeyPair()) {
  await w.svc.init()
  await w.svc.addOwner(pub(ownerKeys), 'Enes')
  await w.svc.share('P', true)
  expect(await w.svc.start()).toBe('started')
  await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
  const owner = w.join(ownerKeys, true)
  await vi.waitFor(() => expect(owner.isApproved()).toBe(true))
  return owner
}

/** A guest whose first connect is waiting for an owner. */
async function pendingGuest(w: ReturnType<typeof world>, keys = genKeyPair(), humanConfirms = true) {
  await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
  const g = w.join(keys, false, humanConfirms)
  await vi.waitFor(() => expect(w.svc.status().pending.some((p) => p.peerKeyB64 === pub(keys))).toBe(true))
  const pendingId = w.svc.status().pending.find((p) => p.peerKeyB64 === pub(keys))!.pendingId
  return { g, pendingId }
}

/** The HOST opened the session. The client's own open can come first: the host pins an
 *  owner-approved teammate into the team store before it opens. */
async function hostOpened(w: ReturnType<typeof world>, keys: KeyPair) {
  // An approved request leaves `pending` in the host's onOpen (the tests here never deny these).
  await vi.waitFor(() => expect(w.svc.status().pending.some((p) => p.peerKeyB64 === pub(keys))).toBe(false))
}

async function approvedGuest(w: ReturnType<typeof world>, owner: Awaited<ReturnType<typeof ownerOnline>>, role: string, id: number, keys = genKeyPair()) {
  const { g, pendingId } = await pendingGuest(w, keys)
  owner.req(id, IPC.relayHostedApprove, [pendingId, role])
  await vi.waitFor(() => expect(g.isApproved()).toBe(true))
  await hostOpened(w, keys)
  return g
}

describe('hosted service', () => {
  it('an unknown device waits; only owners are told; nothing is served before approval', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const guest = w.join()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    await vi.waitFor(() => expect(owner.frames.some((f) => f.includes(IPC.relayHostedPeerPending))).toBe(true))
    // The relay client itself refuses to send before approval…
    expect(guest.req(1, IPC.workspaceLoad)).toBe(false)
    // …and the host refuses a peer that sends anyway, hosted verbs included.
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const raw = w.rawPeer()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(2))
    raw.req(1, IPC.workspaceLoad)
    raw.req(2, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'owner'])
    raw.req(3, IPC.relayHostedSelf)
    await vi.waitFor(() => expect(raw.res(3)).toBeDefined())
    for (const id of [1, 2, 3]) expect(raw.res(id)).toMatchObject({ ok: false, error: { code: 'E_UNAUTHORIZED' } })
    expect(w.dispatched).toEqual([])
    expect(w.svc.status().pending).toHaveLength(2)
  })

  it('owner approves as viewer; the guest opens with viewer rights and a narrowed workspace', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const guest = w.join()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    owner.req(5, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'viewer'])
    await vi.waitFor(() => expect(guest.isApproved()).toBe(true))
    guest.req(2, IPC.fsWrite, ['/srv/app/x', 'y'])
    await vi.waitFor(() => expect(guest.frames.some((f) => f.includes('"id":2') && f.includes('E_ROLE'))).toBe(true))
    guest.req(3, IPC.workspaceLoad)
    await vi.waitFor(() => expect(guest.frames.some((f) => f.includes('"id":3'))).toBe(true))
    const res = JSON.parse(guest.frames.find((f) => f.includes('"id":3'))!)
    expect(res.result.projects.map((p: { id: string }) => p.id)).toEqual(['P'])
    expect(w.svc.status().peers.find((p) => p.role === 'viewer')).toBeTruthy()
  })

  it('a non-owner cannot approve', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const g1 = w.join()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    owner.req(5, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'editor'])
    await vi.waitFor(() => expect(g1.isApproved()).toBe(true))
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const g2 = w.join()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    g1.req(9, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'owner'])
    await vi.waitFor(() => expect(g1.frames.some((f) => f.includes('"id":9') && f.includes('Only an owner'))).toBe(true))
    expect(g2.isApproved()).toBe(false)
  })

  it('pinned reconnect needs no human; removal cuts the live session with a reason', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const keys = genKeyPair()
    const g = w.join(keys)
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    owner.req(5, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'editor'])
    await vi.waitFor(() => expect(g.isApproved()).toBe(true))
    // The reconnect below auto-approves only once the approval is pinned.
    await vi.waitFor(() => expect(w.svc.status().peers.some((p) => p.role === 'editor')).toBe(true))
    g.c.close()
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const again = w.join(keys, true)
    await vi.waitFor(() => expect(again.isApproved()).toBe(true))
    expect(await w.svc.remove(publicKeyToB64(keys.publicKey), false)).toBe('removed')
    await vi.waitFor(() => expect(again.denied).toEqual(['removed']))
  })

  it('an unanswered request expires after 10 minutes and is denied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const w = world()
      const owner = await ownerOnline(w)
      await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
      const g = w.join()
      await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
      const pendingId = w.svc.status().pending[0].pendingId
      expect(w.svc.status().scheduler?.bridged).toBe(2)
      await vi.advanceTimersByTimeAsync(600_000)
      await vi.waitFor(() => expect(g.denied).toEqual(['expired']))
      expect(w.svc.status().pending).toHaveLength(0)
      // R20: the scheduler heard the end it did not see on the wire.
      expect(w.svc.status().scheduler?.bridged).toBe(1)
      expect(owner.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId, reason: 'expired' })
      w.svc.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the pending TTL is ten minutes and at most sixteen requests wait at once', () => {
    expect(PENDING_TTL_MS).toBe(600_000)
    expect(PENDING_MAX).toBe(16)
  })
})

describe('hosted service — the first request of a new teammate (R24)', () => {
  it('a request sent the moment the guest is approved, during the host’s pin write, is answered — not refused', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    let sent = false
    const g = w.join(genKeyPair(), false, true, (c) => {
      sent = c.send(JSON.stringify({ t: 'req', id: 1, method: IPC.workspaceLoad, args: [] }))
    })
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(1))
    disk.holdTeamWrite = true // the pin write is in flight until we say so
    owner.req(5, IPC.relayHostedApprove, [w.svc.status().pending[0].pendingId, 'viewer'])
    await vi.waitFor(() => expect(g.isApproved()).toBe(true))
    expect(sent).toBe(true)
    await vi.waitFor(() => expect(disk.held).toHaveLength(1))
    await settle()
    expect(g.res(1)).toBeUndefined() // held, not refused
    expect(w.dispatched).toEqual([])
    releaseHeldWrites()
    await vi.waitFor(() => expect(g.res(1)).toMatchObject({ ok: true, result: { projects: [{ id: 'P' }], activeProjectId: 'P' } }))
    expect(g.frames.some((f) => f.includes('E_UNAUTHORIZED'))).toBe(false)
  })
})

describe('hosted service — owner routing', () => {
  it('pending events go to connected OWNERS only; an owner who connects later is told what is still open', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const editor = await approvedGuest(w, owner, 'editor', 5)
    const { pendingId } = await pendingGuest(w)
    await vi.waitFor(() => expect(owner.events(IPC.relayHostedPeerPending).map((p) => p.pendingId)).toContain(pendingId))
    expect(editor.frames.some((f) => f.includes('relay:hosted:'))).toBe(false)

    // A second owner, offline until now: the open request reaches them on connect.
    const secondKeys = genKeyPair()
    await w.svc.addOwner(pub(secondKeys), 'Ada')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const second = w.join(secondKeys, true)
    await vi.waitFor(() => expect(second.isApproved()).toBe(true))
    await vi.waitFor(() => expect(second.events(IPC.relayHostedPeerPending).map((p) => p.pendingId)).toEqual([pendingId]))
    // The one already answered (the editor's) is not replayed.
    expect(second.events(IPC.relayHostedPeerPending)).toHaveLength(1)

    // The request ends: both owners hear it, the editor still hears nothing.
    owner.req(8, IPC.relayHostedDeny, [pendingId])
    await vi.waitFor(() => expect(second.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId, reason: 'denied' }))
    expect(owner.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId, reason: 'denied' })
    expect(editor.frames.some((f) => f.includes('relay:hosted:'))).toBe(false)
  })

  it('R25: an owner can PULL the open requests; anyone else is refused', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const viewer = await approvedGuest(w, owner, 'viewer', 5)
    const keys = genKeyPair()
    const { pendingId } = await pendingGuest(w, keys)
    owner.req(1, IPC.relayHostedPending)
    viewer.req(2, IPC.relayHostedPending)
    await vi.waitFor(() => expect(owner.res(1)).toBeDefined())
    await vi.waitFor(() => expect(viewer.res(2)).toBeDefined())
    expect(owner.res(1).result).toEqual(w.svc.status().pending)
    expect(owner.res(1).result).toEqual([expect.objectContaining({ pendingId, peerKeyB64: pub(keys) })])
    expect(viewer.res(2)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Only an owner/) } })
  })

  it('the pending event carries the SAS the guest sees and the guest’s key', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const g = w.join(keys)
    await vi.waitFor(() => expect(owner.events(IPC.relayHostedPeerPending)).toHaveLength(1))
    const ev = owner.events(IPC.relayHostedPeerPending)[0]
    expect(ev.peerKeyB64).toBe(pub(keys))
    expect(ev.sas).toBe(g.c.sas())
    expect(typeof ev.pendingId).toBe('string')
  })

  it('a pinned peer that never confirms does not hold the room’s only idle listener', async () => {
    const w = world()
    await ownerOnline(w)
    const keys = genKeyPair()
    await w.svc.addOwner(pub(keys), 'Stuck')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    // Pinned (the host latches its own confirm), but this client's human never answers its dialog.
    const stuck = w.join(keys, false, false)
    // The handshake alone takes the listener out of the pool: a fresh idle one replaces it.
    await vi.waitFor(() => expect(w.svc.status().scheduler).toMatchObject({ idle: 1, bridged: 2 }))
    expect(stuck.isApproved()).toBe(false)
    // …so the next teammate can still get in.
    const { pendingId } = await pendingGuest(w)
    expect(typeof pendingId).toBe('string')
  })
})

describe('hosted service — at most one request per device, and a bounded queue (R28)', () => {
  it('a second connection from the same key replaces the first request, which is denied', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const first = await pendingGuest(w, keys)
    const second = await pendingGuest(w, keys)
    await vi.waitFor(() => expect(first.g.denied).toEqual(['denied']))
    expect(second.pendingId).not.toBe(first.pendingId)
    expect(w.svc.status().pending.map((p) => p.pendingId)).toEqual([second.pendingId])
    await vi.waitFor(() => expect(owner.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId: first.pendingId, reason: 'replaced' }))
    expect(second.g.denied).toEqual([])
  })

  it(`over ${16} waiting requests, the next is denied at once and no owner is told`, async () => {
    const w = world()
    const owner = await ownerOnline(w)
    for (let i = 0; i < PENDING_MAX; i++) await pendingGuest(w)
    expect(w.svc.status().pending).toHaveLength(PENDING_MAX)
    await vi.waitFor(() => expect(owner.events(IPC.relayHostedPeerPending)).toHaveLength(PENDING_MAX))
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    const bridgedBefore = w.svc.status().scheduler!.bridged
    const over = w.join()
    await vi.waitFor(() => expect(over.denied).toEqual(['denied']))
    expect(w.svc.status().pending).toHaveLength(PENDING_MAX)
    await settle()
    expect(owner.events(IPC.relayHostedPeerPending)).toHaveLength(PENDING_MAX)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.bridged).toBe(bridgedBefore))
  })
})

describe('hosted service — approve and deny', () => {
  it('deny tells the guest why, and the scheduler stops counting it as bridged (R20)', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const { g, pendingId } = await pendingGuest(w)
    expect(w.svc.status().scheduler?.bridged).toBe(2)
    owner.req(7, IPC.relayHostedDeny, [pendingId])
    await vi.waitFor(() => expect(g.denied).toEqual(['denied']))
    await vi.waitFor(() => expect(owner.res(7)).toMatchObject({ ok: true, result: true }))
    expect(w.svc.status().pending).toHaveLength(0)
    expect(w.svc.status().scheduler?.bridged).toBe(1)
    expect(g.isApproved()).toBe(false)
  })

  it('a second approve of the same request answers false', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const { g, pendingId } = await pendingGuest(w)
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'viewer'])
    owner.req(6, IPC.relayHostedApprove, [pendingId, 'owner'])
    await vi.waitFor(() => expect(owner.res(6)).toBeDefined())
    expect(owner.res(5)).toMatchObject({ ok: true, result: true })
    expect(owner.res(6)).toMatchObject({ ok: true, result: false })
    await vi.waitFor(() => expect(g.isApproved()).toBe(true))
    await hostOpened(w, g.keys)
    // The first decision stands.
    expect(w.svc.status().peers.find((p) => p.role === 'viewer')).toBeTruthy()
    expect(w.svc.status().peers.filter((p) => p.role === 'owner')).toHaveLength(1)
    // And an approve after the request closed is false too.
    owner.req(9, IPC.relayHostedApprove, [pendingId, 'editor'])
    await vi.waitFor(() => expect(owner.res(9)).toMatchObject({ ok: true, result: false }))
  })

  it('an approve naming an unknown role or request is refused, and nothing opens', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const { g, pendingId } = await pendingGuest(w)
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'superuser'])
    owner.req(6, IPC.relayHostedApprove, ['no-such-request', 'viewer'])
    await vi.waitFor(() => expect(owner.res(6)).toBeDefined())
    expect(owner.res(5)).toMatchObject({ ok: false })
    expect(owner.res(6)).toMatchObject({ ok: true, result: false })
    expect(g.isApproved()).toBe(false)
    expect(w.svc.status().pending).toHaveLength(1)
  })

  it('the approval is pinned with the approver as addedBy, and the pin is what reconnects', async () => {
    const fixed = 1_700_000_000_000
    const w = world({ now: () => fixed })
    const ownerKeys = genKeyPair()
    const owner = await ownerOnline(w, ownerKeys)
    const keys = genKeyPair()
    const { pendingId } = await pendingGuest(w, keys)
    expect(w.svc.status().pending[0].since).toBe(fixed)
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'commenter'])
    await vi.waitFor(() => expect(w.svc.status().peers.some((p) => p.role === 'commenter')).toBe(true))
    expect(w.teamOnDisk().find((p) => p.pubkeyB64 === pub(keys))).toEqual({
      pubkeyB64: pub(keys), label: '', role: 'commenter', addedAt: new Date(fixed).toISOString(), addedBy: pub(ownerKeys)
    })
  })

  it('hosted verbs cannot be CAST around the interceptor, and an unknown hosted verb is refused', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const { g, pendingId } = await pendingGuest(w)
    owner.cast(IPC.relayHostedApprove, [pendingId, 'owner'])
    owner.req(11, 'relay:hosted:bogus')
    await vi.waitFor(() => expect(owner.res(11)).toMatchObject({ ok: false, error: { code: 'E_ROLE' } }))
    expect(g.isApproved()).toBe(false)
    expect(w.svc.status().pending).toHaveLength(1)
    expect(w.casts).toEqual([])
    expect(w.dispatched).toEqual([])
  })
})

describe('hosted service — an approval never overwrites an entry someone else wrote (M3)', () => {
  it('a `team add-owner` that lands while the approval waits for its pin write keeps its OWNER role', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const { g, pendingId } = await pendingGuest(w, keys)
    // The CLI promotes that very key; its write is held, so the approval's pin queues behind it.
    disk.holdTeamWrite = true
    const promoted = w.svc.addOwner(pub(keys), 'Racer')
    await vi.waitFor(() => expect(disk.held).toHaveLength(1))
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'viewer'])
    await vi.waitFor(() => expect(g.isApproved()).toBe(true))
    const writes = disk.done
    releaseHeldWrites()
    await promoted
    await hostOpened(w, keys)
    // Only the add-owner write landed: the approval found the key already there and wrote nothing.
    await vi.waitFor(() => expect(disk.done).toBe(writes + 1))
    const entry = w.teamOnDisk().find((p) => p.pubkeyB64 === pub(keys))
    expect(entry).toMatchObject({ role: 'owner', label: 'Racer', addedBy: 'cli' })
    g.req(1, IPC.relayHostedSelf)
    await vi.waitFor(() => expect(g.res(1)).toMatchObject({ ok: true, result: { role: 'owner' } }))
  })
})

describe('hosted service — a refusal while the approval’s pin is being written (R26)', () => {
  it('a deny that lands while the pin write waits its turn pins nothing', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const { g, pendingId } = await pendingGuest(w, keys)
    disk.holdTeamWrite = true
    const sharing = w.svc.share('Z', true) // holds the team store's chain
    await vi.waitFor(() => expect(disk.held).toHaveLength(1))
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'editor'])
    await vi.waitFor(() => expect(g.isApproved()).toBe(true)) // both confirmed: the pin is queued
    owner.req(6, IPC.relayHostedDeny, [pendingId])
    await vi.waitFor(() => expect(g.denied).toEqual(['denied']))
    const writes = disk.done
    releaseHeldWrites()
    await sharing
    await settle() // the queued pin runs right behind the share; a skipped one writes nothing
    expect(disk.done).toBe(writes + 1)
    expect(w.teamOnDisk().some((p) => p.pubkeyB64 === pub(keys))).toBe(false)
    expect(w.svc.status().peers.map((p) => p.role)).toEqual(['owner'])
  })

  it('a deny that lands while the pin write itself is in flight takes the pin back', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const { g, pendingId } = await pendingGuest(w, keys)
    disk.holdTeamWrite = true
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'editor'])
    await vi.waitFor(() => expect(disk.held).toHaveLength(1)) // the pin's own write is on disk's doorstep
    owner.req(6, IPC.relayHostedDeny, [pendingId])
    await vi.waitFor(() => expect(g.denied).toEqual(['denied']))
    const writes = disk.done
    releaseHeldWrites()
    // The pin write lands, then the write that takes it back: only then is the file settled.
    await vi.waitFor(() => expect(disk.done).toBe(writes + 2))
    expect(w.teamOnDisk().some((p) => p.pubkeyB64 === pub(keys))).toBe(false)
    expect(w.svc.status().peers.map((p) => p.role)).toEqual(['owner'])
  })

  it('an expiry that lands while the pin write is in flight takes the pin back too', async () => {
    const w = world({ recordTimers: true })
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const { g, pendingId } = await pendingGuest(w, keys)
    const expiry = w.armed.find((a) => a.ms === PENDING_TTL_MS)!
    disk.holdTeamWrite = true
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'editor'])
    await vi.waitFor(() => expect(disk.held).toHaveLength(1))
    expiry.fn() // the ten minutes are up, mid-write
    await vi.waitFor(() => expect(g.denied).toEqual(['expired']))
    const writes = disk.done
    releaseHeldWrites()
    await vi.waitFor(() => expect(disk.done).toBe(writes + 2))
    expect(w.teamOnDisk().some((p) => p.pubkeyB64 === pub(keys))).toBe(false)
    expect(w.svc.status().peers.map((p) => p.role)).toEqual(['owner'])
  })

  it('a guest that merely DROPS during the pin write stays pinned: both humans did approve', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const { g, pendingId } = await pendingGuest(w, keys)
    disk.holdTeamWrite = true
    owner.req(5, IPC.relayHostedApprove, [pendingId, 'editor'])
    await vi.waitFor(() => expect(disk.held).toHaveLength(1))
    g.c.close()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(0))
    releaseHeldWrites()
    await vi.waitFor(() => expect(w.teamOnDisk().some((p) => p.pubkeyB64 === pub(keys) && p.role === 'editor')).toBe(true))
  })
})

describe('hosted service — roles', () => {
  it('relay:hosted:self answers the caller’s own role; invite-code is owner-only', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const viewer = await approvedGuest(w, owner, 'viewer', 5)
    viewer.req(1, IPC.relayHostedSelf)
    owner.req(2, IPC.relayHostedSelf)
    viewer.req(3, IPC.relayHostedInviteCode)
    owner.req(4, IPC.relayHostedInviteCode)
    viewer.req(6, IPC.relayHostedDeny, ['whatever'])
    await vi.waitFor(() => expect(viewer.res(6)).toBeDefined())
    await vi.waitFor(() => expect(owner.res(4)).toBeDefined())
    expect(viewer.res(1)).toMatchObject({ ok: true, result: { role: 'viewer', label: '', hostLabel: 'box' } })
    expect(owner.res(2)).toMatchObject({ ok: true, result: { role: 'owner', label: 'Enes', hostLabel: 'box' } })
    expect(viewer.res(3)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Only an owner/) } })
    expect(viewer.res(6)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Only an owner/) } })
    const code = decodeJoinCode(owner.res(4).result)
    expect(code).toMatchObject({ v: 1, relayEndpoint: 'ws://127.0.0.1/r', hostPublicKeyB64: w.svc.info()!.hostPublicKeyB64, hostDeviceId: 'host-dev', label: 'box' })
  })

  it('the role is read on EVERY decision: a promotion applies to the next request', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const g = await approvedGuest(w, owner, 'viewer', 5, keys)
    g.req(1, IPC.fsWrite, ['/srv/app/x', 'y'])
    await vi.waitFor(() => expect(g.res(1)).toMatchObject({ ok: false, error: { code: 'E_ROLE' } }))
    expect(w.dispatched).toEqual([])
    await w.svc.addOwner(pub(keys), 'Promoted')
    g.req(2, IPC.fsWrite, ['/srv/app/x', 'y'])
    await vi.waitFor(() => expect(g.res(2)).toMatchObject({ ok: true }))
    expect(w.dispatched).toEqual([IPC.fsWrite])
  })

  it('R19: a viewer’s subagent snapshot omits nodes outside the shared projects; an editor’s does not', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const viewer = await approvedGuest(w, owner, 'viewer', 5)
    const editor = await approvedGuest(w, owner, 'editor', 6)
    viewer.req(1, IPC.agentSubagentSnapshot)
    editor.req(2, IPC.agentSubagentSnapshot)
    await vi.waitFor(() => expect(viewer.res(1)).toBeDefined())
    await vi.waitFor(() => expect(editor.res(2)).toBeDefined())
    expect(viewer.res(1).result).toEqual([{ nodeId: 'n-shared', task: 'shared task' }])
    expect(JSON.stringify(viewer.frames)).not.toContain('SECRET')
    // By design: an editor sees other projects' subagent tasks too. Editor is shell access on this
    // host (D8), so withholding a task text an editor could read from disk would be theatre.
    expect(editor.res(2).result.map((e: { nodeId: string }) => e.nodeId)).toEqual(['n-shared', 'n-other'])
  })

  it('workspace:load is narrowed for owners too', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    owner.req(1, IPC.workspaceLoad)
    await vi.waitFor(() => expect(owner.res(1)).toBeDefined())
    expect(owner.res(1).result).toEqual({ projects: [{ id: 'P' }], activeProjectId: 'P' })
  })

  it('status reports members and who is connected', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const g = await approvedGuest(w, owner, 'editor', 5)
    expect(w.svc.status().peers).toEqual([
      { label: 'Enes', role: 'owner', connected: true },
      { label: '', role: 'editor', connected: true }
    ])
    g.c.close()
    await vi.waitFor(() => expect(w.svc.status().peers[1].connected).toBe(false))
    expect(w.svc.status().enabled).toBe(true)
  })
})

describe('hosted service — unshare stops a terminal a viewer is already watching (I3, R45)', () => {
  it('after `team unshare`, output, size and exit of that terminal no longer reach a viewer; an editor keeps them', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const viewer = await approvedGuest(w, owner, 'viewer', 5)
    const vSink = [...w.sinks.values()].at(-1)!
    const editor = await approvedGuest(w, owner, 'editor', 6)
    const eSink = [...w.sinks.values()].at(-1)!
    const size = (n: number) => JSON.stringify({ t: 'ev', channel: IPC.ptySize('sess-shared'), args: [{ cols: n, rows: n }] })
    const exit = JSON.stringify({ t: 'ev', channel: IPC.ptyExit('sess-shared'), args: [0] })
    // Both opened the shared terminal: the relay client delivers output only for a session its own
    // `pty:create` answer named (shared/relay-pty-channel.ts).
    for (const [g, id] of [[viewer, 50], [editor, 60]] as const) {
      g.req(id, IPC.ptyCreate, [{ persistKey: 'n-shared', cols: 80, rows: 24 }])
      await vi.waitFor(() => expect(g.res(id)?.result?.sessionId).toBe('sess-shared'))
    }
    // Both are watching the shared terminal (the PtyManager sends to its subscribers' sinks).
    for (const s of [vSink, eSink]) {
      s.sendBinary(encodePtyData('sess-shared', 'before'))
      s.sendText(size(1))
    }
    await vi.waitFor(() => expect(viewer.bytes).toEqual([['sess-shared', 'before']]))
    expect(viewer.events(IPC.ptySize('sess-shared'))).toEqual([{ cols: 1, rows: 1 }])

    await w.svc.share('P', false)
    for (const s of [vSink, eSink]) {
      s.sendBinary(encodePtyData('sess-shared', 'after'))
      s.sendText(size(2))
      s.sendText(exit)
    }
    await vi.waitFor(() => expect(editor.bytes).toEqual([['sess-shared', 'before'], ['sess-shared', 'after']]))
    expect(editor.events(IPC.ptyExit('sess-shared'))).toEqual([0])
    // A round trip on the viewer's own tunnel: anything sent to it before this answer has arrived.
    viewer.req(1, IPC.relayHostedSelf)
    await vi.waitFor(() => expect(viewer.res(1)).toBeDefined())
    expect(viewer.bytes).toEqual([['sess-shared', 'before']])
    expect(viewer.events(IPC.ptySize('sess-shared'))).toEqual([{ cols: 1, rows: 1 }])
    expect(viewer.events(IPC.ptyExit('sess-shared'))).toEqual([])
  })
})

describe('hosted service — a session with no team entry (R27)', () => {
  it('in the window between a removal’s team write and its kill, the removed peer is served NOTHING', async () => {
    const kills: Array<[string, string]> = []
    const w = world({ killPeer: (key, reason) => { kills.push([key, reason]) } }) // the kill is held back
    const owner = await ownerOnline(w)
    const keys = genKeyPair()
    const g = await approvedGuest(w, owner, 'editor', 5, keys)
    const sink = [...w.sinks.values()].at(-1)!
    const event = (n: number) => JSON.stringify({ t: 'ev', channel: IPC.agentStatus, args: [{ nodeId: 'n-shared', n }] })
    sink.sendText(event(1)) // positive control: an editor receives it
    await vi.waitFor(() => expect(g.frames.some((f) => f.includes('"n":1'))).toBe(true))

    expect(await w.svc.remove(pub(keys), false)).toBe('removed')
    expect(kills).toEqual([[pub(keys), 'removed']])
    g.req(1, IPC.workspaceLoad)
    g.req(2, IPC.fsWrite, ['/srv/app/x', 'y'])
    g.req(3, IPC.relayHostedSelf)
    sink.sendText(event(2))
    await vi.waitFor(() => expect(g.res(3)).toBeDefined())
    expect(g.res(1)).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: expect.stringMatching(/not a member/) } })
    expect(g.res(2)).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: expect.stringMatching(/not a member/) } })
    expect(g.res(3)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not a member/) } })
    expect(g.frames.some((f) => f.includes('"n":2'))).toBe(false)
    expect(w.dispatched).toEqual([])
    killRelayHostsByPeerKey(pub(keys), 'removed') // the kill finally lands
    await vi.waitFor(() => expect(g.denied).toEqual(['removed']))
  })

  it('a session whose OWN pin write failed keeps the documented viewer fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = world()
      const owner = await ownerOnline(w)
      const keys = genKeyPair()
      const { g, pendingId } = await pendingGuest(w, keys)
      disk.failTeamWrite = true
      owner.req(5, IPC.relayHostedApprove, [pendingId, 'editor'])
      await vi.waitFor(() => expect(g.isApproved()).toBe(true))
      await hostOpened(w, keys)
      g.req(1, IPC.workspaceLoad)
      g.req(2, IPC.fsWrite, ['/srv/app/x', 'y'])
      await vi.waitFor(() => expect(g.res(2)).toBeDefined())
      expect(g.res(1)).toMatchObject({ ok: true, result: { projects: [{ id: 'P' }] } })
      expect(g.res(2)).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: expect.stringMatching(/Viewers/) } })
      expect(w.svc.status().peers.map((p) => p.role)).toEqual(['owner'])
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not record an approved teammate/))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('hosted service — removal', () => {
  it('removal returns the scheduler’s bridged count (R20) and refuses the last owner', async () => {
    const w = world()
    const ownerKeys = genKeyPair()
    const owner = await ownerOnline(w, ownerKeys)
    const keys = genKeyPair()
    const g = await approvedGuest(w, owner, 'editor', 5, keys)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.bridged).toBe(2))
    expect(await w.svc.remove(pub(keys), false)).toBe('removed')
    await vi.waitFor(() => expect(g.denied).toEqual(['removed']))
    expect(w.svc.status().scheduler?.bridged).toBe(1)
    expect(w.svc.status().peers).toEqual([{ label: 'Enes', role: 'owner', connected: true }])

    expect(await w.svc.remove(pub(genKeyPair()), false)).toBe('unknown')
    expect(await w.svc.remove(pub(ownerKeys), false)).toBe('last-owner')
    expect(owner.denied).toEqual([])
    expect(owner.c.isOpen()).toBe(true)
    expect(await w.svc.remove(pub(ownerKeys), true)).toBe('removed')
    await vi.waitFor(() => expect(owner.denied).toEqual(['removed']))
  })

  it('remove reads the team from disk even before start (never a false "unknown")', async () => {
    const w = world()
    const keys = genKeyPair()
    await w.svc.init()
    await w.svc.addOwner(pub(genKeyPair()), 'A')
    await w.svc.addOwner(pub(keys), 'B')
    // A fresh service over the same directory has loaded nothing yet.
    const again = createHostedService({
      dataDir: w.dataDir, apiBase: 'https://api', relayUrl: 'ws://127.0.0.1/r', deviceId: 'd', hostLabel: 'x',
      attach: { attach: () => 1, detach: () => {}, dispatch: async (_i, r) => ({ t: 'res', id: r.id, ok: true, result: null }), cast: () => {} },
      projectsOfNode: () => [], nodeOfSession: () => undefined, projectCwd: () => undefined
    })
    expect(await again.remove(pub(keys), false)).toBe('removed')
  })
})

describe('hosted service — a request whose session already ended', () => {
  it('a guest that drops while pending is cleaned up at once: owners told, timer cleared, count returned', async () => {
    const w = world({ recordTimers: true })
    const owner = await ownerOnline(w)
    const { g, pendingId } = await pendingGuest(w)
    expect(w.svc.status().scheduler?.bridged).toBe(2)
    g.c.close()
    await vi.waitFor(() => expect(w.svc.status().pending).toHaveLength(0))
    expect(w.svc.status().scheduler?.bridged).toBe(1)
    await vi.waitFor(() => expect(owner.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId, reason: 'gone' }))
    const expiry = w.armed.filter((a) => a.ms === PENDING_TTL_MS)
    expect(expiry).toHaveLength(1)
    expect(expiry[0].cleared).toBe(true)
  })

  it('expiry tolerates a session closed behind the service’s back: no throw, no second end, entry removed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const w = world()
      const owner = await ownerOnline(w)
      const keys = genKeyPair()
      const { g, pendingId } = await pendingGuest(w, keys)
      // Closed WITHOUT a reason and without the service: the core fires no onClose for this.
      killRelayHostsByPeerKey(pub(keys))
      expect(g.closedCount()).toBe(1)
      expect(w.svc.status().pending).toHaveLength(1)
      expect(w.svc.status().scheduler?.bridged).toBe(2)
      await vi.advanceTimersByTimeAsync(PENDING_TTL_MS)
      expect(w.svc.status().pending).toHaveLength(0)
      expect(w.svc.status().scheduler?.bridged).toBe(1)
      expect(g.denied).toEqual([]) // it was already gone: nothing more was sent
      expect(g.closedCount()).toBe(1)
      await vi.waitFor(() => expect(owner.events(IPC.relayHostedPendingClosed)).toContainEqual({ pendingId, reason: 'expired' }))
      w.svc.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hosted service — lifecycle', () => {
  it('start before init is no-team; init creates once and reports a second init as not created', async () => {
    const w = world()
    expect(await w.svc.start()).toBe('no-team')
    expect(w.svc.info()).toBeNull()
    expect(await w.svc.init()).toEqual({ created: true })
    expect(await w.svc.init()).toEqual({ created: false })
    expect(fs.existsSync(path.join(w.dataDir, 'relay', 'team.json'))).toBe(true)
  })

  it('two inits racing: one creates the key, the other is told it was not created (E_HOST_KEY_EXISTS)', async () => {
    const w = world()
    const results = await Promise.all([w.svc.init(), w.svc.init(), w.svc.init()])
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(results.filter((r) => !r.created)).toHaveLength(2)
  })

  it('an unreadable host key is reported and never replaced; init refuses it too', async () => {
    const w = world()
    await w.svc.init()
    const file = path.join(w.dataDir, 'relay', 'host-key.json')
    fs.writeFileSync(file, 'not json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await w.svc.start()).toBe('host-key-unreadable')
      await expect(w.svc.init()).rejects.toMatchObject({ code: 'E_HOST_KEY_UNREADABLE' })
    } finally {
      err.mockRestore()
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('not json')
    expect(w.svc.status().enabled).toBe(false)
  })

  it('R30: the team is loaded before the host key, so status shows members even when the key is unreadable', async () => {
    const w = world()
    await w.svc.init()
    await w.svc.addOwner(pub(genKeyPair()), 'Enes')
    fs.writeFileSync(path.join(w.dataDir, 'relay', 'host-key.json'), 'not json')
    const fresh = world({ dataDir: w.dataDir }) // nothing loaded yet
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(fresh.svc.status().peers).toEqual([])
      expect(await fresh.svc.start()).toBe('host-key-unreadable')
    } finally {
      err.mockRestore()
    }
    expect(fresh.svc.status().peers).toEqual([{ label: 'Enes', role: 'owner', connected: false }])
  })

  it('R2: start is idempotent — a running or concurrently starting service never gets a second scheduler', async () => {
    const w = world()
    await w.svc.init()
    const [a, b] = await Promise.all([w.svc.start(), w.svc.start()])
    expect([a, b]).toEqual(['started', 'started'])
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    expect(await w.svc.start()).toBe('started')
    await new Promise((r) => setTimeout(r, 30))
    expect(w.mints()).toBe(1)
    expect(w.svc.status().scheduler?.idle).toBe(1)
  })

  it('the hosted mint holds the host key: it asks for a key-proof challenge before every mint', async () => {
    const w = world()
    await w.svc.init()
    expect(await w.svc.start()).toBe('started')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    expect(w.challenges()).toBe(1)
    expect(w.mints()).toBe(1)
  })

  it('stop cuts every session and pending request; start brings hosting back', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const { g } = await pendingGuest(w)
    w.svc.stop()
    expect(w.svc.status()).toMatchObject({ enabled: false, scheduler: null, pending: [] })
    await vi.waitFor(() => expect(owner.closedCount()).toBe(1))
    await vi.waitFor(() => expect(g.closedCount()).toBe(1))
    expect(w.svc.status().peers.every((p) => !p.connected)).toBe(true)
    expect(await w.svc.start()).toBe('started')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
  })

  it('a stop that lands while start is still loading wins', async () => {
    const w = world()
    await w.svc.init()
    const starting = w.svc.start()
    w.svc.stop()
    expect(await starting).toBe('stopped')
    expect(w.svc.status().enabled).toBe(false)
    expect(w.mints()).toBe(0)
  })

  it('R31: rotateKey on a running service replaces the address and restarts, returning the start result', async () => {
    const w = world()
    await ownerOnline(w)
    const before = w.svc.info()!.hostPublicKeyB64
    expect(await w.svc.rotateKey()).toBe('started')
    expect(w.svc.info()!.hostPublicKeyB64).not.toBe(before)
    expect(w.svc.status().enabled).toBe(true)
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    expect(decodeJoinCode(w.svc.joinCode()!)!.hostPublicKeyB64).toBe(w.svc.info()!.hostPublicKeyB64)
  })

  it('R31: rotateKey on a never-started or stopped service rotates WITHOUT starting hosting', async () => {
    const w = world()
    await w.svc.init()
    const onDisk = async () => publicKeyToB64((await loadHostKey(path.join(w.dataDir, 'relay')))!.publicKey)
    const first = await onDisk()
    expect(await w.svc.rotateKey()).toBe('not-running')
    expect(w.svc.status().enabled).toBe(false)
    expect(w.mints()).toBe(0)
    const second = await onDisk()
    expect(second).not.toBe(first)
    expect(w.svc.info()!.hostPublicKeyB64).toBe(second)

    expect(await w.svc.start()).toBe('started')
    w.svc.stop()
    expect(await w.svc.rotateKey()).toBe('not-running')
    expect(w.svc.status().enabled).toBe(false)
    expect(await onDisk()).not.toBe(second)
  })

  it('R22: the scheduler runs on the monotonic clock, not the wall clock', async () => {
    const mono = vi.fn(() => performance.now())
    const w = world({ monotonicNow: mono, now: () => 42 })
    await w.svc.init()
    expect(await w.svc.start()).toBe('started')
    await vi.waitFor(() => expect(w.svc.status().scheduler?.idle).toBe(1))
    // Only the scheduler reads the monotonic clock; the wall clock (42) is for display and the mint.
    expect(mono).toHaveBeenCalled()
    expect(w.svc.status().scheduler?.mintsLastHour).toBe(1)
  })

  it('every hosted channel lives under the one prefix the access hook refuses outside the interceptor', () => {
    const hosted = Object.entries(IPC).filter(([k]) => k.startsWith('relayHosted')).map(([, v]) => v)
    // Seven relay-tunnel verbs plus the desktop's two bookmark channels. Those two are raw ipcMain
    // handlers that never ride the relay; living under the prefix means a relay peer that asks for
    // one is refused by the access hook here, which is the right answer for them.
    expect(hosted).toHaveLength(9)
    expect(hosted).toEqual(expect.arrayContaining([IPC.relayHostedBookmarks, IPC.relayHostedBookmarkRemove]))
    for (const ch of hosted) expect(ch).toMatch(/^relay:hosted:/)
  })
})

describe('hosted service — the canvas authority seam (docs/hosted-team-relay.md)', () => {
  it('sharedProjectIds() follows share/unshare, and onSharedChange fires after each write', async () => {
    const seen: string[][] = []
    // The callback reads the accessor: it must already answer with the NEW set when it is told.
    let svc: HostedService | null = null
    const w = world({ onSharedChange: () => seen.push([...svc!.sharedProjectIds()].sort()) })
    svc = w.svc
    await w.svc.init()
    expect([...w.svc.sharedProjectIds()]).toEqual([])
    await w.svc.share('P', true)
    expect([...w.svc.sharedProjectIds()]).toEqual(['P'])
    await w.svc.share('Q', true)
    await w.svc.share('P', false)
    expect([...w.svc.sharedProjectIds()]).toEqual(['Q'])
    expect(seen).toEqual([['P'], ['P', 'Q'], ['Q']])
  })

  it('a share whose write failed tells nobody', async () => {
    let told = 0
    const w = world({ onSharedChange: () => told++ })
    await w.svc.init()
    disk.failTeamWrite = true
    await expect(w.svc.share('P', true)).rejects.toThrow('disk full')
    expect(told).toBe(0)
    expect([...w.svc.sharedProjectIds()]).toEqual([])
  })

  it('a relay workspace:save is refused for every role, with E_ROLE and the reason, and never reaches the store', async () => {
    const w = world()
    const owner = await ownerOnline(w)
    const editor = await approvedGuest(w, owner, 'editor', 5)
    const viewer = await approvedGuest(w, owner, 'viewer', 6)
    const ws = { version: 2, activeProjectId: 'P', projects: [{ id: 'P', nodes: [] }] }
    owner.req(21, IPC.workspaceSave, [ws])
    editor.req(22, IPC.workspaceSave, [ws])
    viewer.req(23, IPC.workspaceSave, [ws])
    owner.req(24, IPC.workspaceLoad) // positive control: the owner's other requests still dispatch
    await vi.waitFor(() => expect(owner.res(24)).toBeDefined())
    await vi.waitFor(() => expect(editor.res(22)).toBeDefined())
    await vi.waitFor(() => expect(viewer.res(23)).toBeDefined())
    const refusal = {
      ok: false,
      error: {
        code: 'E_ROLE',
        message: "A hosted team cannot save the host's workspace over the relay; edits travel as canvas operations"
      }
    }
    expect(owner.res(21)).toMatchObject(refusal)
    expect(editor.res(22)).toMatchObject(refusal)
    expect(viewer.res(23)).toMatchObject(refusal)
    expect(w.dispatched).not.toContain(IPC.workspaceSave)
    expect(w.dispatched).toContain(IPC.workspaceLoad)
    // A cast of it is dropped too.
    owner.cast(IPC.workspaceSave, [ws])
    owner.req(25, IPC.relayHostedSelf)
    await vi.waitFor(() => expect(owner.res(25)).toBeDefined())
    expect(w.casts).not.toContain(IPC.workspaceSave)
  })
})
