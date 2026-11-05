import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMailbox } from './agent-mailbox'
import type { AgentMessagingDeps } from './agent-messaging'
import type { AgentMessageOutcome } from './agent-message-decide'
import type { MailboxReply, MailboxMessage } from '../../shared/agents/agent-mailbox'
import { MailboxCommitError, type MailboxStoredMessage, type MailboxStorage } from './agent-mailbox-store'

// These tests never resolve a real agent configuration or terminal. The transport and the
// optional process-global mirror are replaced BEFORE the service is imported.
const transport = vi.hoisted(() => vi.fn())
vi.mock('./agent-messaging', () => ({ runDelivery: transport, authorizeMessageScope: async () => ({}) }))
vi.mock('../agent-status-mirror', () => ({ mirrorEntry: () => { throw new Error('global mirror forbidden') } }))

function message(reply: MailboxReply): MailboxMessage {
  expect(reply.ok).toBe(true)
  if (!reply.ok || !('message' in reply.result)) throw new Error('expected message')
  return reply.result.message
}
function harness(disk: MailboxStoredMessage[] = []) {
  let now = 1000, writes = 0, fail = false
  const sessions: Record<string, string> = { a: 'sa', b: 'sb', c: 'sc' }
  const owners: Record<string, string> = { a: 'p', b: 'p', c: 'foreign' }
  let projects: ReturnType<AgentMessagingDeps['projects']> = [
    { id: 'p', nodes: [{ id: 'a', title: 'Sender' }, { id: 'b', title: 'Recipient' }] },
    { id: 'foreign', nodes: [{ id: 'c' }] }
  ]
  let enabled = true
  const commits: MailboxStoredMessage[][] = []
  const storage: MailboxStorage = {
    load: async () => structuredClone(disk),
    commit: async records => {
      if (fail) throw new MailboxCommitError(false)
      disk = structuredClone([...records]); commits.push(disk)
    }
  }
  const deps = {
    projects: () => projects,
    isRemoteNode: () => false,
    mirrorEntry: (id: string) => ({ sessionId: sessions[id], agentId: 'codex', stateVerified: true,
      stateIdentity: { sessionId: sessions[id], agentId: 'codex' } }),
    paneOwnerProject: (id: string) => owners[id], messagingEnabled: () => enabled,
    now: () => now,
    sendEnvelope: vi.fn(async () => { writes++; return true }),
    onHandover: vi.fn()
  } as unknown as AgentMessagingDeps
  const mail = new AgentMailbox(storage, deps)
  const call = (actor: string, verb: string, args: Record<string, string>) => mail.control(actor, true, verb, args)
  return { mail, call, deps, commits, sessions, owners, disk: () => structuredClone(disk), writes: () => writes,
    remove: (id: string) => { projects = projects.map(p => ({ ...p, nodes: p.nodes.filter(n => n.id !== id) })) },
    move: (id: string, projectId: string) => {
      const node = projects.flatMap(p => p.nodes).find(n => n.id === id)!
      projects = projects.map(p => ({ ...p, nodes: [
        ...p.nodes.filter(n => n.id !== id), ...(p.id === projectId ? [node] : [])
      ] }))
      owners[id] = projectId
    },
    fail: () => { fail = true }, revoke: () => { enabled = false }, advance: (ms: number) => { now += ms } }
}
const send = { node: 'b', text: 'work', 'request-id': 'send1' }
beforeEach(() => {
  transport.mockReset()
  transport.mockImplementation(async (req, deps) => {
    const wrote = await deps.sendEnvelope(req.targetNodeId, req.body, {})
    return wrote === 'dialog' ? { kind: 'targetBusy', state: 'blocked' } :
      { kind: 'delivered', traceId: 'trace', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
  })
})

describe('durable agent mailbox', () => {
  it('commits admission and attempt before writing; delivery/read do not acknowledge', async () => {
    const h = harness()
    transport.mockImplementationOnce(async (req, deps) => {
      expect(h.disk()[0].message.deliveryStatus).toBe('pending')
      await deps.sendEnvelope(req.targetNodeId, req.body, {})
      expect(h.disk()[0].attempting).toBe(true)
      expect(req.body).toContain('Agent mail ')
      expect(req.body).toContain('Delivery is not processing')
      return { kind: 'delivered', traceId: 't', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
    })
    const m = message(await h.call('a', 'send', send))
    expect(m.deliveryStatus).toBe('delivered')
    expect(m.processingStatus).toBe('unacknowledged')
    expect(message(await h.call('b', 'read', { message: m.messageId })).processingStatus).toBe('unacknowledged')
    await h.mail.onTargetBoundary('b')
    expect(h.writes()).toBe(1)
    expect(h.disk()[0].message.processingStatus).toBe('unacknowledged')
  })
  it('keeps pending work beyond five minutes and days offline; inbox/outbox share the ID', async () => {
    const h = harness()
    transport.mockResolvedValueOnce({ kind: 'targetBusy', state: 'working' })
    const m = message(await h.call('a', 'send', send))
    expect(m.deliveryStatus).toBe('queued')
    h.advance(7 * 86400000)
    const restored = harness(h.disk())
    const inbox = await restored.call('b', 'inbox', {})
    const outbox = await restored.call('a', 'outbox', {})
    expect(inbox).toMatchObject({ ok: true, result: { schemaVersion: 1, messages: [{ messageId: m.messageId }] } })
    expect(outbox).toMatchObject({ ok: true, result: { messages: [{ messageId: m.messageId }] } })
    expect(JSON.stringify(inbox)).not.toContain('"body"')
    await restored.mail.onTargetBoundary('b')
    expect(restored.writes()).toBe(1)
  })
  it('deduplicates send across restart and rejects changed contents for the same key', async () => {
    const h = harness()
    const m = message(await h.call('a', 'send', send))
    const restored = harness(h.disk())
    expect(message(await restored.call('a', 'send', send)).messageId).toBe(m.messageId)
    expect(restored.writes()).toBe(0)
    expect(await restored.call('a', 'send', { ...send, text: 'other' })).toMatchObject({ ok: false, code: 'idempotency-conflict' })
  })
  it('serializes competing claims and requires recipient, revision and claim for completion', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    const args = { message: m.messageId, state: 'accepted', revision: String(m.revision), note: 'starting', 'request-id': 'ack1' }
    const [one, two] = await Promise.all([h.call('b', 'ack', args), h.call('b', 'ack', { ...args, 'request-id': 'ack2' })])
    const claimed = message(one)
    expect(claimed.claimId).toBeTruthy()
    expect(two).toMatchObject({ ok: false, code: 'revision-conflict' })
    expect(message(await h.call('b', 'ack', args))).toEqual(claimed)
    const done = { message: m.messageId, outcome: 'done', revision: String(claimed.revision), claim: claimed.claimId!, note: 'evidence', 'request-id': 'done1' }
    expect(await h.call('a', 'complete', done)).toMatchObject({ ok: false })
    expect(await h.call('b', 'complete', { ...done, claim: 'wrong' })).toMatchObject({ ok: false, code: 'invalid-state' })
    const completed = message(await h.call('b', 'complete', done))
    expect(completed.processingStatus).toBe('completed')
    expect(message(await h.call('b', 'complete', done))).toEqual(completed)
    expect(await h.call('b', 'inbox', {})).toMatchObject({ ok: true, result: { messages: [] } })
    expect(await h.call('b', 'inbox', { state: 'all' })).toMatchObject({ ok: true, result: { messages: [{ messageId: m.messageId }] } })
  })
  it('blocked remains open; replying is a new unacknowledged message', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    const blocked = message(await h.call('b', 'ack', { message: m.messageId, state: 'blocked', revision: String(m.revision), note: 'waiting', 'request-id': 'ack' }))
    expect(blocked.processingStatus).toBe('blocked')
    const reply = message(await h.call('b', 'reply', { node: 'a', text: 'need input', 'request-id': 'reply1', 'in-reply-to': m.messageId }))
    expect(reply.messageId).not.toBe(m.messageId)
    expect(reply.processingStatus).toBe('unacknowledged')
    expect(message(await h.call('b', 'read', { message: m.messageId })).processingStatus).toBe('blocked')
  })
  it('rejects unknown identities, foreign inboxes, revoked grants and replacement sessions', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    expect(await h.mail.control('a', false, 'send', send)).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(await h.call('c', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.call('c', 'send', { ...send, 'request-id': 'foreign' })).toMatchObject({ ok: false })
    h.sessions.b = 'replacement'
    expect(await h.call('b', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.call('b', 'inbox', {})).toMatchObject({ ok: true, result: { messages: [] } })
    h.revoke()
    expect(await h.call('a', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-permitted' })
  })
  it('never adopts a replacement target while queued', async () => {
    const h = harness()
    transport.mockResolvedValueOnce({ kind: 'targetBusy', state: 'working' })
    const m = message(await h.call('a', 'send', send))
    h.sessions.b = 'other'
    await h.mail.onTargetBoundary('b')
    expect(h.writes()).toBe(0)
    expect(message(await h.call('a', 'read', { message: m.messageId })).deliveryStatus).toBe('failed')
  })
  it.each(['stalled', 'deliveredToReplacedTarget', 'targetGone'])('does not automatically repeat %s after a possible write', async kind => {
    const h = harness()
    transport.mockImplementationOnce(async (req, deps) => {
      await deps.sendEnvelope(req.targetNodeId, req.body, {})
      return { kind } as AgentMessageOutcome
    })
    const m = message(await h.call('a', 'send', send))
    expect(m.deliveryStatus).toBe('uncertain')
    await h.mail.onTargetBoundary('b')
    const restored = harness(h.disk())
    await restored.mail.onTargetBoundary('b')
    expect(h.writes()).toBe(1); expect(restored.writes()).toBe(0)
  })
  it('recovers an interrupted attempt as uncertain and never retries it', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    const disk = h.disk(); disk[0].attempting = true; disk[0].message.deliveryStatus = 'pending'
    const restored = harness(disk)
    await restored.mail.onTargetBoundary('b')
    expect(message(await restored.call('a', 'read', { message: m.messageId })).deliveryStatus).toBe('uncertain')
    expect(restored.writes()).toBe(0)
  })
  it('does not acknowledge admission or write to a pane when storage fails', async () => {
    const h = harness(); h.fail()
    expect(await h.call('a', 'send', send)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(h.writes()).toBe(0); expect(h.disk()).toHaveLength(0)
  })
  it('keeps unsupported host refusal explicit and never claims a landed or processed message', async () => {
    const h = harness()
    transport.mockResolvedValueOnce({ kind: 'notPermitted', reason: 'unsupported-host' })
    const reply = await h.call('a', 'send', send)
    const m = message(reply)
    expect(reply).toMatchObject({ message: expect.stringContaining('unsupported-host: envelope-surface-v2 was not proven') })
    expect(m).toMatchObject({ deliveryStatus: 'failed', deliveryReason: 'unsupported-host', processingStatus: 'unacknowledged' })
    expect(h.writes()).toBe(0)
    expect(vi.mocked(h.deps.onHandover!).mock.calls.some(([e]) => e.phase === 'landed')).toBe(false)
  })
  it('read-only desktop API cannot execute an ack through extra request fields', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    const view = await h.mail.desktopView({ nodeId: 'b', messageId: m.messageId, verb: 'ack' } as never)
    expect(message(view).processingStatus).toBe('unacknowledged')
  })
  it('preserves an ACK made while a transport receipt is pending, with one handover settlement', async () => {
    const h = harness()
    let wrote!: () => void, finish!: () => void
    const written = new Promise<void>(resolve => { wrote = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    transport.mockImplementationOnce(async (req, deps) => {
      await deps.sendEnvelope(req.targetNodeId, req.body, {})
      wrote(); await finished
      return { kind: 'delivered', traceId: 't', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
    })
    const sending = h.call('a', 'send', send)
    await written
    const current = h.disk()[0].message
    const accepted = message(await h.call('b', 'ack', { message: current.messageId, state: 'accepted',
      revision: String(current.revision), note: 'working', 'request-id': 'ack-during-write' }))
    finish()
    const delivered = message(await sending)
    expect(delivered.processingStatus).toBe('accepted')
    expect(delivered.claimId).toBe(accepted.claimId)
    expect(delivered.deliveryStatus).toBe('delivered')
    expect(vi.mocked(h.deps.onHandover!).mock.calls.filter(([e]) => e.phase === 'settled')).toHaveLength(1)
  })
  it('refuses new work at quota while reserving space to finish an accepted message', async () => {
    const h = harness()
    transport.mockResolvedValue({ kind: 'targetBusy', state: 'working' })
    const first = message(await h.call('a', 'send', send))
    let quota = false
    for (let i = 0; i < 512; i++) {
      const r = await h.call('a', 'send', { ...send, 'request-id': `more-${i}` })
      if (!r.ok) { expect(r.code).toBe('quota-exceeded'); quota = true; break }
    }
    expect(quota).toBe(true)
    const count = h.disk().length
    const accepted = message(await h.call('b', 'ack', { message: first.messageId, state: 'accepted',
      revision: String(first.revision), note: 'x'.repeat(4096), 'request-id': 'full-ack' }))
    const done = message(await h.call('b', 'complete', { message: first.messageId, outcome: 'done',
      revision: String(accepted.revision), claim: accepted.claimId!, note: 'complete', 'request-id': 'full-done' }))
    expect(done.processingStatus).toBe('completed')
    expect(h.disk()).toHaveLength(count)
  })
  it('admits new open work alongside a thousand immutable closed history records', async () => {
    const original = harness(), first = message(await original.call('a', 'send', send))
    const ack = message(await original.call('b', 'ack', { message: first.messageId, state: 'accepted',
      revision: String(first.revision), note: 'history', 'request-id': 'history-ack' }))
    await original.call('b', 'complete', { message: first.messageId, outcome: 'done', claim: ack.claimId!,
      revision: String(ack.revision), note: 'complete', 'request-id': 'history-done' })
    const template = original.disk()[0]
    const history = Array.from({ length: 1000 }, (_, i) => {
      const r = structuredClone(template)
      r.sendKey = `history-${i}`; r.message.idempotencyKey = r.sendKey; r.message.messageId = `mail-history-${i}`
      return r
    })
    const restored = harness(history)
    transport.mockResolvedValue({ kind: 'targetBusy', state: 'working' })
    expect(message(await restored.call('a', 'send', send)).processingStatus).toBe('unacknowledged')
    expect(restored.disk()).toHaveLength(1001)
    expect(restored.disk().slice(0, 1000)).toEqual(history)
  })
  it('refuses a failed attempt commit without writing, and keeps the durable admission', async () => {
    const h = harness()
    transport.mockImplementationOnce(async (req, deps) => { h.fail(); return deps.sendEnvelope(req.targetNodeId, req.body, {}) })
    expect(await h.call('a', 'send', send)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(h.disk()).toHaveLength(1)
    expect(h.disk()[0].message.deliveryStatus).toBe('pending')
    expect(h.writes()).toBe(0)
  })
  it('a repeated old ACK after completion returns current state without reopening the message', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    const args = { message: m.messageId, state: 'accepted', revision: String(m.revision), note: 'ok', 'request-id': 'ack1' }
    const ack = message(await h.call('b', 'ack', args))
    const done = message(await h.call('b', 'complete', { message: m.messageId, outcome: 'done',
      revision: String(ack.revision), claim: ack.claimId!, note: 'verified', 'request-id': 'done1' }))
    expect(message(await h.call('b', 'ack', args))).toEqual(done)
  })
  it('fails closed without replacing a store that could not be loaded', async () => {
    const commit = vi.fn()
    const h = harness()
    const mail = new AgentMailbox({ load: async () => { throw new Error('corrupt') }, commit }, h.deps)
    expect(await mail.control('a', true, 'send', send)).toMatchObject({ ok: false, code: 'store-unavailable' })
    expect(commit).not.toHaveBeenCalled()
  })
  it.each([
    { removed: 'b', actor: 'a', box: 'outbox' },
    { removed: 'a', actor: 'b', box: 'inbox' }
  ])('keeps historical $box/read for the unchanged party after $removed is deleted', async ({ removed, actor, box }) => {
    const h = harness()
    transport.mockResolvedValueOnce({ kind: 'targetBusy', state: 'working' })
    const m = message(await h.call('a', 'send', send))
    h.remove(removed)
    expect(await h.call(actor, box, {})).toMatchObject({ ok: true, result: { messages: [{ messageId: m.messageId }] } })
    expect(message(await h.call(actor, 'read', { message: m.messageId }))).toEqual(m)
    expect(message(await h.mail.desktopView({ nodeId: actor, messageId: m.messageId }))).toEqual(m)
    await h.mail.onTargetBoundary('b')
    expect(h.writes()).toBe(0)
    expect(message(await h.call(actor, 'read', { message: m.messageId })).processingStatus).toBe('unacknowledged')
    expect(message(await h.call(actor, 'read', { message: m.messageId })).deliveryStatus).toBe('failed')
    expect(await h.call(removed, 'read', { message: m.messageId })).toMatchObject({ ok: false })
    h.revoke()
    expect(await h.call(actor, 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-permitted' })
  })
  it('recipient can explicitly process existing work after sender deletion', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    h.remove('a')
    const ack = message(await h.call('b', 'ack', { message: m.messageId, state: 'accepted',
      revision: String(m.revision), note: 'own retained task', 'request-id': 'retained-ack' }))
    expect(message(await h.call('b', 'complete', { message: m.messageId, outcome: 'done', claim: ack.claimId!,
      revision: String(ack.revision), note: 'finished', 'request-id': 'retained-done' })).processingStatus).toBe('completed')
  })
  it('historical visibility never follows the reading actor across a project or session change', async () => {
    const h = harness(), m = message(await h.call('a', 'send', send))
    h.remove('b'); h.sessions.a = 'new-source-session'
    expect(await h.call('a', 'outbox', {})).toMatchObject({ ok: true, result: { messages: [] } })
    expect(await h.call('a', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
    h.sessions.a = 'sa'; h.move('a', 'foreign')
    expect(await h.call('a', 'outbox', {})).toMatchObject({ ok: true, result: { messages: [] } })
    expect(await h.call('a', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
  })
  it('retains mail when the other party moves, without granting a peer access or dispatch rights', async () => {
    const h = harness()
    transport.mockResolvedValueOnce({ kind: 'targetBusy', state: 'working' })
    const m = message(await h.call('a', 'send', send))
    h.move('b', 'foreign'); h.move('c', 'p')
    expect(message(await h.call('a', 'read', { message: m.messageId })).messageId).toBe(m.messageId)
    expect(await h.call('c', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.call('c', 'outbox', {})).toMatchObject({ ok: true, result: { messages: [] } })
    expect(await h.call('b', 'read', { message: m.messageId })).toMatchObject({ ok: false, code: 'not-found' })
    await h.mail.onTargetBoundary('b')
    expect(h.writes()).toBe(0)
  })
})
