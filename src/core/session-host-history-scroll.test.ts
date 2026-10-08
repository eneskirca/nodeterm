import { EventEmitter } from 'node:events'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionHostClient, type SessionSubscriber } from './session-host-client'
import { SessionHostPty } from './session-host-pty'
import { sessionHostPaths } from '../session-host/paths'
import { encodeFrame, type SessionHostRequest, type SessionHostResponse } from '../session-host/protocol'

const boundary = vi.hoisted(() => ({ identity: vi.fn(), spawn: vi.fn() }))
vi.mock('./session-host-launcher', () => ({ resolveSessionHostScript: () => null, spawnSessionHost: boundary.spawn }))
vi.mock('../session-host/existing-host-state', () => ({ readExistingSessionHostIdentity: boundary.identity,
  startupLockState: () => 'other', LISTEN_RETRY_BUDGET_MS: 1000, EMPTY_LOCK_STALE_MS: 15000 }))
const generation = 'retained-generation-a'
const capture = { cols: 80, viewportRows: 24, olderTruncated: false,
  rows: [{ text: 'retained pre-attach history', isWrapped: false, section: 'normal' }] }
/** Socket recorder boundary; the production client owns negotiation, subscriptions and sends. */
class Socket extends EventEmitter {
  destroyed = false
  requests: SessionHostRequest[] = []
  constructor(readonly feature = true, readonly act?: (request: SessionHostRequest, socket: Socket) => boolean) { super() }
  unref() { return this }
  write(data: string, cb?: (error?: Error) => void) {
    const request = JSON.parse(data) as SessionHostRequest; this.requests.push(request); cb?.()
    if (this.act?.(request, this)) return true
    const result = request.cmd === 'hello' ? { protocolVersion: 2, features: this.feature ? ['scroll-view-v1'] : [] }
      : request.cmd === 'attach' || request.cmd === 'attachExisting' ? { fresh: request.cmd === 'attach', generation }
      : request.cmd === 'scrollViewV1' ? { status: 'history', ...(request.capture ? { capture } : {}) } : {}
    this.respond({ id: request.id, ok: true, result }); return true
  }
  respond(frame: SessionHostResponse) { queueMicrotask(() => { if (!this.destroyed) this.emit('data', Buffer.from(encodeFrame(frame))) }) }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')) }; return this }
}
let sockets: Socket[], index: number
const viewers: Array<{ client: SessionHostClient; sub: SessionSubscriber }> = []
beforeEach(() => {
  sockets = []; index = 0; boundary.spawn.mockReset()
  const paths = sessionHostPaths('/fixture/user-data')
  boundary.identity.mockReturnValue({ kind: 'ready', state: { pid: 42, endpoint: paths.endpoint,
    tokenPath: paths.tokenPath, startedAt: 1, protocolVersion: 2 }, token: 'a'.repeat(64) })
  vi.spyOn(net, 'connect').mockImplementation(() => {
    const socket = sockets[index++]; if (!socket) throw new Error('unexpected extra transport')
    queueMicrotask(() => socket.emit('connect')); return socket as unknown as net.Socket
  })
})
afterEach(async () => {
  viewers.splice(0).forEach(({ client, sub }) => client.unsubscribe('ours', sub))
  await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve))
  sockets.forEach((socket) => socket.destroy()); await Promise.resolve(); vi.restoreAllMocks()
})
async function viewer(...hosts: Socket[]) {
  sockets.push(...hosts)
  const client = new SessionHostClient({ userDataDir: '/fixture/user-data' })
  const sub = { onData() {}, onExit() {} }; viewers.push({ client, sub })
  await client.attach('ours', { cwd: '/fixture', shell: 'fixture', args: [], env: {}, cols: 80, rows: 24 }, 100, sub)
  return { client, sub }
}
async function queued(client: SessionHostClient) {
  for (let i = 0; i < 100; i++) {
    const pending = (client as unknown as { pending: Map<number, { sent: boolean }> }).pending
    if ([...pending.values()].some((value) => !value.sent)) return
    await Promise.resolve()
  }
  throw new Error('fixture failed to admit an unwritten request')
}
const scrollRequests = (socket: Socket) => socket.requests.filter((r) => r.cmd === 'scrollViewV1')

