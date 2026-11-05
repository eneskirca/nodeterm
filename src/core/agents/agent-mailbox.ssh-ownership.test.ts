import { expect, it, vi } from 'vitest'
import { AgentMailbox } from './agent-mailbox'
import { runDelivery, type AgentMessagingDeps } from './agent-messaging'
import type { EnvelopeWriteAccess } from './agent-message-operation'
import type { PaneOperationContext, PaneOperationProof, PaneOperationPurpose } from './pane-operation-proof'
import type { MailboxStoredMessage } from './agent-mailbox-store'
import type { MailboxReply, MailboxMessage } from '../../shared/agents/agent-mailbox'
vi.mock('./agent-messaging', async original => ({ ...(await original<typeof import('./agent-messaging')>()),
  runDelivery: vi.fn(async () => ({ kind: 'targetBusy', state: 'working' })) }))
const party = (nodeId: string) => ({ nodeId, projectId: 'p', agentId: 'codex', sessionId: `s-${nodeId}` })
function fixture() {
  let grant = true, valid = true, sessions: Record<string, string> = { a: 's-a', b: 's-b' }, nodes = [{ id: 'a' }, { id: 'b' }]
  let disk: MailboxStoredMessage[] = [{ sendKey: 'old-key', fingerprint: 'a'.repeat(64), mutations: [], message: {
    messageId: 'old-mail', idempotencyKey: 'old-key', revision: 1, source: party('a'), target: party('b'), body: 'SYNTHETIC-PRIVATE-SSH-MAIL',
    deliveryStatus: 'delivered', processingStatus: 'unacknowledged', createdAt: 1, updatedAt: 1 } }]
  const run = vi.fn(async () => { throw new Error('permission test must not execute transport') })
  const revalidate = vi.fn(async () => valid)
  const acquire = vi.fn(async (expected: Readonly<PaneOperationContext>, _purpose: PaneOperationPurpose): Promise<PaneOperationProof | null> => ({
    context: { ...expected }, evidenceKey: `complete-${expected.nodeId}`, transportKey: `exact-mux-${expected.nodeId}`, revalidate, runExisting: run }))
  const sync = vi.fn(() => { throw new Error('SSH sync owner cache is NOT authority') })
  const commit = vi.fn(async (next: readonly MailboxStoredMessage[]) => { disk = structuredClone([...next]) })
  const deps = { projects: () => [{ id: 'p', nodes }], isRemoteNode: () => true,
    mirrorEntry: (id: string) => ({ stateVerified: true, state: 'done', updatedAt: 1, agentId: 'codex', sessionId: sessions[id],
      stateIdentity: { agentId: 'codex', sessionId: sessions[id] } }), paneOwnerProject: sync,
    messagingEnabled: () => grant, acquirePaneOwnership: acquire, now: () => 1000
  } as unknown as AgentMessagingDeps
  const mail = new AgentMailbox({ load: async () => structuredClone(disk), commit }, deps)
  const call = (actor: string, verb: string, args: Record<string, string> = {}) => mail.control(actor, true, verb, args)
  return { mail, call, deps, acquire, revalidate, run, sync, commit, disk: () => disk, revoke: () => { grant = false },
    invalidate: () => { valid = false }, replace: (id: string) => { sessions[id] = 'replacement' }, remove: (id: string) => { nodes = nodes.filter(n => n.id !== id) } }
}
const message = (r: MailboxReply): MailboxMessage => {
  expect(r.ok).toBe(true)
  if (!r.ok || !('message' in r.result)) throw new Error('expected message')
  return r.result.message
}
it('every inbox/outbox/read/UI read gets a new operation, never a sync SSH owner', async () => {
  const f = fixture()
  expect(await f.call('b', 'inbox')).toMatchObject({ ok: true, result: { messages: [{ messageId: 'old-mail' }] } })
  expect(await f.call('a', 'outbox')).toMatchObject({ ok: true, result: { messages: [{ messageId: 'old-mail' }] } })
  expect(message(await f.call('b', 'read', { message: 'old-mail' })).body).toBe('SYNTHETIC-PRIVATE-SSH-MAIL')
  expect(await f.mail.desktopView({ nodeId: 'b', messageId: 'old-mail' })).toMatchObject({ ok: true })
  expect(f.acquire).toHaveBeenCalledTimes(4)
  expect(f.acquire.mock.calls.every(([, purpose]) => purpose === 'read')).toBe(true)
  expect(f.sync).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
})
it.each(['missing', 'null', 'throw', 'invalid'] as const)('SSH %s refuses despite cached project/provider state', async failure => {
  const f = fixture()
  if (failure === 'missing') delete f.deps.acquirePaneOwnership
  if (failure === 'null') f.acquire.mockResolvedValue(null)
  if (failure === 'throw') f.acquire.mockRejectedValue(new Error('unknown endpoint'))
  if (failure === 'invalid') f.invalidate()
  expect(await f.call('b', 'read', { message: 'old-mail' })).toMatchObject({ ok: false, code: 'not-permitted' })
  expect(f.commit).not.toHaveBeenCalled(); expect(f.sync).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
})
it.each(['revoke', 'replace'] as const)('a %s during acquire cannot authorize the replacement', async failure => {
  const f = fixture(), acquire = f.acquire.getMockImplementation()!
  f.acquire.mockImplementationOnce(async (...args) => { const p = await acquire(...args); if (failure === 'replace') f.replace('b'); else f.revoke(); return p })
  expect(await f.call('b', 'ack', { message: 'old-mail', revision: '1', state: 'accepted', note: 'no', 'request-id': 'bad-claim' }))
    .toMatchObject({ ok: false, code: 'not-permitted' })
  expect(f.commit).not.toHaveBeenCalled()
})
it('historical own mail remains readable/processable after counterparty removal with fresh Actor proof', async () => {
  const f = fixture(); f.remove('a')
  const read = message(await f.call('b', 'read', { message: 'old-mail' }))
  const ack = message(await f.call('b', 'ack', { message: read.messageId, revision: String(read.revision), state: 'accepted', note: 'own task', 'request-id': 'claim' }))
  const done = message(await f.call('b', 'complete', { message: ack.messageId, revision: String(ack.revision), claim: ack.claimId!, outcome: 'done', note: 'done', 'request-id': 'done' }))
  expect(done.processingStatus).toBe('completed')
  expect(f.acquire.mock.calls.map(([, purpose]) => purpose)).toEqual(['read', 'ack', 'complete'])
  f.invalidate()
  expect(await f.call('b', 'read', { message: 'old-mail' })).toMatchObject({ ok: false })
})
it('a send binds both parties and refuses a changed target across source authorization', async () => {
  const f = fixture(), acquire = f.acquire.getMockImplementation()!
  f.acquire.mockImplementation(async (...args) => { const p = await acquire(...args); if (args[1] === 'send-source') f.replace('b'); return p })
  expect(await f.call('a', 'send', { node: 'b', text: 'new', 'request-id': 'send' })).toMatchObject({ ok: false })
  expect(f.commit).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
})
it('dispatch forwards the exact operation guard and target transport through the durable attempt wrapper', async () => {
  const f = fixture()
  const proof = (await f.acquire(party('b'), 'deliver'))!
  const access: EnvelopeWriteAccess = { remoteProof: proof, beforeWrite: vi.fn(async () => true) }
  f.deps.sendEnvelope = vi.fn(async (_node, _body, _expected, received) => {
    expect(received).toBe(access)
    expect(await received!.beforeWrite()).toBe(true)
    return true
  })
  vi.mocked(runDelivery).mockImplementationOnce(async (req, deps) => {
    expect(await deps.beforeWrite!()).toBe(true)
    await deps.sendEnvelope(req.targetNodeId, 'SYNTHETIC ENVELOPE', undefined, access)
    return { kind: 'delivered', traceId: 'synthetic', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
  })
  expect(await f.call('a', 'send', { node: 'b', text: 'new', 'request-id': 'guard-handoff' })).toMatchObject({ ok: true })
  expect(f.deps.sendEnvelope).toHaveBeenCalledTimes(1)
  expect(f.disk().find(r => r.sendKey === 'guard-handoff')?.message.deliveryStatus).toBe('delivered')
})
