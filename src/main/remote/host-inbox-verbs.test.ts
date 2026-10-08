// The relay phone's Inbox verbs (`approvals.answer` / `inbox.ack`). What these pin:
//   - Absent injection ⇒ an honest "not served", never a silent success.
//   - Every client-sent field is validated BEFORE the writer is asked: the pendingId becomes a file
//     name (`~/.nodeterm/pending/<id>.answer`), so a traversal-shaped id must never reach it, and the
//     decision is exactly `allow` | `deny` — the literals the held hook script compares against.
//   - A writer that did not deliver comes back as an ok ANSWER `{answered:false, reason}`: `gone` (the
//     hook's hold already ended — A06: the writer checks the request file first) or `failed` (the write
//     could not happen), so the phone can open the session or offer a retry instead of a protocol error.
//   - `inbox.ack` runs the SAME ack the `~/.nodeterm/acks` sweep runs for a phone on direct SSH.
import { describe, expect, it, vi } from 'vitest'
import {
  createHostHandlers,
  type HostFsOps,
  type HostInboxOps,
  type HostPtyManager,
  type HostRelaySocket
} from './host-service'

function makeFakes(over: Partial<HostInboxOps> = {}, served = true) {
  const responses: Array<{ id: string; ok: boolean; body: any }> = []
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
  const inbox: HostInboxOps = {
    answerPermission: vi.fn(async () => 'sent' as const),
    ackRead: vi.fn(),
    ...over
  }
  const handlers = createHostHandlers(
    {} as HostPtyManager, socket, fs, () => [],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    served ? inbox : undefined
  )
  return { handlers, responses, inbox }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('approvals.answer', () => {
  it('routes a valid answer to the shared writer and reports it', async () => {
    const { handlers, responses, inbox } = makeFakes()
    handlers.onRpc({
      id: '1',
      method: 'approvals.answer',
      params: { nodeId: 'term-abc-1', pendingId: 'term-abc-1-1700000000000-4242', decision: 'allow' }
    })
    await flush()
    expect(inbox.answerPermission).toHaveBeenCalledWith('term-abc-1', 'term-abc-1-1700000000000-4242', 'allow')
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { answered: true } })
  })

  it('answers {answered:false, reason:"gone"} — an ANSWER, not an error — when the hold had ended', async () => {
    const { handlers, responses } = makeFakes({ answerPermission: async () => 'gone' })
    handlers.onRpc({
      id: '2',
      method: 'approvals.answer',
      params: { nodeId: 'term-abc-1', pendingId: 'p-1', decision: 'deny' }
    })
    await flush()
    expect(responses[0]).toEqual({ id: '2', ok: true, body: { answered: false, reason: 'gone' } })
  })

  it('tells a failed write apart from an ended hold (A35)', async () => {
    const { handlers, responses } = makeFakes({ answerPermission: async () => 'failed' })
    handlers.onRpc({
      id: '2b',
      method: 'approvals.answer',
      params: { nodeId: 'term-abc-1', pendingId: 'p-1', decision: 'allow' }
    })
    await flush()
    expect(responses[0]).toEqual({ id: '2b', ok: true, body: { answered: false, reason: 'failed' } })
  })

  it('a writer that throws is still an answer, not a hung request', async () => {
    const { handlers, responses } = makeFakes({
      answerPermission: async () => {
        throw new Error('disk full')
      }
    })
    handlers.onRpc({ id: '3', method: 'approvals.answer', params: { nodeId: 'n', pendingId: 'p', decision: 'allow' } })
    await flush()
    expect(responses[0]).toEqual({ id: '3', ok: true, body: { answered: false, reason: 'failed' } })
  })

  it.each([
    ['a traversal-shaped pendingId', { nodeId: 'n', pendingId: '../../etc/passwd', decision: 'allow' }],
    ['an empty pendingId', { nodeId: 'n', pendingId: '', decision: 'allow' }],
    ['a decision that is not allow/deny', { nodeId: 'n', pendingId: 'p', decision: 'always' }],
    ['a missing decision', { nodeId: 'n', pendingId: 'p' }],
    ['a control char in the node id', { nodeId: 'n\u001b[2J', pendingId: 'p', decision: 'allow' }],
    ['a missing node id', { pendingId: 'p', decision: 'allow' }]
  ])('refuses %s before the writer is asked', async (_label, params) => {
    const { handlers, responses, inbox } = makeFakes()
    handlers.onRpc({ id: '4', method: 'approvals.answer', params })
    await flush()
    expect(inbox.answerPermission).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })

  it('is "not served" on a host without the injection', async () => {
    const { handlers, responses } = makeFakes({}, false)
    handlers.onRpc({ id: '5', method: 'approvals.answer', params: { nodeId: 'n', pendingId: 'p', decision: 'allow' } })
    await flush()
    expect(responses[0].ok).toBe(false)
    expect(responses[0].body.message).toMatch(/not served/)
  })
})

