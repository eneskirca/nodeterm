import { describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { COMPOSED_INPUT_UNSUPPORTED, type ComposedInput, type ComposedInputResult } from '../../shared/composed-input'
import { OP } from './framing'

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
function fixture(submitComposed?: HostPtyManager['submitComposed']) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = { respond: (id, ok, body) => responses.push({ id, ok, body }), sendFrame: () => true }
  const write = vi.fn()
  const pty: HostPtyManager = { createDetached: () => 'unused', attachDetached: () => 'owned-generation',
    captureSnapshot: async () => 'screen', sessionExists: async () => true,
    submitComposed,
    // This isolated fake explicitly represents a tmux viewer; production resolves the backend.
    scrollAttached: async (clientId, sessionId, up, lines, _capture, current) => {
      if (!current()) return { status: 'refused', message: 'detached' }
      for (let i = 0; i < lines; i++) write(clientId, sessionId, `\x1b[<${up ? 64 : 65};1;1M`)
      return { status: 'input' }
    },
    write, resize: () => {}, setFlow: () => {}, kill: () => {} }
  const fs: HostFsOps = { listDir: async () => [], readText: async () => '', readBinary: async () => '', writeText: async () => true }
  const handlers = createHostHandlers(pty, socket, fs, () => [])
  const attach = async (): Promise<number> => {
    handlers.onRpc({ id: 'attach', method: 'pty.attach', params: { nodeId: 'ours', cols: 80, rows: 24 } })
    await flush()
    return (responses.find((r) => r.id === 'attach')!.body as { streamId: number }).streamId
  }
  return { handlers, responses, attach, write }
}
const input = { kind: 'paste', text: 'a multiline\nΩ draft longer than sixteen characters', enter: true } as const

describe('pty.submitComposed viewer-scoped RPC', () => {
  it('uses only the attached generation, keeping full drafts outside node.sendKeys/raw input', async () => {
    const submit = vi.fn(async (_sessionId: string, _input: ComposedInput, _current: () => boolean): Promise<ComposedInputResult> => ({ status: 'delivered' }))
    const f = fixture(submit), streamId = await f.attach()
    f.handlers.onRpc({ id: 'submit', method: 'pty.submitComposed', params: { streamId, input,
      nodeId: 'foreign', sessionId: 'foreign', paneId: '%666', socket: 'foreign' } })
    await flush()
    expect(submit).toHaveBeenCalledWith('owned-generation', input, expect.any(Function))
    expect(submit.mock.calls[0][2]()).toBe(true)
    expect(f.responses.at(-1)).toEqual({ id: 'submit', ok: true, body: { status: 'delivered' } })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('refuses legacy implementations, unknown methods/streams and malformed inputs without fallback', async () => {
    const f = fixture(), streamId = await f.attach()
    f.handlers.onRpc({ id: 'legacy', method: 'pty.submitComposed', params: { streamId, input } })
    expect(f.responses.at(-1)).toEqual({ id: 'legacy', ok: false, body: { message: COMPOSED_INPUT_UNSUPPORTED } })
    f.handlers.onRpc({ id: 'unknown', method: 'pty.submitComposedOld', params: { streamId, input } })
    expect(f.responses.at(-1)?.ok).toBe(false)
    expect(f.write).not.toHaveBeenCalled()
    const submit = vi.fn(async (): Promise<ComposedInputResult> => ({ status: 'delivered' }))
    const g = fixture(submit), owned = await g.attach()
    for (const params of [{ streamId: 999, input }, { streamId: owned, input: { ...input, kind: 'keys' } },
      { streamId: owned, input: { kind: 'control', text: '\x03', enter: true } }])
      g.handlers.onRpc({ id: 'refuse', method: 'pty.submitComposed', params })
    expect(submit).not.toHaveBeenCalled()
    expect(g.write).not.toHaveBeenCalled()
  })
  it('provides the captured stream-current callback and preserves uncertain delivery without retry', async () => {
    let resolve!: (value: ComposedInputResult) => void
    let current!: () => boolean
    const submit = vi.fn((_id, _input, valid) => { current = valid; return new Promise<ComposedInputResult>((done) => { resolve = done }) })
    const f = fixture(submit), streamId = await f.attach()
    f.handlers.onRpc({ id: 'submit', method: 'pty.submitComposed', params: { streamId, input } })
    expect(current()).toBe(true)
    f.handlers.onRpc({ id: 'kill', method: 'pty.kill', params: { streamId } })
    expect(current()).toBe(false)
    resolve({ status: 'uncertain', message: 'lost acknowledgment' }); await flush()
    expect(f.responses.at(-1)).toEqual({ id: 'submit', ok: true, body: { status: 'uncertain', message: 'lost acknowledgment' } })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(f.write).not.toHaveBeenCalled()
  })
  it('keeps reports raw and routes an explicitly known tmux viewer separately from composed input', async () => {
    const submit = vi.fn(async (): Promise<ComposedInputResult> => ({ status: 'delivered' }))
    const f = fixture(submit), streamId = await f.attach()
    const report = '\x1b[12;34R'
    f.handlers.onFrame({ op: OP.Input, streamId, seq: 0, payload: new TextEncoder().encode(report) })
    f.handlers.onRpc({ id: 'scroll', method: 'pty.scroll', params: { streamId, dir: 'up', lines: 2 } })
    await flush()
    expect(f.write.mock.calls.map((call) => call[2])).toEqual([report, '\x1b[<64;1;1M', '\x1b[<64;1;1M'])
    expect(submit).not.toHaveBeenCalled()
  })
})
