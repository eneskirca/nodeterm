import { describe, it, expect, vi, afterEach } from 'vitest'
import { UiSinkRegistry, type UiSink } from './ui-sink-registry'
import { IPC } from '../shared/ipc'

const sink = (buffered = 0): UiSink & { bin: number; text: number } => {
  const s = { bin: 0, text: 0, sendText: () => { s.text++ }, sendBinary: () => { s.bin++ }, bufferedAmount: () => buffered }
  return s
}

describe('quiet and self-paced clients', () => {
  it('a quiet client is in ids() and quietIds() but not broadcastIds()', () => {
    const r = new UiSinkRegistry()
    r.register(1, sink())
    r.register(2, sink(), { quiet: true })
    expect(r.ids()).toEqual([1, 2])
    expect(r.broadcastIds()).toEqual([1])
    expect(r.quietIds()).toEqual([2])
    r.unregister(2)
    expect(r.quietIds()).toEqual([])
  })

  it('a self-paced client is never paused, dropped or resynced by the registry', () => {
    const r = new UiSinkRegistry()
    const flow = vi.fn()
    const resync = vi.fn(async () => 'SCREEN')
    r.setFlowController(flow)
    r.setResyncProvider(resync)
    const s = sink(50_000_000)
    r.register(7, s, { selfPaced: true })
    for (let i = 0; i < 5; i++) r.sendTo(7, IPC.ptyData('s1'), 'x')
    expect(s.bin).toBe(5)
    expect(flow).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('an ordinary client past the high water still takes a pause ticket', () => {
    const r = new UiSinkRegistry()
    const flow = vi.fn()
    r.setFlowController(flow)
    r.register(8, sink(2_000_000))
    r.sendTo(8, IPC.ptyData('s1'), 'x')
    expect(flow).toHaveBeenCalledWith(8, 's1', false, 'socket')
  })
})

/**
 * The test above holds the socket at 50 MB, and at a backlog that never drains the registry would
 * never resync ANY client — so it proves "never paused, never dropped" but says nothing about the
 * resync. This walks the full drop-and-redraw cycle (high water → drop ceiling → drained → the
 * drain sweep), which an ordinary client completes with a `pty:resync`; a self-paced client must
 * come out of it with every frame delivered and no resync. The resync it would get is the
 * registry's default capture, which is history on the SSH and session-host paths
 * (src/core/watch-link/watcher-policy.ts refuses it as the second layer).
 */
describe('the full drop-and-redraw cycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function cycle(opts?: { selfPaced?: boolean }) {
    vi.useFakeTimers()
    const r = new UiSinkRegistry()
    const flow = vi.fn()
    const resync = vi.fn(async () => 'SCREEN')
    r.setFlowController(flow)
    r.setResyncProvider(resync)
    let buffered = 2_000_000
    const texts: string[] = []
    let bins = 0
    r.register(
      7,
      { sendText: (j) => texts.push(j), sendBinary: () => { bins++ }, bufferedAmount: () => buffered },
      opts
    )
    r.sendTo(7, IPC.ptyData('s1'), 'a') // past the high water
    buffered = 50_000_000
    r.sendTo(7, IPC.ptyData('s1'), 'b') // past the drop ceiling
    r.sendTo(7, IPC.ptyData('s1'), 'c') // still backed up
    buffered = 0
    r.sendTo(7, IPC.ptyData('s1'), 'd') // drained
    await vi.advanceTimersByTimeAsync(2_000) // several drain sweeps
    const resyncs = texts.filter((j) => JSON.parse(j).channel === IPC.ptyResync('s1'))
    r.unregister(7)
    return { flow, resync, bins, resyncs }
  }

  it('an ordinary client is paused, dropped and resynced by it (the cycle reaches resync)', async () => {
    const c = await cycle()
    expect(c.flow).toHaveBeenCalledWith(7, 's1', false, 'socket')
    expect(c.bins).toBe(1) // b, c and d were dropped
    expect(c.resync).toHaveBeenCalledWith('s1')
    expect(c.resyncs).toHaveLength(1)
  })

  it('a self-paced client comes out of it with every frame and no pause, drop or resync', async () => {
    const c = await cycle({ selfPaced: true })
    expect(c.flow).not.toHaveBeenCalled()
    expect(c.bins).toBe(4)
    expect(c.resync).not.toHaveBeenCalled()
    expect(c.resyncs).toEqual([])
  })

  it('a client registered with no options keeps the historical behaviour', async () => {
    const c = await cycle({})
    expect(c.flow).toHaveBeenCalled()
    expect(c.bins).toBe(1)
    expect(c.resync).toHaveBeenCalled()
  })
})

describe('sink options follow the sink', () => {
  it('re-registering an id without options clears them', () => {
    const r = new UiSinkRegistry()
    r.register(3, sink(), { quiet: true })
    r.register(3, sink())
    expect(r.quietIds()).toEqual([])
    expect(r.broadcastIds()).toEqual([3])
  })

  // Task 6 review: registering over a LIVE id replaces the sink, and the old sink's flow state must
  // not outlive it — a stale pause under a self-paced re-register would never be handed back.
  it('re-registering a live id hands back the pause the old sink booked and forgets its desync', () => {
    vi.useFakeTimers()
    try {
      const r = new UiSinkRegistry()
      const flow = vi.fn()
      r.setFlowController(flow)
      r.setResyncProvider(async () => 'SCREEN')
      r.register(9, sink(2_000_000))
      r.sendTo(9, IPC.ptyData('s1'), 'x') // past the high water: a pause ticket
      expect(flow).toHaveBeenLastCalledWith(9, 's1', false, 'socket')
      flow.mockClear()
      r.register(9, sink(0), { selfPaced: true })
      expect(flow).toHaveBeenCalledWith(9, 's1', true, 'socket')
      // And a desync of the old sink does not carry over either: a re-registered ordinary sink streams.
      const big = sink(50_000_000)
      r.register(10, sink(2_000_000))
      r.sendTo(10, IPC.ptyData('s2'), 'a')
      r.register(10, big)
      r.sendTo(10, IPC.ptyData('s2'), 'b') // the old sink's backlog, not this one's
      const fresh = sink(0)
      r.register(10, fresh)
      r.sendTo(10, IPC.ptyData('s2'), 'c')
      expect(fresh.bin).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a quiet sink evicted for throwing is no longer listed anywhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new UiSinkRegistry()
    r.register(4, { sendText: () => { throw new Error('gone') }, sendBinary: () => {} }, { quiet: true })
    r.sendTo(4, 'watch:meta', {})
    r.sendTo(4, 'watch:meta', {})
    expect(r.ids()).toEqual([])
    expect(r.quietIds()).toEqual([])
    warn.mockRestore()
  })
})
