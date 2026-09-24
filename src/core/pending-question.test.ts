import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude } from '../shared/agents/normalize'
import { parseToolResultIds } from './context-tail'
import { subagentReplay } from './subagent-replay'
import { _resetForTest, _snapshot, _inboxSnapshot, recordAgentEvent, recordRawToolEvent,
  recordQuestionResult, ignoreQuestionHook, STASH_MAX_AGE_MS, sweepStaleWorking } from './agent-status-mirror'

function hook(hook_event_name: string, extra: Record<string, unknown> = {}) {
  const payload = { hook_event_name, session_id: 'parent', ...extra }
  recordRawToolEvent('node', payload)
  const event = normalizeClaude({ nodeId: 'node', agentId: 'claude', payload })
  return event ? recordAgentEvent({ ...event, verified: true }) : null
}
function ask(id = 'ask-1') {
  return hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: id,
    tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } })
}
beforeEach(() => { _resetForTest(); vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => { _resetForTest(); vi.useRealTimers() })

describe('Claude pending question correlation (#821)', () => {
  it('keeps attention and the inbox open through unrelated and child activity beyond stash freshness', () => {
    ask()
    vi.setSystemTime(Date.now() + STASH_MAX_AGE_MS + 1)
    for (const extra of [{ tool_name: 'Bash' }, { tool_name: 'Read', session_id: 'child' }]) {
      expect(hook('PreToolUse', extra)?.state).toBe('waiting')
    }
    expect(ignoreQuestionHook('node', { session_id: 'child' })).toBe(true)
    expect(ignoreQuestionHook('node', { session_id: 'parent' })).toBe(false)
    expect(hook('PreToolUse', { tool_name: 'Bash', agent_id: 'child' })).toBeNull()
    expect(hook('Stop')?.state).toBe('waiting')
    expect(hook('Notification', { notification_type: 'permission_prompt' })?.state).toBe('waiting')
    expect(hook('UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' })?.state).toBe('waiting')
    sweepStaleWorking(Date.now() + 30 * 60000)
    expect(_snapshot().node).toMatchObject({ state: 'waiting', sessionId: 'parent' })
    expect(_inboxSnapshot().events).toHaveLength(1)
    expect(_inboxSnapshot().events[0].resolved).not.toBe(true)
  })

  it('matches session and tool ID for hooks, including a delayed answer to an older question', () => {
    ask()
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'other' })?.state).toBe('waiting')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', session_id: 'child' })?.state).toBe('waiting')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1' })?.state).toBe('working')
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
    ask('ask-2')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1' })?.state).toBe('waiting')
  })

  it.each(['User declined to answer questions', 'A'])('rescues the matching transcript result: %s', content => {
    ask()
    const ids = parseToolResultIds(JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'unrelated', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ask-1', content }
    ] } }))
    expect(ids).toEqual(['unrelated', 'ask-1'])
    expect(recordQuestionResult('node', 'parent', ids[0])).toBeUndefined()
    expect(recordQuestionResult('node', 'other-session', ids[1])).toBeUndefined()
    expect(recordQuestionResult('node', 'parent', ids[1])?.state).toBe('working')
    expect(recordQuestionResult('node', 'parent', ids[1])).toBeUndefined()
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it.each(['UserPromptSubmit', 'SessionEnd', 'SessionStart', 'Stop'])('allows explicit reset: %s', event => {
    ask()
    hook(event, { is_interrupt: true, ...(event === 'SessionStart' ? { session_id: 'new' } : {}) })
    expect(_snapshot().node.pendingQuestion).toBeUndefined()
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it('does not let a transcript result dismiss an approval without a tracked question', () => {
    hook('PermissionRequest', { tool_name: 'Bash' })
    expect(recordQuestionResult('node', 'parent', 'tool')).toBeUndefined()
    expect(_snapshot().node.state).toBe('blocked')
  })
})

