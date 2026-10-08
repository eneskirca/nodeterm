// The phone Chat screen's relay verbs (`chat.page` / `chat.status` / `chat.send` / `agent.answer`),
// at the RPC envelope. What these pin:
//   - Absent injection ⇒ every verb answers an honest "not served" (a pre-feature host).
//   - The client-sent node id is validated exactly like the node.* verbs (empty / over REF_MAX_LEN
//     / control chars ⇒ refused, the op never invoked). The phone sends ONLY a node id; everything
//     else about the node is resolved host-side, inside the op.
//   - `chat.send`: raw text over 64000 UTF-16 units ⇒ refused; ESC + C0/C1 stripped (\n \t kept)
//     BEFORE the op sees it; nothing left ⇒ refused.
//   - Unknown node ⇒ "Unknown node.", never an empty success.
//   - Happy paths answer `{page}` / `{status}` / `{result}` / `{ok}`.
import { describe, expect, it, vi } from 'vitest'
import { REF_MAX_LEN } from '../../shared/presence'
import { GROK_AMBIGUOUS_SESSION_MESSAGE } from '../../shared/chat-page'
import { CHAT_SEND_TEXT_MAX, type ChatPage, type ChatStatus } from '../../shared/mobile-chat'
import {
  createHostHandlers,
  type HostChatOps,
  type HostFsOps,
  type HostPtyManager,
  type HostRelaySocket
} from './host-service'

const PAGE: ChatPage = { version: 1, messages: [], found: true, olderCursor: null, unmatchedResults: [] }
const STATUS: ChatStatus = {
  state: 'done',
  held: null,
  hibernated: false,
  paused: false,
  dropped: false,
  sessionEnded: false,
  structuredAnswers: false,
  version: 1,
  hostRefuses: false
}

function make(chat?: Partial<HostChatOps>, served = true) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const ops: HostChatOps = {
    page: vi.fn(async () => PAGE),
    status: vi.fn(async () => STATUS),
    send: vi.fn(async () => ({ result: 'sent' as const })),
    answer: vi.fn(async () => true),
    ...chat
  }
  const handlers = createHostHandlers(
    {} as HostPtyManager,
    socket,
    fs,
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    served ? ops : undefined
  )
  const call = async (method: string, params: unknown) => {
    handlers.onRpc({ id: 'r1', method, params } as never)
    await new Promise((r) => setTimeout(r, 0))
    return responses[responses.length - 1]
  }
  return { call, ops, responses }
}

const VERBS: Array<[string, Record<string, unknown>]> = [
  ['chat.page', {}],
  ['chat.status', {}],
  ['chat.send', { text: 'hi' }],
  ['agent.answer', { pendingId: 'p-1', answer: { kind: 'deny' } }]
]

describe('phone chat verbs — not served', () => {
  it.each(VERBS)('%s answers an honest "not served" when no chat ops are wired', async (method, extra) => {
    const { call } = make(undefined, false)
    const r = await call(method, { nodeId: 'n1', ...extra })
    expect(r).toEqual({ id: 'r1', ok: false, body: { message: `${method} is not served on this host.` } })
  })
})

describe('phone chat verbs — node id validation', () => {
  const bad: unknown[] = [undefined, '', 42, 'x'.repeat(REF_MAX_LEN + 1), 'a\x1bb', 'a\nb', 'a\x9bb']
  it.each(VERBS)('%s refuses an invalid node id without calling the op', async (method, extra) => {
    for (const nodeId of bad) {
      const { call, ops } = make()
      const r = await call(method, { nodeId, ...extra })
      expect(r).toEqual({ id: 'r1', ok: false, body: { message: 'Invalid node id.' } })
      for (const f of Object.values(ops)) expect(f).not.toHaveBeenCalled()
    }
  })
})

