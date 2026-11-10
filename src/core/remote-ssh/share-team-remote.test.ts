import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shareProbeCommand, parseShareProbe, teamCliCommand, parseTeamCliOutput,
  killVerifyCommand, parseKillVerify, paneCommandsByNode, SHARE_INSTALL_SCRIPT, SERVER_INSTALL_URL
} from './share-team-remote'

const run = promisify(execFile)
let dir: string, home: string, bin: string, state: string, wrongSocketLog: string, nodeLog: string

const write = (p: string, body: string, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, { mode })
}
const findTool = (name: string): string => ['/usr/bin', '/bin'].map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) ?? ''
// A server bundle that knows `team bootstrap` carries its usage row as text; the probe detects the
// verb from that text and never by running the bundle.
const NEW_MAIN = '// nodeterm-server\nconst USAGE = "  bootstrap --owner-key <key> --adopt <dir> [--owner-label <name>] [--json]"\n'
const OLD_MAIN = '// an older nodeterm-server, from before the team admin CLI\n'

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-share-'))
  home = path.join(dir, 'home')
  bin = path.join(dir, 'bin')
  state = path.join(dir, 'tmux-state')
  wrongSocketLog = path.join(dir, 'tmux-wrong-socket.log')
  nodeLog = path.join(dir, 'node-calls.log')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true })
  write(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', 0o755)
  write(path.join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo 1000;; -un) echo alice;; esac\n', 0o755)
  write(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n', 0o755)
  // A fake `timeout` that just runs the command: a stock macOS has no `timeout` binary, and the
  // probe skips `team status` without one. The bounding behaviour has its own test below.
  write(path.join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', 0o755)
  // A fake tmux: sessions are files in $STATE; a "*.stuck" one survives kill-session. Like real
  // tmux, a target WITHOUT the leading `=` that matches no session exactly falls back to a prefix
  // match, and a miss prints tmux's own message (measured on tmux 3.4) with exit 1. Any socket but
  // the host's `node-terminal` is recorded and refused, so a kill aimed at another socket fails.
  // FAKE_TMUX_MODE makes every call fail with one of tmux's connect or version errors.
  write(
    path.join(bin, 'tmux'),
    [
      '#!/bin/sh',
      `S=${JSON.stringify(state)}`,
      `W=${JSON.stringify(wrongSocketLog)}`,
      'cmd=""; target=""; sock=""',
      'while [ $# -gt 0 ]; do case "$1" in -L) shift; sock="$1";; -t) shift; target="$1";; kill-session|has-session|list-panes) cmd="$1";; esac; shift; done',
      'if [ "$sock" != node-terminal ]; then echo "$sock $cmd $target" >> "$W"; echo "fake tmux: unexpected socket" >&2; exit 99; fi',
      'case "$FAKE_TMUX_MODE" in',
      "  mismatch) echo 'protocol version mismatch (client 8, server 7)' >&2; exit 1;;",
      "  denied) echo 'error connecting to /tmp/tmux-1000/node-terminal (Permission denied)' >&2; exit 1;;",
      "  nofile) echo 'error connecting to /tmp/tmux-1000/node-terminal (No such file or directory)' >&2; exit 1;;",
      "  refused) echo 'error connecting to /tmp/tmux-1000/node-terminal (Connection refused)' >&2; exit 1;;",
      'esac',
      'name="${target#=}"',
      'exact=0; [ "$name" != "$target" ] && exact=1',
      'resolve() {',
      '  { [ -e "$S/$name" ] || [ -e "$S/$name.stuck" ]; } && return 0',
      '  [ "$exact" = 1 ] && return 1',
      '  for f in "$S/$name"*; do [ -e "$f" ] || continue; b=$(basename "$f"); name="${b%.stuck}"; return 0; done',
      '  return 1',
      '}',
      "missing() { if [ -n \"$(ls \"$S\")\" ]; then echo \"can't find session: $name\" >&2; else echo 'no server running on /tmp/tmux-1000/node-terminal' >&2; fi; exit 1; }",
      'case "$cmd" in',
      '  list-panes) for f in "$S"/*; do [ -e "$f" ] || continue; b=$(basename "$f"); b="${b%.stuck}"; echo "$b|$(cat "$f")"; done; exit 0;;',
      '  kill-session) resolve || missing; [ -e "$S/$name.stuck" ] && exit 0; rm -f "$S/$name"; exit 0;;',
      '  has-session) resolve && exit 0; missing;;',
      'esac',
      'exit 1'
    ].join('\n'),
    0o755
  )
  // A fake node: records every call, answers `team … status --json`, and echoes argv + stdin for
  // other verbs. It has no `--help`: bootstrap support is read from main.cjs's contents.
  write(
    path.join(bin, 'node'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${JSON.stringify(nodeLog)}`,
      'shift', // main.cjs
      'case "$*" in',
      `  *" status --json") printf '{\\n  "enabled": true,\\n  "off": null\\n}\\n';;`,
      `  *" --no-newline") printf '{"a":1}';;`,
      `  *) printf '{"argv":"%s","stdin":"%s"}\\n' "$*" "$(cat | tr -d '\\n"')";;`,
      'esac'
    ].join('\n'),
    0o755
  )
  const main = path.join(home, '.nodeterm-server-app', 'out', 'server', 'main.cjs')
  write(main, NEW_MAIN)
  write(
    path.join(home, '.config', 'systemd', 'user', 'nodeterm-server.service'),
    `[Service]\nEnvironment=NODETERM_HEADLESS=1\nExecStart=${path.join(bin, 'node')} ${main}\n`
  )
  write(path.join(home, '.nodeterm-server', 'install-meta.json'), '{"commit":"abc1234","installedAt":"x","version":"0.4.0"}\n')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  // Only this desktop's socket may ever be addressed (see the fake tmux).
  const wrong = fs.existsSync(wrongSocketLog) ? fs.readFileSync(wrongSocketLog, 'utf8') : ''
  fs.rmSync(wrongSocketLog, { force: true })
  expect(wrong).toBe('')
})

