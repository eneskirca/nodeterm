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
const generation = 'retained-generation-a', ticket = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const input = { kind: 'paste', text: 'retained complete draft', enter: true } as const
class Socket extends EventEmitter {
  destroyed = false
  requests: SessionHostRequest[] = []
  constructor(readonly feature = true, readonly act?: (request: SessionHostRequest, socket: Socket) => boolean) { super() }
  unref() { return this }
  write(data: string, cb?: (error?: Error) => void) {
    const request = JSON.parse(data) as SessionHostRequest; this.requests.push(request); cb?.()
    if (this.act?.(request, this)) return true
    const result = request.cmd === 'hello' ? { protocolVersion: 2, features: this.feature ? ['composed-input-v1'] : [] }
      : request.cmd === 'attach' || request.cmd === 'attachExisting' ? { fresh: request.cmd === 'attach', generation }
      : request.cmd === 'prepareComposedV1' ? { status: 'prepared', ticket }
      : request.cmd === 'writeComposedV1' ? { status: request.phase === 'paste' ? 'awaiting-enter' : 'delivered' }
      : {}
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
/** Admission probe only: pause a real queued request before its real event-loop send turn.
 * No response or expected delivery is manufactured from this private state. */
async function queuedAfter(client: SessionHostClient, after = 0) {
  for (let i = 0; i < 100; i++) {
    const pending = (client as unknown as { pending: Map<number, { sent: boolean }> }).pending
    if ([...pending].some(([id, value]) => id > after && !value.sent)) return
    await Promise.resolve()
  }
  throw new Error('fixture failed to admit an unwritten request')
}

describe('session-host composer captured-subscriber transport', () => {
  it('keeps detached and failed-attachment shim refusals neutral rather than requesting an update', async () => {
    for (const failed of [false, true]) {
      const host = new Socket(true, (req, socket) => {
        if (failed && req.cmd === 'attach') { socket.respond({ id: req.id, ok: false, error: 'fixture attach refused' }); return true }
        return false
      })
      sockets.push(host)
      const client = new SessionHostClient({ userDataDir: '/fixture/user-data' })
      const painter = new SessionHostPty(client, 'ours', { cwd: '/fixture', shell: 'fixture', args: [], env: {}, cols: 80, rows: 24 }, 100)
      try {
        await painter.ready.catch(() => {})
        if (!failed) painter.destroy()
        const result = await painter.submitComposed(input, () => true)
        expect(result.status).toBe('refused'); expect(result.message).toContain('Reattach')
        expect(result.message).not.toContain('Update nodeterm')
        expect(host.requests.some((r) => r.cmd.includes('Composed'))).toBe(false)
      } finally { painter.destroy() }
    }
  })
  it('refuses an older live host without new input commands or a host restart', async () => {
    const old = new Socket(false), { client, sub } = await viewer(old)
    expect((await client.submitComposed('ours', sub, input, () => true)).status).toBe('refused')
    expect(old.requests.filter((r) => r.cmd.includes('Composed'))).toEqual([])
    expect(boundary.spawn).not.toHaveBeenCalled(); expect(index).toBe(1)
  })
  it('rechecks stream retirement inside the deferred paste-send turn', async () => {
    let prepare!: SessionHostRequest
    const host = new Socket(true, (req) => { if (req.cmd === 'prepareComposedV1') { prepare = req; return true }; return false })
    const { client, sub } = await viewer(host); let alive = true
    const sending = client.submitComposed('ours', sub, input, () => alive)
    while (!prepare) await new Promise<void>((resolve) => setImmediate(resolve))
    host.respond({ id: prepare.id, ok: true, result: { status: 'prepared', ticket } })
    await queuedAfter(client, prepare.id); alive = false
    expect((await sending).status).toBe('refused')
    expect(host.requests.filter((r) => r.cmd === 'writeComposedV1')).toEqual([])
  })
  it('describes a negotiated host busy refusal as a current action refusal, not an upgrade requirement', async () => {
    const host = new Socket(true, (req, socket) => {
      if (req.cmd === 'prepareComposedV1') {
        socket.respond({ id: req.id, ok: true, result: { status: 'refused', message: 'Another Send is pending.' } }); return true
      }
      return false
    })
    const { client, sub } = await viewer(host)
    const result = await client.submitComposed('ours', sub, input, () => true)
    expect(result.status).toBe('refused'); expect(result.message).toContain('pending')
    expect(result.message).not.toContain('Update nodeterm')
    expect(host.requests.filter((r) => r.cmd === 'writeComposedV1')).toEqual([])
  })
  it('does not call a failed reconnect proof of a missing host capability', async () => {
    const host = new Socket(), { client, sub } = await viewer(host)
    host.destroy(); await new Promise<void>((resolve) => setImmediate(resolve))
    const result = await client.submitComposed('ours', sub, input, () => true)
    expect(result.status).toBe('refused'); expect(result.message).toContain('Reattach')
    expect(result.message).not.toContain('Update nodeterm')
    expect(host.requests.some((r) => r.cmd.includes('Composed'))).toBe(false)
  })
  it('checks the captured entry again after reconnecting a provably undelivered preparation', async () => {
    let alive = true
    const first = new Socket(), second = new Socket(true, (req) => {
      if (req.cmd === 'attachExisting') alive = false
      return false
    })
    const { client, sub } = await viewer(first, second)
    const sending = client.submitComposed('ours', sub, input, () => alive)
    await queuedAfter(client); first.destroy()
    expect((await sending).status).toBe('refused')
    expect(index).toBe(2)
    expect([...first.requests, ...second.requests].filter((r) => r.cmd === 'prepareComposedV1' || r.cmd === 'writeComposedV1')).toEqual([])
  })
  it('does not redeem an original socket ticket over a reattached same-generation socket', async () => {
    let prepare!: SessionHostRequest
    const first = new Socket(true, (req) => { if (req.cmd === 'prepareComposedV1') { prepare = req; return true }; return false })
    const second = new Socket(), { client, sub } = await viewer(first, second)
    const sending = client.submitComposed('ours', sub, input, () => true)
    while (!prepare) await new Promise<void>((resolve) => setImmediate(resolve))
    first.respond({ id: prepare.id, ok: true, result: { status: 'prepared', ticket } })
    await queuedAfter(client, prepare.id); first.destroy()
    expect((await sending).status).toBe('refused')
    expect(index).toBe(2)
    expect(second.requests.some((r) => r.cmd === 'writeComposedV1')).toBe(false)
  })
  it('keeps a lost transmitted paste uncertain and never replays or submits Enter', async () => {
    const host = new Socket(true, (req, socket) => {
      if (req.cmd === 'writeComposedV1' && req.phase === 'paste') { socket.destroy(); return true }; return false
    })
    const { client, sub } = await viewer(host)
    expect((await client.submitComposed('ours', sub, input, () => true)).status).toBe('uncertain')
    client.unsubscribe('ours', sub)
    expect(host.requests.filter((r) => r.cmd === 'writeComposedV1')).toHaveLength(1)
    expect(host.requests.some((r) => r.cmd === 'write' || r.cmd === 'sendKeysV2')).toBe(false)
    expect(index).toBe(1)
  })
  it('does not reinterpret a server RPC error after a transmitted paste as a proven refusal', async () => {
    const host = new Socket(true, (req, socket) => {
      if (req.cmd === 'writeComposedV1' && req.phase === 'paste') {
        socket.respond({ id: req.id, ok: false, error: 'reply failed after native write' }); return true
      }
      return false
    })
    const { client, sub } = await viewer(host)
    expect((await client.submitComposed('ours', sub, input, () => true)).status).toBe('uncertain')
    expect(host.requests.filter((r) => r.cmd === 'writeComposedV1')).toHaveLength(1)
  })
  it('does not let an unsubscribed registration inherit an action', async () => {
    const host = new Socket(), { client, sub } = await viewer(host)
    const sending = client.submitComposed('ours', sub, input, () => true)
    await queuedAfter(client); client.unsubscribe('ours', sub)
    expect((await sending).status).toBe('refused')
    expect(host.requests.filter((r) => r.cmd === 'writeComposedV1')).toEqual([])
  })
})
