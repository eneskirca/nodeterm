// PANE INPUT, PROVEN AGAINST A REAL TMUX DRIVING A REAL PANE.
//
// The subject is `controlInputPlan` / `remoteControlInputPlan` run through the production
// `runPasteDelivery`, i.e. exactly what `PtyManager.sendPaneKeys` runs: keys as `source-file -` with
// `send-keys -H` lines behind a mode cancel, pastes as `load-buffer -` + `paste-buffer -d -p -r`.
// What judges is not a parser of ours: the pane runs a program that puts its tty in RAW mode and
// appends every byte it receives to a file, so a byte either reached the application or it did not.
//
// The properties, each its own test:
//  - bytes arrive exactly (all 256 values, escape sequences, UTF-8);
//  - the prefix never reaches tmux — and the CONTROL beside it: the same two bytes typed INTO an
//    attached client DO open the session chooser, which is the hole this design closes;
//  - a mode is cancelled first (copy mode and tree mode both eat `send-keys` otherwise);
//  - only the exact session receives it (`nt-c-1` is a prefix of `nt-c-12`);
//  - a paste is framed only when the app asked, and is never submitted;
//  - the SSH command line, run by a real /bin/sh (the remote shell is what reads it), delivers the
//    same bytes. No real ssh: a stub `tmux` on PATH re-points `-L nodeterm-rmt` at the private socket.
//
// Private socket in a private TMUX_TMPDIR (`makeTmuxTmpdir`), never `node-terminal`/`nodeterm-rmt`;
// each session is killed by exact target. Skipped where there is no tmux (Windows, a bare CI image):
// the measurement is of tmux.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { controlInputPlan, remoteControlInputPlan, type ControlInputChunk } from './pane-input'
import { runPasteDelivery } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-ctl-test-${process.pid}`
const CONN = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }
const ESC = '\x1b'
const START = `${ESC}[200~`
const END = `${ESC}[201~`

const TMUX = (() => {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()
const PYTHON = (() => {
  if (!TMUX) return null
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()
// Skipped where there is no tmux binary (Windows, a bare CI image): the measurement is of tmux.
const itTmux = it.skipIf(!TMUX)
// The prefix test also needs a REAL interactive client on a pty, which this file spawns through
// python3's `pty` module (portable across Linux and macOS, unlike `script`'s two dialects).
const itClient = it.skipIf(!TMUX || !PYTHON)

let work = ''
let binDir = ''
const sessions: string[] = []
const clients: ChildProcess[] = []

const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: work, TERM: 'xterm-256color' }
  delete e.TMUX
  delete e.TMUX_PANE
  return e
}

function tmux(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(TMUX as string, ['-L', SOCKET, ...args], { env: env(), encoding: 'utf8' })
  return { status: r.status, out: r.stdout }
}

/** `runPasteDelivery`'s runner: the plan's argv against the private socket, its body on stdin. */
function runLocal(args: string[], input: string): Promise<void> {
  // The plans name their socket; the private one is what controlInputPlan was given.
  const r = spawnSync(TMUX as string, args, { env: env(), input })
  return r.status === 0 ? Promise.resolve() : Promise.reject(new Error(`tmux exit ${r.status}: ${r.stderr}`))
}

const deliver = (session: string, chunk: ControlInputChunk): Promise<boolean> => {
  const plan = controlInputPlan(SOCKET, session, chunk)
  return plan ? runPasteDelivery(plan, runLocal) : Promise.resolve(true)
}

/** The SSH leg: the remote command line (the last ssh argv element) executed by a real /bin/sh,
 *  with the plan's body on its stdin — the way sshd hands both to the user's shell. */
function runRemoteLine(args: string[], input: string): Promise<void> {
  const r = spawnSync('/bin/sh', ['-c', args.at(-1) as string], {
    env: { ...env(), PATH: `${binDir}:/usr/bin:/bin` },
    input
  })
  return r.status === 0 ? Promise.resolve() : Promise.reject(new Error(`sh exit ${r.status}: ${r.stderr}`))
}

const deliverRemote = (session: string, chunk: ControlInputChunk): Promise<boolean> => {
  const plan = remoteControlInputPlan(CONN, '/cm/p1', session, chunk)
  return plan ? runPasteDelivery(plan, runRemoteLine) : Promise.resolve(true)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await sleep(10)
  }
  if (!pred()) throw new Error(`timed out waiting for ${what}`)
}
const fileOf = (session: string) => path.join(work, `${session}.bin`)
const got = (session: string): Buffer => (fs.existsSync(fileOf(session)) ? fs.readFileSync(fileOf(session)) : Buffer.alloc(0))
const inMode = (session: string) => tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_in_mode}']).out.trim()

/** A pane whose program records every byte its tty delivers (raw mode: no CR→NL, no ^C, no ^S). */
async function start(session: string, aware = false): Promise<void> {
  const r = tmux([
    '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
    `${path.join(binDir, 'recorder')} ${fileOf(session)}${aware ? ' aware' : ''}`
  ])
  if (r.status !== 0) throw new Error(`new-session ${session} failed`)
  sessions.push(session)
  await waitFor(() => fs.existsSync(`${fileOf(session)}.ready`), `${session} ready`)
}

/** An interactive-style client: a real pty attached to `session`, our stdin forwarded byte for byte. */
async function attach(session: string): Promise<ChildProcess> {
  const child = spawn(PYTHON as string, [path.join(binDir, 'client.py'), TMUX as string, '-L', SOCKET, 'attach', '-t', `=${session}`], {
    env: env(),
    stdio: ['pipe', 'ignore', 'ignore']
  })
  clients.push(child)
  await waitFor(() => tmux(['list-clients', '-t', `=${session}`]).out.trim().length > 0, `a client on ${session}`)
  return child
}
const clientSession = (session: string) => tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_session}']).out.trim()

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('ntci-', SOCKET)
  binDir = path.join(work, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(
    path.join(binDir, 'recorder'),
    [
      '#!/bin/sh',
      // -iexten as well: with IEXTEN on, ^V (LNEXT) and ^O can still be special in some line disciplines.
      'stty raw -echo -iexten',
      // $2 = "aware": announce DECSET 2004, i.e. request bracketed paste, the way a TUI does.
      '[ "$2" = aware ] && printf \'\\033[?2004h\'',
      'touch "$1.ready"',
      'exec cat > "$1"'
    ].join('\n') + '\n',
    { mode: 0o755 }
  )
  // The SSH leg's tmux: drops `-L nodeterm-rmt` and re-invokes the real tmux on the private socket,
  // refusing anything else. `exec` keeps stdin, which is the whole point of the path being tested.
  fs.writeFileSync(
    path.join(binDir, 'tmux'),
    `#!/bin/sh\n[ "$1" = "-L" ] && [ "$2" = "${RMT_TMUX_SOCKET}" ] || exit 99\nshift 2\nexec '${TMUX}' -L '${SOCKET}' "$@"\n`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(binDir, 'client.py'),
    [
      'import fcntl, os, pty, select, struct, sys, termios',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      "    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))",
      '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
      "fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))",
      'while True:',
      '    r, _, _ = select.select([0, fd], [], [])',
      '    if fd in r:',
      '        try:',
      '            if not os.read(fd, 65536): break',
      '        except OSError: break',
      '    if 0 in r:',
      '        d = os.read(0, 65536)',
      '        if not d: break',
      '        os.write(fd, d)',
      'try: os.kill(pid, 15)',
      'except OSError: pass'
    ].join('\n') + '\n'
  )
})

