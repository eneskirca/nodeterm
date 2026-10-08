import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildManagedScript } from './managed-script'
import { buildHookReply } from '../../../shared/hook-answers'

const homes: string[] = []
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Execute the shipped /bin/sh producer with only its HTTP transport replaced. No live hook server,
// agent account, listener or real home is involved; stdin and stdout use the real Claude schemas.
function run(request: unknown, answer: string | undefined, agent = 'claude') {
  const home = mkdtempSync(join(tmpdir(), 'nt-hook-answer-'))
  homes.push(home)
  const bin = join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
pending=
answered=
for arg do
  case "$arg" in
    nodeterm_pending_id=*) pending="\${arg#*=}" ;;
    nodeterm_answered=*) answered=1 ;;
    nodeterm_hook_reply=*) printf '%s\\n' "$arg" >> "$TEST_POSTS" ;;
  esac
done
if [ -n "$pending" ] && [ -z "$answered" ] && [ "$TEST_WRITE_ANSWER" = 1 ]; then
  printf '%s' "$TEST_ANSWER" > "$HOME/.nodeterm/pending/$pending.answer"
fi
printf 204
`, { mode: 0o700 })
  const script = join(home, 'hook.sh')
  writeFileSync(script, buildManagedScript(agent, null))
  const input = join(home, 'stdin.json')
  writeFileSync(input, JSON.stringify(request))
  const fd = openSync(input, 'r')
  const child = spawnSync('/bin/sh', [script], {
    stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_PORT: '1',
      NODETERM_PERM_WAIT_SECS: '1', TEST_WRITE_ANSWER: answer === undefined ? '0' : '1', TEST_ANSWER: answer ?? '', TEST_POSTS: join(home, 'posts') }
  })
  closeSync(fd)
  if (child.error) throw new Error(`${child.error.message}\n${child.stderr.slice(-3500)}`)
  expect(child.status).toBe(0)
  return { stdout: child.stdout.trim(), posts: readFileSync(join(home, 'posts'), 'utf8'), pendingFiles: readdirSync(join(home, '.nodeterm/pending')) }
}

const permission = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', permission_suggestions: [
  { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }
] }
const question = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tool-1', tool_input: {
  questions: [{ question: 'Which?', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
} }

describe.skipIf(process.platform === 'win32')('real POSIX hook structured answers', () => {
  it('preserves legacy allow and deny output', () => {
    expect(JSON.parse(run(permission, 'allow').stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(JSON.parse(run(permission, 'deny').stdout).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied from nodeterm.' })
  })
  it('returns the exact concrete permission update in Claude decision JSON', () => {
    const reply = buildHookReply(permission, { kind: 'allow-always', suggestionIndex: 0 })!
    const result = run(permission, reply)
    expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: permission.permission_suggestions } })
    expect(result.posts).toContain('nodeterm_hook_reply=2')
  })
  it('returns the original question schema and multi-select answer through PreToolUse', () => {
    const reply = buildHookReply(question, { kind: 'question', selections: [[0, 1]] })!
    expect(JSON.parse(run(question, reply).stdout).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: question.tool_input.questions, answers: { 'Which?': 'A, B' } } })
  })
  it('refuses cross-kind or plain permission answers to a question rather than print a wrong hook decision', () => {
    const permissionReply = buildHookReply(permission, { kind: 'allow-always', suggestionIndex: 0 })!
    const questionReply = buildHookReply(question, { kind: 'question', selections: [[0]] })!
    expect(run(question, permissionReply).stdout).toBe('')
    expect(run(permission, questionReply).stdout).toBe('')
    expect(run(question, 'allow').stdout).toBe('')
  })
  it('releases an unanswered question after the bounded timeout and removes its held files', () => {
    const result = run(question, undefined)
    expect(result.stdout).toBe('')
    expect(result.pendingFiles).toEqual([])
  })
  it('does not hold a child AskUserQuestion or an ordinary PreToolUse event', () => {
    expect(run({ ...question, agent_id: 'child-1' }, undefined).pendingFiles).toEqual([])
    expect(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, undefined).pendingFiles).toEqual([])
  })
  it('never arms or prints Claude decisions from a non-Claude script', () => {
    expect(run(question, buildHookReply(question, { kind: 'question', selections: [[0]] })!, 'codex').stdout).toBe('')
  })
})
