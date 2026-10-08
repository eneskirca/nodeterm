import { describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { OP } from './framing'

// This suite exercises the real host router with a fake PTY boundary, not Electron's factory.
vi.mock('../../core/pty-manager', () => ({ PtyManager: class {} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function pendingHost() {
  const commits = [deferred<string>(), deferred<string>()]
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const frames: number[] = []
  let attachCount = 0
  const pty = {
    createDetached: vi.fn(() => 'unused'),
    attachDetached: vi.fn(() => 'unused'),
    captureSnapshot: vi.fn(async () => ''),
    sessionExists: vi.fn(async () => true),
    prepareRelayAttach: vi.fn(async () => ({
      kind: 'ready' as const, remote: true,
      sessionExists: async () => true,
      snapshot: async () => 'existing screen',
      attach: vi.fn(() => commits[attachCount++].promise)
    })),
    write: vi.fn(), resize: vi.fn(), setFlow: vi.fn(), kill: vi.fn()
  } satisfies HostPtyManager
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => { responses.push({ id, ok, body }) },
    sendFrame: (op) => { frames.push(op); return true }
  }
  const handlers = createHostHandlers(pty, socket, {} as HostFsOps, () => [],
    undefined, () => 17)
  const attach = (id: string) => handlers.onRpc({ id, method: 'pty.attach', params: { nodeId: id } })
  const input = (streamId: number, text: string) => handlers.onFrame({ op: OP.Input, streamId, seq: 0,
    payload: new TextEncoder().encode(text) })
  return { pty, handlers, responses, frames, commits, attach, input }
}

describe('relay attach input handoff', () => {
  it('retains the first launch input exactly once until the original async attach commits', async () => {
    const h = pendingHost()
    h.attach('original')
    await vi.waitFor(() => expect(h.frames).toContain(OP.SnapshotEnd))
    h.input(1, 'claude --resume original\r')
    h.input(1, 'next')
    expect(h.pty.write).not.toHaveBeenCalled()
    h.commits[0].resolve('original-session')
    await vi.waitFor(() => expect(h.pty.write).toHaveBeenCalledTimes(2))
    expect(h.pty.write.mock.calls).toEqual([
      [17, 'original-session', 'claude --resume original\r'], [17, 'original-session', 'next']
    ])
    h.input(1, 'live')
    expect(h.pty.write.mock.calls.at(-1)).toEqual([17, 'original-session', 'live'])
  })

  it('never flushes a closed stream into its replacement or adopts its late client', async () => {
    const h = pendingHost()
    h.attach('original')
    await vi.waitFor(() => expect(h.responses).toHaveLength(1))
    h.input(1, 'old launch\r')
    h.handlers.closeAll()
    h.attach('replacement')
    await vi.waitFor(() => expect(h.responses).toHaveLength(2))
    h.input(1, 'late old input')
    h.input(2, 'new launch\r')
    h.commits[0].resolve('old-client')
    h.commits[1].resolve('new-client')
    await vi.waitFor(() => expect(h.pty.write).toHaveBeenCalledTimes(1))
    expect(h.pty.write.mock.calls).toEqual([[17, 'new-client', 'new launch\r']])
    expect(h.pty.kill).toHaveBeenCalledWith(null, 'old-client')
  })

  it('fails an overflowing stream without input and releases its eventual client', async () => {
    const h = pendingHost()
    h.attach('original')
    await vi.waitFor(() => expect(h.responses).toHaveLength(1))
    h.input(1, 'x'.repeat(64 * 1024))
    h.input(1, 'overflow')
    expect(h.frames).toContain(OP.Error)
    h.commits[0].resolve('overflow-client')
    await vi.waitFor(() => expect(h.pty.kill).toHaveBeenCalledWith(null, 'overflow-client'))
    expect(h.pty.write).not.toHaveBeenCalled()
  })

  it('discards retained input when the original attach fails', async () => {
    const h = pendingHost()
    h.attach('original')
    await vi.waitFor(() => expect(h.responses).toHaveLength(1))
    h.input(1, 'never replay\r')
    h.commits[0].reject(new Error('master gone'))
    await vi.waitFor(() => expect(h.frames).toContain(OP.Error))
    h.input(1, 'late')
    expect(h.pty.write).not.toHaveBeenCalled()
  })
})
