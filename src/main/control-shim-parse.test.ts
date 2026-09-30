// The REAL shim, under REAL `sh`, with a FAKE `curl` that records its argv.
//
// A TypeScript re-implementation of the `--*` loop would assert what we THINK the loop does, and
// the whole bug this file pins is the gap between what it does and what everyone believes it does.
// So the script is executed, not modelled.
//
// Why the fake curl logs to a FILE rather than printing its argv: the shim captures curl's stdout
// in a command substitution (`nt_code=$(… | curl …)`) to read `-w '%{http_code}'`. Anything the
// fake printed on stdout would land in `nt_code`, the shim would treat the run as a non-200
// failure and exit 1, and every case here would fail for a reason that has nothing to do with
// parsing. stderr is no good either — the shim sends curl's stderr to /dev/null.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONTROL_SHIM_SCRIPT } from '../core/canvas-control-core'
import { runNowRequested } from '../shared/control-verbs'
import { REQUEST_ID_VERBS, isValidRequestId, requestIdAnnounceLine } from '../core/control-request-ledger'

let dir = ''

/** Run the shim and return every argv element it handed curl, one per line. */
const runRaw = (args: string[], extraBin?: string): string[] => {
  const log = path.join(dir, 'argv.log')
  fs.writeFileSync(log, '')
  execFileSync('sh', [path.join(dir, 'shim.sh'), ...args], {
    env: {
      PATH: `${extraBin ? `${extraBin}:` : ''}${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_HOOK_PORT: '1',
      NODETERM_NODE_ID: 'n1',
      NT_ARGV_LOG: log,
      HOME: dir
    },
    encoding: 'utf8'
  })
  return fs.readFileSync(log, 'utf8').split('\n')
}

/** Run the shim and return the `arg.<name>=<value>` pairs it handed curl, in order. */
// Only the translated pairs: `nodeId=…`, `requestId=…` and curl's own flags are not part of what
// this file is about.
const run = (args: string[]): string[] => runRaw(args).filter((l) => l.startsWith('arg.'))

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlshim-'))
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'shim.sh'), CONTROL_SHIM_SCRIPT, { mode: 0o755 })
  // A curl that drains the header config off stdin, records its argv, and reports 200 so the shim
  // takes its success path. `-o <file>` is left as mktemp made it: empty, which the shim prints.
  fs.writeFileSync(
    path.join(dir, 'bin', 'curl'),
    '#!/bin/sh\ncat >/dev/null\nfor a in "$@"; do printf \'%s\\n\' "$a"; done >> "$NT_ARGV_LOG"\necho 200\n',
    { mode: 0o755 }
  )
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// The per-RUN request id: what lets the server recognise the shim's own endpoint-walk re-post as
// the SAME call rather than a second open (src/core/control-request-ledger.ts). One run = one id,
// on every POST of that run; two runs = two ids, because a second run is a second call.
describe('the control shim tags each run with its own request id', () => {
  const ids = (args: string[], extraBin?: string): string[] =>
    runRaw(args, extraBin)
      .filter((l) => l.startsWith('requestId='))
      .map((l) => l.slice('requestId='.length))

  it('sends exactly one well-formed id per POST, and never as an arg', () => {
    const got = ids(['open-agent', '--agent', 'claude'])
    expect(got).toHaveLength(1)
    expect(isValidRequestId(got[0])).toBe(true)
    expect(run(['open-agent', '--agent', 'claude'])).toEqual(['arg.agent=claude'])
  })

  it('two runs get two different ids', () => {
    const [a] = ids(['open-terminal'])
    const [b] = ids(['open-terminal'])
    expect(a).not.toBe(b)
  })

  it('with no working od (no random source), it still sends a well-formed id', () => {
    const noOd = path.join(dir, 'no-od')
    fs.mkdirSync(noOd, { recursive: true })
    fs.writeFileSync(path.join(noOd, 'od'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const got = ids(['open-terminal'], noOd)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatch(/^cli-\d+-\d+$/)
    expect(isValidRequestId(got[0])).toBe(true)
  })

  // Review follow-up to #1033: an agent's own tool call is usually killed at 120 s — the same
  // instant the app gives up — so the reply naming the id may never be seen. The id is therefore
  // printed to stderr BEFORE the POST, for every verb the ledger covers, and only when the caller did
  // not pass its own (then it already knows it) and it is not a dry run (which claims nothing).
  it('announces the per-run id on stderr before posting, for exactly the verbs the ledger covers', () => {
    const stderrOf = (args: string[]): string =>
      spawnSync('sh', [path.join(dir, 'shim.sh'), ...args], {
        env: {
          PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
          NODETERM_CANVAS_CONTROL: '1',
          NODETERM_HOOK_PORT: '1',
          NODETERM_NODE_ID: 'n1',
          NT_ARGV_LOG: path.join(dir, 'argv.log'),
          HOME: dir
        },
        encoding: 'utf8'
      }).stderr
    for (const verb of REQUEST_ID_VERBS) {
      const err = stderrOf([verb])
      const posted = ids([verb])
      expect(err, verb).toMatch(/^request id: cli-/)
      // The announced id is well-formed and has the exact announced shape.
      const announced = /^request id: (\S+) /.exec(err)?.[1] ?? ''
      expect(isValidRequestId(announced), verb).toBe(true)
      expect(err, verb).toContain(requestIdAnnounceLine(announced))
      expect(posted, verb).toHaveLength(1)
    }
    expect(stderrOf(['rename', '--node', 'n1', '--title', 't'])).not.toMatch(/request id:/)
    expect(stderrOf(['list'])).not.toMatch(/request id:/)
    expect(stderrOf(['open-agent', '--agent', 'claude', '--request-id', 'mine-1'])).not.toMatch(/request id:/)
    expect(stderrOf(['open-agent', '--agent', 'claude', '--request-id=mine-1'])).not.toMatch(/request id:/)
    expect(stderrOf(['spawn-team', '--dry-run', '--team', '[]'])).not.toMatch(/request id:/)
  })

  it('an explicit --request-id rides as an ordinary arg next to the per-run id', () => {
    expect(run(['open-terminal', '--request-id', 'wave1-a'])).toEqual(['arg.request-id=wave1-a'])
    expect(ids(['open-terminal', '--request-id', 'wave1-a'])).toHaveLength(1)
  })
})

describe('the control shim translates flags', () => {
  it('a --flag followed by another --flag does NOT eat it', () => {
    // THE BUG: this used to yield ['arg.read=--node'] and `b1` was lost with no error anywhere.
    expect(run(['browser', '--read', '--node', 'b1'])).toEqual(['arg.read=', 'arg.node=b1'])
  })

  it('a valueless flag in the middle of a line is expressible', () => {
    expect(run(['open-terminal', '--count', '2', '--verbose', '--cwd', '/tmp'])).toEqual([
      'arg.count=2',
      'arg.verbose=',
      'arg.cwd=/tmp'
    ])
  })

  it('--flag=value is the escape for a value that starts with --', () => {
    expect(run(['open-terminal', '--cmd=--version'])).toEqual(['arg.cmd=--version'])
  })

  it('--flag=value splits on the FIRST = so the value may contain more of them', () => {
    expect(run(['open-terminal', '--cmd=env A=1 B=2'])).toEqual(['arg.cmd=env A=1 B=2'])
  })

  it('--flag= is an explicit empty value', () => {
    expect(run(['rename', '--node', 'n1', '--title='])).toEqual(['arg.node=n1', 'arg.title='])
  })

  // `--dry-run` is valueless and usually mid-line (issue #532): the peek must leave the next
  // `--flag` alone and translate it to an explicit empty `arg.dry-run=`.
  it('--dry-run rides as a valueless flag anywhere on the line', () => {
    expect(run(['spawn-team', '--dry-run', '--team', '[]'])).toEqual([
      'arg.dry-run=',
      'arg.team=[]'
    ])
  })

  it('--run-now last on the line rides as an empty value; =1 carries it explicitly (#925)', () => {
    expect(run(['open-agent', '--agent', 'claude', '--project', 'p2', '--run-now'])).toEqual([
      'arg.agent=claude',
      'arg.project=p2',
      'arg.run-now='
    ])
    expect(run(['open-agent', '--run-now=1', '--agent', 'claude'])).toEqual([
      'arg.run-now=1',
      'arg.agent=claude'
    ])
  })

  // The agent docs say "put --run-now LAST on the line (either form)", and this is the measurement
  // behind it. The loop below is the shim's `--*` branch as it shipped BEFORE b7f19f64
  // (2026-08-15), copied verbatim: it took the token after any `--flag` as that flag's value and
  // had no `--*=*` branch. An SSH host keeps whatever shim it got at its last connect, so this
  // loop can still be what an agent there runs. Executed under real `sh`, not modelled.
  it('on the pre-2026-08-15 shim loop --run-now survives only LAST on the line, in either form (#925)', () => {
    const oldLoop = [
      'nt_count=$#',
      'nt_i=0',
      'while [ "$nt_i" -lt "$nt_count" ]; do',
      '  nt_a="$1"; shift; nt_i=$((nt_i + 1))',
      '  case "$nt_a" in',
      '    --*)',
      '      nt_k=${nt_a#--}',
      '      nt_v=""',
      '      if [ "$nt_i" -lt "$nt_count" ]; then nt_v="$1"; shift; nt_i=$((nt_i + 1)); fi',
      '      set -- "$@" --data-urlencode "arg.$nt_k=$nt_v"',
      '      ;;',
      '  esac',
      'done',
      'for a in "$@"; do case "$a" in arg.*) printf \'%s\\n\' "$a" ;; esac; done'
    ].join('\n')
    // What the server reads: curl's `--data-urlencode name=content` splits on the FIRST `=`.
    const oldShim = (flags: string[]): Record<string, string> =>
      Object.fromEntries(
        execFileSync('sh', ['-c', oldLoop, 'sh', ...flags], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map((pair) => {
            const at = pair.indexOf('=')
            return [pair.slice('arg.'.length, at), pair.slice(at + 1)]
          })
      )
    // Last on the line: both forms are on, and nothing is lost.
    for (const last of ['--run-now', '--run-now=1']) {
      const args = oldShim(['--agent', 'claude', '--project', 'p2', last])
      expect(runNowRequested(args), last).toBe(true)
      expect(args.agent, last).toBe('claude')
      expect(args.project, last).toBe('p2')
    }
    // Mid-line: either form swallows the next flag, and its value is dropped as a stray positional.
    for (const mid of ['--run-now', '--run-now=1']) {
      const args = oldShim([mid, '--agent', 'claude'])
      expect(args.agent, mid).toBeUndefined()
    }
  })

  it('run takes its node positionally, like rename (#925)', () => {
    expect(run(['run', 'n7'])).toEqual(['arg.node=n7'])
  })

  // Hyphenated flag names ride through as-is — the loop strips only the leading `--`, so
  // `--prompt-file` lands as `arg.prompt-file` and the server reads args['prompt-file'].
  it('a hyphenated flag name (--prompt-file) keeps its hyphen in the arg key', () => {
    expect(run(['open-claude', '--prompt-file', '/tmp/brief.md'])).toEqual([
      'arg.prompt-file=/tmp/brief.md'
    ])
  })

  // The peek tests for `--`, not for `-`: a single-dash token is a VALUE. `--scroll -600` must
  // keep working, or the fix trades one silent misparse for another.
  it('a negative number is still consumed as a value', () => {
    expect(run(['browser', '--scroll', '-600'])).toEqual(['arg.scroll=-600'])
  })

  it('an ordinary --flag value pair is unchanged', () => {
    expect(run(['open-agent', '--agent', 'codex', '--count', '3'])).toEqual([
      'arg.agent=codex',
      'arg.count=3'
    ])
  })

  it('a value containing spaces, quotes and = survives intact', () => {
    expect(run(['rename', '--node', 'n1', '--title', 'a b="c" d'])).toEqual([
      'arg.node=n1',
      'arg.title=a b="c" d'
    ])
  })

  // Order is the order the tokens were translated in, so the positional comes first here. It is
  // asserted because the loop's accumulator (originals off the front, pairs onto the back) is the
  // subtle part of this script and a reordering would mean the drain went wrong.
  it('the bare positional forms still work', () => {
    expect(run(['write', 'n7', '--text', 'hi'])).toEqual(['arg.node=n7', 'arg.text=hi'])
    expect(run(['color', 'n7,n8', '--color', '#32d74b'])).toEqual([
      'arg.node=n7,n8',
      'arg.color=#32d74b'
    ])
  })

  // Task 5.4: the messaging verbs take the same "first bare word is the node" convenience —
  // executed under real sh, because the case pattern is the easy thing to typo and the string
  // assertion in canvas-control-core.test.ts cannot see a broken glob.
  it('send/reply map the bare positional onto arg.node too', () => {
    expect(run(['send', 'b1', '--text', 'hi'])).toEqual(['arg.node=b1', 'arg.text=hi'])
    expect(run(['reply', 'b1', '--text', 'done'])).toEqual(['arg.node=b1', 'arg.text=done'])
  })

  it('a trailing flag with no value is still empty, as it always was', () => {
    expect(run(['rename', '--node', 'n1', '--title'])).toEqual(['arg.node=n1', 'arg.title='])
  })

  // The regression the fix deliberately takes, pinned so nobody "fixes" it back by accident.
  it('a --value passed as a separate token becomes its own flag — use the = form', () => {
    expect(run(['write', '--node', 'n1', '--text', '--oops'])).toEqual([
      'arg.node=n1',
      'arg.text=',
      'arg.oops='
    ])
    expect(run(['write', '--node', 'n1', '--text=--oops'])).toEqual([
      'arg.node=n1',
      'arg.text=--oops'
    ])
  })
})
