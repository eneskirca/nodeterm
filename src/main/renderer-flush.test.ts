import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { requestRendererFlush, type FlushIpc } from './renderer-flush'

let ipc: EventEmitter & FlushIpc
const sentIds: string[] = []
const target = (opts: { destroyed?: boolean; reply?: 'ours' | 'stale' | 'none'; throws?: boolean } = {}) => ({
  isDestroyed: () => !!opts.destroyed,
  send: (channel: string, id: unknown) => {
    if (opts.throws) throw new Error('Object has been destroyed')
    expect(channel).toBe(IPC.appFlushRequest)
    sentIds.push(id as string)
    if (opts.reply === 'ours') queueMicrotask(() => ipc.emit(IPC.appFlushDone, {}, id))
    if (opts.reply === 'stale') queueMicrotask(() => ipc.emit(IPC.appFlushDone, {}, 'flush-0'))
  }
})

beforeEach(() => {
  ipc = new EventEmitter() as EventEmitter & FlushIpc
  sentIds.length = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('requestRendererFlush', () => {
  it('resolves flushed when the renderer answers with the same id', async () => {
    await expect(requestRendererFlush(target({ reply: 'ours' }), ipc)).resolves.toBe('flushed')
    expect(ipc.listenerCount(IPC.appFlushDone)).toBe(0)
  })

  it('times out (never hangs) when the renderer does not answer', async () => {
    const p = requestRendererFlush(target({ reply: 'none' }), ipc, 1000)
    vi.advanceTimersByTime(999)
    let settled = false
    void p.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe('timeout')
    expect(ipc.listenerCount(IPC.appFlushDone)).toBe(0)
  })

  it('ignores a stale reply for another request id', async () => {
    const p = requestRendererFlush(target({ reply: 'stale' }), ipc, 1000)
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    await expect(p).resolves.toBe('timeout')
  })

  it('answers no-window without a live target — and never throws', async () => {
    await expect(requestRendererFlush(undefined, ipc)).resolves.toBe('no-window')
    await expect(requestRendererFlush(target({ destroyed: true }), ipc)).resolves.toBe('no-window')
    await expect(requestRendererFlush(target({ throws: true }), ipc)).resolves.toBe('no-window')
    expect(ipc.listenerCount(IPC.appFlushDone)).toBe(0)
  })

  it('mints a distinct id per request', async () => {
    await Promise.all([
      requestRendererFlush(target({ reply: 'ours' }), ipc),
      requestRendererFlush(target({ reply: 'ours' }), ipc)
    ])
    expect(new Set(sentIds).size).toBe(2)
  })
})

describe('before-quit wiring (source guard)', () => {
  it('re-runs the SSH mirror flush AFTER the renderer flush answered', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
    // The renderer's save may queue a throttled mirror write after the parallel remote flush took
    // its snapshot; without the chained flush that write dies with the ControlMasters.
    expect(src).toMatch(
      /requestRendererFlush\(getMainWindow\(\)\?\.webContents, ipcMain\)\.then\(\(\) => remoteWorkspaceIO\.flush\(\)\)/
    )
  })
})
