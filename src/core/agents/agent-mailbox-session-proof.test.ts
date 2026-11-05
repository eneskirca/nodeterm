import { beforeEach, expect, it, vi } from 'vitest'
import { AgentMailbox } from './agent-mailbox'
import { reduceEntry, buildFile, type MirrorEntry } from '../agent-status-mirror'
import { normalizeClaude, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { resetMessageFlow } from './agent-message-flow'
import type { AgentMessagingDeps } from './agent-messaging'
import type { MailboxStoredMessage } from './agent-mailbox-store'
import type { MailboxReply, MailboxMessage } from '../../shared/agents/agent-mailbox'
vi.mock('./node-token-files', () => ({ nodeTokenFilePresent: () => true }))
const event = (sessionId: string, state: 'working' | 'done', more: Partial<NormalizedAgentEvent> = {}): NormalizedAgentEvent =>
  ({ nodeId: 'b', agentId: 'claude', sessionId, state, kind: 'state', verified: true, clientRevision: MANAGED_SCRIPT_REVISION, ...more }) as NormalizedAgentEvent
const message = (r: MailboxReply): MailboxMessage => {
  expect(r.ok).toBe(true)
  if (!r.ok || !('message' in r.result)) throw new Error('expected message')
  return r.result.message
}
beforeEach(() => resetMessageFlow())

it('unverified ignored idle_prompt cannot transfer old-session read, ACK or completion rights', async () => {
  let disk: MailboxStoredMessage[] = []
  const mirror: Record<string, MirrorEntry> = {
    a: reduceEntry(undefined, event('source', 'working', { nodeId: 'a' }), 1000),
    b: reduceEntry(undefined, event('old-session', 'working'), 1000)
  }
  const write = vi.fn(async () => true)
  const deps: AgentMessagingDeps = {
    projects: () => [{ id: 'p', nodes: [{ id: 'a', agentId: 'claude' }, { id: 'b', agentId: 'claude' }] }],
    mirrorEntry: id => mirror[id], paneOwnerProject: () => 'p', messagingEnabled: () => true,
    hasLiveSession: () => true, isRemoteNode: () => false, customAgents: () => undefined,
    paneOwner: vi.fn(async () => null), sendEnvelope: write, appendBoardLog: async () => false, now: () => 2000
  }
  const mail = new AgentMailbox({ load: async () => [], commit: async rows => { disk = structuredClone([...rows]) } }, deps)
  const m = message(await mail.control('a', true, 'send', { node: 'b', text: 'SYNTHETIC-OLD-SESSION-PRIVATE', 'request-id': 'old-mail' }))
  expect(message(await mail.control('b', true, 'read', { message: m.messageId })).body).toBe(m.body)
  mirror.b = reduceEntry(mirror.b, event('new-session', 'done'), 3000)
  expect((await mail.control('b', true, 'read', { message: m.messageId })).ok).toBe(false)
  const normalized = normalizeClaude({ nodeId: 'b', agentId: 'claude', payload: {
    hook_event_name: 'Notification', notification_type: 'idle_prompt', session_id: 'old-session'
  } })!
  mirror.b = reduceEntry(mirror.b, { ...normalized, verified: false }, 4000)
  // Display labels deliberately retain their tolerant contract; they are not session proof.
  expect(mirror.b).toMatchObject({ sessionId: 'old-session', stateVerified: true,
    stateIdentity: { sessionId: 'new-session', agentId: 'claude' } })
  for (const [verb, args] of [
    ['read', { message: m.messageId }],
    ['ack', { message: m.messageId, state: 'accepted', revision: String(m.revision), note: 'forged', 'request-id': 'forged-ack' }],
    ['complete', { message: m.messageId, outcome: 'done', revision: String(m.revision), claim: 'forged', note: 'forged', 'request-id': 'forged-done' }]
  ] as const) expect((await mail.control('b', true, verb, args)).ok).toBe(false)
  mirror.b = reduceEntry(mirror.b, event('', 'done', { sessionId: undefined }), 5000)
  expect((await mail.control('b', true, 'read', { message: m.messageId })).ok).toBe(false)
  expect(disk[0].message.processingStatus).toBe('unacknowledged')
  expect(write).not.toHaveBeenCalled()
})

it('session proof is committed with state, cleared on missing/unverified proof and never persisted', () => {
  const proven = reduceEntry(undefined, event('s-new', 'done'), 1000)
  expect(proven.stateIdentity).toEqual({ sessionId: 's-new', agentId: 'claude' })
  const displayOnly = reduceEntry(proven, event('s-old', 'working', { kind: 'subagent-start', verified: false }), 2000)
  expect(displayOnly.stateIdentity).toEqual(proven.stateIdentity)
  expect(displayOnly.sessionId).toBe('s-old')
  const absent = reduceEntry(displayOnly, event('', 'done', { sessionId: undefined }), 3000)
  expect(absent.stateVerified).toBe(true)
  expect(absent.stateIdentity).toBeUndefined()
  expect(reduceEntry(proven, event('s-new', 'done', { verified: false }), 4000).stateIdentity).toBeUndefined()
  expect(reduceEntry(proven, event('s-new', 'done', { kind: 'session', sessionPhase: 'end' }), 4000).stateIdentity).toBeUndefined()
  expect(buildFile({ b: proven }, 1000).nodes.b).not.toHaveProperty('stateIdentity')
})
