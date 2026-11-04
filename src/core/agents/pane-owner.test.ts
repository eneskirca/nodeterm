// The pure parsers, then the same parsers against a REAL tmux pane.
//
// The `ps` fixtures below are not invented: they are literal output captured on this host while
// writing the module (Linux 6.8, procps-ng 4.0.4), which is why they carry a `stat` column and why
// the foreground group is found through its `+` flag rather than through `tpgid`. See the module
// docblock for what was measured and what it ruled out.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  COMBINED_PANE_MARKER,
  PANE_OWNER_FMT,
  foregroundArgvArgs,
  foregroundPgid,
  isSafeTty,
  paneOwnerFrom,
  parseCombinedPaneOwner,
  parseForegroundArgv,
  parsePaneOwner
} from './pane-owner'
import { remotePaneOwnerCombinedArgs } from '../remote-ssh/control-master'

describe('PANE_OWNER_FMT', () => {
  it('asks for pid, tty, current command and the pane id in one round-trip', () => {
    expect(PANE_OWNER_FMT).toBe('#{pane_pid}|#{pane_tty}|#{pane_current_command}|#{pane_id}')
  })
})

describe('parsePaneOwner', () => {
  it('parses a well-formed line', () => {
    expect(parsePaneOwner('4242|/dev/pts/9|claude|%17')).toEqual({
      panePid: 4242,
      tty: '/dev/pts/9',
      command: 'claude',
      paneId: '%17'
    })
  })

  it('still parses a three-field read — an older format string is not a broken one', () => {
    // `#{pane_id}` is appended, so a tmux that expands it to nothing (or a caller still sending the
    // old format) degrades to exactly the three fields this parser always had.
    expect(parsePaneOwner('4242|/dev/pts/9|claude')).toEqual({
      panePid: 4242,
      tty: '/dev/pts/9',
      command: 'claude'
    })
  })

  it('drops a pane id that is not tmux-shaped rather than carrying a garbage one', () => {
    // `samePane` reads an ABSENT id as "cannot confirm" and refuses. A garbage id that compared
    // equal to another garbage id would read as "confirmed", which is the dangerous direction.
    for (const bad of ['', '17', 'pane17', '%', '%1x']) {
      expect(parsePaneOwner(`4242|/dev/pts/9|claude|${bad}`)?.paneId).toBeUndefined()
    }
  })

  it('tolerates the trailing newline a real display-message writes', () => {
    expect(parsePaneOwner('4242|/dev/pts/9|node\n')?.command).toBe('node')
  })

  // Unknown is never evidence of a particular command — paneCommand's contract, verbatim.
  it.each(['', '   ', 'notanumber|/dev/pts/9|claude', '0|/dev/pts/9|claude', '4242', '4242||claude', '4242|/dev/pts/9|'])(
    'answers null for %j rather than guessing',
    (s) => {
      expect(parsePaneOwner(s)).toBeNull()
    }
  )

  it('answers null for a missing read rather than throwing', () => {
    expect(parsePaneOwner(null)).toBeNull()
    expect(parsePaneOwner(undefined)).toBeNull()
  })
})

describe('isSafeTty', () => {
  it.each(['/dev/pts/0', '/dev/ttys004', 'pts/9'])('accepts the real thing: %s', (t) => {
    expect(isSafeTty(t)).toBe(true)
  })
  it.each(['', '/dev/pts/0; rm -rf ~', '/dev/pts/$(id)', '/dev/../etc/passwd', '/dev/pts/0 && x', '/dev/pts/`id`'])(
    'refuses %j — nothing shell-live reaches a command line',
    (t) => {
      expect(isSafeTty(t)).toBe(false)
    }
  )

  it('refuses an absurdly long tty — a bounded value, not just a well-charactered one', () => {
    // Charset-clean and therefore past every other check, but no pty path is anywhere near this.
    // The cost of not capping is DoS-shaped (a megabyte argv on the remote command line), which is
    // why it is a cap rather than a pattern.
    const long = `/dev/pts/${'0'.repeat(200)}`
    expect(/^[A-Za-z0-9/._-]+$/.test(long)).toBe(true)
    expect(isSafeTty(long)).toBe(false)
    expect(isSafeTty(`/dev/pts/${'0'.repeat(100)}`)).toBe(true)
  })
})

