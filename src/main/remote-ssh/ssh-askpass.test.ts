import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'http'
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import {
  AskpassServer,
  buildAskpassScript,
  classifyPrompt,
  ensureAskpassScript,
  type AskpassPromptRequest
} from './ssh-askpass'

/** ssh's real passphrase prompt (sshconnect2.c), byte-identical on every retry. */
const passphrasePrompt = (key: string) => `Enter passphrase for key '${key}': `

let sockSeq = 0
/** A unique tmpdir socket per server: the production default under ~/.nodeterm must not be
 *  touched by tests, and unix sockets cannot be double-bound like port 0 could. */
const tmpSock = (): string => path.join(os.tmpdir(), `nt-ap-${process.pid}-${sockSeq++}.sock`)

/** fetch() cannot speak unix sockets; this is the minimal http.request equivalent. */
function sockReq(
  sock: string,
  urlPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: sock, path: urlPath, method: opts.method ?? 'POST', headers: opts.headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += String(c)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

describe('classifyPrompt', () => {
  it('recognizes the key-passphrase prompt and extracts the key ssh actually wants', () => {
    expect(classifyPrompt(passphrasePrompt('/home/u/.ssh/id_ed25519'))).toEqual({
      passphrase: true,
      keyPath: '/home/u/.ssh/id_ed25519'
    })
  })

  it('does NOT claim the server password or keyboard-interactive prompts', () => {
    // SSH_ASKPASS_REQUIRE=force routes these here too; answering them would send a server
    // password where a key passphrase belongs and mislabel the dialog.
    expect(classifyPrompt("root@example.com's password: ").passphrase).toBe(false)
    expect(classifyPrompt('Verification code: ').passphrase).toBe(false)
    expect(classifyPrompt('Duo two-factor login for alice\n\nPasscode or option (1-3): ').passphrase).toBe(false)
    expect(classifyPrompt('').passphrase).toBe(false)
  })

  it('still treats an unrecognized passphrase-shaped prompt as a passphrase ask', () => {
    expect(classifyPrompt('Enter passphrase: ')).toEqual({ passphrase: true })
  })
})

describe('buildAskpassScript', () => {
  it('is a POSIX-sh script that curls the unix socket with the expected fields', () => {
    const script = buildAskpassScript()
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('--unix-socket')
    expect(script).toContain('/prompt')
    expect(script).toContain('NODETERM_ASKPASS_SOCK')
    expect(script).toContain('NODETERM_ASKPASS_TOKEN')
    expect(script).toContain('NODETERM_ASKPASS_IDENTITY')
    // The invoking ssh pid: a SECOND ask from the same pid selects the "didn't work" dialog copy
    // (ssh reuses the byte-identical prompt on retries, so wording can never carry it), and it is
    // what cancel attribution (wasCancelledBy) scopes by.
    expect(script).toContain('caller=$PPID')
  })
})

// A command line is not private: `ps` and /proc/<pid>/cmdline are world-readable, so
// `curl -H "X-Nodeterm-Askpass-Token: …"` published this app instance's askpass bearer to every
// other account on the machine. And this is the longest-lived curl nodeterm generates — it waits
// out `--max-time 300` for a human to type a passphrase — so the window was minutes, not the
// milliseconds a hook POST takes. The bearer therefore goes in on stdin as a curl config.
//
// The recording curl below is a PASSTHROUGH — it logs argv + stdin, then execs the REAL curl —
// so each case proves the bearer left argv AND that the socket still accepted the request.
// Asserting only that the server got its header would pass with the leak completely intact.
describe('the askpass helper keeps its bearer off curl\'s command line', () => {
  let dir = ''
  let script = ''
  let binDir = ''
  const argvLog = (): string => path.join(binDir, 'argv.log')
  const stdinLog = (): string => path.join(binDir, 'stdin.log')

  /** Run a command, resolving (never rejecting) with its exit code: the failure paths below are
   *  the point of the test, and a non-zero exit is data here, not an error. */
  function run(
    cmd: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, env ? { env } : {}, (err, stdout, stderr) => {
        const code = err ? Number((err as NodeJS.ErrnoException).code ?? 1) : 0
        resolve({ code, stdout, stderr })
      })
    })
  }

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nt-askpass-argv-'))
    // The real generator + the real 0700 write, not a hand-rolled copy of the script.
    script = await ensureAskpassScript(dir)
    binDir = path.join(dir, 'bin')
    await fsp.mkdir(binDir, { recursive: true })
    const realCurl = (await run('/bin/sh', ['-c', 'command -v curl'])).stdout.trim()
    await fsp.writeFile(
      path.join(binDir, 'curl'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog())}`,
        // Only a curl that was told to read its config from stdin gets a reader. A regression that
        // put the header back on argv would otherwise leave `tee` waiting on a stdin nobody ever
        // closes, and the failure would read as a timeout instead of the assertion it really is.
        // `tee | curl` also keeps the shim's exit status curl's own, which is what -f depends on.
        'case "$*" in',
        `  *"--config -"*) tee -a ${JSON.stringify(stdinLog())} | ${JSON.stringify(realCurl)} "$@" ;;`,
        `  *) ${JSON.stringify(realCurl)} "$@" </dev/null ;;`,
        'esac',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
  })

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  /** Runs the real script under the real /bin/sh, with the recording curl first on PATH. */
  async function record(
    s: AskpassServer,
    opts: { token?: string; prompt?: string; identity?: string } = {}
  ): Promise<{ code: number; stdout: string; stderr: string; argv: string; stdin: string }> {
    // Truncated, not deleted: a regression must fail on the assertion below, not a missing file.
    await fsp.writeFile(argvLog(), '')
    await fsp.writeFile(stdinLog(), '')
    const identity = opts.identity ?? '/home/u/.ssh/id_ed25519'
    const res = await run('/bin/sh', [script, opts.prompt ?? passphrasePrompt(identity)], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      NODETERM_ASKPASS_SOCK: s.getSockPath(),
      NODETERM_ASKPASS_TOKEN: opts.token ?? s.getToken(),
      NODETERM_ASKPASS_IDENTITY: identity
    })
    return {
      ...res,
      argv: await fsp.readFile(argvLog(), 'utf8'),
      stdin: await fsp.readFile(stdinLog(), 'utf8')
    }
  }

  let server: AskpassServer | undefined
  afterEach(() => {
    server?.stop()
    server = undefined
  })
  async function serve(handler: (req: AskpassPromptRequest) => Promise<string | null>) {
    const s = new AskpassServer()
    s.setPromptHandler(handler)
    await s.start(tmpSock())
    server = s
    return s
  }

  it('names the header nowhere on the command line, and is valid POSIX sh', async () => {
    const src = buildAskpassScript()
    expect(src).not.toContain('-H "X-Nodeterm-Askpass-Token')
    expect((src.match(/--config -/g) ?? []).length).toBe(1)
    // The long wait is exactly what made an argv header so bad here; it must survive the change.
    expect(src).toContain('--max-time 300')
    // dash, not bash: the helper runs under whatever /bin/sh the user (or the SSH host) has.
    expect((await run('/usr/bin/env', ['dash', '-n', script])).code).toBe(0)
  })

  it('sends the bearer on stdin, not in argv, and still gets the passphrase back', async () => {
    const s = await serve(async () => 'correct horse battery staple')
    const r = await record(s)
    // End to end: the socket accepted the request and the answer reached ssh's stdout unchanged.
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('correct horse battery staple')
    // THE assertion. Reverting the fix to `-H "X-Nodeterm-Askpass-Token: …"` fails right here.
    expect(r.argv).not.toContain(s.getToken())
    expect(r.argv).not.toContain('X-Nodeterm-Askpass-Token')
    expect(r.stdin).toContain(`header = "X-Nodeterm-Askpass-Token: ${s.getToken()}"`)
    // The rest of the request is unchanged, and the socket is still what it talks to.
    expect(r.argv).toContain('--unix-socket')
    expect(r.argv).toContain('identity=/home/u/.ssh/id_ed25519')
  })

  it('works identically with the plain system curl, no recording shim in the way', async () => {
    const s = await serve(async () => 'plain-curl-answer')
    const r = await run('/bin/sh', [script, passphrasePrompt('/home/u/.ssh/id_ed25519')], {
      PATH: process.env.PATH ?? '',
      NODETERM_ASKPASS_SOCK: s.getSockPath(),
      NODETERM_ASKPASS_TOKEN: s.getToken(),
      NODETERM_ASKPASS_IDENTITY: '/home/u/.ssh/id_ed25519'
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('plain-curl-answer')
  })

  it('still reports a rejected bearer as a non-zero exit with the breadcrumb', async () => {
    // The exit code now comes out of a PIPELINE (`nt_askpass_headers | curl`). POSIX makes a
    // pipeline's status its last command's, so -f's 403 must still reach `[ $? -eq 0 ]` — if it
    // did not, a stale token would read to ssh as "no passphrase" and die silently.
    const s = await serve(async () => 'never-reached')
    const r = await record(s, { token: 'a-stale-token-from-another-instance' })
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('nodeterm-askpass: no answer from the app')
  })

  it('passes a decline through as the empty answer ssh needs, exit 0', async () => {
    const s = await serve(async () => null)
    const r = await record(s)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  // Belt and braces on the config-file quoting: a curl config is line-based, so a value carrying
  // a `"`, a `\` or a line break could end its header line and inject a directive of its own.
  // None can occur today — the bearer is a randomUUID() — which is exactly why they are STRIPPED
  // rather than escaped: nothing legitimate is ever altered.
  it('cannot be broken out of the config file by a quote or a newline in the bearer', async () => {
    const s = await serve(async () => 'never-reached')
    const r = await record(s, { token: 'ab"\nuser-agent = "pwned' })
    // The whole hostile value collapses onto the one header line it was given.
    expect(r.stdin).toContain('header = "X-Nodeterm-Askpass-Token: abuser-agent = pwned"')
    expect(r.stdin.split('\n').some((l) => l.trim().startsWith('user-agent'))).toBe(false)
    expect(r.argv).not.toContain('pwned')
    // And it is still just a wrong token: rejected, loudly.
    expect(r.code).toBe(1)
  })
})

