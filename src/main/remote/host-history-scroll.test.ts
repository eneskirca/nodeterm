import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { NativeWindowsPane } from '../../core/native-windows-pane'
import { HISTORY_VIEW_TTL_MS } from '../../core/history-scroll-view'
import type { HistoryScrollCapture, HistoryScrollPage, NativeScrollResult } from '../../shared/history-scroll'

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.useRealTimers() })
const capture = (): HistoryScrollCapture => ({ cols: 80, viewportRows: 4, olderTruncated: false,
  rows: Array.from({ length: 40 }, (_, i) => ({ text: `retained ${i}`, isWrapped: i === 2, section: 'normal' })) })
function fixture(scroll?: HostPtyManager['scrollAttached']) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = [], write = vi.fn()
  const socket: HostRelaySocket = { respond: (id, ok, body) => responses.push({ id, ok, body }), sendFrame: () => true }
  let next = 0
  const pty: HostPtyManager = { scrollAttached: scroll, createDetached: () => 'unused',
    attachDetached: () => `owned-${++next}`, captureSnapshot: async () => '', sessionExists: async () => true,
    write, resize: () => {}, setFlow: () => {}, kill: () => {} }
  const fs: HostFsOps = { listDir: async () => [], readText: async () => '', readBinary: async () => '', writeText: async () => true }
  const handlers = createHostHandlers(pty, socket, fs, () => [], async () => '', () => 17)
  cleanups.push(() => handlers.closeAll())
  const request = (id: string, method: string, params: unknown) => handlers.onRpc({ id, method, params })
  const response = (id: string) => { const result = responses.find(r => r.id === id);
    expect(result, `missing host response ${id}`).toBeDefined(); return result! }
  const attach = async (id = 'attach') => { request(id, 'pty.attach', { nodeId: id }); await flush();
    return (response(id).body as { streamId: number }).streamId }
  const page = (id: string) => response(id).body as HistoryScrollPage
  const answered = async (id: string) => { for (let n = 0; n < 1000 && !responses.some(r => r.id === id); n++) await new Promise<void>(r => setTimeout(r, 1));
    expect(response(id), `missing response ${id}`).toBeDefined() }
  return { responses, request, response, attach, page, answered, write, handlers }
}