describe('foregroundArgvArgs', () => {
  it('is one ps call on the pane tty, wide enough that BSD does not truncate the argv', () => {
    expect(foregroundArgvArgs('/dev/pts/0')).toEqual({
      bin: 'ps',
      args: ['-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'args=', '-t', '/dev/pts/0']
    })
  })

  it('gives each keyword its OWN -o, because a comma list is one column on the BSDs', () => {
    // FreeBSD parsefmt(): an item containing `=` is a column HEADER and is always the last item, so
    // `-o pid=,pgid=,stat=,args=` asks for the single keyword `pid` with the header
    // `,pgid=,stat=,args=` — one column, exit 0, a read that silently never works. The SSH leg runs
    // this on the remote host, and FreeBSD/TrueNAS/pfSense is an ordinary SSH target.
    const args = foregroundArgvArgs('/dev/pts/0')!.args
    expect(args.filter((a) => a === '-o')).toHaveLength(4)
    expect(args.some((a) => a.includes(','))).toBe(false)
  })
  it('refuses to build a command line around an unsafe tty', () => {
    expect(foregroundArgvArgs('/dev/pts/0; id')).toBeNull()
  })
})

// Captured verbatim from `ps -ww -o pid=,pgid=,stat=,args= -t /dev/pts/0` while a pipeline ran in a
// real tmux pane. `Ss` (no `+`) is the pane's own shell; the `S+` rows are the foreground group.
const REAL_PS = [
  '2485382 2485382 Ss   -bash',
  '2489089 2489089 S+   /bin/sh -c sleep 200 | cat',
  '2489091 2489089 S+   sleep 200',
  '2489092 2489089 S+   cat'
].join('\n')

describe('foregroundPgid', () => {
  it('reads the foreground group off the + flag, not off the pane shell', () => {
    expect(foregroundPgid(REAL_PS)).toBe(2489089)
  })
  it('answers null when nothing is marked foreground', () => {
    expect(foregroundPgid('2485382 2485382 Ss   -bash')).toBeNull()
  })
  it('answers null on garbage and on nothing at all', () => {
    expect(foregroundPgid('<<ps: illegal option>>')).toBeNull()
    expect(foregroundPgid('')).toBeNull()
    expect(foregroundPgid(null)).toBeNull()
  })
})

describe('parseForegroundArgv', () => {
  it('returns every argv in the group, group leader first', () => {
    expect(parseForegroundArgv(REAL_PS, 2489089)).toEqual([
      '/bin/sh -c sleep 200 | cat',
      'sleep 200',
      'cat'
    ])
  })

  it('ignores rows from another pgid — a backgrounded job shares the tty', () => {
    expect(parseForegroundArgv(REAL_PS, 2489089)).toHaveLength(3)
    expect(parseForegroundArgv(REAL_PS, 2489089).join('\n')).not.toContain('-bash')
  })

  it('keeps the full argv, so the script path an interpreter runs is still there', () => {
    const ps = '2503294 2503294 Sl+  node /home/u/.npm/bin/claude --resume x'
    expect(parseForegroundArgv(ps, 2503294)).toEqual(['node /home/u/.npm/bin/claude --resume x'])
  })

  it('answers [] on garbage — never throws, never partially guesses', () => {
    expect(parseForegroundArgv('<<ps: illegal option>>', 4243)).toEqual([])
    expect(parseForegroundArgv(REAL_PS, 0)).toEqual([])
    expect(parseForegroundArgv(null, 4243)).toEqual([])
  })
})

describe('paneOwnerFrom', () => {
  const identity = { panePid: 2485382, tty: '/dev/pts/0', command: 'sh' }

  it('joins the two round-trips into one owner, argv and pids row-for-row', () => {
    expect(paneOwnerFrom(identity, REAL_PS)).toEqual({
      ...identity,
      argv: ['/bin/sh -c sleep 200 | cat', 'sleep 200', 'cat'],
      pids: [2489089, 2489091, 2489092]
    })
  })

  it('pairs each pid with ITS OWN argv row, and excludes the pane shell from both', () => {
    // The property `agentPidIn` depends on: index i of `pids` is the process that ran `argv[i]`.
    // The pane's own `-bash` (2485382, not in the foreground group) must appear in neither.
    const owner = paneOwnerFrom(identity, REAL_PS)!
    expect(owner.pids).toEqual([2489089, 2489091, 2489092])
    expect(owner.argv).toEqual(['/bin/sh -c sleep 200 | cat', 'sleep 200', 'cat'])
    for (let i = 0; i < owner.argv.length; i++) {
      expect(REAL_PS).toContain(`${owner.pids![i]} 2489089 S+   ${owner.argv[i]}`)
    }
    expect(owner.pids).not.toContain(2485382)
  })

  it('answers null rather than an owner with an empty argv', () => {
    // A PaneOwner carrying no argv would read to isAgentPane as "the kernel answered" and then as
    // `unknown` anyway — but the two must not be able to diverge, so the null happens HERE, once.
    expect(paneOwnerFrom(identity, '')).toBeNull()
    expect(paneOwnerFrom(identity, '2485382 2485382 Ss   -bash')).toBeNull()
    expect(paneOwnerFrom(null, REAL_PS)).toBeNull()
  })
})

/**
 * THE REAL PANE (Global Constraint 9).
 *
 * Everything above trusts our own fixtures. This drives a real tmux server on a socket of its own,
 * runs a real command in a real pane, and asks the real `ps` — so the format string, the `ps`
 * columns and the `+` flag are judged by the programs that produce them, not by us.
 *
 * tmux allocates the pane's pty itself, so no node-pty wrapper is needed to make this real: the
 * process under test genuinely has a controlling terminal and a foreground process group.
 *
 * The tmux server is entirely private: its own socket, in its own `TMUX_TMPDIR`, removed with the
 * directory in afterAll. Nothing here can see — let alone touch — the app's `node-terminal` socket
 * or an SSH project's `nodeterm-rmt` one, and nothing is left behind in the shared `/tmp/tmux-<uid>`
 * of a host that may be running other people's sessions.
 */
const tmuxBin = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()

const TMUX_TMPDIR = tmuxBin ? fs.mkdtempSync(path.join(os.tmpdir(), 'nt-paneowner-')) : ''
const tmux = (...args: string[]) =>
  execFileSync(tmuxBin as string, ['-L', 'probe', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TMUX_TMPDIR }
  })