describe('session-host scrolling on the original subscribed transport', () => {
  it('sends exact generation and capture intent, returning bounded inert physical rows', async () => {
    const host = new Socket(), { client, sub } = await viewer(host)
    expect(await client.scrollForHistory('ours', sub, true, 3, true, () => true)).toEqual({ status: 'history', capture })
    expect(await client.scrollForHistory('ours', sub, false, 2, false, () => true)).toEqual({ status: 'history' })
    expect(scrollRequests(host).map(({ id: _id, ...body }) => body)).toEqual([
      { cmd: 'scrollViewV1', name: 'ours', generation, up: true, lines: 3, capture: true },
      { cmd: 'scrollViewV1', name: 'ours', generation, up: false, lines: 2, capture: false }
    ])
  })
  it('only describes a negotiated missing feature as an update requirement', async () => {
    const host = new Socket(false), { client, sub } = await viewer(host)
    const old = await client.scrollForHistory('ours', sub, true, 1, true, () => true)
    expect(old.status).toBe('refused'); if (old.status === 'refused') expect(old.message).toContain('Update nodeterm')
    expect(scrollRequests(host)).toEqual([]); expect(boundary.spawn).not.toHaveBeenCalled()
    host.destroy(); await new Promise<void>((resolve) => setImmediate(resolve))
    const lost = await client.scrollForHistory('ours', sub, true, 1, true, () => true)
    expect(lost.status).toBe('refused'); if (lost.status === 'refused') expect(lost.message).not.toContain('Update nodeterm')
    expect(scrollRequests(host)).toEqual([])
  })
  it('rechecks viewer lifetime, registration and generation in the deferred send turn', async () => {
    for (const change of ['current', 'entry', 'generation', 'barrier'] as const) {
      const host = new Socket(), { client, sub } = await viewer(host); let current = true
      const action = client.scrollForHistory('ours', sub, true, 1, true, () => current)
      await queued(client)
      const internals = client as unknown as { sessions: Map<string, { entries: Map<SessionSubscriber, unknown>; generation: string }>; killReplayBarriers: Set<string> }
      if (change === 'current') current = false
      if (change === 'entry') internals.sessions.get('ours')!.entries.set(sub, { ...(internals.sessions.get('ours')!.entries.get(sub) as object) })
      if (change === 'generation') internals.sessions.get('ours')!.generation = 'replacement-generation'
      if (change === 'barrier') internals.killReplayBarriers.add('ours')
      expect((await action).status).toBe('refused'); expect(scrollRequests(host)).toEqual([])
    }
  })
  it('does not replay an unwritten mixed scroll after replacing the socket', async () => {
    const first = new Socket(), second = new Socket(), { client, sub } = await viewer(first, second)
    const action = client.scrollForHistory('ours', sub, true, 1, true, () => true)
    await queued(client); first.destroy()
    expect((await action).status).toBe('refused')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(scrollRequests(first)).toEqual([]); expect(scrollRequests(second)).toEqual([])
  })
  it('keeps a lost transmitted wheel or negative RPC uncertain without a second frame', async () => {
    for (const reply of ['lost', 'error'] as const) {
      const host = new Socket(true, (req, socket) => {
        if (req.cmd !== 'scrollViewV1') return false
        if (reply === 'lost') socket.destroy()
        else socket.respond({ id: req.id, ok: false, error: 'native write reply lost' })
        return true
      })
      const { client, sub } = await viewer(host)
      expect((await client.scrollForHistory('ours', sub, true, 3, false, () => true)).status).toBe('uncertain')
      client.unsubscribe('ours', sub)
      expect(scrollRequests(host)).toHaveLength(1)
      expect(host.requests.some((r) => r.cmd === 'write' || r.cmd === 'sendKeysV2')).toBe(false)
    }
  })
  it('rejects malformed or over-budget captures without interpreting them as successful history', async () => {
    const bodies = [
      { status: 'input-ish' }, { status: 'refused', message: '' },
      { status: 'history', capture: { ...capture, viewportRows: 201 } },
      { status: 'history', capture: { ...capture, rows: [{ text: 'bad', isWrapped: false, section: 'foreign' }] } },
      { status: 'history', capture: { ...capture, rows: Array.from({ length: 8193 }, () => capture.rows[0]) } },
      { status: 'history', capture: { ...capture, rows: [{ ...capture.rows[0], text: '\"'.repeat(600_000) }] } }
    ]
    for (const body of bodies) {
      const host = new Socket(true, (req, socket) => {
        if (req.cmd !== 'scrollViewV1') return false
        socket.respond({ id: req.id, ok: true, result: body }); return true
      })
      const { client, sub } = await viewer(host)
      expect((await client.scrollForHistory('ours', sub, true, 1, true, () => true)).status).toBe('uncertain')
      expect(scrollRequests(host)).toHaveLength(1)
    }
  })
  it('drops a late history answer and treats a late input acknowledgement as uncertain after retirement', async () => {
    for (const status of ['history', 'input'] as const) {
      let held!: SessionHostRequest, entered!: () => void
      const admitted = new Promise<void>((done) => { entered = done })
      const host = new Socket(true, (req) => { if (req.cmd !== 'scrollViewV1') return false; held = req; entered(); return true })
      const { client, sub } = await viewer(host); let current = true
      const action = client.scrollForHistory('ours', sub, true, 1, true, () => current)
      await admitted; current = false
      host.respond({ id: held.id, ok: true, result: { status, ...(status === 'history' ? { capture } : {}) } })
      expect((await action).status).toBe(status === 'history' ? 'refused' : 'uncertain')
    }
  })
  it('keeps detached or failed-attachment shim actions neutral and sends no scroll', async () => {
    for (const failed of [false, true]) {
      const host = new Socket(true, (req, socket) => {
        if (failed && req.cmd === 'attach') { socket.respond({ id: req.id, ok: false, error: 'attach refused' }); return true }
        return false
      })
      sockets.push(host)
      const client = new SessionHostClient({ userDataDir: '/fixture/user-data' })
      const painter = new SessionHostPty(client, 'ours', { cwd: '/fixture', shell: 'fixture', args: [], env: {}, cols: 80, rows: 24 }, 100)
      try {
        await painter.ready.catch(() => {})
        if (!failed) painter.destroy()
        const result = await painter.scrollForHistory(true, 1, true, () => true)
        expect(result.status).toBe('refused'); if (result.status === 'refused') expect(result.message).not.toContain('Update nodeterm')
        expect(scrollRequests(host)).toEqual([])
      } finally { painter.destroy() }
    }
  })
})