describe('subagent attention forwarding (W2)', () => {
  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('filters child %s without changing a blocked parent', event => {
    hook('PermissionRequest', { tool_name: 'Bash' })
    expect(hook(event, { agent_id: 'child', tool_name: 'Bash' })).toBeNull()
    expect(_snapshot().node.state).toBe('blocked')
  })

  it.each(['allow', 'deny'])('forwards a child approval ticket, summary and %s reply', decision => {
    const approval = { agent_id: 'child', tool_name: 'Bash', tool_input: { command: 'echo child' }, nodeterm_pending_id: 'node-1-1' }
    expect(hook('PermissionRequest', approval)).toMatchObject({ state: 'blocked', pendingId: 'node-1-1', askKind: 'approval' })
    expect(_inboxSnapshot().events[0]).toMatchObject({ kind: 'approval', pendingId: 'node-1-1' })
    expect(_inboxSnapshot().events[0].resolved).not.toBe(true)
    expect(JSON.stringify(_inboxSnapshot().events[0])).toContain('echo child')
    expect(hook('PermissionRequest', { ...approval, nodeterm_answered: decision })).toMatchObject({ state: 'working', pendingId: 'node-1-1' })
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it.each(['allow', 'deny'])('keeps the parent picker while concurrent child approvals receive %s replies', decision => {
    ask()
    const question = _inboxSnapshot().events[0]
    const approval = { agent_id: 'child', session_id: 'child-session', tool_name: 'Bash',
      tool_input: { command: 'echo child' }, nodeterm_pending_id: 'ticket-1' }
    const request = (ticket: string) => hook('PermissionRequest', { ...approval, nodeterm_pending_id: ticket })
    expect(request('ticket-1')).toMatchObject({ state: 'waiting', sessionId: 'parent',
      pendingId: 'ticket-1', askKind: 'approval' })
    request('ticket-1') // A reassertion must not duplicate the card.
    request('ticket-2') // Identical commands may be waiting on distinct tickets.
    const cards = _inboxSnapshot().events
    expect(cards).toHaveLength(3)
    expect(cards.filter(e => !e.resolved)).toHaveLength(3)
    for (const pendingId of ['ticket-1', 'ticket-2']) {
      expect(cards.find(e => e.pendingId === pendingId)).toMatchObject({ kind: 'approval' })
      expect(JSON.stringify(cards.find(e => e.pendingId === pendingId))).toContain('echo child')
      expect(cards.find(e => e.pendingId === pendingId)?.options).toBeUndefined()
    }
    expect(hook('PermissionRequest', { ...approval, nodeterm_answered: decision })).toMatchObject({
      state: 'waiting', sessionId: 'parent', askKind: 'question' })
    expect(_inboxSnapshot().events.find(e => e.pendingId === 'ticket-1')?.resolved).toBe(true)
    expect(_inboxSnapshot().events.find(e => e.pendingId === 'ticket-2')?.resolved).not.toBe(true)
    expect(_inboxSnapshot().events.find(e => e.id === question.id)?.resolved).not.toBe(true)
    expect(_snapshot().node.pendingQuestion).toEqual({ sessionId: 'parent', toolUseId: 'ask-1' })
    hook('PermissionRequest', { ...approval, nodeterm_pending_id: 'ticket-2', nodeterm_answered: decision })
    expect(_inboxSnapshot().events.filter(e => !e.resolved).map(e => e.id)).toEqual([question.id])
    expect(recordQuestionResult('node', 'parent', 'ask-1')?.state).toBe('working')
    expect(_inboxSnapshot().events.every(e => e.resolved)).toBe(true)
  })

  it.each(['allow', 'deny'])('keeps approval tickets actionable when the parent answers first (%s)', decision => {
    ask()
    const approval = { agent_id: 'child', session_id: 'child-session', tool_name: 'Bash',
      tool_input: { command: 'echo child' }, nodeterm_pending_id: 'ticket-1' }
    hook('PermissionRequest', approval)
    hook('PermissionRequest', { ...approval, nodeterm_pending_id: 'ticket-2' })
    expect(recordQuestionResult('node', 'parent', 'ask-1')).toMatchObject({
      state: 'blocked', askKind: 'approval', pendingId: 'ticket-2' })
    expect(_snapshot().node.pendingQuestion).toBeUndefined()
    expect(_inboxSnapshot().events.find(e => e.kind === 'question')?.resolved).toBe(true)
    expect(_inboxSnapshot().events.filter(e => e.kind === 'approval' && !e.resolved)).toHaveLength(2)
    expect(hook('PreToolUse', { tool_name: 'Read' })).toMatchObject({ state: 'blocked', pendingId: 'ticket-2' })
    expect(hook('PermissionRequest', { ...approval, nodeterm_answered: decision })).toMatchObject({
      state: 'blocked', askKind: 'approval', pendingId: 'ticket-2' })
    expect(_inboxSnapshot().events.find(e => e.pendingId === 'ticket-1')?.resolved).toBe(true)
    expect(_inboxSnapshot().events.find(e => e.pendingId === 'ticket-2')?.resolved).not.toBe(true)
    expect(hook('PermissionRequest', { ...approval, nodeterm_pending_id: 'ticket-2', nodeterm_answered: decision }))
      .toMatchObject({ state: 'working' })
    expect(_inboxSnapshot().events.every(e => e.resolved)).toBe(true)
    expect(_snapshot().node.concurrentApprovalIds).toBeUndefined()
  })

  it.each(['UserPromptSubmit', 'SessionEnd', 'SessionStart', 'Stop'])('resets overlapping approvals on explicit %s', event => {
    ask()
    hook('PermissionRequest', { agent_id: 'child', tool_name: 'Bash', nodeterm_pending_id: 'ticket' })
    recordQuestionResult('node', 'parent', 'ask-1')
    hook(event, { is_interrupt: true, ...(event === 'SessionStart' ? { session_id: 'new' } : {}) })
    expect(_snapshot().node.concurrentApprovalIds).toBeUndefined()
    expect(_inboxSnapshot().events.filter(e => e.kind !== 'done').every(e => e.resolved)).toBe(true)
  })

  it('does not turn the held picker own permission into an approval', () => {
    ask()
    expect(hook('PermissionRequest', { tool_name: 'AskUserQuestion', nodeterm_pending_id: 'picker' }))
      .toMatchObject({ state: 'waiting', askKind: 'question' })
    expect(_inboxSnapshot().events).toHaveLength(1)
    expect(_inboxSnapshot().events[0].pendingId).toBeUndefined()
  })

  it('forwards child permission notifications and ignores informational notifications', () => {
    expect(hook('Notification', { agent_id: 'child', notification_type: 'permission_prompt' })?.state).toBe('blocked')
    expect(hook('Notification', { agent_id: 'child', notification_type: 'auth_success' })).toBeNull()
    expect(_snapshot().node.state).toBe('blocked')
  })
})


describe('independent question, approval and lifecycle streams', () => {
  const approval = { agent_id: 'child', session_id: 'child-session', tool_name: 'Bash',
    tool_input: { command: 'echo child' }, nodeterm_pending_id: 'ticket-1' }
  const open = () => {
    ask()
    hook('PermissionRequest', approval)
    hook('PermissionRequest', { ...approval, nodeterm_pending_id: 'ticket-2' })
  }
  const live = () => _inboxSnapshot().events.filter(e => !e.resolved)

  describe.each([false, true])('parent answered: %s', answered => {
    it.each([
      ['PreToolUse', { tool_name: 'Agent', tool_use_id: 'task-1', tool_input: { description: 'Work' } }, 'subagent-start'],
      ['PostToolUse', { tool_name: 'Agent', tool_use_id: 'task-1', tool_response: { content: [{ type: 'text', text: 'Done' }] } }, 'subagent-end'],
      ['PreToolUse', { tool_name: 'CronCreate', tool_input: { cron: '* * * * *', prompt: 'Check' } }, 'recurring'],
      ['PreToolUse', { tool_name: 'CronDelete' }, 'recurring'],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true } }, 'background-task']
    ] as const)('preserves %s %j as %s without refreshing held state', (event, extra, kind) => {
      open()
      if (answered) recordQuestionResult('node', 'parent', 'ask-1')
      const before = _snapshot().node
      const cards = _inboxSnapshot().events
      vi.setSystemTime(Date.now() + 5000)
      const payload = { hook_event_name: event, session_id: 'parent', ...extra }
      recordRawToolEvent('node', payload)
      const normalized = normalizeClaude({ nodeId: 'node', agentId: 'claude', payload })!
      expect(normalized.kind).toBe(kind)
      expect(recordAgentEvent(normalized)).toBe(normalized)
      expect(_snapshot().node).toEqual(before)
      expect(_inboxSnapshot().events).toEqual(cards)
    })
  })

  it('keeps reload replay and live lifecycle consistent while child approvals hold attention', () => {
    open()
    recordQuestionResult('node', 'parent', 'ask-1')
    expect(hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'task-1',
      tool_input: { description: 'Independent child' } })).toMatchObject({ kind: 'subagent-start' })
    expect(subagentReplay.snapshot()).toMatchObject([{ kind: 'subagent-start', toolUseId: 'task-1', taskLabel: 'Independent child' }])
    expect(subagentReplay.snapshot()[0].verified).toBeUndefined()
    ask('ask-2')
    expect(subagentReplay.snapshot()).toHaveLength(1)
    recordQuestionResult('node', 'parent', 'ask-2')
    expect(hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'task-1', tool_response: {} }))
      .toMatchObject({ kind: 'subagent-end', toolUseId: 'task-1' })
    expect(subagentReplay.snapshot()).toEqual([])
    expect(_snapshot().node.state).toBe('blocked')
    expect(live().map(e => e.pendingId)).toEqual(['ticket-1', 'ticket-2'])
  })

  it('does not deduplicate a new picker against an independent approval with the same title', () => {
    open()
    recordQuestionResult('node', 'parent', 'ask-1')
    const title = live().find(e => e.pendingId === 'ticket-2')!.title
    expect(hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-2',
      tool_input: { questions: [{ question: title, options: [{ label: 'A' }, { label: 'B' }] }] } }))
      .toMatchObject({ state: 'waiting', askKind: 'question' })
    expect(live()).toHaveLength(3)
    expect(live().find(e => e.kind === 'question')).toMatchObject({ title, options: ['A', 'B'] })
    expect(live().filter(e => e.kind === 'approval').map(e => e.pendingId)).toEqual(['ticket-1', 'ticket-2'])
  })

  it.each(['allow', 'deny'])('keeps sequential pickers and independent tickets through both answer orders (%s)', decision => {
    open()
    recordQuestionResult('node', 'parent', 'ask-1')
    // A parent can ask and answer repeatedly while both child permissions remain outstanding.
    for (const id of ['ask-2', 'ask-3']) {
      expect(ask(id)).toMatchObject({ kind: 'state', state: 'waiting', askKind: 'question', questionId: id })
      expect(_snapshot().node.pendingQuestion).toEqual({ sessionId: 'parent', toolUseId: id })
      expect(live().filter(e => e.kind === 'question')).toHaveLength(1)
      expect(live().filter(e => e.kind === 'approval').map(e => e.pendingId)).toEqual(['ticket-1', 'ticket-2'])
      // Reassertions and an older delayed result cannot duplicate or answer the new question.
      ask(id)
      expect(live()).toHaveLength(3)
      expect(recordQuestionResult('node', 'parent', 'ask-1')).toBeUndefined()
      expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1' })?.state).toBe('waiting')
      expect(recordQuestionResult('node', 'parent', id)).toMatchObject({ state: 'blocked', pendingId: 'ticket-2' })
      expect(live().map(e => e.pendingId)).toEqual(['ticket-1', 'ticket-2'])
    }
    // Now answer one child first, then the next parent picker, then the final child.
    ask('ask-4')
    expect(hook('PermissionRequest', { ...approval, nodeterm_answered: decision }))
      .toMatchObject({ state: 'waiting', askKind: 'question' })
    expect(_snapshot().node.pendingQuestion?.toolUseId).toBe('ask-4')
    expect(live().filter(e => e.kind === 'approval').map(e => e.pendingId)).toEqual(['ticket-2'])
    expect(recordQuestionResult('node', 'parent', 'ask-4')).toMatchObject({ state: 'blocked', pendingId: 'ticket-2' })
    ask('ask-5')
    expect(hook('PermissionRequest', { ...approval, nodeterm_pending_id: 'ticket-2', nodeterm_answered: decision }))
      .toMatchObject({ state: 'waiting', askKind: 'question' })
    expect(live()).toHaveLength(1)
    expect(live()[0].kind).toBe('question')
    expect(_snapshot().node.concurrentApprovalIds).toBeUndefined()
    expect(recordQuestionResult('node', 'parent', 'ask-5')).toMatchObject({ state: 'working' })
    expect(live()).toHaveLength(0)
  })
})
