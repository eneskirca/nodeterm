// THE DELIVERY, PROVEN AGAINST A REAL TMUX DRIVING A REAL APPLICATION.
//
// The subject is `sendText`'s one-round-trip paste: `load-buffer -` over stdin, a copy-mode
// cancel gated by `if-shell -F`, then `paste-buffer -d -p -r`, then Enter. Both the LOCAL argv
// (`localTmuxPasteArgs`) and the REMOTE command line (`remoteTmuxPasteArgs`, run through a real
// /bin/sh) are driven here, against the same panes, and asserted to produce the SAME bytes —
// parity is the property that kept breaking when the two paths were written twice.
//
// WHAT JUDGES. Not a parser of ours, and not tmux's own `#{bracket_paste_flag}` (which is the
// thing being removed, and which does not even exist on this host's tmux 3.4). The pane runs a
// program that puts its tty in RAW mode and appends every byte it receives to a file: the frame
// either arrives on the application's stdin or it does not. For the security cases the pane runs
// a real interactive bash — readline's own bracketed-paste implementation — and the verdict is
// whether a file the payload asked for exists.
//
// WHY THIS FILE EXISTS AT ALL. The previous delivery asked tmux "did the app request bracketed
// paste?" via `#{bracket_paste_flag}`, a format that first shipped in TMUX 3.7 (2026-06-26). On
// anything older it expands to '' and the code read that as "no" — then delivered the text with
// RAW NEWLINES, one submit per line. Every assertion below that names the version floor is a
// measurement of that, taken here, on this tmux.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  localPasteDelivery,
  localTmuxPasteArgs,
  pasteBufferName,
  runPasteDelivery,
  type PasteDelivery
} from './tmux-naming'
import { remotePasteDelivery } from './remote-ssh/control-master'
import { makeTmuxTmpdir } from './tmux-test-socket'

const ESC = '\x1b'
const START = `${ESC}[200~`
const END = `${ESC}[201~`
/** A private socket — never `TMUX_SOCKET`/`nodeterm-rmt`, which carry live user sessions. */
const SOCKET = `nt-paste-test-${process.pid}`
const CONN = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}
const TMUX = findTmux()

let work: string
let binDir: string

/**
 * The socket file lives in the test's OWN dir: `kill-server` does not unlink it, so a per-pid name
 * under the shared `/tmp/tmux-<uid>/` would leave one stale entry behind per run, forever.
 */
function env(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: work }
}

function tmux(args: string[], input?: string): string {
  return execFileSync(TMUX as string, args, { encoding: 'utf8', env: env(), input })
}

/**
 * `tmux`, ignoring the exit status — for the CONTROL cases and the buffer scrubbing, which are
 * about what reached the application (or what is left in the server), not about what tmux told
 * its client. Where a control's exit status IS the point, the test asserts it explicitly.
 */
function tryTmux(args: string[], input?: string): void {
  try {
    tmux(args, input)
  } catch {
    // the bytes are the witness
  }
}

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('ntpb-', SOCKET)
  binDir = path.join(work, 'bin')
  fs.mkdirSync(binDir)
  // The SSH path's shim. `remoteTmuxPasteArgs` hard-codes `-L nodeterm-rmt`, which on a real host
  // is the socket a remote nodeterm owns; here the first two arguments are dropped and the real
  // tmux is re-invoked on the test's private socket. `exec` keeps stdin, which is the whole point
  // of the path being tested.
  fs.writeFileSync(
    path.join(binDir, 'tmux'),
    `#!/bin/sh\nexport TMUX_TMPDIR=${work}\nshift 2\nexec ${TMUX} -L ${SOCKET} "$@"\n`,
    { mode: 0o755 }
  )
  // A pane program that records the RAW bytes its stdin receives. `stty raw` matters: in cooked
  // mode the line discipline rewrites CR to NL on input, which would hide exactly the `\n` vs
  // `\r` distinction this file is about.
  fs.writeFileSync(
    path.join(binDir, 'recorder'),
    [
      '#!/bin/sh',
      'stty raw -echo',
      // $2 = "aware": announce DECSET 2004, i.e. request bracketed paste, the way a TUI does.
      '[ "$2" = aware ] && printf \'\\033[?2004h\'',
      'touch "$1.ready"',
      'exec cat > "$1"'
    ].join('\n') + '\n',
    { mode: 0o755 }
  )
})