describe('negotiated, viewer-owned history scrolling', () => {
  it('advertises only the actual route and refuses an older implementation without injecting input', async () => {
    const f = fixture(), streamId = await f.attach()
    expect(f.response('attach').body).toEqual({ streamId, fresh: false })
    f.request('old', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 })
    expect(f.response('old').body).toMatchObject({ status: 'refused', message: expect.stringContaining('Update') })
    f.request('legacy', 'pty.scroll', { streamId, dir: 'up', lines: 1 })
    expect(f.response('legacy').ok).toBe(false); expect(f.write).not.toHaveBeenCalled()
  })
  it('pages a frozen capture across new output and checks application mode only for a new attached-view intent', async () => {
    const source = capture(), scroll = vi.fn(async (_client, _session, _up, _lines, needCapture, _current: () => boolean): Promise<NativeScrollResult> =>
      needCapture ? { status: 'history', capture: source } : { status: 'history' })
    const f = fixture(scroll), streamId = await f.attach()
    expect(f.response('attach').body).toMatchObject({ scrollV1: true })
    f.request('up', 'pty.scrollV1', { streamId, dir: 'up', lines: 2, sessionId: 'foreign', nodeId: 'foreign' }); await flush()
    const page = f.page('up')
    expect(page.offset).toBe(6); expect(page.rows.map(r => r.text)).toEqual(['retained 30', 'retained 31', 'retained 32', 'retained 33'])
    source.rows.splice(0, source.rows.length, { text: 'new output replaced the live buffer', isWrapped: false, section: 'normal' })
    f.request('down', 'pty.scrollV1', { streamId, dir: 'down', lines: 1, viewId: page.viewId }); await flush()
    expect(f.page('down').offset).toBe(3); expect(f.page('down').rows[0].text).toBe('retained 33')
    expect(scroll.mock.calls.map(c => c.slice(0, 5))).toEqual([[17, 'owned-1', true, 2, true]])
    expect(scroll.mock.calls.every(c => c[5]())).toBe(true); expect(f.write).not.toHaveBeenCalled()
  })
  it('keeps two independent viewer positions and refuses another stream’s view id before its backend', async () => {
    const scroll = vi.fn(async (): Promise<NativeScrollResult> => ({ status: 'history', capture: capture() }))
    const f = fixture(scroll), a = await f.attach('a'), b = await f.attach('b')
    f.request('pa', 'pty.scrollV1', { streamId: a, dir: 'up', lines: 2 }); await flush()
    f.request('pb', 'pty.scrollV1', { streamId: b, dir: 'up', lines: 1 }); await flush()
    expect(f.page('pa').offset).toBe(6); expect(f.page('pb').offset).toBe(3)
    expect(f.page('pa').viewId).not.toBe(f.page('pb').viewId)
    f.request('foreign', 'pty.scrollV1', { streamId: b, dir: 'up', lines: 1, viewId: f.page('pa').viewId }); await flush()
    expect(f.response('foreign').body).toMatchObject({ status: 'refused' }); expect(scroll).toHaveBeenCalledTimes(2)
  })
  it('rejects malformed untrusted movements and unready streams without backend or raw writes', async () => {
    const scroll = vi.fn(async (): Promise<NativeScrollResult> => ({ status: 'input' }))
    const f = fixture(scroll)
    f.request('attach', 'pty.attach', { nodeId: 'node' })
    f.request('unready', 'pty.scrollV1', { streamId: 1, dir: 'up', lines: 1 })
    await flush()
    for (const [i, params] of [{ streamId: 999, dir: 'up', lines: 1 }, { streamId: 1, dir: 'left', lines: 1 },
      { streamId: 1.5, dir: 'up', lines: 1 }, { streamId: 1, dir: 'up', lines: 0 }, { streamId: 1, dir: 'up', lines: 21 },
      { streamId: 1, dir: 'up', lines: 1.5 }, { streamId: 1, dir: 'up', lines: 1, viewId: null },
      { streamId: 1, dir: 'up', lines: 1, viewId: 'foreign' }].entries()) {
      f.request(`bad-${i}`, 'pty.scrollV1', params); expect(f.response(`bad-${i}`).body).toMatchObject({ status: 'refused' })
    }
    expect(f.response('unready').body).toMatchObject({ status: 'refused' })
    expect(scroll).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
  })
  it('releases a history view on app-directed wheel input and preserves refused or uncertain results without retry', async () => {
    let mode = 'history'
    const scroll = vi.fn(async (): Promise<NativeScrollResult> => mode === 'history' ? { status: 'history', capture: capture() }
      : mode === 'input' ? { status: 'input' } : { status: mode as 'refused' | 'uncertain', message: mode })
    const f = fixture(scroll), streamId = await f.attach()
    f.request('page', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    const viewId = f.page('page').viewId
    mode = 'input'; f.request('still-history', 'pty.scrollV1', { streamId, dir: 'up', lines: 1, viewId }); await flush()
    expect(f.page('still-history').status).toBe('history'); expect(scroll).toHaveBeenCalledTimes(1)
    f.request('input', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    expect(f.response('input').body).toEqual({ status: 'input' })
    f.request('old-id', 'pty.scrollV1', { streamId, dir: 'up', lines: 1, viewId }); await flush()
    expect(f.response('old-id').body).toMatchObject({ status: 'refused' }); expect(scroll).toHaveBeenCalledTimes(2)
    for (mode of ['refused', 'uncertain']) { f.request(mode, 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
      expect(f.response(mode).body).toEqual({ status: mode, message: mode }) }
    expect(scroll).toHaveBeenCalledTimes(4); expect(f.write).not.toHaveBeenCalled()
  })
  it('makes a thrown mixed operation uncertain once and refuses a capture completed after detach', async () => {
    const thrown = vi.fn(async (): Promise<NativeScrollResult> => { throw new Error('possibly written') })
    const f = fixture(thrown), id = await f.attach(); f.request('throw', 'pty.scrollV1', { streamId: id, dir: 'up', lines: 1 }); await flush()
    expect(f.response('throw').body).toMatchObject({ status: 'uncertain' }); expect(thrown).toHaveBeenCalledTimes(1)
    let release!: (r: NativeScrollResult) => void, current!: () => boolean
    const held = vi.fn((_c, _s, _u, _n, _cap, valid) => { current = valid; return new Promise<NativeScrollResult>(done => { release = done }) })
    const g = fixture(held), streamId = await g.attach(); g.request('held', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    expect(current()).toBe(true); g.request('kill', 'pty.kill', { streamId }); expect(current()).toBe(false)
    release({ status: 'history', capture: capture() }); await flush()
    expect(g.response('held').body).toMatchObject({ status: 'refused', message: expect.stringContaining('detached') })
    expect(held).toHaveBeenCalledTimes(1)
  })
  it('serializes reversals and caps pending work instead of unbounded snapshot allocation', async () => {
    let release!: () => void, first = true
    const scroll = vi.fn(async (_c, _s, _u, _n, need): Promise<NativeScrollResult> => {
      if (first) { first = false; await new Promise<void>(done => { release = done }) }
      return need ? { status: 'history', capture: capture() } : { status: 'history' }
    })
    const f = fixture(scroll), streamId = await f.attach()
    f.request('held', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    for (let i = 1; i <= 32; i++) f.request(`queue-${i}`, 'pty.scrollV1', { streamId, dir: i % 2 ? 'down' : 'up', lines: 1 })
    await flush() // A second turn must remain blocked while the first backend call is held.
    expect(scroll).toHaveBeenCalledTimes(1); expect(f.response('queue-32').body).toMatchObject({ status: 'refused', message: expect.stringContaining('busy') })
    release(); await flush(); expect(scroll).toHaveBeenCalledTimes(32)
    expect(scroll.mock.calls.slice(0, 3).map(c => c[2])).toEqual([true, false, true])
  })
  it('expires held snapshots and requires a fresh user intent rather than silently reusing another live buffer', async () => {
    const scroll = vi.fn(async (): Promise<NativeScrollResult> => ({ status: 'history', capture: capture() }))
    const f = fixture(scroll), streamId = await f.attach()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    f.request('old', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    vi.advanceTimersByTime(HISTORY_VIEW_TTL_MS + 1)
    f.request('expired', 'pty.scrollV1', { streamId, dir: 'up', lines: 1, viewId: f.page('old').viewId }); await flush()
    expect(f.response('expired').body).toMatchObject({ status: 'refused', message: expect.stringContaining('expired') })
    expect(scroll).toHaveBeenCalledTimes(1)
    f.request('new', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await flush()
    expect(f.page('new').viewId).not.toBe(f.page('old').viewId); expect(scroll).toHaveBeenCalledTimes(2)
    f.handlers.closeAll(); f.request('gone', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 })
    expect(f.response('gone').body).toMatchObject({ status: 'refused' })
  })
})

it('actual native emulator pages retained pre-attach history with zero off-mode bytes and respects later SGR/default mode changes', async () => {
  const write = vi.fn(), pane = new NativeWindowsPane({ pid: 42, write }, { cols: 20, rows: 5, scrollback: 100 })
  cleanups.push(() => pane.dispose()); pane.recordOutput('pre-attach older row\r\n' + 'history row\r\n'.repeat(35))
  const f = fixture((_c, _s, up, lines, need, current) => pane.scrollForHistory(up, lines, need, current)), streamId = await f.attach()
  f.request('history', 'pty.scrollV1', { streamId, dir: 'up', lines: 20 }); await f.answered('history')
  expect(f.page('history').rows.some(r => r.text.includes('pre-attach older'))).toBe(true); expect(write).not.toHaveBeenCalled()
  pane.recordOutput('\x1b[?1000h\x1b[?1006h')
  f.request('still-history', 'pty.scrollV1', { streamId, dir: 'down', lines: 2, viewId: f.page('history').viewId }); await f.answered('still-history')
  expect(f.page('still-history').status).toBe('history'); expect(write).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
  f.request('sgr', 'pty.scrollV1', { streamId, dir: 'down', lines: 2 }); await f.answered('sgr')
  expect(f.response('sgr').body).toEqual({ status: 'input' }); expect(write.mock.calls).toEqual([['\x1b[<65;1;1M'], ['\x1b[<65;1;1M']])
  write.mockClear(); pane.recordOutput('\x1b[?1006l')
  f.request('default', 'pty.scrollV1', { streamId, dir: 'up', lines: 1 }); await f.answered('default')
  expect(write.mock.calls).toEqual([['\x1b[M`!!']])
  write.mockClear(); pane.recordOutput('\x1b[?1000l')
  f.request('legacy', 'pty.scroll', { streamId, dir: 'up', lines: 2 }); await f.answered('legacy')
  expect(f.response('legacy').ok).toBe(false); expect(write).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
})
