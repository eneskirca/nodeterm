import { describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { searchTerminalHistory, type HistorySearch } from '../../core/terminal-history'

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
function fixture(historySearch?: HostPtyManager['historySearch']) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = { respond: (id, ok, body) => responses.push({ id, ok, body }), sendFrame: () => true }
  const pty: HostPtyManager = {
    createDetached: () => 'unused', attachDetached: () => 'owned-generation', captureSnapshot: async () => 'screen', sessionExists: async () => true,
    historySearch, write: () => {}, resize: () => {}, setFlow: () => {}, kill: () => {}
  }
  const fs: HostFsOps = { listDir: async () => [], readText: async () => '', readBinary: async () => '', writeText: async () => true }
  const handlers = createHostHandlers(pty, socket, fs, () => [])
  const attach = async (): Promise<number> => {
    handlers.onRpc({ id: 'attach', method: 'pty.attach', params: { nodeId: 'ours', cols: 80, rows: 24 } })
    await flush()
    const reply = responses.find((r) => r.id === 'attach')!.body as { streamId: number }
    return reply.streamId
  }
  return { handlers, responses, attach }
}

describe('pty.historySearch', () => {
  it('uses only the actual attached generation, ignoring caller-selected target/path', async () => {
    const search = vi.fn(async (_id: string, query: string) => searchTerminalHistory('old Ω\n' + 'recent\n'.repeat(500), query))
    const f = fixture(search)
    const streamId = await f.attach()
    f.handlers.onRpc({ id: 'search', method: 'pty.historySearch', params: { streamId, query: 'Ω', nodeId: 'foreign', sessionId: 'foreign', cwd: '/' } })
    await flush()
    expect(search).toHaveBeenCalledWith('owned-generation', 'Ω')
    expect(f.responses.at(-1)).toEqual({ id: 'search', ok: true, body: { searchedLines: 501, truncated: false, rows: [{ line: 0, text: 'old Ω' }] } })
  })
  it('refuses unknown streams and malformed queries before capture', async () => {
    const search = vi.fn(async () => searchTerminalHistory('', 'x'))
    const f = fixture(search)
    f.handlers.onRpc({ id: 'bad-stream', method: 'pty.historySearch', params: { streamId: 99, query: 'x' } })
    const streamId = await f.attach()
    for (const query of ['', 'x\ny', 'x'.repeat(257), 1]) f.handlers.onRpc({ id: 'bad-query', method: 'pty.historySearch', params: { streamId, query } })
    expect(search).not.toHaveBeenCalled()
    expect(f.responses.filter((r) => r.id !== 'attach').every((r) => !r.ok)).toBe(true)
  })
  it('returns honest older-host and capture errors', async () => {
    for (const search of [undefined, async (): Promise<HistorySearch> => { throw new Error('capture failed') }]) {
      const f = fixture(search)
      const streamId = await f.attach()
      f.handlers.onRpc({ id: 'search', method: 'pty.historySearch', params: { streamId, query: 'x' } })
      await flush()
      expect(f.responses.at(-1)?.ok).toBe(false)
      expect(f.responses.at(-1)?.body).toHaveProperty('message', search ? 'capture failed' : 'History search is not served on this host. Update nodeterm on the computer.')
    }
  })
  it('rejects results if the stream detached during capture', async () => {
    let resolve!: (value: HistorySearch) => void
    const f = fixture(() => new Promise((done) => { resolve = done }))
    const streamId = await f.attach()
    f.handlers.onRpc({ id: 'search', method: 'pty.historySearch', params: { streamId, query: 'x' } })
    f.handlers.onRpc({ id: 'kill', method: 'pty.kill', params: { streamId } })
    resolve({ searchedLines: 1, truncated: false, rows: [{ line: 0, text: 'x' }] })
    await flush()
    expect(f.responses.at(-1)).toEqual({ id: 'search', ok: false, body: { message: 'The terminal detached while its history was searched.' } })
  })
})
