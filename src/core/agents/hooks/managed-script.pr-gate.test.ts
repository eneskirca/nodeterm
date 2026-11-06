// The PR write gate in the managed hook script, run under a REAL /bin/sh (see
// managed-script.answer.test.ts for why string checks on a script prove nothing).
// Harness: a fake `curl` logs each call and, when told to, writes the gate's answer file the way
// desktop main does (the id rides the POST); a fake `sleep` counts the poll iterations.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildManagedScript, PR_GATE_POLLS } from './managed-script'
import { preToolDenyAnswer } from '../../../shared/pr-write-hook'

const sh = spawnSync('sh', ['-c', 'exit 0'])
const shAvailable = sh.status === 0 && !sh.error && process.platform !== 'win32'

const pre = (command: string, tool = 'Bash') =>
  JSON.stringify({ session_id: 's-1', cwd: '/home/u/gh pr', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } })

const DENY = preToolDenyAnswer('nodeterm: Do not write to GitHub yourself. Run `pr-propose --node p8 --action merge`.')

interface Run { stdout: string; sleeps: number; gateIds: string[]; calls: number }

describe.skipIf(!shAvailable)('managed hook PR write gate, under /bin/sh', () => {
  const root = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-hook-gate-')) : ''
  let n = 0
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  /** `answer`: what the fake server writes as the gate answer (undefined = nobody answers).
   *  `curlFails`: the POST reaches no server. */
  function run(agent: 'claude' | 'codex' | 'gemini', payload: string, opts: { answer?: string; curlFails?: boolean } = {}): Run {
    const dir = join(root, `case-${++n}`)
    const home = join(dir, 'home')
    const bin = join(dir, 'bin')
    const log = join(dir, 'curl.log')
    const count = join(dir, 'sleeps')
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    const endpoint = join(home, '.nodeterm', 'hook-endpoint.env')
    writeFileSync(endpoint, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=tok\nNODETERM_HOOK_VERSION=2\n', 'utf8')
    const answerFile = join(dir, 'answer')
    if (opts.answer !== undefined) writeFileSync(answerFile, opts.answer, 'utf8')
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        'cat >/dev/null',
        'gate=""',
        'for a in "$@"; do case "$a" in nodeterm_gate_id=*) gate=${a#nodeterm_gate_id=} ;; esac; done',
        `printf 'CALL %s\\n' "$gate" >> ${JSON.stringify(log)}`,
        opts.curlFails ? 'exit 7' : ':',
        `if [ -n "$gate" ] && [ -f ${JSON.stringify(answerFile)} ]; then cp ${JSON.stringify(answerFile)} "$HOME/.nodeterm/pending/$gate.answer"; fi`,
        "printf '204'",
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    writeFileSync(
      join(bin, 'sleep'),
      ['#!/bin/sh', `c=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)`, `echo $((c + 1)) > ${JSON.stringify(count)}`, 'exit 0', ''].join('\n'),
      { mode: 0o755 }
    )
    const script = join(dir, `${agent}.sh`)
    writeFileSync(script, buildManagedScript(agent, null), { mode: 0o755 })
    const res = spawnSync('sh', [script], {
      encoding: 'utf8',
      input: payload,
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: endpoint }
    })
    // A non-gated POST is backgrounded: give it a moment to land before reading the log.
    const deadline = Date.now() + 2000
    while (!existsSync(log) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('CALL')) : []
    return {
      stdout: res.stdout,
      sleeps: existsSync(count) ? Number(readFileSync(count, 'utf8').trim()) : 0,
      gateIds: lines.map((l) => l.slice(5)).filter(Boolean),
      calls: lines.length
    }
  }

  it.each(['claude', 'codex'] as const)('%s: prints the deny the server wrote for a matching command', (agent) => {
    const r = run(agent, pre('git push && gh pr merge 8 --squash'), { answer: DENY })
    expect(r.stdout).toBe(`${DENY}\n`)
    expect(r.gateIds).toHaveLength(1)
    expect(r.gateIds[0]).toMatch(/^gate-node-1-\d+-\d+$/)
    expect(r.sleeps).toBe(0)
  })

  it('prints nothing for an allow answer', () => {
    const r = run('claude', pre('gh api -X PUT repos/acme/app/pulls/8/merge'), { answer: 'allow' })
    expect(r.stdout).toBe('')
    expect(r.gateIds).toHaveLength(1)
  })

  it('makes no gate round trip and no wait for a command that is not a PR write candidate', () => {
    for (const command of ['ls -la', 'npm test', 'ghost pr merge 8', 'echo graph api', 'gh issue list', 'gh pr view 8', 'gh pr list',
      'gh api repos/acme/app/pulls/8']) {
      const r = run('claude', pre(command), { answer: DENY })
      expect(r).toMatchObject({ stdout: '', sleeps: 0, gateIds: [], calls: 1 })
    }
    // A cwd that happens to read "gh pr" is not the command.
    expect(run('claude', pre('ls'), { answer: DENY }).gateIds).toEqual([])
    // Another tool, another event, another agent: never gated.
    expect(run('claude', pre('gh pr merge 8', 'Write'), { answer: DENY }).gateIds).toEqual([])
    expect(run('claude', pre('gh pr merge 8').replace('PreToolUse', 'PostToolUse'), { answer: DENY }).gateIds).toEqual([])
    expect(run('gemini', pre('gh pr merge 8'), { answer: DENY })).toMatchObject({ stdout: '', sleeps: 0 })
  }, 30_000)

  it('fails open after the hold when nobody answers', () => {
    const r = run('claude', pre('gh pr merge 8'))
    expect(r).toMatchObject({ stdout: '', sleeps: PR_GATE_POLLS })
    expect(r.gateIds).toHaveLength(1)
  })

  it('fails open at once when the POST reaches no server', () => {
    const r = run('claude', pre('gh pr merge 8'), { curlFails: true, answer: DENY })
    expect(r).toMatchObject({ stdout: '', sleeps: 0 })
  })

  it('prints nothing for an answer that is not the deny shape', () => {
    for (const answer of ['deny', '{"hookSpecificOutput":{"hookEventName":"PermissionRequest"}}', `${DENY.slice(0, -1)}\u0007}`]) {
      expect(run('claude', pre('gh pr merge 8'), { answer }).stdout).toBe('')
    }
  })
})