describe('chat.page', () => {
  it('answers {page} and passes only before/maxBytes through', async () => {
    const { call, ops } = make()
    const r = await call('chat.page', { nodeId: 'n1', before: 100, maxBytes: 65536, cwd: '/etc', sessionId: 'x' })
    expect(r).toEqual({ id: 'r1', ok: true, body: { page: PAGE } })
    expect(ops.page).toHaveBeenCalledWith('n1', { before: 100, maxBytes: 65536 })
  })
  it('refuses an invalid page before reading anything', async () => {
    const { call, ops } = make()
    const r = await call('chat.page', { nodeId: 'n1', before: -1 })
    expect(r).toEqual({ id: 'r1', ok: false, body: { message: 'Invalid page.' } })
    expect(ops.page).not.toHaveBeenCalled()
  })
  it('an unknown node is "Unknown node."', async () => {
    const { call } = make({ page: vi.fn(async () => null) })
    expect(await call('chat.page', { nodeId: 'n1' })).toEqual({ id: 'r1', ok: false, body: { message: 'Unknown node.' } })
  })
  it('a non-chat agent is refused by name, never an empty page', async () => {
    const { call } = make({ page: vi.fn(async () => 'unsupported' as const) })
    expect(await call('chat.page', { nodeId: 'n1' })).toEqual({
      id: 'r1',
      ok: false,
      body: { message: 'Chat is not available for this agent.' }
    })
  })
  it('an ambiguous grok session id reaches the phone as its own sentence, not "Could not read"', async () => {
    const { call } = make({ page: vi.fn(async () => { throw new Error(GROK_AMBIGUOUS_SESSION_MESSAGE) }) })
    expect(await call('chat.page', { nodeId: 'n1' })).toEqual({
      id: 'r1',
      ok: false,
      body: { message: GROK_AMBIGUOUS_SESSION_MESSAGE }
    })
  })
  it('a failed read is an error, never an empty page', async () => {
    const { call } = make({ page: vi.fn(async () => { throw new Error('boom') }) })
    expect(await call('chat.page', { nodeId: 'n1' })).toEqual({
      id: 'r1',
      ok: false,
      body: { message: 'Could not read the transcript.' }
    })
  })
})

describe('chat.status', () => {
  it('answers {status}', async () => {
    const { call } = make()
    expect(await call('chat.status', { nodeId: 'n1' })).toEqual({ id: 'r1', ok: true, body: { status: STATUS } })
  })
  it('passes the phone\'s catalog opt-in through — and only a literal true', async () => {
    const status = vi.fn(async (_nodeId: string, _opts?: { catalog?: boolean }) => STATUS)
    const { call } = make({ status })
    await call('chat.status', { nodeId: 'n1', catalog: true })
    await call('chat.status', { nodeId: 'n1', catalog: 'yes' })
    await call('chat.status', { nodeId: 'n1' })
    expect(status.mock.calls.map((c) => c[1])).toEqual([{ catalog: true }, undefined, undefined])
  })
  it('unknown node ⇒ "Unknown node."', async () => {
    const { call } = make({ status: vi.fn(async () => null) })
    expect(await call('chat.status', { nodeId: 'n1' })).toEqual({ id: 'r1', ok: false, body: { message: 'Unknown node.' } })
  })
  it('a desktop window that does not answer is said as such', async () => {
    const { call } = make({ status: vi.fn(async () => { throw new Error('x') }) })
    expect(await call('chat.status', { nodeId: 'n1' })).toEqual({
      id: 'r1',
      ok: false,
      body: { message: 'The desktop window is not available.' }
    })
  })
})

