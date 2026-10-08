// Issue #629 — the invariant: **a test never touches the machine's live nodeterm tmux server.**
//
// This repo is developed from inside nodeterm, so `tmux -L node-terminal` and `-L nodeterm-rmt` are
// not names in a fixture — on a contributor's machine they are the servers holding every terminal
// they have open. A test that binds one shares a process with the user's entire canvas, and the
// failure mode is not a red test: it is every pane printing `[server exited unexpectedly]`.
//
// It is enforced three ways, deliberately, because each covers what the others cannot:
//
//   1. STRUCTURAL — `test/setup/tmux-sandbox.ts` gives the run a private `TMUX_TMPDIR`, which
//      re-points every socket name, the real ones included. This is the only leg that covers a test
//      nobody thought about.
//   2. BEHAVIOURAL — the third test below actually starts a server on the real socket NAME and
//      proves the socket file landed inside the sandbox. Asserting the environment variable would
//      only prove we set a variable; the resolution rule is a property of tmux.
//   3. BY REVIEW — the scan at the bottom lists the files that hand a real socket name to a real
//      tmux binary. It cannot stop a new one being written; it makes writing one a decision
//      somebody signs for, the way `fs-atomic.guard.test.ts` does for a bare rename.
//
// The scan is the weakest of the three ON PURPOSE. A test can still escape the sandbox by handing a
// real tmux an `env` object it built from scratch (with no `TMUX_TMPDIR` in it), and no regex sees
// that reliably; the allowlist is what keeps such a file rare and reviewed.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import { SANDBOX_ENV, tmuxSocketPath } from './tmux-test-socket'

const REPO_ROOT = join(__dirname, '..', '..')
const TEST_ROOTS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'test')]
const UID = process.getuid?.() ?? 0
const HAS_TMUX = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('the run cannot reach a live nodeterm tmux server', () => {
  it('runs inside a private TMUX_TMPDIR', () => {
    const sandbox = process.env[SANDBOX_ENV]
    expect(sandbox, 'globalSetup did not create the tmux sandbox').toBeTruthy()
    expect(process.env.TMUX_TMPDIR).toBe(sandbox)
    expect(existsSync(sandbox!)).toBe(true)
    // `/tmp` is what an unset `TMUX_TMPDIR` resolves to, and it is where the live servers are.
    expect(tmuxSocketPath(sandbox!, UID, TMUX_SOCKET)).not.toBe(
      tmuxSocketPath('/tmp', UID, TMUX_SOCKET)
    )
  })

  it('inherits no ambient tmux client', () => {
    // Both are set for every process inside a nodeterm terminal — i.e. for the suite as it is
    // normally run in this repo.
    expect(process.env.TMUX).toBeUndefined()
    expect(process.env.TMUX_PANE).toBeUndefined()
  })

  it.skipIf(!HAS_TMUX || process.platform === 'win32')(
    'binds the REAL socket name inside the sandbox — measured, not inferred from the env',
    () => {
      const sandbox = process.env[SANDBOX_ENV]!
      // Its OWN session, killed by exact target. NOT `kill-server`: inside the sandbox this socket
      // name is shared with `main/remote/host-destroy-tmux.test.ts`, which binds it too (it has no
      // choice — `PtyManager` hardcodes the name), and killing the server took that suite's session
      // out from under it on CI. The sandbox moves the shared server somewhere harmless; it does
      // not stop a `kill-server` from being a SHARED-server kill once you are in there.
      const session = `nt-isolation-guard-${process.pid}`
      const tmux = (args: string[]): void => {
        execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' })
      }
      try {
        tmux(['new-session', '-d', '-s', session, 'sleep', '30'])
        expect(existsSync(tmuxSocketPath(sandbox, UID, TMUX_SOCKET))).toBe(true)
      } finally {
        try {
          // `=` is an exact match: without it tmux falls back to fnmatch and then to PREFIX
          // matching, so a miss could kill somebody else's session.
          tmux(['kill-session', '-t', `=${session}`])
        } catch {
          /* never started */
        }
      }
    }
  )
})

