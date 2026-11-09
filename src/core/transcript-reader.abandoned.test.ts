// A prompt whose request was cancelled before anything answered it stays in the transcript as a
// dead end of the record tree; the chat thread must not show it as sent. The golden fixture
// (`abandoned-prompts`) pins the paged read; these cover the unpaged read and the window edge.
import { describe, expect, it } from 'vitest'
import { parseChatMessages, parseChatWindow } from './transcript-reader'
import type { ChatMessage } from '../shared/types'

type Rec = Record<string, unknown>
const prompt = (uuid: string, parentUuid: string | null, content: unknown): Rec => ({
  type: 'user',
  uuid,
  parentUuid,
  isSidechain: false,
  message: { role: 'user', content }
})
const reply = (uuid: string, parentUuid: string, t: string): Rec => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text: t }] }
})
const texts = (ms: ChatMessage[]): string[] =>
  ms.flatMap((m) => m.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])))

// Measured shape (a queued prompt, then Esc): the cancelled prompt and the next one share a parent.
const queuedThenEsc: Rec[] = [
  prompt('u1', null, 'Rename the helper.'),
  reply('a1', 'u1', 'Renamed.'),
  prompt('u2', 'a1', 'Also update the docs.'),
  { type: 'file-history-snapshot', snapshot: {} },
  prompt('u3', 'a1', 'Also update the docs, and the README.'),
  reply('a2', 'u3', 'Done.')
]

describe('abandoned prompts', () => {
  it('unpaged: a dead-end prompt with a later sibling is not shown', () => {
    const ms = parseChatMessages(queuedThenEsc.map((r) => JSON.stringify(r)))

    expect(texts(ms)).toEqual(['Rename the helper.', 'Renamed.', 'Also update the docs, and the README.', 'Done.'])
  })

  it('keeps a prompt with no later sibling, even with no answer yet', () => {
    const recs = queuedThenEsc.slice(0, 3)

    const ms = parseChatMessages(recs.map((r) => JSON.stringify(r)))

    expect(texts(ms)).toEqual(['Rename the helper.', 'Renamed.', 'Also update the docs.'])
  })

  it('keeps a prompt the model answered, even when a later prompt shares its parent', () => {
    const recs = [
      prompt('u1', 'root', 'Explain the cache.'),
      reply('a1', 'u1', 'The cache keeps'),
      prompt('u2', 'root', 'Explain the cache briefly.')
    ]

    const ms = parseChatMessages(recs.map((r) => JSON.stringify(r)))

    expect(texts(ms)).toEqual(['Explain the cache.', 'The cache keeps', 'Explain the cache briefly.'])
  })

  it('never hides a record without string uuid fields', () => {
    const recs = queuedThenEsc.map((r) => ({ ...r, uuid: undefined }))

    const ms = parseChatMessages(recs.map((r) => JSON.stringify(r)))

    expect(texts(ms)).toContain('Also update the docs.')
  })

  it('paged: a sibling in a newer window is not seen, so the older window shows the prompt', () => {
    const file = queuedThenEsc.map((r) => JSON.stringify(r) + '\n').join('')
    const buf = Buffer.from(file)
    const siblingAt = buf.indexOf(Buffer.from(JSON.stringify(queuedThenEsc[4])))

    const older = parseChatWindow(buf.subarray(0, siblingAt), 0)
    const whole = parseChatWindow(buf, 0)

    expect(texts(older.messages)).toContain('Also update the docs.')
    expect(texts(whole.messages)).not.toContain('Also update the docs.')
  })
})
