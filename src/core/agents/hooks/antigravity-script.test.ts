// The Antigravity hook, EXECUTED — never grepped.
//
// Our hook sits in front of every tool call of every `agy` on the machine and `agy` reads its
// stdout as a decision (see antigravity-decision.ts for the measured table). A string assertion
// would stay green while a stray byte ahead of the answer turned every tool call into a DENY, so
// every case below runs the generated script under a real `sh` with a fake `curl` on PATH and
// checks stdout BYTE FOR BYTE, the exit status, and what (if anything) was POSTed.
//
// On Windows `sh` is Git for Windows' MSYS shell — the exact interpreter the wrapper hands the
// script to — so these run there too; they are slower there (a process start is ~60 ms), hence
// the generous timeouts.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path, { join } from 'node:path'
import { buildManagedScript } from './managed-script'
import { buildManagedHookCommand } from './install-helper'
import {
  ANTIGRAVITY_EVENTS,
  ANTIGRAVITY_EVENT_ENV,
  antigravityDecisionFor,
  antigravityDecisionBatch,
  antigravityDecisionCaseSh
} from './antigravity-decision'

const T = 60_000
const probe = spawnSync('sh', ['-c', 'exit 0'])
const shAvailable = probe.status === 0 && !probe.error

const root = shAvailable ? mkdtempSync(join(tmpdir(), 'nt agy script ')) : ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

let seq = 0
interface Run {
  dir: string
  stdout: string
  stderr: string
  status: number | null
  /** Wall time of the script run — what agy waits for before it reads the decision. */
  elapsedMs: number
  /** Every fake-curl invocation's argv, once the (backgrounded) POST has finished. */
  posts: () => string[]
}

/** A stand-in curl that appends its argv (and nothing to stdout) to a log. `delaySec` makes it
 *  behave like an endpoint that accepts and never answers (curl's own --max-time is 1.5 s). */
const FAKE_CURL = (log: string, delaySec = 0): string =>
  [
    '#!/bin/sh',
    ...(delaySec > 0 ? [`sleep ${delaySec}`] : []),
    `printf 'ARGV %s\\n' "$*" >> '${log.replaceAll('\\', '/')}'`,
    'cat >/dev/null',
    'exit 0',
    ''
  ].join('\n')

