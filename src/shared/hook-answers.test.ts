import { describe, expect, it } from 'vitest'
import { buildHookReply, hookQuestions, permissionSuggestions, HOOK_REPLY_MARKER } from './hook-answers'

const permission = {
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]
}
const question = {
  hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1',
  tool_input: { questions: [
    { question: 'Which sections?', header: 'Sections', options: [{ label: 'Intro', description: 'First' }, { label: '結論', description: 'Last' }], multiSelect: true },
    { question: '__proto__', header: 'Format', options: [{ label: 'Plain', description: '' }, { label: 'Detailed', description: '' }], multiSelect: false }
  ], metadata: 'preserve original input' }
}
function output(value: string | null): any {
  expect(value?.split('\n')[0]).toBe(HOOK_REPLY_MARKER)
  return JSON.parse(value!.split('\n')[1]).hookSpecificOutput
}

describe('layout-independent hook answers', () => {
  it('remembers only the exact suggested rule and destination, with no keystrokes', () => {
    expect(permissionSuggestions(permission)).toEqual([{ index: 0, label: 'Bash(npm test) — localSettings' }])
    const other = { ...permission.permission_suggestions[0], destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm build' }] }
    expect(output(buildHookReply({ ...permission, permission_suggestions: [permission.permission_suggestions[0], other] },
      { kind: 'allow-always', suggestionIndex: 1 })).decision.updatedPermissions).toEqual([other])
    expect(output(buildHookReply(permission, { kind: 'allow-always', suggestionIndex: 0 }))).toEqual({
      hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: permission.permission_suggestions }
    })
  })
  it('rejects mode changes, denial rules, whole-tool grants, wildcards and another tool', () => {
    for (const update of [
      { ...permission.permission_suggestions[0], type: 'setMode', mode: 'bypassPermissions' },
      { ...permission.permission_suggestions[0], behavior: 'deny' },
      { ...permission.permission_suggestions[0], rules: [{ toolName: 'Bash' }] },
      { ...permission.permission_suggestions[0], rules: [{ toolName: 'Bash', ruleContent: '*' }] },
      { ...permission.permission_suggestions[0], rules: [{ toolName: 'Write', ruleContent: '/tmp/a' }] },
      { ...permission.permission_suggestions[0], destination: 'managedSettings' }
    ]) {
      const request = { ...permission, permission_suggestions: [update] }
      expect(permissionSuggestions(request)).toEqual([])
      expect(buildHookReply(request, { kind: 'allow-always', suggestionIndex: 0 })).toBeNull()
    }
  })
  it('does not infer a remember rule when suggestions are absent or use the wrong event', () => {
    expect(permissionSuggestions({ ...permission, permission_suggestions: undefined })).toEqual([])
    expect(buildHookReply(question, { kind: 'allow-always', suggestionIndex: 0 })).toBeNull()
    for (const suggestionIndex of [-1, 1, 0.1, NaN]) expect(buildHookReply(permission, { kind: 'allow-always', suggestionIndex })).toBeNull()
  })
  it('validates full question schema and returns all original inputs with Unicode multi-select answers', () => {
    expect(hookQuestions(question)).toEqual(question.tool_input.questions)
    const reply = output(buildHookReply(question, { kind: 'question', selections: [[1, 0], [1]] }))
    expect(reply.hookEventName).toBe('PreToolUse')
    expect(reply.permissionDecision).toBe('allow')
    expect(reply.updatedInput.questions).toEqual(question.tool_input.questions)
    expect(reply.updatedInput.metadata).toBe('preserve original input')
    expect(reply.updatedInput.answers).toEqual({ 'Which sections?': 'Intro, 結論', ['__proto__']: 'Detailed' })
  })
  it('requires every question and rejects duplicates, invalid indices and multiple single-select answers', () => {
    for (const selections of [[], [[0]], [[0], [0], [0]], [[0], []], [[0, 0], [0]], [[-1], [0]], [[2], [0]], [[0.5], [0]], [[0], [0, 1]]]) {
      expect(buildHookReply(question, { kind: 'question', selections })).toBeNull()
    }
  })
  it('rejects duplicate question text or option labels rather than overwrite an answer', () => {
    const q = question.tool_input.questions[0]
    for (const questions of [[q, q], [{ ...q, options: [q.options[0], q.options[0]] }]]) {
      expect(hookQuestions({ ...question, tool_input: { questions } })).toBeNull()
    }
  })
  it('does not answer a legacy PermissionRequest question as a PreToolUse hook', () => {
    const request = { ...question, hook_event_name: 'PermissionRequest' }
    expect(hookQuestions(request)).toBeNull()
    expect(buildHookReply(request, { kind: 'question', selections: [[0], [0]] })).toBeNull()
  })
  it('bounds final UTF-8 reply bytes and refuses child questions without a parent card', () => {
    expect(buildHookReply({ ...question, agent_id: 'child' }, { kind: 'question', selections: [[0], [0]] })).toBeNull()
    expect(buildHookReply({ ...question, tool_input: { ...question.tool_input, metadata: '界'.repeat(50000) } },
      { kind: 'question', selections: [[0], [0]] })).toBeNull()
  })
  it('bounds schema and suggestions without publishing a truncated answerable picker', () => {
    const q = question.tool_input.questions[0]
    for (const questions of [Array(5).fill(q), [{ ...q, question: 'x'.repeat(4097) }], [{ ...q, options: Array(5).fill(q.options[0]) }]]) {
      expect(hookQuestions({ ...question, tool_input: { questions } })).toBeNull()
    }
    expect(permissionSuggestions({ ...permission, permission_suggestions: Array(33).fill(permission.permission_suggestions[0]) })).toEqual([])
  })
})
