// The managed hook's answer-file decoder, executed under a REAL /bin/sh (the discipline every
// generated shell in this repo is held to — canvas-control-shim.test.ts, remote-claude-usage.test.ts).
// A string assertion on the script proves nothing about what `case` or `${#x}` actually do in dash.
//
// Harness: a fake `curl` records every invocation (argv = what `ps` would show, stdin = the curl
// config), and a fake `sleep` — dash has no builtin sleep — counts the poll iterations and, on the
// Nth one, drops a scripted answer file next to the held request. That makes a 540 s hold testable
// in ~a second and every branch deterministic.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildManagedScript, MANAGED_SCRIPT_REVISION } from './managed-script'
import {
  buildPermissionDecision,
  parsePendingRequest,
  PERMISSION_DECISION_MAX_BYTES,
  PERMISSION_DECISION_PREFIX,
  PERM_WAIT_SECS_INTERACTIVE,
  MIN_STRUCTURED_ANSWER_REVISION,
  type PendingRequest
} from '../permission-decision'
import { mergeManagedHook } from './install-helper'
import { CLAUDE_HOOK_EVENTS, PERMISSION_REQUEST_HOOK_TIMEOUT_SECS } from '../../../shared/agents/hook-events'

const sh = spawnSync('sh', ['-c', 'exit 0'])
const shAvailable = sh.status === 0 && !sh.error && process.platform !== 'win32'

const ALLOW = `${PERMISSION_DECISION_PREFIX}"allow"}}}`
const ALLOW_PLAN = `${PERMISSION_DECISION_PREFIX}"allow","updatedInput":{}}}}`
const DENY = `${PERMISSION_DECISION_PREFIX}"deny","message":"Denied from nodeterm."}}}`

const QUESTIONS = [
  {
    question: 'Which surfaces should get it?',
    header: 'Surfaces',
    options: [{ label: 'Desktop', description: 'Electron' }, { label: 'Phone', description: 'iOS' }],
    multiSelect: true
  }
]

function envelope(toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 's-1',
    transcript_path: '/home/u/.claude/projects/x/s-1.jsonl',
    cwd: '/home/u/proj',
    permission_mode: 'plan',
    ...extra,
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: []
  })
}

function built(payload: string, answer: Parameters<typeof buildPermissionDecision>[1]): string {
  const r = buildPermissionDecision(parsePendingRequest(payload) as PendingRequest, answer)
  if (!r.ok) throw new Error(r.reason)
  return r.content
}

interface Run {
  status: number | null
  stdout: string
  /** Poll iterations the hook waited through. */
  sleeps: number
  /** Every curl invocation: its argv and the config it read on stdin. */
  calls: { argv: string; cfg: string }[]
  pendingLeft: string[]
}