afterAll(() => {
  if (TMUX) {
    try {
      tmux(['-L', SOCKET, 'kill-server'])
    } catch {
      // already gone
    }
  }
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

function waitFor(predicate: () => boolean, what: string, ms = 10_000): void {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    execFileSync('sleep', ['0.03'])
  }
}

/** A fresh single-pane session running the byte recorder. Returns the file it writes to. */
function recorderPane(session: string, kind: 'aware' | 'unaware'): string {
  const out = path.join(work, `${session}.bytes`)
  try {
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', `=${session}`], {
      stdio: 'ignore',
      env: env()
    })
  } catch {
    // no such session yet
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '200',
    '-y',
    '40',
    '-c',
    work,
    `${binDir}/recorder ${out} ${kind}`
  ])
  waitFor(() => fs.existsSync(`${out}.ready`), `${session} recorder to come up`)
  return out
}

/**
 * Everything sent before this call has reached the application.
 *
 * A sentinel, not a sleep, and deliberately delivered by a DIFFERENT mechanism than the subject
 * (a plain literal `send-keys`): if the subject delivered nothing at all, the marker still shows
 * up and the assertion sees an empty payload rather than hanging.
 */
const MARK = '<<NTEND>>'
function drain(session: string, out: string): string {
  tmux(['-L', SOCKET, 'send-keys', '-t', session, '-l', '--', MARK])
  waitFor(() => fs.readFileSync(out, 'utf8').includes(MARK), `${session} to receive the marker`)
  const all = fs.readFileSync(out, 'utf8')
  return all.slice(0, all.lastIndexOf(MARK))
}

/**
 * ── THE DELIVERY UNDER TEST IS THE PRODUCTION ONE, NOT A COPY OF IT ─────────────────────────────
 *
 * `PtyManager.sendText` is a dispatcher over `localPasteDelivery` / `remotePasteDelivery` +
 * `runPasteDelivery`, and so is this. That is the whole point: an earlier revision of this file
 * re-implemented the composition here — it called `sanitizePasteText` and `pasteBufferName`
 * itself and then invoked the argv builder — and two mutations survived a green suite as a
 * result (deleting the empty-body branch, and deleting the sanitize call). A test that rebuilds
 * the thing it tests cannot see the thing it tests being deleted.
 *
 * Only the RUNNER differs per leg, which is exactly the part `sendText` also supplies: a local
 * plan's argv goes to the tmux binary; a remote plan's argv is an `ssh` command line whose last
 * element is the remote command, so it goes through a real /bin/sh with the shim on PATH. Both
 * carry the payload on stdin.
 */
function runnerFor(pathName: 'local' | 'ssh'): (args: string[], input: string) => Promise<unknown> {
  if (pathName === 'local') {
    return async (args, input) => tmux(args, input)
  }
  return async (args, input) =>
    execFileSync('/bin/sh', ['-c', args[args.length - 1]], {
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: work },
      input,
      encoding: 'utf8'
    })
}

function planFor(
  pathName: 'local' | 'ssh',
  session: string,
  text: string,
  enter: boolean
): PasteDelivery | null {
  return pathName === 'local'
    ? localPasteDelivery(SOCKET, session, text, enter)
    : remotePasteDelivery(CONN, '/s.sock', session, text, enter)
}

