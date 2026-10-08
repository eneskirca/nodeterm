// Claude's documented hook decision contract, independent of prompt layout or keystrokes.
// https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction
// https://code.claude.com/docs/en/hooks#permission-update-entries

export const HOOK_REPLY_MARKER = 'nodeterm-hook-reply-v2'
export const HOOK_REQUEST_MAX_BYTES = 128 * 1024

export interface PermissionSuggestion {
  index: number
  label: string
}

export interface HookQuestion {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export type HookAnswer =
  | { kind: 'allow-always'; suggestionIndex: number }
  | { kind: 'question'; selections: number[][] }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/** Only concrete allow rules supplied by this exact request, never a permission-mode change. */
function permissionUpdate(request: unknown, index: number): Record<string, unknown> | null {
  const req = record(request)
  if (req?.hook_event_name !== 'PermissionRequest' || !text(req.tool_name, 128)) return null
  const suggestions = req.permission_suggestions
  if (!Array.isArray(suggestions) || suggestions.length > 32 || !Number.isInteger(index) || index < 0) return null
  const update = record(suggestions[index])
  if (!update || update.type !== 'addRules' || update.behavior !== 'allow' ||
      !['session', 'localSettings', 'projectSettings', 'userSettings'].includes(String(update.destination))) return null
  const rules = update.rules
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 8) return null
  const checked: { toolName: string; ruleContent: string }[] = []
  for (const raw of rules) {
    const rule = record(raw)
    // A missing ruleContent grants the whole tool. This feature remembers only an explicit scope.
    if (!rule || rule.toolName !== req.tool_name || !text(rule.ruleContent, 4096) || rule.ruleContent === '*') return null
    checked.push({ toolName: req.tool_name, ruleContent: rule.ruleContent })
  }
  return { type: 'addRules', rules: checked, behavior: 'allow', destination: update.destination }
}

export function permissionSuggestions(request: unknown): PermissionSuggestion[] {
  const req = record(request)
  const suggestions = req?.permission_suggestions
  if (!Array.isArray(suggestions) || suggestions.length > 32) return []
  return suggestions.flatMap((_, index) => {
    const update = permissionUpdate(req, index)
    if (!update) return []
    const rules = update.rules as { toolName: string; ruleContent: string }[]
    return [{ index, label: `${rules.map(r => `${r.toolName}(${r.ruleContent})`).join(', ')} — ${update.destination}` }]
  })
}

/** Full, bounded schema. Never answer only the first of several questions or clipped labels. */
export function hookQuestions(request: unknown): HookQuestion[] | null {
  const req = record(request)
  if (req?.hook_event_name !== 'PreToolUse' || req.tool_name !== 'AskUserQuestion' ||
      (typeof req.agent_id === 'string' && req.agent_id.length > 0)) return null
  const input = record(req.tool_input)
  const questions = input?.questions
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) return null
  const result: HookQuestion[] = []
  const seen = new Set<string>()
  for (const raw of questions) {
    const q = record(raw)
    if (!q || !text(q.question, 4096) || seen.has(q.question) || !text(q.header, 80) ||
        (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')) return null
    seen.add(q.question)
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null
    const options: HookQuestion['options'] = []
    const labels = new Set<string>()
    for (const rawOption of q.options) {
      const option = record(rawOption)
      if (!option || !text(option.label, 256) || labels.has(option.label) ||
          typeof option.description !== 'string' || option.description.length > 4096) return null
      labels.add(option.label)
      options.push({ label: option.label, description: option.description })
    }
    result.push({ question: q.question, header: q.header, options, multiSelect: q.multiSelect === true })
  }
  return result
}

/** Build only from the original live request. Callers supply indexes, never hook JSON or rules. */
export function buildHookReply(request: unknown, answer: HookAnswer): string | null {
  let hookSpecificOutput: Record<string, unknown>
  if (answer?.kind === 'allow-always') {
    const update = permissionUpdate(request, answer.suggestionIndex)
    if (!update) return null
    hookSpecificOutput = { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [update] } }
  } else if (answer?.kind === 'question') {
    const questions = hookQuestions(request)
    if (!questions || !Array.isArray(answer.selections) || answer.selections.length !== questions.length) return null
    const answers: Record<string, string> = Object.create(null)
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const selected = answer.selections[i]
      if (!Array.isArray(selected) || selected.length === 0 || selected.length > q.options.length ||
          (!q.multiSelect && selected.length !== 1) || new Set(selected).size !== selected.length ||
          selected.some(n => !Number.isInteger(n) || n < 0 || n >= q.options.length)) return null
      // Claude documents the comma-space representation for multi-select labels.
      answers[q.question] = [...selected].sort((a, b) => a - b).map(n => q.options[n].label).join(', ')
    }
    const req = request as Record<string, unknown>
    hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...record(req.tool_input), answers } }
  } else return null
  const output = JSON.stringify({ hookSpecificOutput })
  return new TextEncoder().encode(output).length <= HOOK_REQUEST_MAX_BYTES ? `${HOOK_REPLY_MARKER}\n${output}` : null
}
