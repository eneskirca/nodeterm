// THE TYPED DELIVERY, PROVEN AGAINST A REAL TMUX.
//
// The subject is `typedInputScript` — the fixed script `sendText({ typed: true })` runs, with the
// prompt on stdin — driven both as the LOCAL `sh -c` argv (`localTypedArgs`) and as the REMOTE
// command line (`remoteTypedArgs`, through a real /bin/sh with a tmux shim on PATH), and judged by
// the raw bytes a pane receives. The pane program puts its tty in raw mode and appends everything
// to a file, so what is asserted is what an agent CLI would read. Harness: tmux-paste.realtmux.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { pasteBufferName } from './tmux-naming'
import { localTypedArgs, typedLines, typedStdin, TYPED_TAB } from './typed-input'
import { remoteTypedArgs } from './remote-ssh/control-master'
import { makeTmuxTmpdir } from './tmux-test-socket'

const ESC = '\x1b'
/** M-Enter as the pane receives it: the "new line, don't submit" key. */
const NEWLINE_KEY = `${ESC}\r`
/** A private socket — never `TMUX_SOCKET`/`nodeterm-rmt`, which carry live user sessions. */
const SOCKET = `nt-typed-test-${process.pid}`
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

const env = (): NodeJS.ProcessEnv => ({ ...process.env, TMUX_TMPDIR: work })
const tmux = (args: string[]): string =>
  execFileSync(TMUX as string, args, { encoding: 'utf8', env: env() })

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('nttp-', SOCKET)
  binDir = path.join(work, 'bin')
  fs.mkdirSync(binDir)
  // The SSH leg's shim: the remote script says `tmux -L nodeterm-rmt …`; drop those two words and
  // re-invoke the real tmux on this test's private socket.
  fs.writeFileSync(
    path.join(binDir, 'tmux'),
    `#!/bin/sh\nexport TMUX_TMPDIR=${work}\nshift 2\nexec ${TMUX} -L ${SOCKET} "$@"\n`,
    { mode: 0o755 }
  )
  // Records the raw bytes it receives, and REQUESTS bracketed paste (DECSET 2004) the way Claude
  // Code does — without that, tmux would not frame even a `-p` paste, and this file could not tell
  // typing from pasting.
  fs.writeFileSync(
    path.join(binDir, 'recorder'),
    ['#!/bin/sh', 'stty raw -echo', "printf '\\033[?2004h'", 'touch "$1.ready"', 'exec cat > "$1"'].join('\n') + '\n',
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

function recorderPane(session: string): string {
  const out = path.join(work, `${session}.bytes`)
  tmux(['-L', SOCKET, 'new-session', '-d', '-s', session, '-x', '200', '-y', '40', `${binDir}/recorder ${out}`])
  waitFor(() => fs.existsSync(`${out}.ready`), `${session} recorder to come up`)
  return out
}

const MARK = '<<NTEND>>'
function drain(session: string, out: string): string {
  tmux(['-L', SOCKET, 'send-keys', '-t', session, '-l', '--', MARK])
  waitFor(() => fs.readFileSync(out, 'utf8').includes(MARK), `${session} to receive the marker`)
  const all = fs.readFileSync(out, 'utf8')
  return all.slice(0, all.lastIndexOf(MARK))
}

/** Exactly what `PtyManager.sendTyped` runs for one leg, with the prompt on stdin. */
function type(leg: 'local' | 'ssh', session: string, text: string): void {
  const stdin = typedStdin(typedLines(text))
  if (leg === 'local') {
    execFileSync('/bin/sh', localTypedArgs(TMUX as string, SOCKET, session, pasteBufferName()), {
      env: env(),
      input: stdin
    })
    return
  }
  const args = remoteTypedArgs(CONN, '/s.sock', session, pasteBufferName())
  execFileSync('/bin/sh', ['-c', args[args.length - 1]], {
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: work },
    input: stdin
  })
}

describe.skipIf(TMUX === null || process.platform === 'win32')('typed delivery through a real tmux', () => {
  for (const leg of ['local', 'ssh'] as const) {
    describe(leg, () => {
      it('types each line and joins them with the new-line key, never a submit', () => {
        const session = `nt-ty-lines-${leg}`
        const out = recorderPane(session)

        type(leg, session, 'This is a test\nof a multiline message\n\n- said nobody ever')

        expect(drain(session, out)).toBe(
          `This is a test${NEWLINE_KEY}of a multiline message${NEWLINE_KEY}${NEWLINE_KEY}- said nobody ever`
        )
      })

      it('delivers what tmux argv parsing would mangle, byte for byte', () => {
        const session = `nt-ty-argv-${leg}`
        const out = recorderPane(session)
        // A trailing `;` is a command separator, `\;` loses its backslash and a leading `-` is an
        // option — all measured with `send-keys -l`. The text rides stdin, so none of it applies.
        const text = 'ends with semi;\n;\n-leading dash\nbackslash-semi \\;\nfor (;;) {} é 日本'

        type(leg, session, text)

        expect(drain(session, out)).toBe(text.split('\n').join(NEWLINE_KEY))
      })

      it('turns a tab into spaces and never sends a control key', () => {
        const session = `nt-ty-ctl-${leg}`
        const out = recorderPane(session)

        type(leg, session, 'a\tb\x03c\x1b[201~d')

        expect(drain(session, out)).toBe(`a${TYPED_TAB}bc[201~d`)
      })

      it('leaves copy mode first, so the keys reach the application', () => {
        const session = `nt-ty-copy-${leg}`
        const out = recorderPane(session)
        tmux(['-L', SOCKET, 'copy-mode', '-t', session])

        type(leg, session, 'after copy mode')

        expect(drain(session, out)).toBe('after copy mode')
      })

      it('leaves no buffer behind', () => {
        const session = `nt-ty-buf-${leg}`
        recorderPane(session)

        type(leg, session, 'one\ntwo\nthree')

        const buffers = tmux(['-L', SOCKET, 'list-buffers', '-F', '#{buffer_name}'])
        expect(buffers.split('\n').filter((b) => b.startsWith('nt-paste-'))).toEqual([])
      })
    })
  }
})