describe('AskpassServer', () => {
  let server: AskpassServer | undefined

  afterEach(() => {
    server?.stop()
    server = undefined
  })

  async function makeServer(handler?: (req: AskpassPromptRequest) => Promise<string | null>) {
    const s = new AskpassServer()
    if (handler) s.setPromptHandler(handler)
    await s.start(tmpSock())
    server = s
    return s
  }

  async function post(
    s: AskpassServer,
    identity: string,
    caller: string,
    prompt = passphrasePrompt(identity)
  ): Promise<{ status: number; body: string }> {
    return sockReq(s.getSockPath(), '/prompt', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-askpass-token': s.getToken()
      },
      body: new URLSearchParams({ identity, caller, prompt }).toString()
    })
  }

  it('answers a throwing prompt handler with an empty 200, and a wrong route with a clean 404', async () => {
    // The catch is the SSH_ASKPASS contract's backstop: empty stdout = "no passphrase", never a
    // hang. It must also never re-head a response that was already answered (the 404/403 bails
    // above it), which would throw ERR_HTTP_HEADERS_SENT out of this un-awaited async callback
    // and take the main process down with it.
    const s = await makeServer(async () => {
      throw new Error('handler blew up')
    })
    const res = await post(s, '/home/u/.ssh/id_ed25519', '111')
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
    const wrongRoute = await sockReq(s.getSockPath(), '/nope', { method: 'GET' })
    expect(wrongRoute.status).toBe(404)
    expect(wrongRoute.body).toBe('')
  })

  it('rejects a bad token with 403', async () => {
    const s = await makeServer()
    const res = await sockReq(s.getSockPath(), '/prompt', {
      headers: { 'x-nodeterm-askpass-token': 'wrong' }
    })
    expect(res.status).toBe(403)
  })

  it('binds the socket owner-only (0600) and unlinks it on stop', async () => {
    // The socket's file mode IS the access control now: any other user must be refused by the
    // kernel, not by guessing wrong at the token.
    const s = await makeServer()
    const sock = s.getSockPath()
    expect(((await fsp.stat(sock)).mode & 0o777).toString(8)).toBe('600')
    s.stop()
    server = undefined
    await expect(fsp.stat(sock)).rejects.toThrow()
  })

  it('holds no passphrase state: every NEW ssh process prompts (prompt-free reconnects are the agent, not us)', async () => {
    // The old in-app cache served a second master from memory. AddKeysToAgent=yes replaced it:
    // once the agent holds the key, ssh never invokes askpass at all, so any ask that DOES reach
    // this server is one the agent could not answer and must go to the user.
    const prompts: { identityFile: string; retry: boolean; caller: string }[] = []
    const s = await makeServer(async (req) => {
      prompts.push(req)
      return 'hunter2'
    })
    const identity = '/home/u/.ssh/id_test_a'

    const first = await post(s, identity, '111')
    expect(first.body).toBe('hunter2')
    const second = await post(s, identity, '222')
    expect(second.body).toBe('hunter2')
    expect(prompts).toEqual([
      // `caller` is the asking master's pid, which is how main names the server on the dialog.
      { identityFile: identity, retry: false, caller: '111' },
      { identityFile: identity, retry: false, caller: '222' } // a new pid is a fresh connection, never a retry
    ])
  })

  it('flags a second ask from the SAME ssh process as retry (the "didn\'t work" dialog copy)', async () => {
    let calls = 0
    const s = await makeServer(async (req) => {
      calls++
      expect(req.retry).toBe(calls > 1)
      return calls === 1 ? 'wrong-guess' : 'right-guess'
    })
    const identity = '/home/u/.ssh/id_test_b'

    const first = await post(s, identity, '333')
    expect(first.body).toBe('wrong-guess')

    // ssh re-invokes askpass with the SAME prompt text when the passphrase failed to decrypt.
    const retry = await post(s, identity, '333')
    expect(retry.body).toBe('right-guess')
    expect(calls).toBe(2)
  })

  it('dedupes concurrent asks for the same identity into one prompt whose answer feeds both', async () => {
    let calls = 0
    const s = await makeServer(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 50))
      return 'shared-pw'
    })
    const identity = '/home/u/.ssh/id_test_c'
    const [a, b] = await Promise.all([post(s, identity, '444'), post(s, identity, '555')])
    expect(a.body).toBe('shared-pw')
    expect(b.body).toBe('shared-pw')
    expect(calls).toBe(1)
  })

  it('declining a SHARED dialog attributes the cancel to EVERY master that joined it', async () => {
    // Two projects share one key: the second master joins the first master's in-flight dialog
    // rather than opening its own. Recording only the first asker's pid on decline left the
    // joiner's connect with wasCancelledBy(itsPid) === false, so one project showed "needs its
    // passphrase" while the other showed the generic connection error for the same Cancel click.
    let release: ((v: string | null) => void) | undefined
    const s = await makeServer(() => new Promise((r) => (release = r)))
    const identity = '/home/u/.ssh/id_test_joint'
    const first = post(s, identity, '9001')
    // Wait until the first ask's dialog is actually outstanding before the second joins it.
    await new Promise<void>((resolve) => {
      const tick = () => (s.isPromptingAny() ? resolve() : setTimeout(tick, 5))
      tick()
    })
    const second = post(s, identity, '9002')
    // Give the joiner's POST time to reach the in-flight dialog, then decline it once.
    await new Promise((r) => setTimeout(r, 50))
    release!(null)
    const [a, b] = await Promise.all([first, second])
    expect(a.body).toBe('')
    expect(b.body).toBe('')
    expect(s.wasCancelledBy(9001)).toBe(true)
    expect(s.wasCancelledBy(9002)).toBe(true)
    expect(s.wasCancelledBy(9003)).toBe(false) // a master that never asked stays unaffected
  })

  it('serializes prompts for different identities: one dialog at a time, both answered', async () => {
    let active = 0
    let maxActive = 0
    const s = await makeServer(async (req) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      return `pw-for-${req.identityFile}`
    })
    const [a, b] = await Promise.all([
      post(s, '/home/u/.ssh/id_d1', '666'),
      post(s, '/home/u/.ssh/id_d2', '777')
    ])
    expect(maxActive).toBe(1)
    expect(a.body).toBe('pw-for-/home/u/.ssh/id_d1')
    expect(b.body).toBe('pw-for-/home/u/.ssh/id_d2')
  })

  it('a cancel answers empty, records the pid, and keeps NO suppression latch', async () => {
    let calls = 0
    const s = await makeServer(async () => {
      calls++
      return null
    })
    const identity = '/home/u/.ssh/id_test_e'

    expect(s.cancelledRecently()).toBe(false)
    const first = await post(s, identity, '888')
    expect(first.body).toBe('')
    expect(s.cancelledRecently()).toBe(true)
    expect(s.wasCancelledBy(888)).toBe(true)

    // There is deliberately no per-(key, pid) latch suppressing a repeat ask. ssh ABANDONS a key
    // the moment it gets an empty answer, so the process that was declined never asks for that
    // key again: a latch could only ever fire on a RECYCLED pid, where it would silently swallow
    // a brand-new master's legitimate prompt and leave the user staring at a failed connect with
    // no dialog. Prompting again is the safe direction for a case that cannot occur anyway.
    const second = await post(s, identity, '888')
    expect(second.body).toBe('')
    expect(calls).toBe(2)
  })

  it('a LATER connect (new ssh pid) prompts again after a cancel, with no explicit reset', async () => {
    let calls = 0
    const s = await makeServer(async () => {
      calls++
      return calls === 1 ? null : 'second-time-pw'
    })
    const identity = '/home/u/.ssh/id_test_f'

    await post(s, identity, '101') // cancelled
    // A fresh master (fresh pid) must always get its own dialog; nothing lingers from a decline.
    const second = await post(s, identity, '102')
    expect(second.body).toBe('second-time-pw')
    expect(calls).toBe(2)
  })

  it("a sibling connect does not wipe a concurrent master's retry counter (pid-scoped counting)", async () => {
    // Two projects share one key: master B's fresh ask must read as a first ask, while master
    // A's re-ask right after must STILL read as A's retry, or the dialog would drop its "that
    // passphrase didn't work" wording exactly when the user needs it.
    const flags: boolean[] = []
    let calls = 0
    const s = await makeServer(async (req) => {
      flags.push(req.retry)
      calls++
      return calls === 1 ? 'wrong-guess' : 'right-guess'
    })
    const identity = '/home/u/.ssh/id_test_shared'

    await post(s, identity, '501') // master A, first ask
    await post(s, identity, '502') // sibling master B: its own first ask
    await post(s, identity, '501') // master A asking AGAIN: a retry despite B in between
    expect(flags).toEqual([false, false, true])
  })

  it('sets SSH_ASKPASS even when the server has NO configured identity file', async () => {
    // The regression this guards: saved servers usually have identityFile null (ssh then offers
    // the default identities, which are exactly the ones likely to be encrypted). Returning {}
    // here meant the tty-less master had no way to prompt and the whole feature was dead code.
    const s = await makeServer()
    const env = s.envFor(undefined, '/ud/ssh-askpass.sh')
    expect(env.SSH_ASKPASS).toBe('/ud/ssh-askpass.sh')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env.NODETERM_ASKPASS_IDENTITY).toBe('')
  })

  it('declines a server password prompt instead of answering it', async () => {
    let calls = 0
    const s = await makeServer(async () => {
      calls++
      return 'should-never-be-sent'
    })
    const identity = '/home/u/.ssh/id_test_pw'
    const res = await post(s, identity, '601', "root@example.com's password: ")
    expect(res.body).toBe('')
    expect(calls).toBe(0) // no dialog shown
  })

  it('a password prompt after a passphrase ask is not counted as a passphrase retry', async () => {
    // Key decrypts fine but the server rejects publickey and falls back to password auth: the
    // declined password prompt must not open a dialog, and must not pollute the retry counter
    // (a later passphrase ask from this same pid would then wrongly say "that didn't work").
    let calls = 0
    const s = await makeServer(async (req) => {
      calls++
      expect(req.retry).toBe(false)
      return 'correct-passphrase'
    })
    const identity = '/home/u/.ssh/id_test_fallback'

    await post(s, identity, '701')
    const fallback = await post(s, identity, '701', "root@example.com's password: ")
    expect(fallback.body).toBe('')
    expect(calls).toBe(1)
  })

  it('keys the ask under the key the PROMPT names, not the configured -i identity', async () => {
    // Without IdentitiesOnly (no configured identityFile), ssh also offers default identities:
    // the prompt names the real key, and that is what the dialog, the retry counter and the
    // in-flight coalescing must be keyed by.
    const s = await makeServer(async (req) => `pw-for-${req.identityFile}`)
    const configured = '/home/u/.ssh/id_configured'
    const actual = '/home/u/.ssh/id_default'
    const res = await post(s, configured, '801', passphrasePrompt(actual))
    expect(res.body).toBe(`pw-for-${actual}`)
  })

  it('drops an oversized body without wedging the server', async () => {
    const s = await makeServer(async () => 'never-asked')
    const big = 'x'.repeat(80_000)
    await sockReq(s.getSockPath(), '/prompt', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-askpass-token': s.getToken()
      },
      body: `identity=${big}`
    }).catch(() => undefined) // the server destroys the connection; a reset here is expected
    // The server must still answer the next, well-formed request.
    const after = await post(s, '/home/u/.ssh/id_test_i', '401')
    expect(after.status).toBe(200)
  })

  it('attributes a decline to the ssh process that was asked, not to a global clock', async () => {
    // The failure message used to come from a process-wide timestamp, so a Cancel on one project
    // relabelled an unrelated project's genuine auth failure as "needs its passphrase" for the
    // next 60s. The askpass helper's $PPID is the master pid (verified against a real sshd), so
    // the answer can be exact.
    const s = await makeServer(async () => null)
    const identity = '/home/u/.ssh/id_test_pid'
    await post(s, identity, '4242') // master 4242's prompt was declined

    expect(s.wasCancelledBy(4242)).toBe(true)
    expect(s.wasCancelledBy(9999)).toBe(false) // a different project's master: unaffected
    // Only a caller that cannot name its master (adopted orphan, test fake) falls back to time.
    expect(s.wasCancelledBy(undefined)).toBe(true)
  })

  it('envFor passes the configured identity file through as a hint', async () => {
    const s = await makeServer()
    const env = s.envFor('/home/u/.ssh/id_ed25519', '/ud/ssh-askpass.sh')
    expect(env.SSH_ASKPASS).toBe('/ud/ssh-askpass.sh')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env.NODETERM_ASKPASS_IDENTITY).toBe('/home/u/.ssh/id_ed25519')
  })

  it('envFor is EMPTY when the server never started: a failed relay must degrade, not misconfigure', () => {
    // Boot survives a failed start() now (index.ts catches it); handing out askpass env pointing
    // at a socket that never bound would make every prompt a silent curl error instead of the
    // pre-feature behavior (ssh fails with its real error, no prompt).
    const s = new AskpassServer()
    expect(s.envFor('/home/u/.ssh/id_ed25519', '/ud/ssh-askpass.sh')).toEqual({})
  })
})