function runScript(opts: {
  event?: string
  nodeId?: string | null
  input?: string | Buffer
  /** Extra lines appended to the script, to prove nothing written after the answer escapes. */
  append?: string
  /** No endpoint file at all: the POST has nowhere to go. */
  noEndpoint?: boolean
  /** Seconds the fake curl stalls before it answers (a blackholed endpoint). */
  curlDelaySec?: number
}): Run {
  const dir = join(root, `case-${++seq}`)
  const bin = join(dir, 'bin')
  const home = join(dir, 'home dir')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(home, '.nodeterm'), { recursive: true })
  const log = join(dir, 'curl.log')
  writeFileSync(join(bin, 'curl'), FAKE_CURL(log, opts.curlDelaySec), { encoding: 'utf8', mode: 0o755 })
  const endpoint = join(home, '.nodeterm', 'hook-endpoint.env')
  if (!opts.noEndpoint) {
    writeFileSync(endpoint, 'NODETERM_HOOK_PORT=45999\nNODETERM_HOOK_TOKEN=t\nNODETERM_HOOK_VERSION=2\n', 'utf8')
  }
  const script = join(dir, 'antigravity.sh')
  const body = buildManagedScript('antigravity', null).replace(/\nexit 0\n$/, `\n${opts.append ?? ''}\nexit 0\n`)
  writeFileSync(script, body, { encoding: 'utf8', mode: 0o755 })
  const env: Record<string, string> = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    NODETERM_HOOK_ENDPOINT: endpoint
  }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (opts.nodeId !== null) env.NODETERM_NODE_ID = opts.nodeId ?? 'term-agy-1'
  if (opts.event !== undefined) env[ANTIGRAVITY_EVENT_ENV] = opts.event
  const started = Date.now()
  const res = spawnSync('sh', [script], { input: opts.input ?? '{"conversationId":"c1"}', env, timeout: T })
  const elapsedMs = Date.now() - started
  return {
    dir,
    elapsedMs,
    stdout: res.stdout.toString('utf8'),
    stderr: res.stderr.toString('utf8'),
    status: res.status,
    posts: () => {
      // The POST is backgrounded (the hot path never waits on the network); poll for it.
      const deadline = Date.now() + 15_000
      let last = ''
      while (Date.now() < deadline) {
        last = existsSync(log) ? readFileSync(log, 'utf8') : ''
        if (last) break
        sleep(100)
      }
      return last.split('\n').filter((l) => l.startsWith('ARGV '))
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

describe('the decision table', () => {
  it('answers exactly the measured contract, and silence for anything else', () => {
    expect(antigravityDecisionFor('PreToolUse')).toBe('{"decision":"ask"}')
    expect(antigravityDecisionFor('Stop')).toBe('{"decision":""}')
    expect(antigravityDecisionFor('PreInvocation')).toBe('{}')
    expect(antigravityDecisionFor('PostInvocation')).toBe('{}')
    expect(antigravityDecisionFor('PostToolUse')).toBe('{}')
    for (const unknown of ['', 'stop', 'pretooluse', 'SessionEnd', 'constructor', '__proto__', 'toString']) {
      expect(antigravityDecisionFor(unknown), unknown).toBeNull()
    }
    expect(antigravityDecisionFor(undefined)).toBeNull()
    expect(antigravityDecisionFor(null)).toBeNull()
  })

  it('never approves, never force-asks, never keeps agy running', () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      const out = antigravityDecisionFor(ev) ?? ''
      expect(out, ev).not.toMatch(/allow|force_ask|continue|deny/)
    }
  })

  it('the sh and batch renderings are generated from the same table', () => {
    const sh = antigravityDecisionCaseSh()
    const batch = antigravityDecisionBatch().join('\n')
    for (const ev of ANTIGRAVITY_EVENTS) {
      expect(sh).toContain(`  ${ev}) printf '%s\\n' '${antigravityDecisionFor(ev)}' ;;`)
      expect(batch).toContain(`if "%${ANTIGRAVITY_EVENT_ENV}%"=="${ev}" echo ${antigravityDecisionFor(ev)}`)
    }
    // No catch-all: an unknown event must print nothing.
    expect(sh).not.toMatch(/\*\)/)
  })
})