afterAll(() => {
  if (!tmuxBin) return
  try {
    tmux('kill-server')
  } catch {
    // already gone — the server exits on its own when the last session dies
  }
  fs.rmSync(TMUX_TMPDIR, { recursive: true, force: true })
})

describe.skipIf(!tmuxBin)('against a real tmux pane', () => {
  it('finds the command actually running in the pane, which pane_current_command cannot name', () => {
    tmux('new-session', '-d', '-s', 'owner', 'sh')
    // A distinctive argv the pane's shell could never be confused with.
    tmux('send-keys', '-t', 'owner', 'sleep 411', 'Enter')
    // The pane's shell forks and execs asynchronously; poll rather than sleep a fixed time.
    let argv: string[] = []
    let identity: ReturnType<typeof parsePaneOwner> = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      identity = parsePaneOwner(tmux('display-message', '-p', '-t', 'owner', PANE_OWNER_FMT))
      if (identity) {
        const call = foregroundArgvArgs(identity.tty)
        expect(call).not.toBeNull()
        const out = execFileSync(call!.bin, call!.args, { encoding: 'utf8', timeout: 10_000 })
        const pgid = foregroundPgid(out)
        if (pgid !== null) argv = parseForegroundArgv(out, pgid)
      }
      if (argv.some((a) => a.includes('sleep 411'))) break
    }
    expect(identity).not.toBeNull()
    expect(identity!.panePid).toBeGreaterThan(0)
    expect(identity!.tty).toMatch(/^\/dev\//)
    expect(argv.join('\n')).toContain('sleep 411')
    // And the pane's own shell — which is NOT in the foreground group — is not reported as owner.
    expect(argv.every((a) => !/(^|\/)-?sh$/.test(a))).toBe(true)
  }, 30_000)

  it('reports the pane shell as owner once the command finishes, so an idle pane is never an agent', () => {
    tmux('new-session', '-d', '-s', 'idle', 'sh')
    let argv: string[] = []
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const identity = parsePaneOwner(tmux('display-message', '-p', '-t', 'idle', PANE_OWNER_FMT))
      if (identity) {
        const call = foregroundArgvArgs(identity.tty)!
        const out = execFileSync(call.bin, call.args, { encoding: 'utf8', timeout: 10_000 })
        const pgid = foregroundPgid(out)
        if (pgid !== null) argv = parseForegroundArgv(out, pgid)
      }
      // `tmux new-session ... sh` runs `$SHELL -c sh` (`bash -c sh`), which then execs `sh`;
      // wait until the wrapper finishes execing so we don't catch `bash -c sh` mid-spawn.
      if (argv.length === 1 && /(^|\/)-?sh$/.test(argv[0])) break
    }
    expect(argv).toHaveLength(1)
    expect(argv[0]).toMatch(/(^|\/)-?sh$/)
  }, 30_000)
})