const sh = async (command: string, stdin?: string, env: Record<string, string> = {}): Promise<string> => {
  const p = run('/bin/sh', ['-c', command], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env } })
  if (stdin !== undefined) p.child.stdin?.end(stdin)
  return (await p).stdout
}
/** A home holding one user unit that runs `nodeBin` on a main.cjs with `mainBody`. */
const homeWithUnit = (name: string, nodeBin: string, mainBody: string): string => {
  const h = path.join(dir, name)
  const main = path.join(h, '.nodeterm-server-app', 'out', 'server', 'main.cjs')
  write(main, mainBody)
  write(path.join(h, '.config', 'systemd', 'user', 'nodeterm-server.service'), `[Service]\nExecStart=${nodeBin} ${main}\n`)
  return h
}
/** The script inside `sh -c '<script>'`, decoded the way POSIX sh decodes the single quotes. */
const innerScript = (command: string): string => {
  expect(command.startsWith("sh -c '") && command.endsWith("'")).toBe(true)
  return command.slice("sh -c '".length, -1).split("'\\''").join("'")
}
const noSystemUnit = (): string => path.join(dir, 'etc', 'no-such.service')

describe.skipIf(process.platform === 'win32')('share-team remote shell (real /bin/sh, fake host)', () => {
  it('probes a user install: unit, node, main, data dir, meta, bootstrap verb, status, real cwd, panes', async () => {
    fs.writeFileSync(path.join(state, 'nt-term-a'), 'claude')
    fs.writeFileSync(path.join(state, 'nt-term-b'), 'bash')
    const p = parseShareProbe(await sh(shareProbeCommand('~/proj')))
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({
      os: 'Linux', uid: 1000, user: 'alice', home, unit: 'user', node: path.join(bin, 'node'),
      dataDir: path.join(home, '.nodeterm-server'), meta: { version: '0.4.0', commit: 'abc1234' },
      hasBootstrap: true, statusRc: 0, teamExists: true, adoptCwd: fs.realpathSync(path.join(home, 'proj')),
      homeReal: fs.realpathSync(home), have: { git: true, curl: expect.any(Boolean) } // curl is whatever /usr/bin holds on the test machine
    })
    expect(p.panes).toEqual(expect.arrayContaining([{ session: 'nt-term-a', command: 'claude' }, { session: 'nt-term-b', command: 'bash' }]))
    fs.rmSync(path.join(state, 'nt-term-a'))
    fs.rmSync(path.join(state, 'nt-term-b'))
  })
  // The system unit is an absolute host path, and a test machine may well run nodeterm-server as a
  // system service itself, so these point the check into the fake tree.
  it('a host with nothing installed and a missing folder', async () => {
    const bare = path.join(dir, 'bare-home')
    fs.mkdirSync(bare, { recursive: true })
    const out = await sh(shareProbeCommand('~/nope', noSystemUnit()), undefined, { HOME: bare })
    const p = parseShareProbe(out)
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ unit: 'none', node: '', main: '', hasBootstrap: false, statusRc: null, adoptCwd: null, meta: null })
  })
  // Symlinks need a privilege a stock Windows account does not hold (and the suite is POSIX-only).
  it('reports the real path of the home directory, and none when it cannot be entered', async () => {
    const realHome = path.join(dir, 'real-home')
    fs.mkdirSync(realHome, { recursive: true })
    const linkHome = path.join(dir, 'link-home')
    fs.symlinkSync(realHome, linkHome)
    const viaLink = parseShareProbe(await sh(shareProbeCommand('~', noSystemUnit()), undefined, { HOME: linkHome }))
    if ('error' in viaLink) throw new Error(viaLink.error)
    // `~` there is the home itself, so the plan can tell the two apart only through real paths.
    expect(viaLink).toMatchObject({ home: linkHome, homeReal: fs.realpathSync(realHome), adoptCwd: fs.realpathSync(realHome) })
    const gone = parseShareProbe(await sh(shareProbeCommand('/', noSystemUnit()), undefined, { HOME: path.join(dir, 'no-such-home') }))
    if ('error' in gone) throw new Error(gone.error)
    expect(gone).toMatchObject({ homeReal: null, adoptCwd: '/' })
  })
  it('a system unit with no user unit is reported as system', async () => {
    const bare = path.join(dir, 'sys-home')
    fs.mkdirSync(bare, { recursive: true })
    const unit = path.join(dir, 'etc', 'nodeterm-server.service')
    write(unit, '[Service]\nExecStart=/usr/bin/node /opt/nodeterm/out/server/main.cjs\n')
    const p = parseShareProbe(await sh(shareProbeCommand('~', unit), undefined, { HOME: bare }))
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ unit: 'system', node: '', main: '', adoptCwd: fs.realpathSync(bare) })
  })
  it('never runs an installed server too old to know the team CLI (it would boot a second server)', async () => {
    // Before the team CLI, `main.cjs team …` ignored `team` and started a full server that never exits.
    const bootLog = path.join(dir, 'old-server-ran.log')
    const booting = path.join(dir, 'bin-old', 'node')
    write(booting, ['#!/bin/sh', `echo "$*" >> ${JSON.stringify(bootLog)}`, 'echo "nodeterm-server listening on http 127.0.0.1:7681"', 'exec sleep 30'].join('\n'), 0o755)
    const oldHome = homeWithUnit('old-home', booting, OLD_MAIN)
    const started = Date.now()
    const p = parseShareProbe(await sh(shareProbeCommand('~', noSystemUnit()), undefined, { HOME: oldHome }))
    expect(Date.now() - started).toBeLessThan(4000)
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ unit: 'user', node: booting, hasBootstrap: false, statusRc: null, teamExists: false })
    expect(fs.existsSync(bootLog)).toBe(false)
  })
  it('bounds the status call with `timeout 10`, and gives the server no stdin', async () => {
    // A server new enough for the team CLI that does not answer: the probe still finishes.
    const hangLog = path.join(dir, 'hung-server.log')
    const hung = path.join(dir, 'bin-hung', 'node')
    write(hung, ['#!/bin/sh', 'if read -r line; then echo "stdin:$line" >> ' + JSON.stringify(hangLog) + '; fi', `echo "$*" >> ${JSON.stringify(hangLog)}`, 'exec sleep 30'].join('\n'), 0o755)
    const hungHome = homeWithUnit('hung-home', hung, NEW_MAIN)
    // A stand-in `timeout` records the duration it was given, then kills the command after 1 s
    // instead and answers 124 as the real one does. Plain sh, so the test needs no `timeout` binary.
    const timeoutLog = path.join(dir, 'timeout-calls.log')
    const fastTimeout = path.join(dir, 'bin-fast-timeout')
    write(
      path.join(fastTimeout, 'timeout'),
      [
        '#!/bin/sh',
        `echo "$1" >> ${JSON.stringify(timeoutLog)}`,
        'shift',
        '"$@" &',
        'pid=$!',
        '( sleep 1; kill -TERM "$pid" 2>/dev/null ) >/dev/null 2>&1 &',
        'watcher=$!',
        'wait "$pid"; rc=$?',
        'kill "$watcher" 2>/dev/null',
        '[ "$rc" -gt 128 ] && exit 124',
        'exit "$rc"'
      ].join('\n'),
      0o755
    )
    const started = Date.now()
    const out = await sh(shareProbeCommand('~', noSystemUnit()), 'leaked\n', { HOME: hungHome, PATH: `${fastTimeout}:${bin}:/usr/bin:/bin` })
    expect(Date.now() - started).toBeLessThan(4000)
    const p = parseShareProbe(out)
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ hasBootstrap: true, statusRc: 124, teamExists: false })
    expect(fs.readFileSync(timeoutLog, 'utf8')).toBe('10\n')
    const calls = fs.readFileSync(hangLog, 'utf8')
    expect(calls).toContain('team --data-dir')
    expect(calls).not.toContain('stdin:')
  })
  it('without a `timeout` binary the server is not run at all and its status is unknown', async () => {
    // Only what the probe needs besides `timeout`: the fakes plus a few real tools.
    const minimal = path.join(dir, 'bin-min')
    fs.mkdirSync(minimal, { recursive: true })
    for (const t of ['uname', 'id', 'tmux']) fs.symlinkSync(path.join(bin, t), path.join(minimal, t))
    for (const t of ['sh', 'sed', 'head', 'grep', 'basename', 'cat', 'ls']) fs.symlinkSync(findTool(t), path.join(minimal, t))
    fs.rmSync(nodeLog, { force: true })
    const p = parseShareProbe(await sh(shareProbeCommand('~/proj', noSystemUnit()), undefined, { PATH: minimal }))
    if ('error' in p) throw new Error(p.error)
    expect(p).toMatchObject({ hasBootstrap: true, statusRc: null, teamExists: false })
    expect(fs.existsSync(nodeLog)).toBe(false)
  })
  it('a cut-off probe is an error, never a half-filled probe', () => {
    expect(parseShareProbe("##NTP 1\n##OS Linux\n")).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('')).toMatchObject({ error: expect.any(String) })
    // Cut after the unit line, and cut inside a block: neither reached ##END.
    expect(parseShareProbe('##NTP 1\n##OS Linux\n##UNIT none\n##CWD /p\n')).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('##NTP 1\n##UNIT none\n##CWD /p\n##PANES\nnt-a|bash\n')).toMatchObject({ error: expect.any(String) })
    expect(parseShareProbe('##NTP 1\n##UNIT bogus\n##END\n')).toMatchObject({ error: expect.any(String) })
  })
  it('a line named like an Object prototype member is not a block start', () => {
    for (const line of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const p = parseShareProbe(`##NTP 1\n${line}\n##UNIT none\n##CWD /p\n##END\n`)
      if ('error' in p) throw new Error(`${line}: ${p.error}`)
      expect(p).toMatchObject({ unit: 'none', adoptCwd: '/p' })
    }
  })
  it('teamExists: on when hosting, on when it is off for a reason other than no team, off with no team', () => {
    const withStatus = (json: string): unknown => {
      const p = parseShareProbe(`##NTP 1\n##UNIT user\n##STATUSRC 0\n##STATUS\n${json}\n##STATUSEND\n##END\n`)
      if ('error' in p) throw new Error(p.error)
      return p.teamExists
    }
    expect(withStatus('{"enabled":true,"off":null}')).toBe(true)
    expect(withStatus('{"enabled":false,"off":{"reason":"no-team"}}')).toBe(false)
    expect(withStatus('{"enabled":false,"off":{"reason":"stopped"}}')).toBe(true)
    expect(withStatus('{"enabled":false,"off":{"reason":"host-key-unreadable","detail":"x"}}')).toBe(true)
    expect(withStatus('{"enabled":false,"off":null}')).toBe(false)
    expect(withStatus('{"ok":false,"error":"no server"}')).toBe(false)
    expect(withStatus('not json')).toBe(false)
  })
  it('install meta keeps version and commit only when both are strings', () => {
    const metaOf = (json: string): unknown => {
      const p = parseShareProbe(`##NTP 1\n##UNIT user\n##META\n${json}\n##METAEND\n##END\n`)
      if ('error' in p) throw new Error(p.error)
      return p.meta
    }
    expect(metaOf('{"version":"0.4.0","commit":"abc"}')).toEqual({ version: '0.4.0', commit: 'abc' })
    expect(metaOf('{"version":4,"commit":"abc"}')).toBeNull()
    expect(metaOf('{"version":"0.4.0","commit":null}')).toBeNull()
    expect(metaOf('{"version":"0.4.0"}')).toBeNull()
    expect(metaOf('[1,2]')).toBeNull()
  })
  it('a hostile folder name cannot inject shell', async () => {
    // Unquoted breakouts: a separator, a command substitution and backticks in the folder name.
    for (const [name, marker] of [
      [`~/x; touch ${path.join(dir, 'pwned-a')}`, 'pwned-a'],
      [`/x$(touch ${path.join(dir, 'pwned-b')})`, 'pwned-b'],
      ['~/x`touch ' + path.join(dir, 'pwned-c') + '`', 'pwned-c']
    ]) {
      const p = parseShareProbe(await sh(shareProbeCommand(name)))
      expect(p).toMatchObject({ adoptCwd: null })
      expect(fs.existsSync(path.join(dir, marker))).toBe(false)
    }
  })
  it('refuses a quote or backslash in any value it would embed (not every login shell can take them nested)', () => {
    expect(() => shareProbeCommand("~/x'; touch /tmp/nt-pwned-$$; '")).toThrow(/folder path contains a quote or backslash/)
    expect(() => shareProbeCommand('~/a\\b')).toThrow(/folder path contains a quote or backslash/)
    const p = { node: '/usr/bin/node', main: '/x/main.cjs', dataDir: '/d' }
    expect(() => teamCliCommand(p, ['bootstrap', '--owner-label', "Enes's Mac"])).toThrow(/team command argument contains a quote or backslash/)
    expect(() => teamCliCommand(p, ['status', 'a\\b'])).toThrow(/team command argument contains a quote or backslash/)
    expect(() => teamCliCommand({ ...p, dataDir: "/d'x" }, ['status'])).toThrow(/install path contains a quote or backslash/)
    expect(() => teamCliCommand({ ...p, node: '/n\\ode' }, ['status'])).toThrow(/install path contains a quote or backslash/)
    expect(() => killVerifyCommand(['term-1', "a'b"])).toThrow(/node id/)
    expect(() => killVerifyCommand(['a\\b'])).toThrow(/node id/)
    expect(() => killVerifyCommand(['..'])).toThrow(/node id/)
    expect(() => killVerifyCommand([''])).toThrow(/node id/)
  })
  it('every generated script is safe inside fish single quotes (no \\\' and no \\\\ in the script)', () => {
    const scripts = [
      innerScript(shareProbeCommand('~/proj')),
      innerScript(teamCliCommand({ node: '/usr/bin/node', main: '/x/main.cjs', dataDir: '/d d' }, ['resume', '--project', 'p 1', '--json'])),
      innerScript(killVerifyCommand(['term-1', 'term-a.1'])),
      SHARE_INSTALL_SCRIPT
    ]
    for (const s of scripts) {
      expect(s).not.toContain("\\'")
      expect(s).not.toContain('\\\\')
    }
  })
  it('runs the team CLI with argv quoted and stdin passed, fenced so login noise cannot corrupt it', async () => {
    const cmd = teamCliCommand({ node: path.join(bin, 'node'), main: '/x/main.cjs', dataDir: '/d d' }, ['resume', '--project', 'p 1;$x', '--json'])
    const r = parseTeamCliOutput('motd line\n' + (await sh(cmd, '[{"a":1}]')))
    if ('error' in r) throw new Error(r.error)
    expect(r.rc).toBe(0)
    expect(r.body).toEqual({ argv: 'team --data-dir /d d resume --project p 1;$x --json', stdin: '[{a:1}]' })
  })
  it('a non-JSON CLI reply is an error that names the exit code and quotes the output (bounded)', () => {
    const boom = parseTeamCliOutput('##NTB\nboom\n##NTRC 1\n')
    expect(boom).toEqual({ error: 'The team command printed no JSON (exit 1): boom' })
    expect(parseTeamCliOutput('##NTB\n##NTRC 127\n')).toEqual({ error: 'The team command printed no JSON (exit 127): (nothing)' })
    const long = parseTeamCliOutput(`##NTB\n${'x'.repeat(5000)}\n##NTRC 1\n`)
    expect('error' in long && long.error.length < 400).toBe(true)
  })
  it('a quoted reply carries no control or text-direction characters', () => {
    const rlo = String.fromCharCode(0x202e)
    const esc = String.fromCharCode(0x1b)
    const r = parseTeamCliOutput(`##NTB\nab${rlo}cd${esc}[31m\n##NTRC 1\n`)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error).toContain('ab cd [31m')
  })
  it('a pretty-printed multi-line success parses as one value; a reply without a final newline keeps its rc', async () => {
    expect(parseTeamCliOutput('##NTB\n{\n  "ok": true\n}\n\n##NTRC 0\n')).toEqual({ rc: 0, body: { ok: true } })
    // The fake CLI prints its reply with no trailing newline: the rc marker must still land on its own line.
    const cmd = teamCliCommand({ node: path.join(bin, 'node'), main: '/x/main.cjs', dataDir: '/d' }, ['info', '--no-newline'])
    expect(parseTeamCliOutput(await sh(cmd))).toEqual({ rc: 0, body: { a: 1 } })
  })
  it('kills exactly the named sessions on node-terminal and verifies each; a dotted id maps through sessionName', async () => {
    for (const s of ['nt-term-1', 'nt-term-a_1', 'nt-term-12', 'nt-term-stuck.stuck']) fs.writeFileSync(path.join(state, s), 'x')
    const ids = ['term-1', 'term-a.1', 'term-stuck', 'term-never']
    const r = parseKillVerify(await sh(killVerifyCommand(ids)), ids)
    expect(r).toEqual([
      { nodeId: 'term-1', state: 'gone' },
      { nodeId: 'term-a.1', state: 'gone' },
      { nodeId: 'term-stuck', state: 'alive' },
      { nodeId: 'term-never', state: 'gone' }
    ])
    expect(fs.existsSync(path.join(state, 'nt-term-12'))).toBe(true) // exact target: a longer id is untouched
    for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f))
  })
  it('a node with no session is gone without touching a session whose name it prefixes', async () => {
    fs.writeFileSync(path.join(state, 'nt-term-9x'), 'x')
    const r = parseKillVerify(await sh(killVerifyCommand(['term-9'])), ['term-9'])
    expect(r).toEqual([{ nodeId: 'term-9', state: 'gone' }])
    expect(fs.existsSync(path.join(state, 'nt-term-9x'))).toBe(true)
    fs.rmSync(path.join(state, 'nt-term-9x'))
  })
  it('gone needs tmux to say so: no server, or nothing to connect to, is gone', async () => {
    // An empty socket: the fake answers "no server running", as tmux does.
    expect(parseKillVerify(await sh(killVerifyCommand(['term-1'])), ['term-1'])).toEqual([{ nodeId: 'term-1', state: 'gone' }])
    for (const mode of ['nofile', 'refused']) {
      const out = await sh(killVerifyCommand(['term-1']), undefined, { FAKE_TMUX_MODE: mode })
      expect(parseKillVerify(out, ['term-1'])).toEqual([{ nodeId: 'term-1', state: 'gone' }])
    }
  })
  it('an exit 1 that is not one of tmux\'s absence messages is unknown, never gone', async () => {
    fs.writeFileSync(path.join(state, 'nt-term-1'), 'x')
    for (const mode of ['mismatch', 'denied']) {
      const out = await sh(killVerifyCommand(['term-1']), undefined, { FAKE_TMUX_MODE: mode })
      expect(parseKillVerify(out, ['term-1'])).toEqual([{ nodeId: 'term-1', state: 'unknown' }])
    }
    fs.rmSync(path.join(state, 'nt-term-1'))
  })
  it('a host where tmux cannot run reports every node unknown, never gone', async () => {
    const noTmux = path.join(dir, 'bin-notmux')
    write(path.join(noTmux, 'tmux'), '#!/bin/sh\nexit 127\n', 0o755)
    const out = await sh(killVerifyCommand(['term-1']), undefined, { PATH: `${noTmux}:/usr/bin:/bin` })
    expect(parseKillVerify(out, ['term-1'])).toEqual([{ nodeId: 'term-1', state: 'unknown' }])
  })
  it('a kill reply missing a node is unknown for that node; a cut-off reply is an error', () => {
    expect(parseKillVerify("##NTK\n##K nt-a gone\n##NTKEND\n", ['a', 'b'])).toEqual([
      { nodeId: 'a', state: 'gone' }, { nodeId: 'b', state: 'unknown' }
    ])
    expect(parseKillVerify("##NTK\n##K nt-a gone\n", ['a'])).toMatchObject({ error: expect.any(String) })
  })
  it('maps panes to node ids through sessionName', () => {
    expect(paneCommandsByNode([{ session: 'nt-term-a_1', command: 'npm' }], ['term-a.1', 'term-b'])).toEqual({ 'term-a.1': 'npm' })
  })
  it('the install script downloads to a temp file (a curl failure is an error, not an empty bash run)', () => {
    expect(SHARE_INSTALL_SCRIPT).toContain(SERVER_INSTALL_URL)
    expect(SHARE_INSTALL_SCRIPT).not.toMatch(/\|\s*bash/)
  })
  it('the install script runs the download, passes its exit code through and removes the temp file on every exit', async () => {
    const curlBin = path.join(dir, 'bin-curl')
    const tmp = path.join(dir, 'install-tmp')
    fs.mkdirSync(tmp, { recursive: true })
    write(
      path.join(curlBin, 'curl'),
      [
        '#!/bin/sh',
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) shift; out="$1";; -*) ;; *) url="$1";; esac; shift; done',
        '[ -n "$FAKE_CURL_FAIL" ] && exit 22',
        `printf 'echo "installer from %s"; exit 3\\n' "$url" > "$out"`,
        // The session is torn down while the download finishes (an ssh drop, the runner's timeout).
        '[ -n "$FAKE_CURL_TERM_PARENT" ] && kill -TERM "$PPID"',
        'exit 0'
      ].join('\n'),
      0o755
    )
    const runInstall = async (env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const r = await run('/bin/sh', ['-c', SHARE_INSTALL_SCRIPT], { env: { HOME: home, TMPDIR: tmp, PATH: `${curlBin}:/usr/bin:/bin`, ...env } })
        return { code: 0, stdout: r.stdout, stderr: r.stderr }
      } catch (e) {
        const err = e as { code: number | null; signal?: string; stdout: string; stderr: string }
        return { code: err.code ?? -1, stdout: err.stdout, stderr: err.stderr }
      }
    }
    expect(await runInstall({})).toMatchObject({ code: 3, stdout: `installer from ${SERVER_INSTALL_URL}\n` })
    expect(fs.readdirSync(tmp)).toEqual([])
    const failed = await runInstall({ FAKE_CURL_FAIL: '1' })
    expect(failed.code).toBe(1)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('could not download the installer')
    expect(fs.readdirSync(tmp)).toEqual([])
    const killed = await runInstall({ FAKE_CURL_TERM_PARENT: '1' })
    expect(killed.code).not.toBe(0)
    expect(killed.stdout).toBe('')
    expect(fs.readdirSync(tmp)).toEqual([])
  })
})