describe('the managed script for antigravity', () => {
  it('answers before anything else and swallows every later byte', () => {
    const s = buildManagedScript('antigravity', '/fixed/identity-root')
    const lines = s.split('\n')
    // shebang, comment, then the case statement — ahead of the codex prelude and the gate.
    expect(lines[2]).toBe(`case "$${ANTIGRAVITY_EVENT_ENV}" in`)
    const answer = s.indexOf(`case "$${ANTIGRAVITY_EVENT_ENV}" in`)
    const silence = s.indexOf('command exec >/dev/null 2>&1 || :')
    expect(answer).toBeGreaterThan(0)
    expect(silence).toBeGreaterThan(answer)
    for (const later of ['CODEX_THREAD_ID', 'if [ -z "$NODETERM_NODE_ID" ]', 'payload=$(cat)', '. "$NODETERM_HOOK_ENDPOINT"']) {
      expect(s.indexOf(later), later).toBeGreaterThan(silence)
    }
  })

  it('sends the event name on BOTH transports, and only antigravity does', () => {
    const s = buildManagedScript('antigravity', null)
    expect(s.match(/--data-urlencode "nodeterm_hook_event=\$\{NODETERM_AGY_EVENT\}"/g)).toHaveLength(2)
    for (const other of ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot']) {
      const o = buildManagedScript(other, null)
      expect(o, other).not.toContain('nodeterm_hook_event')
      expect(o, other).not.toContain('command exec')
    }
  })

  it('leaves the other six scripts byte-identical to the pre-antigravity build', () => {
    // sha256 of each agent's script as built by origin/main at 06afa9d7 (the merge this branch
    // was brought up to), computed from THAT commit's managed-script.ts — i.e. without any
    // antigravity code — and compared equal to this branch's output before being pinned here.
    // If the SHARED script legitimately changes, recompute these deliberately from the base
    // commit's builder — a silent diff here is exactly the regression to catch.
    //
    // RECOMPUTED deliberately for the Windows hook-cost change (no subshell/mkdir on the pending
    // dir once it exists, token read by `read` instead of `head`, the `[A-Za-z0-9._-]` curl-config
    // header fast path): the shared script changed for every agent, so every pin moved. Each
    // change is pinned behaviourally in managed-script / node-token-sh / hook-curl-config tests.
    //
    // RECOMPUTED again for #1150/#1175 on top of that: the shared codex prelude changed, so every
    // IDENTITY-ROOT variant (the second hash of each pair) moved — codex's most, since it reads its
    // payload first. The no-root (remote) variants did not.
    const expected: Record<string, [string, string]> = {
      // claude changed DELIBERATELY (issues #1112/#1153): it now reports which process ran the
      // hook (`$CLAUDE_PID`, foreground, tty — claude-pane-origin.ts). Recomputed from this
      // branch's builder; the other five are untouched, which is what this test still proves.
      claude: [
        '53c1c47ad9fe6d7391abe911f7f86d1e2bffe2b0fa1dec186f85ac0a46b3d624',
        'fcfa2ad72580ebdb25d3ea36980eb61584091bbc303abe3751f9e344cd40f8df'
      ],
      codex: [
        '053908a6ad05ad4c87af0baef58a4271959946b5bc3f958df1561a0923a15441',
        '8c411341109faf32c72d4d9ab876887567e1f12fc1883210cde01620ababd21a'
      ],
      gemini: [
        'ff55978a373961e77959ee1325e326ec7bd8b256e0a2f370f716f17dffb0fdfa',
        '13471898c33f7b30ab42cfe1624fda8d41e7a352f7e5d5f0c9533632e3d19962'
      ],
      opencode: [
        'a00a9905d8f6bc66e20dbe16b91e1ccbc45f2435f6f5f7d63fc7a2cc0c05eeaf',
        'd44dabebdec27333608657ac622cd12bcebee37da1c163738dcbe1b15659808c'
      ],
      grok: [
        '18201b71d85135d31e18a16c59921df62926346de6cd3f8b9587cac5fb0482ab',
        '39d3f375c88ed837cd3256eeb66637f1766ef0ce88eb3a95eeda2d7c8f1a0181'
      ],
      copilot: [
        '1c87a1d31a93acb2d007a64ed6a077942d1322f62fa75d42a1c55e938960de0a',
        '3e2094ffa446582f81883f40a9cf099563fbacf73a30e83a7966eb76d131cbce'
      ]
    }
    const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
    for (const [agent, [noRoot, withRoot]] of Object.entries(expected)) {
      expect(sha(buildManagedScript(agent, null)), `${agent} (no identity root)`).toBe(noRoot)
      expect(sha(buildManagedScript(agent, '/fixed/identity-root')), `${agent} (identity root)`).toBe(withRoot)
    }
  })
})