/** Exactly `sendText`'s body for one leg: plan, then run. Returns what `sendText` would return. */
async function send(
  pathName: 'local' | 'ssh',
  session: string,
  text: string,
  enter = true
): Promise<boolean> {
  const plan = planFor(pathName, session, text, enter)
  if (!plan) return true
  return runPasteDelivery(plan, runnerFor(pathName))
}

/** Every buffer the tmux server is holding, by name. */
function bufferNames(): string[] {
  const out = tmux(['-L', SOCKET, 'list-buffers', '-F', '#{buffer_name}']).trim()
  return out.length === 0 ? [] : out.split('\n')
}

const suite = TMUX ? describe : describe.skip
const PATHS: Array<'local' | 'ssh'> = ['local', 'ssh']

suite('REAL tmux: the version floor is real, and paste-buffer -p removes it', () => {
  it('MEASURED: `#{bracket_paste_flag}` is EMPTY on this tmux even for a pane that DID request it', async () => {
    // This is the whole bug in one assertion. The app below announces DECSET 2004; the format the
    // deleted probe read still comes back '' (it first shipped in tmux 3.7), and '' !== '1', so
    // the old code concluded "not paste-aware" and mangled the write.
    const out = recorderPane('nt-floor', 'aware')
    expect(fs.existsSync(`${out}.ready`)).toBe(true)
    const flag = tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-floor', '#{bracket_paste_flag}'])
    const version = tmux(['-V']).trim()
    if (/tmux (3\.[7-9]|[4-9]\.)/.test(version)) {
      // On a host that DOES have 3.7+, the old probe would have worked — the point of the fix is
      // that we no longer care either way, so assert the new path instead of the floor.
      expect(flag.trim()).toBe('1')
    } else {
      expect(flag.trim(), `${version} should not know #{bracket_paste_flag}`).toBe('')
    }
    // …and the new delivery frames it regardless of what that format said.
    await send('local', 'nt-floor', 'a\nb')
    expect(drain('nt-floor', out)).toBe(`${START}a\nb${END}\r`)
  })

  it('CONTROL: the pre-fix delivery mangles the very same write into raw newlines', async () => {
    // The legacy two-step, reproduced: `send-keys -l --` then `send-keys Enter`, which is what the
    // shipped code ran once the probe above answered ''. If this ever stops producing unframed
    // newlines, the test above is not measuring a fix.
    const out = recorderPane('nt-legacy', 'aware')
    tmux(['-L', SOCKET, 'send-keys', '-t', 'nt-legacy', '-l', '--', 'a\nb'])
    tmux(['-L', SOCKET, 'send-keys', '-t', 'nt-legacy', 'Enter'])
    expect(drain('nt-legacy', out)).toBe('a\nb\r')
  })
})

