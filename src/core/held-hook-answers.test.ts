import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude } from '../shared/agents/normalize'
import { _resetForTest, _inboxSnapshot, _snapshot, recordAgentEvent, recordRawToolEvent,
  hookTicketStillOpen, onNodeStateChange, type NodeStateChange } from './agent-status-mirror'

const questions = [
  { question: 'Which languages?', header: 'Languages', multiSelect: true, options: [{ label: 'Kotlin', description: 'Phone' }, { label: 'TypeScript', description: 'Host' }] },
  { question: 'Where?', header: 'Place', multiSelect: false, options: [{ label: 'Here', description: '' }, { label: 'There', description: '' }] }
]
function hook(extra: Record<string, unknown>) {
  const payload = { hook_event_name: 'PreToolUse', session_id: 'parent', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1', tool_input: { questions }, ...extra }
  recordRawToolEvent('node', payload)
  const event = normalizeClaude({ nodeId: 'node', agentId: 'claude', payload })
  if (event) recordAgentEvent({ ...event, verified: true })
}
beforeEach(() => { _resetForTest(); vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => { _resetForTest(); vi.useRealTimers() })
describe('held hook reply producer compatibility', () => {
  it('publishes full held questions while an old Inbox or push consumer receives no numbered actions', () => {
    const live: NodeStateChange[] = []
    onNodeStateChange(e => live.push(e))
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100000-42' })
    const card = _inboxSnapshot().events[0]
    expect(card).toMatchObject({ kind: 'question', questionPendingId: 'node-100000-42', questions })
    expect(card.options).toBeUndefined()
    expect(card.multiSelect).toBeUndefined()
    expect(card.pendingId).toBeUndefined()
    expect(live.find(e => e.state === 'needsYou')).toMatchObject({ kind: 'question' })
    expect(live.find(e => e.state === 'needsYou')?.options).toBeUndefined()
    expect(hookTicketStillOpen('node', 'node-100000-42', 'question')).toBe(true)
    expect(hookTicketStillOpen('other', 'node-100000-42', 'question')).toBe(false)
    expect(hookTicketStillOpen('node', 'node-100000-42', 'approval')).toBe(false)
  })
  it('preserves legacy unheld numbered choices and read-only multi-select indication', () => {
    hook({})
    expect(_inboxSnapshot().events[0]).toMatchObject({ options: ['Kotlin', 'TypeScript'], multiSelect: true })
    expect(_inboxSnapshot().events[0].questionPendingId).toBeUndefined()
  })
  it('does not expose legacy digit actions for a held schema it cannot answer', () => {
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100000-42', tool_input: { questions: [{ ...questions[0], header: undefined }] } })
    const card = _inboxSnapshot().events[0]
    expect(card.questionPendingId).toBe('node-100000-42')
    expect(card.questions).toBeUndefined()
    expect(card.options).toBeUndefined()
    expect(hookTicketStillOpen('node', 'node-100000-42', 'question')).toBe(false)
  })
  it('correlates the hook answer with its actual question and rejects a settled ticket', () => {
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100000-42' })
    hook({ nodeterm_answered: 'allow', nodeterm_pending_id: 'node-100000-42' })
    expect(_snapshot().node.state).toBe('working')
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
    expect(hookTicketStillOpen('node', 'node-100000-42', 'question')).toBe(false)
  })
  it('gives identical text on a new held ticket a distinct card instead of reusing the stale request', () => {
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100000-42' })
    hook({ nodeterm_answered: 'allow', nodeterm_pending_id: 'node-100000-42' })
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100001-43', tool_use_id: 'tool-2' })
    expect(_inboxSnapshot().events).toHaveLength(2)
    expect(_inboxSnapshot().events.filter(e => !e.resolved).map(e => e.questionPendingId)).toEqual(['node-100001-43'])
  })
  it('offers only host-derived concrete approval rules while child approvals remain independently answerable', () => {
    hook({ nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100000-42' })
    hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: 'child', nodeterm_hook_reply: 2, nodeterm_pending_id: 'node-100001-43',
      permission_suggestions: [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] })
    const approval = _inboxSnapshot().events.find(e => e.kind === 'approval')!
    expect(approval.permissionSuggestions).toEqual([{ index: 0, label: 'Bash(npm test) — session' }])
    expect(hookTicketStillOpen('node', 'node-100001-43', 'approval')).toBe(true)
    expect(hookTicketStillOpen('node', 'node-100000-42', 'question')).toBe(true)
  })
})