describe.skipIf(!shAvailable)('the managed script for antigravity, executed under sh', () => {
  it.each(ANTIGRAVITY_EVENTS)('%s: stdout is exactly the table row, exit 0, and the event is POSTed', (ev) => {
    const r = runScript({ event: ev })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`${antigravityDecisionFor(ev)}\n`)
    expect(r.stderr).toBe('')
    const posts = r.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(`nodeterm_hook_event=${ev}`)
    expect(posts[0]).toContain('/hook/antigravity')
    expect(posts[0]).toContain('nodeId=term-agy-1')
  }, T)

  it.each(['', 'stop', 'SessionEnd', 'PreToolUse ', 'constructor'])(
    'unknown event %j: NOTHING on stdout, exit 0',
    (ev) => {
      const r = runScript({ event: ev })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe('')
    },
    T
  )

  it('no event variable at all: nothing on stdout, exit 0', () => {
    const r = runScript({})
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }, T)

  it("outside nodeterm (no NODETERM_NODE_ID): the SAME answer, exit 0, and no POST", () => {
    for (const ev of ANTIGRAVITY_EVENTS) {
      const r = runScript({ event: ev, nodeId: null })
      expect(r.status, ev).toBe(0)
      expect(r.stdout, ev).toBe(`${antigravityDecisionFor(ev)}\n`)
      expect(r.stderr, ev).toBe('')
    }
    // Give a (wrongly) backgrounded POST time to land, then check none did.
    const r = runScript({ event: 'Stop', nodeId: null })
    sleep(1500)
    expect(existsSync(join(r.dir, 'curl.log'))).toBe(false)
  }, T)

  it('empty stdin: the answer, exit 0, and the event is still POSTed (with a {} payload)', () => {
    const r = runScript({ event: 'Stop', input: '' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('{"decision":""}\n')
    const posts = r.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain('nodeterm_hook_event=Stop')
    // The payload goes by file (payload@...), never on argv.
    expect(posts[0]).toMatch(/payload@/)
  }, T)

  it('a 200 KB payload: the answer, exit 0, no EPIPE, and the body stays off argv', () => {
    const big = JSON.stringify({ conversationId: 'c1', toolCall: { name: 'run_command', args: { blob: 'x'.repeat(200_000) } } })
    const r = runScript({ event: 'PreToolUse', input: big })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('{"decision":"ask"}\n')
    expect(r.stderr).toBe('')
    const posts = r.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].length).toBeLessThan(2000)
  }, T)

  it('nothing written AFTER the answer reaches stdout or stderr', () => {
    const r = runScript({
      event: 'PreToolUse',
      append: [
        'echo THIS-MUST-NOT-APPEAR',
        'printf "%s" "NOR-THIS" >&2',
        'ls /definitely/not/a/path',
        'curl --version'
      ].join('\n')
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('{"decision":"ask"}\n')
    expect(r.stderr).toBe('')
  }, T)

  it('an unreachable endpoint still ends with the answer only and exit 0', () => {
    // No endpoint file, no port, no socket: nt_request_post returns 1, the walk finds nothing.
    const r = runScript({ event: 'PreToolUse', noEndpoint: true })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('{"decision":"ask"}\n')
    expect(r.stderr).toBe('')
    sleep(1500)
    expect(existsSync(join(r.dir, 'curl.log'))).toBe(false)
  }, T)
})

describe('the hooks.json command (POSIX form)', () => {
  it('exports the event and answers from the table when the script is gone', () => {
    const cmd = buildManagedHookCommand('/h/.nodeterm/agent-hooks/antigravity.sh', {
      env: { [ANTIGRAVITY_EVENT_ENV]: 'PreToolUse' },
      fallbackStdout: '{"decision":"ask"}'
    })
    expect(cmd).toBe(
      "NODETERM_AGY_EVENT='PreToolUse'; export NODETERM_AGY_EVENT; " +
        "if [ -r '/h/.nodeterm/agent-hooks/antigravity.sh' ]; then sh '/h/.nodeterm/agent-hooks/antigravity.sh' || :; " +
        "else printf '%s\\n' '{\"decision\":\"ask\"}'; cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('is byte-identical for callers that pass no options', () => {
    expect(buildManagedHookCommand("/it's/claude.sh")).toBe(
      "if [ -r '/it'\\''s/claude.sh' ]; then sh '/it'\\''s/claude.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('refuses an env name that is not a name', () => {
    expect(() => buildManagedHookCommand('/x.sh', { env: { 'A;rm -rf /': 'v' } })).toThrow()
  })

  it.skipIf(!shAvailable)(
    'runs under sh: script present → script answers; script missing → command answers; both exit 0',
    () => {
      const dir = join(root, `cmd-${++seq}`)
      mkdirSync(dir, { recursive: true })
      const script = join(dir, 'antigravity.sh').replaceAll('\\', '/')
      const missing = join(dir, 'gone.sh').replaceAll('\\', '/')
      writeFileSync(script, buildManagedScript('antigravity', null), { encoding: 'utf8', mode: 0o755 })
      for (const ev of ANTIGRAVITY_EVENTS) {
        const answer = antigravityDecisionFor(ev)!
        for (const target of [script, missing]) {
          const cmd = buildManagedHookCommand(target, { env: { [ANTIGRAVITY_EVENT_ENV]: ev }, fallbackStdout: answer })
          const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir }
          const res = spawnSync('sh', ['-c', cmd], { input: '{"conversationId":"c"}', env, timeout: T })
          expect(res.status, `${ev} ${target}`).toBe(0)
          expect(res.stdout.toString(), `${ev} ${target}`).toBe(`${answer}\n`)
        }
      }
    },
    T
  )

  it.skipIf(!shAvailable)(
    'exits 0 even when the script fails AFTER answering (a broken endpoint file is sourced late)',
    () => {
      // The script answers FIRST, then sources the endpoint file. A syntax error there used to leak
      // out as `sh`'s exit status 2 — the right answer on stdout with a non-zero exit, a pair agy
      // was never measured on (silence + exit 1 is a measured DENY). The command forces 0.
      const dir = join(root, `cmd-${++seq}`)
      mkdirSync(dir, { recursive: true })
      const script = join(dir, 'antigravity.sh').replaceAll('\\', '/')
      writeFileSync(script, buildManagedScript('antigravity', null), { encoding: 'utf8', mode: 0o755 })
      const endpoint = join(dir, 'hook-endpoint.env')
      writeFileSync(endpoint, 'if then\n', 'utf8')
      const answer = antigravityDecisionFor('PreToolUse')!
      const cmd = buildManagedHookCommand(script, {
        env: { [ANTIGRAVITY_EVENT_ENV]: 'PreToolUse' },
        fallbackStdout: answer
      })
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        NODETERM_NODE_ID: 'term-agy-1',
        NODETERM_HOOK_ENDPOINT: endpoint
      }
      const res = spawnSync('sh', ['-c', cmd], { input: '{"conversationId":"c"}', env, timeout: T })
      expect(res.stdout.toString()).toBe(`${answer}\n`)
      expect(res.status).toBe(0)
    },
    T
  )
})

describe.skipIf(!shAvailable)('the POST never holds up the answer', () => {
  it('a stalled endpoint does not delay the script: the POST runs in the background', () => {
    // agy waits for the hook PROCESS to exit before it acts on the decision, and our handler's
    // timeout is ANTIGRAVITY_HOOK_TIMEOUT (5 s). A foreground POST against an endpoint that accepts
    // and never answers, plus the bounded fallback walk, measured ~6 s — past that timeout, on
    // every tool call. The fake curl here stalls for 6 s; the script must be long gone by then,
    // and the POST must still arrive afterwards.
    const r = runScript({ event: 'PreToolUse', curlDelaySec: 6 })
    expect(r.stdout).toBe(`${antigravityDecisionFor('PreToolUse')}\n`)
    expect(r.status).toBe(0)
    expect(r.elapsedMs).toBeLessThan(3000)
    const posts = r.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain('nodeterm_hook_event=PreToolUse')
  }, T)
})