suite('REAL tmux: tmux decides the framing from the pane, on both paths', () => {
  for (const p of PATHS) {
    it(`${p}: a pane whose app REQUESTED bracketed paste gets a framed multi-line write`, async () => {
      const out = recorderPane(`nt-aw-${p}`, 'aware')
      await send(p, `nt-aw-${p}`, 'line1\nline2\nline3')
      expect(drain(`nt-aw-${p}`, out)).toBe(`${START}line1\nline2\nline3${END}\r`)
    })

    it(`${p}: a pane whose app did NOT request it gets the legacy bytes, unframed and unchanged`, async () => {
      // Not a regression to guard against — a deliberate non-change. An app that never asked for
      // bracketed paste must keep receiving exactly what it received before this PR.
      const out = recorderPane(`nt-un-${p}`, 'unaware')
      await send(p, `nt-un-${p}`, 'line1\nline2\nline3')
      expect(drain(`nt-un-${p}`, out)).toBe('line1\nline2\nline3\r')
    })

    it(`${p}: enter:false (dictation insert) sends the frame and NO submit`, async () => {
      const out = recorderPane(`nt-ne-${p}`, 'aware')
      await send(p, `nt-ne-${p}`, 'draft me', false)
      expect(drain(`nt-ne-${p}`, out)).toBe(`${START}draft me${END}`)
    })

    it(`${p}: an empty payload with enter still submits (and never silently drops the Enter)`, async () => {
      // `Canvas.tsx`'s write verb calls `sendText(node, args.text ?? '')`, so this is a live
      // caller, not a defensive branch. `load-buffer -` given zero bytes creates NO buffer, so a
      // plan that tried to paste would fail and tmux would abandon the list — Enter included.
      const out = recorderPane(`nt-mt-${p}`, 'aware')
      expect(await send(p, `nt-mt-${p}`, '')).toBe(true)
      expect(drain(`nt-mt-${p}`, out)).toBe('\r')
    })

    it(`${p}: an empty payload WITHOUT enter is nothing at all — no process, no buffer`, () => {
      expect(planFor(p, 'nt-x', '', false)).toBeNull()
      expect(planFor(p, 'nt-x', '', true)).not.toBeNull()
    })
  }

  it('CONTROL: the naive empty-payload delivery loses the Enter entirely', async () => {
    const out = recorderPane('nt-mt-ctl', 'aware')
    const buffer = pasteBufferName()
    // Same argv the non-empty case uses, but with nothing on stdin.
    try {
      tmux(localTmuxPasteArgs(SOCKET, 'nt-mt-ctl', buffer, true), '')
    } catch {
      // tmux reports "no buffer …" — the point is what did NOT reach the pane
    }
    expect(drain('nt-mt-ctl', out), 'the empty-payload special case is no longer needed').toBe('')
  })

  it('the two paths are byte-identical for the same payload', async () => {
    const a = recorderPane('nt-par-l', 'aware')
    const b = recorderPane('nt-par-s', 'aware')
    const text = "mixed 'quotes' $HOME `id` #hash;\nsecond line\tand a tab"
    await send('local', 'nt-par-l', text)
    await send('ssh', 'nt-par-s', text)
    expect(drain('nt-par-s', b)).toBe(drain('nt-par-l', a))
  })

  it('a pane in a session that is NOT the current one, with no client attached, is framed too', async () => {
    // The everyday shape: nodeterm's tmux server holds one session per node, nothing is attached,
    // and the write is aimed at a session that is not the server's most-recent one. Nothing in the
    // delivery may depend on the target being "current" — the deleted `#{bracket_paste_flag}`
    // probe and the paste both resolve their own target, and only one of them is still ours.
    const out = recorderPane('nt-other', 'aware')
    const decoy = recorderPane('nt-decoy', 'aware') // created last ⇒ tmux's current session
    await send('local', 'nt-other', 'x\ny')
    expect(drain('nt-other', out)).toBe(`${START}x\ny${END}\r`)
    expect(fs.readFileSync(decoy, 'utf8'), 'the write leaked into the current session').toBe('')
  })
})

