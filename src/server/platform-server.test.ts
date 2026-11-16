import { describe, it, expect, vi } from 'vitest'
import { ServerPlatform, type UiSink } from './platform-server'
import { E_NO_HANDLER } from '../shared/rpc'
import { decodePtyData } from '../shared/rpc'

function fakeSink() {
  const texts: string[] = []
  const bins: Uint8Array[] = []
  const sink: UiSink = { sendText: (j) => texts.push(j), sendBinary: (b) => bins.push(b) }
  return { sink, texts, bins }
}

describe('ServerPlatform', () => {
  it('dispatches req to handle and handleWithSender (sender = uiId)', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    p.handle('a:b', (n: number) => n + 1)
    p.handleWithSender('a:c', (sender: number, s: string) => `${sender}:${s}`)
    const { sink } = fakeSink()
    const ui = p.attach(sink)
    expect(await p.dispatch(ui, { t: 'req', id: 1, method: 'a:b', args: [41] })).toEqual({
      t: 'res', id: 1, ok: true, result: 42
    })
    expect(await p.dispatch(ui, { t: 'req', id: 2, method: 'a:c', args: ['x'] })).toEqual({
      t: 'res', id: 2, ok: true, result: `${ui}:x`
    })
  })

  it('unknown method → E_NO_HANDLER; throwing handler → E_HANDLER with message', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    p.handle('boom', () => { throw new Error('kapow') })
    const ui = p.attach(fakeSink().sink)
    const missing = await p.dispatch(ui, { t: 'req', id: 3, method: 'nope', args: [] })
    expect(missing).toMatchObject({ ok: false, error: { code: E_NO_HANDLER } })
    const thrown = await p.dispatch(ui, { t: 'req', id: 4, method: 'boom', args: [] })
    expect(thrown).toMatchObject({ ok: false, error: { code: 'E_HANDLER', message: 'kapow' } })
  })

  it('cast runs on-listeners and ignores unknown methods silently', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const got: unknown[] = []
    p.on('w', (a: string) => got.push(a))
    const ui = p.attach(fakeSink().sink)
    p.cast(ui, 'w', ['hello'])
    p.cast(ui, 'unknown', ['ignored'])
    expect(got).toEqual(['hello'])
  })

  it('cast delivers the sending uiId to onWithSender listeners (and still runs plain on)', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const withSender: Array<[number, unknown]> = []
    const plain: unknown[] = []
    p.onWithSender('presence:cursor', (senderId: number, cursor: unknown) =>
      withSender.push([senderId, cursor])
    )
    p.on('presence:cursor', (cursor: unknown) => plain.push(cursor))
    const ui = p.attach(fakeSink().sink)
    p.cast(ui, 'presence:cursor', [{ x: 1, y: 2 }])
    expect(withSender).toEqual([[ui, { x: 1, y: 2 }]])
    expect(plain).toEqual([{ x: 1, y: 2 }])
    // Unknown method: silent no-op, never throws.
    expect(() => p.cast(ui, 'nope', [])).not.toThrow()
  })

  it('on() supports multiple listeners per channel; cast fires all of them', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const hits: string[] = []
    p.on('w', (a: string) => hits.push(`A:${a}`))
    p.on('w', (a: string) => hits.push(`B:${a}`))
    const ui = p.attach({ sendText: () => {}, sendBinary: () => {} })
    p.cast(ui, 'w', ['x'])
    expect(hits).toEqual(['A:x', 'B:x'])
    p.cast(ui, 'unknown', ['ignored']) // no listener → silent no-op
    expect(hits).toEqual(['A:x', 'B:x'])
  })

  it('cast isolates a throwing listener: the others on the channel still run', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hits: string[] = []
    p.onWithSender('pty:write', () => { throw new Error('attribution blew up') })
    p.onWithSender('pty:write', (_sender: number, a: string) => hits.push(`S:${a}`))
    p.on('pty:write', () => { throw new Error('plain blew up') })
    p.on('pty:write', (a: string) => hits.push(`P:${a}`))
    const ui = p.attach({ sendText: () => {}, sendBinary: () => {} })
    expect(() => p.cast(ui, 'pty:write', ['keystroke'])).not.toThrow()
    expect(hits).toEqual(['S:keystroke', 'P:keystroke'])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('cast fires listeners in registration order across on() and onWithSender()', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const order: string[] = []
    p.on('c', () => order.push('plain-1'))
    p.onWithSender('c', () => order.push('sender-1'))
    p.on('c', () => order.push('plain-2'))
    const ui = p.attach({ sendText: () => {}, sendBinary: () => {} })
    p.cast(ui, 'c', [])
    expect(order).toEqual(['plain-1', 'sender-1', 'plain-2'])
  })

  it('sendTo routes pty:data as binary, other channels as JSON events, drops when detached', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const a = fakeSink()
    const ui = p.attach(a.sink)
    p.sendTo(ui, 'pty:data:s1', 'output')
    p.sendTo(ui, 'pty:exit:s1', 0)
    expect(decodePtyData(a.bins[0])).toEqual({ sessionId: 's1', data: 'output' })
    expect(JSON.parse(a.texts[0])).toEqual({ t: 'ev', channel: 'pty:exit:s1', args: [0] })
    p.detach(ui)
    p.sendTo(ui, 'pty:exit:s1', 1) // must not throw
    expect(a.texts).toHaveLength(1)
  })

  it('broadcast reaches every attached sink', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    const a = fakeSink(); const b = fakeSink()
    p.attach(a.sink); p.attach(b.sink)
    p.broadcast('license:changed', { tier: 'x' })
    expect(a.texts).toHaveLength(1)
    expect(b.texts).toHaveLength(1)
  })

  it("detach clears the departing connection's backpressure entries", () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const ui = p.attach({ sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 2_000_000 })
    p.sendTo(ui, 'pty:data:s1', 'x') // buffered > high → (ui, s1) marked paused
    p.detach(ui)
    // The entry is gone with the connection: a fresh attach + low-buffer send does not emit a
    // spurious resume for a pause the NEW connection never issued.
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((_uiId, sid, resume) => flow.push({ sid, resume }))
    const ui2 = p.attach({ sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 0 })
    p.sendTo(ui2, 'pty:data:s1', 'x')
    expect(flow).toEqual([]) // ui2 owes nothing → no resume fired
  })

  it('clientIds lists every attached sink and drops detached ones', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1.0.0' })
    expect(p.clientIds()).toEqual([])
    const a = p.attach(fakeSink().sink)
    const b = p.attach(fakeSink().sink)
    expect(p.clientIds()).toEqual([a, b])
    p.detach(a)
    expect(p.clientIds()).toEqual([b])
  })

  it('attach mints monotone ids into the shared registry, and detach unregisters (incl. flow state)', () => {
    // Pins the delegation seam: ServerPlatform owns the id counter, UiSinkRegistry owns the sinks
    // and their backpressure bookkeeping. attach → register, detach → unregister (which prunes).
    const p = new ServerPlatform({ userDataDir: '/tmp/x', appVersion: '1' })
    const a = p.attach(fakeSink().sink)
    const b = p.attach(fakeSink().sink)
    expect([a, b]).toEqual([1, 2])
    expect(p.clientIds()).toEqual([1, 2])

    // Pause (a, s1) via a high-water send, then detach: the pruning must delegate too — a fresh
    // attach must not inherit a pause it never issued (and detach must not throw).
    const flow: Array<{ uiId: number; sid: string; resume: boolean }> = []
    p.setFlowController((uiId, sid, resume) => flow.push({ uiId, sid, resume }))
    const slow = p.attach({
      sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 2_000_000
    })
    p.sendTo(slow, 'pty:data:s1', 'x')
    expect(flow).toEqual([{ uiId: slow, sid: 's1', resume: false }])
    p.detach(slow)
    expect(p.clientIds()).toEqual([1, 2])
    p.sendTo(slow, 'pty:data:s1', 'x') // gone: no sink, no flow event
    expect(flow).toEqual([{ uiId: slow, sid: 's1', resume: false }])

    p.detach(a)
    expect(p.clientIds()).toEqual([2])
  })

  it('exposes userDataDir/appVersion/isPackaged; openExternal rejects', async () => {
    const p = new ServerPlatform({ userDataDir: '/data', appVersion: '9.9.9' })
    expect(p.userDataDir).toBe('/data')
    expect(p.appVersion).toBe('9.9.9')
    expect(p.isPackaged).toBe(true)
    await expect(p.openExternal('https://x')).rejects.toThrow()
  })
})