describe('inbox.ack', () => {
  it('runs the shared read-ack for the node', async () => {
    const { handlers, responses, inbox } = makeFakes()
    handlers.onRpc({ id: '6', method: 'inbox.ack', params: { nodeId: 'term-abc-1' } })
    await flush()
    expect(inbox.ackRead).toHaveBeenCalledWith('term-abc-1')
    expect(responses[0]).toEqual({ id: '6', ok: true, body: {} })
  })

  it('still answers when the ack throws (best-effort, like the file sweep)', async () => {
    const { handlers, responses } = makeFakes({
      ackRead: () => {
        throw new Error('boom')
      }
    })
    handlers.onRpc({ id: '7', method: 'inbox.ack', params: { nodeId: 'n' } })
    await flush()
    expect(responses[0]).toEqual({ id: '7', ok: true, body: {} })
  })

  it('refuses an invalid node id and a host without the injection', async () => {
    const a = makeFakes()
    a.handlers.onRpc({ id: '8', method: 'inbox.ack', params: { nodeId: '' } })
    const b = makeFakes({}, false)
    b.handlers.onRpc({ id: '9', method: 'inbox.ack', params: { nodeId: 'n' } })
    await flush()
    expect(a.inbox.ackRead).not.toHaveBeenCalled()
    expect(a.responses[0].ok).toBe(false)
    expect(b.responses[0].ok).toBe(false)
  })
})


describe('structured hook answer verbs', () => {
  it('routes a remembered rule by index rather than accepting client-supplied rules', async () => {
    const { handlers, responses, inbox } = makeFakes()
    handlers.onRpc({ id: 'remember', method: 'approvals.answer', params: { nodeId: 'n', pendingId: 'n-1-1', decision: 'allow-always', suggestionIndex: 2 } })
    await flush()
    expect(inbox.answerPermission).toHaveBeenCalledWith('n', 'n-1-1', 'allow-always', 2)
    expect(responses[0]).toEqual({ id: 'remember', ok: true, body: { answered: true } })
  })
  it.each([-1, 32, 1.2, undefined, '1'])('rejects invalid suggestion index %s', async suggestionIndex => {
    const { handlers, responses, inbox } = makeFakes()
    handlers.onRpc({ id: 'bad', method: 'approvals.answer', params: { nodeId: 'n', pendingId: 'n-1-1', decision: 'allow-always', suggestionIndex } })
    await flush()
    expect(inbox.answerPermission).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })
  it('submits every question selection in one call and preserves a gone result', async () => {
    const answerQuestion = vi.fn(async () => 'gone' as const)
    const { handlers, responses } = makeFakes({ answerQuestion })
    handlers.onRpc({ id: 'question', method: 'questions.answer', params: { nodeId: 'n', pendingId: 'n-1-1', selections: [[0, 1], [1]] } })
    await flush()
    expect(answerQuestion).toHaveBeenCalledWith('n', 'n-1-1', [[0, 1], [1]])
    expect(responses[0]).toEqual({ id: 'question', ok: true, body: { answered: false, reason: 'gone' } })
  })
  it.each([[], [[]], [[-1]], [[4]], [[0.5]], [[0, 1, 2, 3, 0]], [[0], [0], [0], [0], [0]], [['1']]].map(selections => ({ selections })))('rejects malformed question selections $selections', async ({ selections }) => {
    const answerQuestion = vi.fn(async () => 'sent' as const)
    const { handlers, responses } = makeFakes({ answerQuestion })
    handlers.onRpc({ id: 'bad-q', method: 'questions.answer', params: { nodeId: 'n', pendingId: 'n-1-1', selections } })
    await flush()
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })
  it('honestly refuses the new verb on an older injected host', async () => {
    const { handlers, responses } = makeFakes()
    handlers.onRpc({ id: 'old', method: 'questions.answer', params: { nodeId: 'n', pendingId: 'n-1-1', selections: [[0]] } })
    await flush()
    expect(responses[0].ok).toBe(false)
    expect(responses[0].body.message).toMatch(/not served/)
  })
})