describe('chat.send', () => {
  it('answers {result} with the sanitized text', async () => {
    const { call, ops } = make()
    const r = await call('chat.send', { nodeId: 'n1', text: 'a\x1b[2Jb\r\nc\td\x00e\x9bf' })
    expect(r).toEqual({ id: 'r1', ok: true, body: { result: 'sent' } })
    expect(ops.send).toHaveBeenCalledWith('n1', 'a[2Jb\nc\tdef')
  })
  it('refuses text over the cap (raw length) without sending', async () => {
    const { call, ops } = make()
    const r = await call('chat.send', { nodeId: 'n1', text: 'x'.repeat(CHAT_SEND_TEXT_MAX + 1) })
    expect(r).toEqual({ id: 'r1', ok: false, body: { message: 'Text too long.' } })
    expect(ops.send).not.toHaveBeenCalled()
  })
  it('accepts text exactly at the cap', async () => {
    const { call } = make()
    const r = await call('chat.send', { nodeId: 'n1', text: 'x'.repeat(CHAT_SEND_TEXT_MAX) })
    expect(r?.ok).toBe(true)
  })
  it('refuses empty (or control-only / blank) text', async () => {
    for (const text of [undefined, '', '\x1b\x1b', '  \n ']) {
      const { call, ops } = make()
      const r = await call('chat.send', { nodeId: 'n1', text })
      expect(r).toEqual({ id: 'r1', ok: false, body: { message: 'chat.send requires non-empty text.' } })
      expect(ops.send).not.toHaveBeenCalled()
    }
  })
  it('passes a refusal and a partial delivery through verbatim', async () => {
    for (const result of ['refused', 'pasted-not-submitted', 'unconfirmed'] as const) {
      const { call } = make({ send: vi.fn(async () => ({ result })) })
      expect(await call('chat.send', { nodeId: 'n1', text: 'hi' })).toEqual({ id: 'r1', ok: true, body: { result } })
    }
    const { call } = make({ send: vi.fn(async () => ({ result: 'refused' as const, reason: 'busy' as const })) })
    expect(await call('chat.send', { nodeId: 'n1', text: 'hi' })).toEqual({
      id: 'r1',
      ok: true,
      body: { result: 'refused', reason: 'busy' }
    })
  })
  it('unknown node ⇒ "Unknown node."', async () => {
    const { call } = make({ send: vi.fn(async () => 'unknown-node' as const) })
    expect(await call('chat.send', { nodeId: 'n1', text: 'hi' })).toEqual({
      id: 'r1',
      ok: false,
      body: { message: 'Unknown node.' }
    })
  })
  it('a throwing send is a refusal, never "sent"', async () => {
    const { call } = make({ send: vi.fn(async () => { throw new Error('x') }) })
    expect(await call('chat.send', { nodeId: 'n1', text: 'hi' })).toEqual({
      id: 'r1',
      ok: true,
      body: { result: 'refused', reason: 'unavailable' }
    })
  })
})

describe('agent.answer', () => {
  it('answers {ok} and passes the raw answer to the op (validated there against the pending file)', async () => {
    const { call, ops } = make()
    const answer = { kind: 'plan', mode: 'restore' }
    expect(await call('agent.answer', { nodeId: 'n1', pendingId: 'p-1', answer })).toEqual({
      id: 'r1',
      ok: true,
      body: { ok: true }
    })
    expect(ops.answer).toHaveBeenCalledWith('n1', 'p-1', answer)
  })
  it('refuses an invalid pending id without calling the op', async () => {
    for (const pendingId of [undefined, '', '../x', 'a b', 'x'.repeat(257)]) {
      const { call, ops } = make()
      const r = await call('agent.answer', { nodeId: 'n1', pendingId, answer: { kind: 'deny' } })
      expect(r).toEqual({ id: 'r1', ok: false, body: { message: 'Invalid pending id.' } })
      expect(ops.answer).not.toHaveBeenCalled()
    }
  })
  it('a refused or throwing answer is {ok:false}, never ok', async () => {
    for (const answer of [vi.fn(async () => false), vi.fn(async () => { throw new Error('x') })]) {
      const { call } = make({ answer })
      expect(await call('agent.answer', { nodeId: 'n1', pendingId: 'p-1', answer: { kind: 'deny' } })).toEqual({
        id: 'r1',
        ok: true,
        body: { ok: false }
      })
    }
  })
})
