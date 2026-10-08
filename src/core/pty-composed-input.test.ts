import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { ComposedInputResult } from '../shared/composed-input'
import type { ComposedViewerReceipt } from './composed-tmux'
import { NativeWindowsPane } from './native-windows-pane'

const seam = vi.hoisted(() => ({ capture: vi.fn(), submit: vi.fn(), writes: vi.fn(), exit: undefined as undefined | ((e: { exitCode: number }) => void) }))
vi.mock('./composed-tmux', async (original) => ({ ...(await original<typeof import('./composed-tmux')>()),
  captureComposedViewer: seam.capture, submitComposedTmux: seam.submit }))
vi.mock('./tmux-painter', () => ({ trackTmuxPainter: () => ({ close() {}, settled: Promise.resolve() }) }))
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
vi.mock('./tmux-hint', async (original) => ({ ...(await original<typeof import('./tmux-hint')>()), findFixedTmux: () => '/usr/bin/tmux' }))
vi.mock('node-pty', () => ({ spawn: () => ({ pid: 123, onData() {}, onExit(cb: typeof seam.exit) { seam.exit = cb },
  write: seam.writes, resize() {}, pause() {}, resume() {}, kill() {} }) }))
vi.mock('child_process', () => ({ execFileSync: () => '',
  execFile: (_file: string, _args: string[], a?: unknown, b?: unknown) => {
    const callback = (typeof a === 'function' ? a : b) as (err: null, value: { stdout: string; stderr: string }) => void
    callback?.(null, { stdout: '', stderr: '' }); return {}
  } }))

let userData: string
const r: ComposedViewerReceipt = { socket: 'node-terminal', session: 'nt-owned', viewerPid: 123,
  viewerCreated: '1700000000', viewerName: 'client-123', viewerBirth: 'viewer-birth', serverPid: 99,
  serverBirth: 'server-birth', sessionCreated: '1700000000', paneId: '%7', panePid: 77, paneBirth: 'pane-birth' }
const input = { kind: 'paste', text: 'composed draft', enter: true } as const
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pty-composed-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
  vi.useFakeTimers()
  seam.capture.mockReset().mockResolvedValue(r)
  seam.submit.mockReset().mockResolvedValue({ status: 'delivered' } satisfies ComposedInputResult)
  seam.writes.mockReset(); seam.exit = undefined
})
afterEach(() => { vi.useRealTimers(); resetPlatformForTests(); fs.rmSync(userData, { recursive: true, force: true }) })
async function manager() {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager()
  m.init(() => DEFAULT_SETTINGS)
  return m
}
const sinks = () => ({ onData() {}, onExit() {} })

describe('PtyManager composed action on the captured relay viewer', () => {
  it('captures the spawned local viewer during attach, before any Send', async () => {
    const m = await manager()
    const id = m.attachDetached('owned', sinks())
    expect(seam.capture).toHaveBeenCalledWith('node-terminal', 'nt-owned', 123, expect.any(Object))
    expect(await m.submitComposed(id, input, () => true)).toEqual({ status: 'delivered' })
    expect(seam.submit).toHaveBeenCalledWith(r, input, expect.any(Object))
    expect(seam.capture).toHaveBeenCalledTimes(1)
    expect(seam.writes).not.toHaveBeenCalled()
    m.kill(null, id)
  })
  it('refuses a detach while attachment receipt is pending, with no replacement/raw write', async () => {
    let resolve!: (receipt: ComposedViewerReceipt) => void
    seam.capture.mockReturnValue(new Promise((done) => { resolve = done }))
    const m = await manager(), id = m.attachDetached('owned', sinks())
    const send = m.submitComposed(id, input, () => true)
    m.kill(null, id)
    resolve(r)
    expect((await send).status).toBe('refused')
    expect(seam.submit).not.toHaveBeenCalled()
    expect(seam.writes).not.toHaveBeenCalled()
  })
  it('keeps stream-current checks inside dispatch and serializes repeated explicit actions', async () => {
    const m = await manager(), id = m.attachDetached('owned', sinks())
    let resolve!: (result: ComposedInputResult) => void
    let alive = true
    seam.submit.mockImplementationOnce((_receipt, _input, b) => {
      expect(b.current()).toBe(true)
      return new Promise((done) => { resolve = done })
    })
    const first = m.submitComposed(id, input, () => alive)
    await Promise.resolve(); await Promise.resolve()
    const second = m.submitComposed(id, input, () => alive)
    expect(seam.submit).toHaveBeenCalledTimes(1)
    alive = false; resolve({ status: 'uncertain' })
    expect((await first).status).toBe('uncertain')
    expect((await second).status).toBe('refused')
    expect(seam.submit).toHaveBeenCalledTimes(1)
    m.kill(null, id)
  })
  it('refuses an older unverified backend shim and unknown viewers while preserving raw reports', async () => {
    const m = await manager(), id = m.attachDetached('owned', sinks())
    expect((await m.submitComposed('foreign', input, () => true)).status).toBe('refused')
    const internals = m as unknown as { sessions: Map<string, { composedViewer?: Promise<ComposedViewerReceipt>; sessionHost?: boolean; proc: { write(text: string): void } }> }
    internals.sessions.get(id)!.sessionHost = true
    expect((await m.submitComposed(id, input, () => true)).status).toBe('refused')
    m.write(null, id, '\x1b[12;34R')
    expect(seam.writes).toHaveBeenCalledWith('\x1b[12;34R')
    expect(seam.submit).not.toHaveBeenCalled()
    internals.sessions.get(id)!.sessionHost = false
    m.kill(null, id)
  })
  it('routes an owned direct Windows pane through its actual emulator and split writer', async () => {
    vi.useRealTimers()
    const m = await manager(), id = m.attachDetached('owned', sinks())
    const proc = { pid: 123, write: seam.writes }
    const pane = new NativeWindowsPane(proc, { cols: 80, rows: 24, scrollback: 100 })
    pane.recordOutput('\x1b[?2004h')
    const internals = m as unknown as { sessions: Map<string, { nativeWindowsPane?: NativeWindowsPane }> }
    internals.sessions.get(id)!.nativeWindowsPane = pane
    expect(await m.submitComposed(id, input, () => true)).toEqual({ status: 'delivered' })
    expect(seam.writes.mock.calls.map(([data]) => data)).toEqual(['\x1b[200~composed draft\x1b[201~', '\r'])
    expect(seam.submit).not.toHaveBeenCalled()
    let current = false
    expect((await m.submitComposed(id, input, () => current)).status).toBe('refused')
    expect(seam.writes).toHaveBeenCalledTimes(2)
    m.kill(null, id)
  })
})