describe('parseCombinedPaneOwner', () => {
  const REPLY = [
    `${COMBINED_PANE_MARKER}4242|/dev/pts/9|claude|%17`,
    '4242 4242 Ss   -bash',
    '5001 5001 Sl+  claude --resume x',
    '5002 5001 S+   rg --files'
  ].join('\n')

  it('routes the marker line through parsePaneOwner and the tail through paneOwnerFrom', () => {
    expect(parseCombinedPaneOwner(REPLY)).toEqual({
      panePid: 4242,
      tty: '/dev/pts/9',
      command: 'claude',
      paneId: '%17',
      argv: ['claude --resume x', 'rg --files'],
      pids: [5001, 5002]
    })
  })

  it('tolerates noise ABOVE the marker (a chatty remote rc file) — the fence is the anchor', () => {
    expect(parseCombinedPaneOwner(`motd line\n${REPLY}`)?.command).toBe('claude')
  })

  it('answers null with no marker, an empty read, or identity-only output', () => {
    expect(parseCombinedPaneOwner(null)).toBeNull()
    expect(parseCombinedPaneOwner('')).toBeNull()
    expect(parseCombinedPaneOwner('4242|/dev/pts/9|claude|%17')).toBeNull()
    // Identity with no ps rows below it — the two-trip contract, kept: no rows, no owner.
    expect(parseCombinedPaneOwner(`${COMBINED_PANE_MARKER}4242|/dev/pts/9|claude|%17`)).toBeNull()
  })

  it('refuses an identity whose tty isSafeTty rejects — a reply we do not name a pane with', () => {
    const hostile = [
      `${COMBINED_PANE_MARKER}42|/dev/pts/0; curl evil|node|%1`,
      '42 42 Ss   -bash',
      '43 43 S+   node'
    ].join('\n')
    expect(parseCombinedPaneOwner(hostile)).toBeNull()
  })

  it('a single-row group parses to one argv and its own pid', () => {
    const one = [`${COMBINED_PANE_MARKER}7|/dev/pts/1|sh`, '9 9 S+   sleep 5'].join('\n')
    expect(parseCombinedPaneOwner(one)).toMatchObject({ argv: ['sleep 5'], pids: [9] })
  })
})

/**
 * THE REAL SCRIPT (Global Constraint 9) — `remotePaneOwnerCombinedArgs`'s remote command is
 * generated shell no compiler checks, so it runs here for REAL: under `/bin/sh`, against a real
 * tmux server on the `nodeterm-rmt` socket name — inside this suite's own private `TMUX_TMPDIR`,
 * so the byte-identical script resolves a test server and can never see an SSH project's real
 * remote socket. The bytes that ship are the bytes judged.
 */
describe.skipIf(!tmuxBin)('the combined remote script, under a real /bin/sh + real tmux', () => {
  const conn = { host: 'h.example.com', user: 'deploy' } as never
  const scriptFor = (session: string): string =>
    remotePaneOwnerCombinedArgs(conn, '/s.sock', session).at(-1) as string
  const rmt = (...args: string[]) =>
    execFileSync(tmuxBin as string, ['-L', 'nodeterm-rmt', ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TMUX_TMPDIR }
    })
  const runScript = (session: string): string =>
    execFileSync('sh', ['-c', scriptFor(session)], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TMUX_TMPDIR }
    })

  afterAll(() => {
    try {
      rmt('kill-server')
    } catch {
      // never started (skipped) or already gone
    }
  })

  it('one round-trip answers identity AND foreground argv, and the parser adopts it', () => {
    rmt('new-session', '-d', '-s', 'nt-comb', 'sh')
    rmt('send-keys', '-t', 'nt-comb', 'sleep 412', 'Enter')
    let owner: ReturnType<typeof parseCombinedPaneOwner> = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      owner = parseCombinedPaneOwner(runScript('nt-comb'))
      if (owner?.argv.some((a) => a.includes('sleep 412'))) break
    }
    expect(owner).not.toBeNull()
    expect(owner!.tty).toMatch(/^\/dev\//)
    expect(owner!.paneId).toMatch(/^%\d+$/)
    expect(owner!.argv.join('\n')).toContain('sleep 412')
    expect(owner!.pids?.length).toBe(owner!.argv.length)
  }, 30_000)

  it('a MISSING SESSION on a live server parses to null — measured: display-message exits 0', () => {
    // Measured on tmux 3.4: `display-message -p -t <no-such-session>` does NOT error — the target
    // resolution is allowed to fail and the format expands with empty fields (stdout `|||`),
    // exit 0. The `|| exit 9` therefore only fires for a server-level failure; the missing-session
    // answer is an empty identity, which the parser refuses — the same null the two-trip read gave.
    let out: string | null = null
    try {
      out = runScript('nt-no-such-session')
    } catch {
      out = null // an erroring tmux is equally fine: runAsync throws, the caller answers null
    }
    if (out !== null) expect(parseCombinedPaneOwner(out)).toBeNull()
  }, 15_000)

  it('NO SERVER on the socket exits non-zero (the caller answers null) — never a half-answer', () => {
    const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-comb-none-'))
    let code = 0
    try {
      execFileSync('sh', ['-c', scriptFor('nt-comb')], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, TMUX_TMPDIR: emptyTmp },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      code = (e as { status?: number }).status ?? -1
    } finally {
      fs.rmSync(emptyTmp, { recursive: true, force: true })
    }
    expect(code).toBe(9)
  }, 15_000)
})
