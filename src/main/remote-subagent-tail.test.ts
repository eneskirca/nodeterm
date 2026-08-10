import { describe, expect, it, vi } from 'vitest'
import { createRemoteSubagentTail } from './remote-subagent-tail'
import { formatSubagentChunk, SUBAGENT_READ_CAP } from '../core/subagent-tail'
import type { RemoteFileRef } from './remote-ssh/remote-file'

const ref: RemoteFileRef = { conn: { host: 'h', user: 'u' }, controlPath: '/s', path: '/abs/agent-1.jsonl' }

function fakeWin(): { win: never; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { win: { isDestroyed: () => false, webContents: { send } } as never, send }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('createRemoteSubagentTail', () => {
  it('streams a formatted chunk over agent:subagent-activity for the toolUseId', async () => {
    const { win, send } = fakeWin()
    const raw = assistant('hello from subagent')
    let served = false
    const remoteFile = {
      readFromCapped: vi.fn(async (_r: RemoteFileRef, o: number, _cap: number) => {
        if (served) return { data: Buffer.alloc(0), newOffset: o }
        served = true
        const data = Buffer.from(raw + '\n')
        return { data, newOffset: o + data.length }
      })
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-1', ref)
    await tick()
    expect(send).toHaveBeenCalled()
    const [channel, payload] = send.mock.calls.at(-1)!
    expect(channel).toBe('agent:subagent-activity')
    expect(payload.toolUseId).toBe('tool-1')
    expect(payload.chunk).toContain(formatSubagentChunk(raw + '\n'))
    expect(remoteFile.readFromCapped.mock.calls[0][2]).toBe(SUBAGENT_READ_CAP)
    tail.untrack('tool-1')
  })

  it('does not drop a line served torn across two reads', async () => {
    const { win, send } = fakeWin()
    const raw = assistant('remote torn line')
    // The remote `tail -c +N` can return a line mid-write; the second read completes it.
    const parts = [raw.slice(0, 15), raw.slice(15) + '\n']
    let i = 0
    const remoteFile = {
      readFromCapped: vi.fn(async (_r: RemoteFileRef, o: number) => {
        const data = Buffer.from(parts[i] ?? '')
        i++
        return { data, newOffset: o + data.length }
      })
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-3', ref) // immediate first read gets the partial line
    await new Promise((r) => setTimeout(r, 1100)) // next poll (1s) reads the rest
    const streamed = send.mock.calls.map((c) => (c[1] as { chunk: string }).chunk).join('')
    expect(streamed).toContain('remote torn line')
    tail.untrack('tool-3')
  }, 5000)

  it('does not send when the chunk is empty', async () => {
    const { win, send } = fakeWin()
    const remoteFile = {
      readFromCapped: vi.fn(async (_r: RemoteFileRef, o: number) => ({ data: Buffer.alloc(0), newOffset: o }))
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-2', ref)
    await tick()
    expect(send).not.toHaveBeenCalled()
    tail.untrack('tool-2')
  })

  it('reassembles a multibyte char the read cap split across two reads', async () => {
    const { win, send } = fakeWin()
    const raw = Buffer.from(assistant('emoji 🚀 survives') + '\n', 'utf-8')
    // The cap lands inside the emoji's 4 bytes; the carry holds RAW bytes, so the halves rejoin.
    const cut = raw.indexOf(Buffer.from('🚀', 'utf-8')) + 2
    const parts = [raw.subarray(0, cut), raw.subarray(cut)]
    let i = 0
    const remoteFile = {
      readFromCapped: vi.fn(async (_r: RemoteFileRef, o: number) => {
        const data = parts[i] ?? Buffer.alloc(0)
        i++
        return { data, newOffset: o + data.length }
      })
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-4', ref)
    await new Promise((r) => setTimeout(r, 1100)) // next poll (1s) delivers the rest
    const streamed = send.mock.calls.map((c) => (c[1] as { chunk: string }).chunk).join('')
    expect(streamed).toContain('emoji 🚀 survives')
    expect(streamed).not.toContain('�')
    tail.untrack('tool-4')
  }, 5000)
})
