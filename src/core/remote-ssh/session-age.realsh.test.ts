// The generated `#{session_created}` line, executed by a REAL /bin/sh against a stub tmux.
//
// It is generated shell that no compiler checks, and its job is to produce TWO epoch numbers on the
// HOST so the caller never has to subtract two different clocks. The failure this guards is the one
// the session-memory work already hit once: a plan whose `echo ##MEM` printed an EMPTY LINE under
// POSIX sh, so every healthy host reported a failure. Only running it catches that.
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { remoteSessionAgeArgs, parseSessionAge } from './control-master'
import { testTmpDir } from '../test-tmp'

const conn = { host: 'h.example.com', user: 'deploy' }
let binDir: string

/** The last argv element of an `ssh …` argv IS the remote command line. */
function remoteCommand(args: string[]): string {
  return args[args.length - 1]
}

/** Run that line under a real /bin/sh with a stub `tmux` that answers `created`. */
function runWithTmuxAnswer(line: string, created: string): string {
  fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\nprintf '%s' '${created}'\n`, { mode: 0o755 })
  return execFileSync('/bin/sh', ['-c', line], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf8'
  })
}

beforeAll(() => {
  binDir = testTmpDir('ntage-')
})

describe('remoteSessionAgeArgs (real /bin/sh)', () => {
  it('prints the tmux stamp and the HOST clock on one line, so the age needs one clock', () => {
    const line = remoteCommand(remoteSessionAgeArgs(conn, '/cm/p1', 'nt-abc'))
    const now = Math.floor(Date.now() / 1000)
    const out = runWithTmuxAnswer(line, String(now - 3))
    const [created, hostNow] = out.trim().split(/\s+/)
    expect(Number(created)).toBe(now - 3)
    expect(Number(hostNow)).toBeGreaterThanOrEqual(now)
    expect(parseSessionAge(out)).toBeGreaterThanOrEqual(3)
  })

  it('a session tmux cannot find yields no age — the empty format leaves ONE field', () => {
    // Measured against a real sshd + tmux 3.3a: an unknown target prints an empty first field, so
    // the line comes back as just the host clock. `parseSessionAge` must read that as "no answer",
    // never as an epoch — the caller ACTS on a small number.
    const line = remoteCommand(remoteSessionAgeArgs(conn, '/cm/p1', 'nt-nope'))
    const out = runWithTmuxAnswer(line, '')
    expect(out.trim().split(/\s+/)).toHaveLength(1)
    expect(parseSessionAge(out)).toBeNull()
  })

  it('carries the PATH prologue, so a host with tmux outside the exec-channel PATH still answers', () => {
    // Issue #449: an ssh exec channel gets a non-login shell, and Homebrew's tmux lives in
    // /opt/homebrew/bin. Every remote tmux invocation goes through the same prologue.
    const line = remoteCommand(remoteSessionAgeArgs(conn, '/cm/p1', 'nt-abc'))
    expect(line).toContain('/opt/homebrew/bin')
  })

  it('targets EXACTLY one session — tmux prefix matching could answer about another node', () => {
    const line = remoteCommand(remoteSessionAgeArgs(conn, '/cm/p1', 'nt-abc'))
    expect(line).toContain("-t '=nt-abc:'")
  })
})

describe('parseSessionAge', () => {
  it('reads a well-formed pair', () => {
    expect(parseSessionAge('1000 1042\n')).toBe(42)
    expect(parseSessionAge('  1000   1000  ')).toBe(0)
  })

  it('answers null for everything it cannot read as two epochs', () => {
    for (const bad of ['', '\n', 'abc def', '1000', '1000 abc', 'abc 1000', '0 1000', '1000 0']) {
      expect(parseSessionAge(bad)).toBeNull()
    }
  })

  it('a clock that stepped BACKWARDS is unknowable, not brand new', () => {
    // The caller acts on a small age, so a negative must never round to zero.
    expect(parseSessionAge('1042 1000')).toBeNull()
  })
})