describe.skipIf(!shAvailable)('managed hook answer decoding, under /bin/sh', () => {
  const root = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-hook-answer-')) : ''
  let n = 0
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  let dir = ''
  beforeEach(() => {
    fresh()
  })

  /**
   * Run claude's hook on `payload` with NODETERM_PERM_WAIT_SECS=1 (a 2-poll default hold).
   * `answers[k]` is written as the answer file on the k-th poll (1-based).
   */
  function run(payload: string, answers: Record<number, string> = {}, opts: { noFractionalSleep?: boolean } = {}): Run {
    const home = join(dir, 'home')
    const bin = join(dir, 'bin')
    const answersDir = join(dir, 'answers')
    const log = join(dir, 'curl.log')
    const count = join(dir, 'sleeps')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(answersDir, { recursive: true })
    for (const [k, v] of Object.entries(answers)) writeFileSync(join(answersDir, k), v, 'utf8')
    const endpoint = join(home, '.nodeterm', 'hook-endpoint.env')
    writeFileSync(endpoint, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=tok\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(log)}`,
        `sed 's/^/CFG /' >> ${JSON.stringify(log)}`,
        `printf 'END\\n' >> ${JSON.stringify(log)}`,
        "printf '200'",
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    writeFileSync(
      join(bin, 'sleep'),
      [
        '#!/bin/sh',
        // A sleep that rejects fractions (busybox without FANCY_SLEEP, some old BSDs).
        'if [ "$1" = 0.5 ] && [ -n "$NT_NO_FRACTION" ]; then exit 1; fi',
        `c=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)`,
        'c=$((c + 1))',
        `echo "$c" > ${JSON.stringify(count)}`,
        `a=${JSON.stringify(answersDir)}/$c`,
        'if [ -f "$a" ]; then',
        '  for p in "$HOME"/.nodeterm/pending/*.json; do',
        '    [ -f "$p" ] && cp "$a" "${p%.json}.answer"',
        '  done',
        'fi',
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    const script = join(dir, 'claude.sh')
    writeFileSync(script, buildManagedScript('claude'), { mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: payload,
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        NODETERM_NODE_ID: 'node-1',
        NODETERM_HOOK_ENDPOINT: endpoint,
        NODETERM_PERM_WAIT_SECS: '1',
        ...(opts.noFractionalSleep ? { NT_NO_FRACTION: '1' } : {})
      }
    })
    // The "answered" POST is backgrounded; give it a moment to land before reading the log.
    const deadline = Date.now() + 3000
    const wantAnswered = res.stdout.trim().length > 0
    while (wantAnswered && Date.now() < deadline) {
      const txt = existsSync(log) ? readFileSync(log, 'utf8') : ''
      if ((txt.match(/^END$/gm) ?? []).length >= 2) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    const calls: { argv: string; cfg: string }[] = []
    if (existsSync(log)) {
      let argv = ''
      let cfg: string[] = []
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (line.startsWith('ARGV ')) {
          argv = line.slice(5)
          cfg = []
        } else if (line.startsWith('CFG ')) cfg.push(line.slice(4))
        else if (line === 'END') calls.push({ argv, cfg: cfg.join('\n') })
      }
    }
    const pendingDir = join(home, '.nodeterm', 'pending')
    return {
      status: res.status,
      stdout: res.stdout,
      sleeps: existsSync(count) ? Number(readFileSync(count, 'utf8').trim()) : 0,
      calls,
      pendingLeft: existsSync(pendingDir)
        ? readdirSync(pendingDir).filter((f) => f.endsWith('.json') || f.endsWith('.answer'))
        : []
    }
  }

  /** Each run needs its own dir: the fake sleep's counter and the answer schedule live there. */
  function fresh(): void {
    dir = join(root, `case-${++n}`)
    mkdirSync(dir, { recursive: true })
  }

  const answeredVerbs = (r: Run): string[] =>
    r.calls.map((c) => /nodeterm_answered=(\S*)/.exec(c.argv)?.[1]).filter((v): v is string => v !== undefined)

  it('legacy allow / deny on an ordinary tool: byte-identical decisions', () => {
    const allow = run(envelope('Bash', { command: 'ls' }), { 1: 'allow' })
    expect(allow.stdout).toBe(`${ALLOW}\n`)
    expect(answeredVerbs(allow)).toEqual(['allow'])
    fresh()
    const deny = run(envelope('Bash', { command: 'ls' }), { 1: 'deny' })
    expect(deny.stdout).toBe(`${DENY}\n`)
    expect(answeredVerbs(deny)).toEqual(['deny'])
  })

  it('a plain allow on ExitPlanMode prints updatedInput:{} (Claude drops a bare allow there)', () => {
    const r = run(envelope('ExitPlanMode', { plan: '# Plan', planFilePath: '/p.md' }), { 1: 'allow' })
    expect(r.stdout).toBe(`${ALLOW_PLAN}\n`)
    expect(answeredVerbs(r)).toEqual(['allow'])
    expect(r.pendingLeft).toEqual([])
  })

  it('a plain deny on ExitPlanMode is still the fixed deny', () => {
    expect(run(envelope('ExitPlanMode', { plan: 'p' }), { 1: 'deny' }).stdout).toBe(`${DENY}\n`)
  })

  it('a plain allow on AskUserQuestion is consumed and the hook KEEPS HOLDING for a real answer', () => {
    const payload = envelope('AskUserQuestion', { questions: QUESTIONS })
    const answer = built(payload, { kind: 'question', answers: { 'Which surfaces should get it?': ['Desktop', 'Phone'] } })
    const r = run(payload, { 1: 'allow', 3: answer })
    expect(r.stdout).toBe(`${answer}\n`)
    expect(r.sleeps).toBe(3)
    // Exactly one answered POST (for the real answer), never one for the swallowed allow.
    expect(answeredVerbs(r)).toEqual(['allow'])
  })

  it('a core-built plan decision is printed verbatim and nothing from it reaches an argv', () => {
    const payload = envelope('ExitPlanMode', { plan: 'p' })
    const answer = built(payload, { kind: 'plan', mode: 'acceptEdits' })
    const r = run(payload, { 1: answer })
    expect(r.stdout).toBe(`${answer}\n`)
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
    ])
    for (const c of r.calls) {
      expect(c.argv).not.toContain('hookSpecificOutput')
      expect(c.argv).not.toContain('setMode')
    }
    expect(answeredVerbs(r)).toEqual(['allow'])
  })

  it('hostile feedback text survives verbatim and executes nothing', () => {
    const payload = envelope('ExitPlanMode', { plan: 'p' })
    const hostile = `it's $(touch PWNED) \`touch PWNED2\` "q" \\ ; rm -rf ~ | x\ny`
    const answer = built(payload, { kind: 'plan-revise', message: hostile })
    const r = run(payload, { 1: answer })
    expect(r.stdout).toBe(`${answer}\n`)
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.message).toContain("$(touch PWNED)")
    expect(existsSync(join(dir, 'PWNED'))).toBe(false)
    expect(existsSync(join(dir, 'PWNED2'))).toBe(false)
    expect(answeredVerbs(r)).toEqual(['deny'])
    for (const c of r.calls) expect(c.argv).not.toContain('PWNED')
  })

  it('refuses anything that is not a bounded core decision: prints nothing, posts no answer', () => {
    const payload = envelope('Bash', { command: 'ls' })
    const hostile = [
      'yes',
      'allow deny',
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","decision":{"behavior":"allow"}}}',
      `${PERMISSION_DECISION_PREFIX}"ask"}}}`,
      `${ALLOW}\n{"hookSpecificOutput":{}}`,
      `${PERMISSION_DECISION_PREFIX}"allow","m":"\u001b]52;c;cHduZWQ=\u0007"}}}`,
      `${PERMISSION_DECISION_PREFIX}"allow"`,
      `${PERMISSION_DECISION_PREFIX}"allow","x":"${'a'.repeat(PERMISSION_DECISION_MAX_BYTES)}"}}}`
    ]
    for (const h of hostile) {
      fresh()
      const r = run(payload, { 1: h })
      expect(r.stdout, JSON.stringify(h.slice(0, 80))).toBe('')
      expect(answeredVerbs(r), JSON.stringify(h.slice(0, 80))).toEqual([])
      expect(r.status).toBe(0)
    }
  })

  it(`holds ExitPlanMode / AskUserQuestion for ${PERM_WAIT_SECS_INTERACTIVE}s, everything else for the armed default`, () => {
    const plan = run(envelope('ExitPlanMode', { plan: 'p' }))
    expect(plan.sleeps).toBe(PERM_WAIT_SECS_INTERACTIVE * 2)
    expect(plan.stdout).toBe('')
    expect(plan.pendingLeft).toEqual([]) // timeout still cleans up the request file
    fresh()
    expect(run(envelope('AskUserQuestion', { questions: QUESTIONS })).sleeps).toBe(PERM_WAIT_SECS_INTERACTIVE * 2)
    fresh()
    expect(run(envelope('Bash', { command: 'ls' })).sleeps).toBe(2)
  }, 60_000)

  it('keeps the v2 PreToolUse question on its armed hold instead of the PermissionRequest dialog wait', () => {
    const payload = JSON.parse(envelope('AskUserQuestion', { questions: QUESTIONS }))
    payload.hook_event_name = 'PreToolUse'
    const result = run(JSON.stringify(payload))
    expect(result.sleeps).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.pendingLeft).toEqual([])
  })

  it('where fractional sleep fails, the 1 s fallback counts double: the hold stays 540 s, not 1080 s', () => {
    const plan = run(envelope('ExitPlanMode', { plan: 'p' }), {}, { noFractionalSleep: true })
    expect(plan.sleeps).toBe(PERM_WAIT_SECS_INTERACTIVE) // 540 one-second sleeps
    fresh()
    expect(run(envelope('Bash', { command: 'ls' }), {}, { noFractionalSleep: true }).sleeps).toBe(1)
    fresh()
    // An answer still lands on the fallback path.
    expect(run(envelope('ExitPlanMode', { plan: 'p' }), { 3: 'allow' }, { noFractionalSleep: true }).stdout).toBe(`${ALLOW_PLAN}\n`)
  }, 60_000)

  it('a SUBAGENT\'s plan/question keeps the short hold (its dialog waits for the hook)', () => {
    const r = run(envelope('ExitPlanMode', { plan: 'p' }, { agent_id: 'a-1', agent_type: 'Plan' }))
    expect(r.sleeps).toBe(2)
    // …but its plain allow is still mapped, so an answer inside the window works.
    fresh()
    expect(run(envelope('ExitPlanMode', { plan: 'p' }, { agent_id: 'a-1' }), { 1: 'allow' }).stdout).toBe(`${ALLOW_PLAN}\n`)
  })

  it('a nested "tool_name" inside tool_input can never make an ordinary tool look like a plan', () => {
    // Reordered envelope: tool_input BEFORE tool_name, carrying a spoofed key. The script must not
    // trust the first match here — it would replace this MCP tool's input with {} on an allow.
    const spoof = JSON.stringify({
      session_id: 's',
      hook_event_name: 'PermissionRequest',
      tool_input: { tool_name: 'ExitPlanMode', q: 'x' },
      tool_name: 'mcp__srv__do'
    })
    const r = run(spoof, { 1: 'allow' })
    expect(r.stdout).toBe(`${ALLOW}\n`)
    fresh()
    expect(run(spoof).sleeps).toBe(2)
    // And a nested key AFTER the real one is simply never read.
    fresh()
    const after = envelope('mcp__srv__do', { nested: { tool_name: 'ExitPlanMode' } })
    expect(run(after, { 1: 'allow' }).stdout).toBe(`${ALLOW}\n`)
  })
})

describe('hold time vs the command-hook timeout we write', () => {
  it('our installer writes an explicit timeout on the PermissionRequest entry', () => {
    const merged = mergeManagedHook({}, "sh '/x/agent-hooks/claude.sh'", CLAUDE_HOOK_EVENTS)
    const entry = merged.hooks?.PermissionRequest?.[0]?.hooks?.[0] as Record<string, unknown>
    expect(entry.timeout).toBe(PERMISSION_REQUEST_HOOK_TIMEOUT_SECS)
  })
  it('the interactive hold leaves at least a minute of margin under that timeout', () => {
    expect(PERM_WAIT_SECS_INTERACTIVE).toBeLessThanOrEqual(PERMISSION_REQUEST_HOOK_TIMEOUT_SECS - 60)
    expect(PERM_WAIT_SECS_INTERACTIVE).toBeGreaterThan(45)
  })
  it('the script revision is structured-answer capable', () => {
    expect(MANAGED_SCRIPT_REVISION).toBeGreaterThanOrEqual(MIN_STRUCTURED_ANSWER_REVISION)
  })
})