suite('REAL tmux: copy mode', () => {
  for (const p of PATHS) {
    it(`${p}: a pane the user scrolled back in still receives a FRAMED write, and the submit`, async () => {
      const out = recorderPane(`nt-cm-${p}`, 'aware')
      tmux(['-L', SOCKET, 'copy-mode', '-t', `nt-cm-${p}`])
      expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', `nt-cm-${p}`, '#{pane_in_mode}']).trim()).toBe('1')
      await send(p, `nt-cm-${p}`, 'a\nb')
      expect(drain(`nt-cm-${p}`, out)).toBe(`${START}a\nb${END}\r`)
      // The user-visible cost, asserted rather than described: they are back at the live view.
      expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', `nt-cm-${p}`, '#{pane_in_mode}']).trim()).toBe('0')
    })
  }

  it('CONTROL: without the gated cancel, copy mode unframes the paste', async () => {
    // Why the cancel is in the command list at all. `paste-buffer -p` consults the copy-mode
    // SCREEN, not the application, so a wheel scroll silently restores the one-turn-per-line bug.
    const out = recorderPane('nt-cm-ctl', 'aware')
    tmux(['-L', SOCKET, 'copy-mode', '-t', 'nt-cm-ctl'])
    expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-cm-ctl', '#{pane_in_mode}']).trim()).toBe('1')
    const buffer = pasteBufferName()
    tmux(
      ['-L', SOCKET, 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', 'nt-cm-ctl', ';', 'send-keys', '-t', 'nt-cm-ctl', 'Enter'],
      'a\nb'
    )
    // The Enter never reached the app either. Detached tmux 3.4 can leave copy mode active
    // (copy-selection needs a client); exit it only so the observation sentinel can reach the
    // recorder. This does not resend or reframe the already delivered control payload.
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-ctl', '-X', 'cancel'])
    expect(drain('nt-cm-ctl', out), 'copy mode no longer unframes — the if-shell gate is dead weight').toBe('a\nb')
  })

  it('CONTROL: an UNGATED cancel breaks every ordinary write — which is why `if-shell -F` gates it', async () => {
    // Measured: `send-keys -X cancel` against a pane not in a mode exits 1 and tmux ABANDONS the
    // rest of the command list. Prepending it unconditionally would have replaced a mangle with a
    // total failure.
    const out = recorderPane('nt-nc-ctl', 'aware')
    const buffer = pasteBufferName()
    expect(() =>
      tmux(
        ['-L', SOCKET, 'send-keys', '-t', 'nt-nc-ctl', '-X', 'cancel', ';', 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', 'nt-nc-ctl'],
        'a\nb'
      )
    ).toThrow()
    expect(drain('nt-nc-ctl', out)).toBe('')
  })

  it('CONTROL: today, a write into a scrolled-back pane delivers NO TEXT — at best nothing, at worst a bare submit', async () => {
    // The honest baseline for the user-visible cost above: cancelling copy mode is not a
    // regression against a working behaviour, it replaces a silent drop of the whole payload.
    //
    // Measured in isolation, 20/20 runs: both sends exit 0 and the pane receives ZERO bytes — so
    // `sendText` returns TRUE having typed nothing. Inside this file, where one tmux server
    // carries many sessions and earlier tests deliberately fail commands against it, the same
    // sequence sometimes lands a bare `\r` (the payload's own `\n` is `copy-selection-and-cancel`
    // in the copy-mode table, which changes what the keys after it do). Both outcomes are bad in
    // the same direction and the stable, assertable property covers both: the TEXT never lands,
    // while a bare submit still can — i.e. the write can submit whatever the human had composed
    // and type none of the payload. Exit status is not asserted because it is not what harms the
    // user; the bytes are.
    const out = recorderPane('nt-cm-legacy', 'aware')
    tmux(['-L', SOCKET, 'copy-mode', '-t', 'nt-cm-legacy'])
    expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-cm-legacy', '#{pane_in_mode}']).trim()).toBe('1')
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', '-l', '--', 'a\nb'])
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', 'Enter'])
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', '-X', 'cancel'])
    const got = drain('nt-cm-legacy', out)
    expect(got, 'the legacy path now reaches a scrolled-back pane').not.toMatch(/[ab]/)
    expect(got.replace(/\r/g, '')).toBe('')
  })
})

suite('REAL tmux: the payload does not ride a command line', () => {
  const BIG = 'A'.repeat(300_000)

  it('CONTROL: the same payload as ONE argument is "Argument list too long"', async () => {
    // MAX_ARG_STRLEN is 128 KB per argument, far below `getconf ARG_MAX`. This is why the text
    // goes over stdin and not through `set-buffer --`.
    expect(() => tmux(['-L', SOCKET, 'set-buffer', '-b', 'nt-argmax', '--', BIG])).toThrow(
      /too long|E2BIG|ENAMETOOLONG/i
    )
  })

  for (const p of PATHS) {
    it(`${p}: 300 KB over stdin arrives complete and framed`, async () => {
      const out = recorderPane(`nt-big-${p}`, 'aware')
      await send(p, `nt-big-${p}`, BIG, false)
      const got = drain(`nt-big-${p}`, out)
      expect(got.length).toBe(BIG.length + START.length + END.length)
      expect(got.startsWith(START) && got.endsWith(END)).toBe(true)
    })
  }
})

suite("REAL tmux: the delivery does not disturb the user's own tmux state", () => {
  it("leaves the numbered buffer stack untouched and deletes its own private buffer", async () => {
    const out = recorderPane('nt-buf', 'aware')
    tmux(['-L', SOCKET, 'set-buffer', 'USER-A'])
    tmux(['-L', SOCKET, 'set-buffer', 'USER-B'])
    const before = tmux(['-L', SOCKET, 'list-buffers'])
    await send('local', 'nt-buf', 'hello')
    drain('nt-buf', out)
    expect(tmux(['-L', SOCKET, 'list-buffers'])).toBe(before)
  })

  it('two concurrent deliveries do not swap payloads (the buffer name is per-call)', async () => {
    // tmux interleaves command lists from different clients, so a shared buffer name is a real
    // race: the second `load-buffer` overwrites the first before its `paste-buffer` runs.
    const a = recorderPane('nt-race-a', 'aware')
    const b = recorderPane('nt-race-b', 'aware')
    const ba = pasteBufferName()
    const bb = pasteBufferName()
    expect(ba).not.toBe(bb)
    tmux(['-L', SOCKET, 'load-buffer', '-b', ba, '-'], 'AAA')
    tmux(['-L', SOCKET, 'load-buffer', '-b', bb, '-'], 'BBB')
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', ba, '-t', 'nt-race-a'])
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', bb, '-t', 'nt-race-b'])
    expect(drain('nt-race-a', a)).toBe(`${START}AAA${END}`)
    expect(drain('nt-race-b', b)).toBe(`${START}BBB${END}`)
  })

  it('CONTROL: with ONE shared buffer name the same interleaving crosses the payloads', async () => {
    const a = recorderPane('nt-race2-a', 'aware')
    const b = recorderPane('nt-race2-b', 'aware')
    const shared = pasteBufferName()
    tmux(['-L', SOCKET, 'load-buffer', '-b', shared, '-'], 'AAA')
    tmux(['-L', SOCKET, 'load-buffer', '-b', shared, '-'], 'BBB')
    tmux(['-L', SOCKET, 'paste-buffer', '-p', '-r', '-b', shared, '-t', 'nt-race2-a'])
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', shared, '-t', 'nt-race2-b'])
    expect(drain('nt-race2-a', a), 'a shared buffer name is no longer a race').toBe(`${START}BBB${END}`)
    expect(drain('nt-race2-b', b)).toBe(`${START}BBB${END}`)
  })
})

suite('REAL tmux: a FAILED delivery leaves no payload behind in the buffer stack', () => {
  // ── THE LEAK, MEASURED ─────────────────────────────────────────────────────────────────────────
  //
  // `load-buffer` succeeds, `paste-buffer` fails ("can't find pane" — a node closed while the
  // write was in flight), tmux abandons the rest of the command list, and the `-d` that would have
  // dropped the buffer never runs. The payload then sits in the server's buffer stack, which is
  // USER-VISIBLE (`prefix-=`, `list-buffers`, a phone attaching), for as long as the server lives:
  // days, on a host with dozens of sessions. `buffer-limit` does not rescue it — named buffers are
  // not reaped. And the payload can be a note push or a 300 KB scrollback paste.
  const GONE = 'nt-nosuch-pane'

  beforeEach(() => {
    for (const b of bufferNames()) tryTmux(['-L', SOCKET, 'delete-buffer', '-b', b])
  })

  it('MEASURED: `buffer-limit` does not reap NAMED buffers, so nothing else will clean this up', () => {
    tmux(['-L', SOCKET, 'set-option', '-g', 'buffer-limit', '5'])
    try {
      for (let i = 0; i < 20; i++) tmux(['-L', SOCKET, 'load-buffer', '-b', `nt-paste-limit${i}`, '-'], 'x')
      expect(bufferNames().filter((b) => b.startsWith('nt-paste-limit'))).toHaveLength(20)
    } finally {
      tmux(['-L', SOCKET, 'set-option', '-g', 'buffer-limit', '50'])
    }
  })

  for (const p of PATHS) {
    it(`${p}: a paste that fails sweeps its own buffer`, async () => {
      expect(await send(p, GONE, 'a secret note push')).toBe(false)
      waitFor(() => bufferNames().length === 0, 'the failed delivery to sweep its buffer')
    })
  }

  it('CONTROL: without the sweep, the full payload is left in the stack', async () => {
    const plan = planFor('local', GONE, 'a secret note push', true) as PasteDelivery
    // The shipped plan with its cleanup removed — i.e. the code before this fix.
    const leaky: PasteDelivery = { args: plan.args, body: plan.body, cleanup: null }
    expect(await runPasteDelivery(leaky, runnerFor('local'))).toBe(false)
    const left = bufferNames()
    expect(left, 'the leak is gone by construction — the sweep is dead weight').toHaveLength(1)
    expect(tmux(['-L', SOCKET, 'show-buffer', '-b', left[0]])).toContain('a secret note push')
    tryTmux(['-L', SOCKET, 'delete-buffer', '-b', left[0]])
  })

  it('a SUCCESSFUL delivery needs no sweep — `-d` already dropped the buffer', async () => {
    const out = recorderPane('nt-sweep-ok', 'aware')
    expect(await send('local', 'nt-sweep-ok', 'hello')).toBe(true)
    drain('nt-sweep-ok', out)
    expect(bufferNames()).toHaveLength(0)
  })

  it('the bare-Enter plan has nothing to sweep', () => {
    for (const p of PATHS) expect(planFor(p, 'nt-x', '', true)?.cleanup).toBeNull()
  })
})

suite('REAL tmux: -r is what keeps a newline a newline', () => {
  it('CONTROL: without -r, tmux rewrites every \\n to \\r — one submit per line, the bug itself', async () => {
    const out = recorderPane('nt-nor', 'aware')
    const buffer = pasteBufferName()
    tmux(['-L', SOCKET, 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-b', buffer, '-t', 'nt-nor'], 'a\nb')
    expect(drain('nt-nor', out)).toBe(`${START}a\rb${END}`)
  })
})

// ── SECURITY: a real bash, a real readline, and a filesystem verdict ────────────────────────────
//
// The frame is a promise to somebody else's parser that everything between the markers is CONTENT.
// tmux inserting the markers changes who writes them, not that promise — a payload carrying
// `ESC[201~` would still close the frame early and turn its tail into KEY INPUT. `sanitizePasteText`
// is untouched by this PR and this is where that is proven for the new delivery.
function bashPane(session: string): string {
  const marker = path.join(work, `${session}-ready`)
  try {
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', `=${session}`], {
      stdio: 'ignore',
      env: env()
    })
  } catch {
    // none yet
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '200',
    '-y',
    '40',
    '-e',
    'HISTFILE=/dev/null',
    '-c',
    work,
    'bash --norc --noprofile -i'
  ])
  waitFor(() => tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', session]).trim().length > 0, 'bash prompt')
  return marker
}

/** ctrl-c, then a sentinel command: once its file exists, everything queued before it has run. */
function bashDrain(session: string, tag: string): void {
  const sentinel = path.join(work, `sent-${tag}`)
  tmux(['-L', SOCKET, 'send-keys', '-t', session, 'C-c'])
  tmux(['-L', SOCKET, 'send-keys', '-t', session, '-l', '--', `touch ${sentinel}`])
  tmux(['-L', SOCKET, 'send-keys', '-t', session, 'Enter'])
  waitFor(() => fs.existsSync(sentinel), `bash to reach the ${tag} sentinel`)
}

suite('REAL bash through REAL tmux: the payload cannot become key input', () => {
  for (const p of PATHS) {
    it(`${p}: a payload closing the frame early does NOT execute its tail`, async () => {
      bashPane(`nt-sec-${p}`)
      const m = path.join(work, `pwn-${p}`)
      await send(p, `nt-sec-${p}`, `hello${END}\rtouch ${m}\r`, false)
      bashDrain(`nt-sec-${p}`, `nt-sec-${p}`)
      expect(fs.existsSync(m), 'the payload ESCAPED the frame and ran').toBe(false)
      // and the text still arrived as content: ESC has no glyph, its printable tail survives
      expect(tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', `nt-sec-${p}`])).toContain('hello[201~')
    })

    it(`${p}: an early close plus ctrl-u does not wipe the line and run a command`, async () => {
      bashPane(`nt-sec2-${p}`)
      const m = path.join(work, `pwn2-${p}`)
      await send(p, `nt-sec2-${p}`, `SAFE${END}\x15touch ${m} #`, true)
      bashDrain(`nt-sec2-${p}`, `nt-sec2-${p}`)
      expect(fs.existsSync(m), 'ctrl-u was read as a KEY').toBe(false)
    })
  }

  it('CONTROL: the same attack DOES run when the payload is not sanitized', async () => {
    // Run, not described. If this stops creating the marker the two tests above prove nothing.
    bashPane('nt-sec-ctl')
    const m = path.join(work, 'pwn-ctl')
    const buffer = pasteBufferName()
    tmux(localTmuxPasteArgs(SOCKET, 'nt-sec-ctl', buffer, false), `hello${END}\rtouch ${m}\r`)
    // tmux returning means the bytes reached the PTY, not that readline has consumed them. The
    // drain starts with Ctrl-C, so firing it immediately can cancel the very attack this control
    // is meant to witness and make the two sanitizer tests vacuous on a fast host.
    waitFor(() => fs.existsSync(m), 'the unsanitized control attack to run')
    bashDrain('nt-sec-ctl', 'nt-sec-ctl')
    expect(fs.existsSync(m), 'the attack no longer works — these tests are vacuous').toBe(true)
  })
})

suite('the unquoted splices are asserted, not assumed', () => {
  it('refuses a target that this app did not generate (it is spliced into a tmux command string)', async () => {
    for (const bad of ['nt-x; kill-server', 'nt-x y', "nt-x'", '#{pane_id}', '', 'other-session']) {
      expect(() => localTmuxPasteArgs('s', bad, pasteBufferName(), true)).toThrow(/unsafe tmux paste target/)
      expect(() => remotePasteDelivery(CONN, '/s.sock', bad, 'body', true)).toThrow(
        /unsafe tmux paste target/
      )
      expect(() => localPasteDelivery('s', bad, 'body', true)).toThrow(/unsafe tmux paste target/)
      // …including the bare-Enter plan, which was the one builder that opted out of the rule.
      expect(() => remotePasteDelivery(CONN, '/s.sock', bad, '', true)).toThrow(
        /unsafe tmux paste target/
      )
      expect(() => localPasteDelivery('s', bad, '', true)).toThrow(/unsafe tmux paste target/)
    }
  })
  it('refuses a buffer name that is not one of ours', async () => {
    expect(() => localTmuxPasteArgs('s', 'nt-x', 'buffer0', true)).toThrow(/unsafe tmux buffer name/)
    expect(() => localTmuxPasteArgs('s', 'nt-x', 'nt-paste-a b', true)).toThrow(/unsafe tmux buffer name/)
  })
  it('accepts every name `sessionName` can produce', async () => {
    expect(() => localTmuxPasteArgs('s', 'nt-term-mabc-3', pasteBufferName(), true)).not.toThrow()
  })
})
