import { beforeEach, expect, it, vi } from 'vitest'
import { AgentMailbox } from './agent-mailbox'
import type { AgentMessagingDeps } from './agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { MailboxStoredMessage } from './agent-mailbox-store'

// The real runDelivery/decider/envelope/receipt chain, with no token files or real profile mirror.
vi.mock('./node-token-files', () => ({ nodeTokenFilePresent: () => true }))
vi.mock('../agent-status-mirror', () => ({ mirrorEntry: () => { throw new Error('global mirror forbidden') } }))
beforeEach(() => { resetMessageFlow(); resetAgentMessageTraceForTests() })

it('uses actual delivery gates, a framed envelope and a verified receipt without claiming the mail', async () => {
  let disk: MailboxStoredMessage[] = [], busy = true
  const sent: string[] = []
  let receipt: ((event: { nodeId: string; newTurn: boolean; verified: boolean }) => void) | undefined
  const deps: AgentMessagingDeps = {
    projects: () => [{ id: 'p', nodes: [{ id: 'a', agentId: 'claude' }, { id: 'b', agentId: 'claude' }] }],
    paneOwnerProject: () => 'p', messagingEnabled: () => true,
    mirrorEntry: id => ({ sessionId: `s-${id}`, agentId: 'claude', stateVerified: true,
      stateIdentity: { sessionId: `s-${id}`, agentId: 'claude' },
      state: busy && id === 'b' ? 'working' : 'done', updatedAt: 1, clientRevision: MANAGED_SCRIPT_REVISION }),
    hasLiveSession: () => true, isRemoteNode: () => false, customAgents: () => undefined,
    paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude', argv: ['claude'], pids: [200] }),
    appendBoardLog: async () => false,
    subscribeReceipts: cb => { receipt = cb; return () => { receipt = undefined } },
    now: () => 1_000_000,
    sendEnvelope: async (_node, text) => {
      expect(disk[0].attempting).toBe(true)
      sent.push(text)
      receipt?.({ nodeId: 'b', newTurn: true, verified: true })
      return true
    }
  }
  const mail = new AgentMailbox({ load: async () => [], commit: async records => { disk = structuredClone([...records]) } }, deps)
  const accepted = await mail.control('a', true, 'send', { node: 'b', text: 'work\n$(touch /tmp/forbidden); `no`', 'request-id': 'one' })
  expect(accepted).toMatchObject({ ok: true, result: { deliveryStatus: 'queued', processingStatus: 'unacknowledged' } })
  expect(sent).toHaveLength(0)
  busy = false
  await mail.onTargetBoundary('b')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatch(/^--- NODETERM MESSAGE /)
  expect(sent[0]).toContain(`Agent mail ${disk[0].message.messageId}`)
  expect(sent[0]).toContain('$(touch /tmp/forbidden); `no`')
  expect(disk[0].message.deliveryStatus).toBe('delivered')
  expect(disk[0].message.processingStatus).toBe('unacknowledged')
  await mail.onTargetBoundary('b')
  expect(sent).toHaveLength(1)
})