afterAll(() => {
  for (const c of clients) {
    c.stdin?.end()
    c.kill()
  }
  if (TMUX) {
    for (const name of sessions) tmux(['kill-session', '-t', `=${name}`])
  }
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

describe('controller input on a real tmux', () => {
  itTmux('bytes arrive exactly: every control and printable byte, escape sequences, UTF-8', async () => {
    await start('nt-c-bytes')
    // A controller's keys are TEXT, typed as its UTF-8: U+0000-U+007F are one byte each (every C0
    // control, DEL, ESC, ^C, ^S, ^V included), U+0080-U+00FF and the rest arrive as their UTF-8.
    const all = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i))
    const chunks = [0, 64, 128, 192].map((i) => all.slice(i, i + 64))
    chunks.push('\x1b[A', '\x1bOA', '\r', '\x03', '\x7f', 'ç', '漢', '🙂', 'é')
    for (const data of chunks) expect(await deliver('nt-c-bytes', { kind: 'keys', data })).toBe(true)
    const expected = Buffer.from(chunks.join(''), 'utf8')
    await waitFor(() => got('nt-c-bytes').length >= expected.length, 'all bytes')
    await sleep(100)
    expect(got('nt-c-bytes').equals(expected)).toBe(true)
  })

  itTmux('a long chunk (16 KiB, 16 send-keys lines) arrives exactly and in order', async () => {
    await start('nt-c-big')
    const text = Array.from({ length: 16384 }, (_, i) => String.fromCharCode(0x20 + (i % 95))).join('')
    expect(await deliver('nt-c-big', { kind: 'keys', data: text })).toBe(true)
    await waitFor(() => got('nt-c-big').length >= 16384, '16 KiB')
    expect(got('nt-c-big').toString('latin1')).toBe(text)
  })

  itClient(
    'the prefix never reaches tmux — while the same bytes typed INTO the client open the session chooser',
    async () => {
      await start('nt-c-prefix')
      await start('nt-c-other')
      const client = await attach('nt-c-prefix')
      expect(await deliver('nt-c-prefix', { kind: 'keys', data: '\x02s' })).toBe(true)
      await waitFor(() => got('nt-c-prefix').length >= 2, 'C-b s in the pane')
      await sleep(150)
      expect(got('nt-c-prefix').toString('latin1')).toBe('\x02s')
      expect(inMode('nt-c-prefix')).toBe('0')
      // CONTROL: the same two bytes written into the attached client's pty ARE its keyboard.
      client.stdin!.write('\x02s')
      await waitFor(() => inMode('nt-c-prefix') === '1', 'the chooser to open')
      expect(tmux(['display-message', '-p', '-t', '=nt-c-prefix:', '#{pane_mode}']).out.trim()).toBe('tree-mode')
      expect(got('nt-c-prefix').toString('latin1')).toBe('\x02s') // the client's keys never reached the app
      // And with the chooser open: `j` + Enter would move to the other session and switch the
      // client to it. Through the plan the chooser is closed first and both bytes reach the app.
      expect(await deliver('nt-c-prefix', { kind: 'keys', data: 'j\r' })).toBe(true)
      await waitFor(() => got('nt-c-prefix').length >= 4, 'j Enter in the pane')
      await sleep(150)
      expect(got('nt-c-prefix').toString('latin1')).toBe('\x02sj\r')
      expect(inMode('nt-c-prefix')).toBe('0')
      expect(clientSession('nt-c-prefix')).toBe('nt-c-prefix')
      expect(got('nt-c-other').length).toBe(0)
    },
    20_000
  )

  itTmux('a mode is cancelled first: copy mode and the tree chooser both left, the app gets the key', async () => {
    await start('nt-c-mode')
    // Copy mode — and the control: send-keys with no cancel is eaten by the copy-mode table.
    tmux(['copy-mode', '-t', '=nt-c-mode:'])
    expect(inMode('nt-c-mode')).toBe('1')
    tmux(['send-keys', '-t', '=nt-c-mode:', '-H', '78'])
    await sleep(200)
    expect(got('nt-c-mode').length).toBe(0)
    expect(await deliver('nt-c-mode', { kind: 'keys', data: 'a' })).toBe(true)
    await waitFor(() => got('nt-c-mode').length >= 1, 'a after copy mode')
    expect(got('nt-c-mode').toString('latin1')).toBe('a')
    expect(inMode('nt-c-mode')).toBe('0')
    // The tree chooser, opened without a client.
    tmux(['choose-tree', '-t', '=nt-c-mode:'])
    await waitFor(() => inMode('nt-c-mode') === '1', 'tree mode')
    expect(await deliver('nt-c-mode', { kind: 'keys', data: 'b' })).toBe(true)
    await waitFor(() => got('nt-c-mode').length >= 2, 'b after tree mode')
    expect(got('nt-c-mode').toString('latin1')).toBe('ab')
    expect(inMode('nt-c-mode')).toBe('0')
    // A paste into copy mode: left first, so tmux frames by the APP's state, not the mode's.
    tmux(['copy-mode', '-t', '=nt-c-mode:'])
    expect(await deliver('nt-c-mode', { kind: 'paste', text: 'c' })).toBe(true)
    await waitFor(() => got('nt-c-mode').length >= 3, 'c after copy mode')
    expect(got('nt-c-mode').toString('latin1')).toBe('abc')
    expect(inMode('nt-c-mode')).toBe('0')
  })

  itTmux('only the exact session receives it; a missing or killed target fails and reaches no prefix match', async () => {
    await start('nt-c-1')
    await start('nt-c-12')
    expect(await deliver('nt-c-1', { kind: 'keys', data: 'Z' })).toBe(true)
    await waitFor(() => got('nt-c-1').length >= 1, 'Z')
    expect(await deliver('nt-c-9', { kind: 'keys', data: 'Q' })).toBe(false)
    expect(await deliver('nt-c-9', { kind: 'paste', text: 'Q' })).toBe(false)
    tmux(['kill-session', '-t', '=nt-c-1'])
    expect(await deliver('nt-c-1', { kind: 'keys', data: 'R' })).toBe(false)
    expect(await deliver('nt-c-1', { kind: 'paste', text: 'R' })).toBe(false)
    await sleep(200)
    expect(got('nt-c-1').toString('latin1')).toBe('Z')
    expect(got('nt-c-12').length).toBe(0)
    // A failed paste swept its own buffer: nothing of the payload is left in the server.
    expect(tmux(['list-buffers', '-F', '#{buffer_name}']).out).not.toMatch(/nt-paste-/)
  })

  itTmux('a paste is framed only when the app asked, keeps \\n, drops ESC, and is never submitted', async () => {
    await start('nt-c-aware', true)
    await start('nt-c-plain')
    expect(await deliver('nt-c-aware', { kind: 'paste', text: 'a\nb' })).toBe(true)
    expect(await deliver('nt-c-plain', { kind: 'paste', text: 'a\nb' })).toBe(true)
    expect(await deliver('nt-c-plain', { kind: 'paste', text: `x${ESC}[A${END}y` })).toBe(true)
    await waitFor(() => got('nt-c-aware').length >= 15 && got('nt-c-plain').length >= 3 + 9, 'pastes')
    await sleep(150)
    expect(got('nt-c-aware').toString('latin1')).toBe(`${START}a\nb${END}`)
    expect(got('nt-c-plain').toString('latin1')).toBe('a\nbx[A[201~y')
  })

  itTmux('the SSH command line, run by a real /bin/sh, delivers the same bytes', async () => {
    await start('nt-c-remote', true)
    expect(await deliverRemote('nt-c-remote', { kind: 'keys', data: `\x02s${ESC}[Aç` })).toBe(true)
    expect(await deliverRemote('nt-c-remote', { kind: 'paste', text: 'p\nq' })).toBe(true)
    const expected = `\x02s${ESC}[A${Buffer.from('ç', 'utf8').toString('latin1')}${START}p\nq${END}`
    await waitFor(() => got('nt-c-remote').length >= expected.length, 'remote bytes')
    expect(got('nt-c-remote').toString('latin1')).toBe(expected)
    expect(inMode('nt-c-remote')).toBe('0')
    expect(await deliverRemote('nt-c-remote-9', { kind: 'keys', data: 'x' })).toBe(false)
  })
})
