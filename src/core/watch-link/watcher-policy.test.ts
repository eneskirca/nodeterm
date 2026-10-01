import { describe, it, expect } from 'vitest'
import { IPC } from '../../shared/ipc'
import { encodePtyData, decodePtyData } from '../../shared/rpc'
import { WATCH_CHAT_CAST, WATCH_EVENT } from '../../shared/watch-link/protocol'
import { watcherAccess, watcherEventAllowed, wrapWatcherSink, WATCHER_BUFFER_LIMIT } from './watcher-policy'
import { createStreamFilter, type StreamFilter } from './stream-filter'
import { createTokenBucket } from './token-bucket'
import type { UiSink } from '../ui-sink-registry'

const channelValues = (): string[] =>
  (Object.values(IPC) as unknown[]).filter((v): v is string => typeof v === 'string')
/** Every per-id channel factory in IPC (`pty:data:<sid>`, `pty:size:<sid>`, …). */
const channelFactories = (): Array<(id: string) => string> =>
  (Object.values(IPC) as unknown[]).filter((v): v is (id: string) => string => typeof v === 'function')

describe('watcherAccess', () => {
  it('refuses every IPC channel as a request and as a cast, for both roles', () => {
    for (const ch of channelValues()) {
      for (const role of ['viewer', 'commenter'] as const) {
        expect(watcherAccess('req', ch, role).allow).toBe(false)
        expect(watcherAccess('cast', ch, role).allow).toBe(false)
      }
    }
  })
  it('allows the chat cast only for a commenter link, and never as a request', () => {
    expect(watcherAccess('cast', WATCH_CHAT_CAST, 'commenter')).toEqual({ allow: true })
    expect(watcherAccess('cast', WATCH_CHAT_CAST, 'viewer').allow).toBe(false)
    expect(watcherAccess('req', WATCH_CHAT_CAST, 'commenter').allow).toBe(false)
  })
})

describe('watcherEventAllowed', () => {
  it('passes watch:* and this session\'s pty:size only', () => {
    expect(watcherEventAllowed(WATCH_EVENT.meta, null)).toBe(true)
    expect(watcherEventAllowed(IPC.ptySize('s1'), 's1')).toBe(true)
    expect(watcherEventAllowed(IPC.ptySize('s2'), 's1')).toBe(false)
    expect(watcherEventAllowed(IPC.ptySize('s11'), 's1')).toBe(false)
    expect(watcherEventAllowed(IPC.ptySize('s1'), null)).toBe(false)
  })
  it('refuses this session\'s lifecycle and resync events (consumed, or history)', () => {
    for (const ch of [IPC.ptyExit('s1'), IPC.ptyClosed('s1'), IPC.ptyRecycled('s1'), IPC.ptyResync('s1')]) {
      expect(watcherEventAllowed(ch, 's1')).toBe(false)
    }
  })
  it('refuses every broadcast channel in IPC', () => {
    for (const ch of channelValues()) expect(watcherEventAllowed(ch, 's1')).toBe(false)
  })
  it('passes exactly one per-session channel in IPC: pty:size of this session', () => {
    const factories = channelFactories()
    expect(factories.length).toBeGreaterThan(5)
    for (const f of factories) {
      expect(watcherEventAllowed(f('s1'), 's1')).toBe(f === IPC.ptySize)
      expect(watcherEventAllowed(f('s2'), 's1')).toBe(false)
    }
  })
})

function harness(
  o: { streaming?: boolean; buffered?: number; rate?: number; burst?: number; filter?: StreamFilter } = {}
) {
  const text: string[] = []
  const bin: string[] = []
  const base: UiSink = {
    sendText: (j) => text.push(j),
    sendBinary: (b) => bin.push(decodePtyData(b)!.data),
    bufferedAmount: () => o.buffered ?? 0
  }
  const calls = { over: 0, life: [] as string[] }
  let streaming = o.streaming ?? true
  const sink = wrapWatcherSink(base, {
    sessionId: () => 's1',
    streaming: () => streaming,
    filter: o.filter ?? createStreamFilter(),
    bucket: createTokenBucket({ ratePerSec: o.rate ?? 1e9, burst: o.burst ?? o.rate ?? 1e9, now: () => 0 }),
    onOverBudget: () => { calls.over++ },
    onLifecycle: (k) => { calls.life.push(k) }
  })
  return { sink, text, bin, calls, setStreaming: (v: boolean) => { streaming = v } }
}
const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })

