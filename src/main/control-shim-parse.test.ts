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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONTROL_SHIM_SCRIPT } from './canvas-control-core'

let dir = ''

/** Run the shim and return the `arg.<name>=<value>` pairs it handed curl, in order. */
const run = (args: string[]): string[] => {
  const log = path.join(dir, 'argv.log')
  fs.writeFileSync(log, '')
  execFileSync('sh', [path.join(dir, 'shim.sh'), ...args], {
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_HOOK_PORT: '1',
      NODETERM_NODE_ID: 'n1',
      NT_ARGV_LOG: log,
      HOME: dir
    },
    encoding: 'utf8'
  })
  // One argv element per line; keep only the translated pairs (`nodeId=…` and curl's own flags
  // are not part of what this file is about).
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('arg.'))
}

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