/**
 * Files allowed to name a real nodeterm socket to a real tmux, each with the reason.
 *
 * Both are here because the NAME is part of what they measure, not because nobody got round to
 * changing them. Each must also carry `TMUX_TMPDIR` in its own text — the sandbox is the floor, and
 * a file that deliberately names a live socket owes an explicit statement of where it binds.
 */
const REAL_SOCKET_ALLOWED = new Map<string, string>([
  [
    'src/core/managed-pane.realtmux.test.ts',
    'measures the canonical managed receipt and production paste bytes in its OWN private TMUX_TMPDIR; kills only its owned exact session'
  ],
  [
    'src/core/agents/pane-owner.test.ts',
    'the production bytes hardcode `-L nodeterm-rmt`; re-spelling it would judge different bytes'
  ],
  [
    'src/main/remote/host-destroy-tmux.test.ts',
    'PtyManager binds TMUX_SOCKET itself, so the verb can only be measured on that name'
  ],
  [
    'test/server/canvas-control-boot-e2e.test.ts',
    'boots a real Server Edition, whose PtyManager binds TMUX_SOCKET itself: the assertion is that ' +
      'boot spawns NOTHING, and only that socket can answer it. Reads with has-session and kills ' +
      'one per-run unique nt-<uuid> target — never a broad target and never the server itself.'
  ]
])

/**
 * An exec of a real tmux whose argv begins `-L <a real nodeterm socket>`.
 *
 * Deliberately narrow: `['-L', 'node-terminal', …]` appears all over the suite as an EXPECTATION
 * against a faked `execFile`, and a scan that flagged those would be switched off within a week.
 * What it matches is the program-plus-argv adjacency, which only a real spawn has.
 */
const REAL_SOCKET_EXEC =
  /(?:execFile|execFileSync|spawn|spawnSync|run|runAsync)\s*\(\s*[^,()]*,\s*\[\s*'-L',\s*(?:TMUX_SOCKET|RMT_TMUX_SOCKET|'node-terminal'|'nodeterm-rmt')/

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') testFiles(p, out)
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

describe('no unreviewed test hands a real socket name to a real tmux', () => {
  const files = TEST_ROOTS.filter((r) => existsSync(r)).flatMap((r) => testFiles(r))

  it('finds the test tree (a zero-file scan would pass silently)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('matches the construction it is meant to catch, and not the expectations beside it', () => {
    // The lesson from fs-atomic.guard.test.ts: a scan nobody proved can match anything reads
    // exactly like a scan with nothing to find.
    expect(REAL_SOCKET_EXEC.test("await run(TMUX!, ['-L', TMUX_SOCKET, 'has-session'])")).toBe(true)
    expect(REAL_SOCKET_EXEC.test("execFileSync(bin, ['-L', 'nodeterm-rmt', 'ls'])")).toBe(true)
    expect(
      REAL_SOCKET_EXEC.test("expect(kills).toEqual([['-L', 'node-terminal', 'kill-session']])")
    ).toBe(false)
  })

  it('flags every offender that is not allowlisted', () => {
    // This file is skipped rather than allowlisted: it matches only because it spells the pattern
    // out in the positive control above, and an allowlist entry would read as permission to run a
    // real tmux from here.
    const self = relative(REPO_ROOT, __filename).replace(/\\/g, '/')
    const offenders = files
      .filter((f) => REAL_SOCKET_EXEC.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'))
      .filter((rel) => rel !== self && !REAL_SOCKET_ALLOWED.has(rel))
    expect(offenders).toEqual([])
  })

  it('every allowlisted file still exists and says where it binds', () => {
    for (const [rel] of REAL_SOCKET_ALLOWED) {
      const p = join(REPO_ROOT, rel)
      expect(existsSync(p), `${rel} is allowlisted but gone — drop the entry`).toBe(true)
      expect(readFileSync(p, 'utf8'), `${rel} must say which TMUX_TMPDIR it binds in`).toContain(
        'TMUX_TMPDIR'
      )
    }
  })

  it('the socket names the scan spells are still the production ones', () => {
    // The regex carries the two names as literals so it can read a test that hardcodes them. If a
    // constant is ever renamed, this is what says the scan went blind.
    expect(TMUX_SOCKET).toBe('node-terminal')
    expect(RMT_TMUX_SOCKET).toBe('nodeterm-rmt')
  })
})