describe('wrapWatcherSink', () => {
  it('forwards watch:* events and this session\'s pty:size', () => {
    const h = harness()
    const meta = ev(WATCH_EVENT.meta, { v: 1 })
    const size = ev(IPC.ptySize('s1'), 80, 24)
    h.sink.sendText(meta)
    h.sink.sendText(size)
    expect(h.text).toEqual([meta, size])
  })
  it('drops broadcast events and another session\'s data', () => {
    const h = harness()
    h.sink.sendText(ev('canvas:mut', 'p1', {}))
    h.sink.sendText(ev('presence:sync', []))
    h.sink.sendBinary(encodePtyData('s2', 'other'))
    expect(h.text).toEqual([])
    expect(h.bin).toEqual([])
  })
  it('filters the stream and keeps the parser fed while not streaming', () => {
    const h = harness({ streaming: false })
    h.sink.sendBinary(encodePtyData('s1', 'x\x1b]52;c;c2Vj'))
    h.setStreaming(true)
    h.sink.sendBinary(encodePtyData('s1', 'cmV0\x07visible'))
    expect(h.bin).toEqual(['visible'])
  })
  it('never lets another session\'s bytes move this viewer\'s parser', () => {
    const h = harness()
    h.sink.sendBinary(encodePtyData('s2', '\x1b]52;c;'))
    h.sink.sendBinary(encodePtyData('s1', 'visible'))
    expect(h.bin).toEqual(['visible'])
  })
  it('reports its session\'s lifecycle events and forwards none of them', () => {
    const h = harness()
    h.sink.sendText(ev(IPC.ptyExit('s1'), 0))
    // `{by}` names another client: never for a viewer's eyes.
    h.sink.sendText(ev(IPC.ptyClosed('s1'), { by: 3 }))
    h.sink.sendText(ev(IPC.ptyRecycled('s1'), { ready: true }))
    expect(h.calls.life).toEqual(['exit', 'closed', 'recycled'])
    expect(h.text).toEqual([])
  })
  it('ignores another session\'s lifecycle events and refuses a resync', () => {
    const h = harness()
    h.sink.sendText(ev(IPC.ptyExit('s2'), 0))
    h.sink.sendText(ev(IPC.ptyClosed('s2'), { by: 3 }))
    h.sink.sendText(ev(IPC.ptyRecycled('s2'), { ready: true }))
    h.sink.sendText(ev(IPC.ptyResync('s1'), 'HISTORY \x1b]8;;https://x\x07link\x1b]8;;\x07'))
    expect(h.calls.life).toEqual([])
    expect(h.text).toEqual([])
  })
  it('goes over budget when the socket backs up or the bucket is empty', () => {
    const backed = harness({ buffered: WATCHER_BUFFER_LIMIT + 1 })
    backed.sink.sendBinary(encodePtyData('s1', 'a'))
    expect(backed.bin).toEqual([])
    expect(backed.calls.over).toBe(1)
    const poor = harness({ rate: 5 })
    poor.sink.sendBinary(encodePtyData('s1', 'this is more than five bytes'))
    expect(poor.bin).toEqual([])
    expect(poor.calls.over).toBe(1)
  })
  it('keeps bufferedAmount pointing at the base sink', () => {
    expect(harness({ buffered: 42 }).sink.bufferedAmount?.()).toBe(42)
  })

  // A viewer that co-attaches to a RUNNING session is handed a `midStream` filter by the link host.
  // Its first frame may start inside an OSC 52 (tmux emits one per copy): the clipboard's base64
  // must not reach the viewer as text, however it is split across frames.
  it('forwards no payload byte when joined mid-OSC-52 with a midStream filter', () => {
    const secret = ['c2VjcmV0', 'LXBhc3N3b3Jk', 'LWZvci10aGUtY2xpcGJvYXJk']
    const frames = [secret[0], secret[1], `${secret[2]}\x07`, '\x1b[0mvisible']
    const h = harness({ filter: createStreamFilter({ midStream: true }) })
    for (const f of frames) h.sink.sendBinary(encodePtyData('s1', f))
    expect(h.bin).toEqual(['\x1b[0mvisible'])
    for (const part of secret) expect(h.bin.join('')).not.toContain(part)
    // Control: the same join through a filter that assumes it saw the stream from the start is
    // exactly the leak `midStream` exists to close.
    const naive = harness()
    for (const f of frames) naive.sink.sendBinary(encodePtyData('s1', f))
    expect(naive.bin.join('')).toContain(secret[0])
  })

  // A pty frame is coalesced up to 256 K UTF-16 units plus one read chunk, so a frame can be larger
  // than the bucket's burst and can then NEVER be taken. It goes over budget (the link host repaints
  // with a keyframe) instead of throwing, and it drains nothing: the next frame still passes.
  it('sends a frame larger than the burst over budget, forwards nothing, and does not throw', () => {
    const burst = 1024 * 1024
    const h = harness({ rate: 256 * 1024, burst })
    const huge = 'a'.repeat(burst + 1)
    expect(() => h.sink.sendBinary(encodePtyData('s1', huge))).not.toThrow()
    expect(h.calls.over).toBe(1)
    expect(h.bin).toEqual([])
    h.sink.sendBinary(encodePtyData('s1', 'small'))
    expect(h.bin).toEqual(['small'])
  })
})
