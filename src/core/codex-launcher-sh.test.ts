// The generated Codex launcher, run by the real /bin/sh against the real hook server.
//
// This script is source no compiler checks, it is the ONLY thing standing between a Codex node and
// a shell, and its most important job is the one that is hardest to assert on paper: FALLING BACK.
// Every branch below therefore runs for real, with a fake `codex` on PATH that records the argv it
// was exec'd with — because "did it fall back with the arguments intact?" is exactly the question
// a string assertion cannot answer. Same discipline as canvas-control-shim.test.ts and
// remote-claude-usage.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createHmac, randomBytes } from 'node:crypto'
import { buildCodexLauncherScript } from './codex-identity-proxy'
import { hookServer } from './agents/hook-server'
import { nodeAuthKid, nodeAuthToken } from './agents/node-auth-token'
import {
  nodeTokenDir,
  resetNodeTokenFilesForTests,
  sweepNodeTokenFile,
  writeNodeTokenFile
} from './agents/node-token-files'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const run = promisify(execFile)

/** The one secret. Every token in this file is derived from it by `nodeAuthToken` — the same
 *  function the server verifies with, so a second derivation cannot hide here. */
const SECRET = randomBytes(32)

let dir = ''
let launcher = ''
let binDir = ''
let argvLog = ''
let started: Array<{ nodeId: string; cwd: string; accountId?: string; agentId?: string }> = []
let bound: Array<{ nodeId: string; threadId: string; accountId?: string; agentId?: string }> = []
let fallbacks: Array<{ nodeId: string; reason?: string }> = []
let startAnswer: (() => string) | null = null
let startDelayMs = 0
let bindAnswer: (() => void) | null = null

/** A stand-in for the real `codex`, which records how it was invoked before the injected body. */
function writeFakeCodex(body = 'exit 0'): void {
  fs.writeFileSync(
    path.join(binDir, 'codex'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n${body}\n`,
    { mode: 0o755 }
  )
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-launcher-'))
  binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir)
  argvLog = path.join(dir, 'codex-argv.log')
  writeFakeCodex()
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  launcher = path.join(dir, 'nodeterm-codex')
  // `true` stands in for `codex app-server daemon start`; `false` makes preflight exercise that
  // start rather than calling the fake client as a health probe. Health-specific cases override it.
  fs.writeFileSync(launcher, buildCodexLauncherScript('true', 'false'), { mode: 0o755 })
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setCodexThreadStartHandler(async ({ nodeId, cwd, accountId, agent }) => {
    started.push({ nodeId, cwd, accountId, agentId: agent?.agentId })
    if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs))
    if (!startAnswer) throw new Error('start refused')
    return startAnswer()
  })
  hookServer.setCodexThreadBindHandler(async ({ nodeId, threadId, accountId, agent }) => {
    bound.push({ nodeId, threadId, accountId, agentId: agent?.agentId })
    if (!bindAnswer) throw new Error('bind refused')
    bindAnswer()
  })
  hookServer.setCodexIdentityListener((e) => {
    if (e.mode === 'plain') fallbacks.push({ nodeId: e.nodeId, reason: e.reason })
  })
})

afterAll(() => {
  hookServer.stop()
  hookServer.clearNodeAuthSecretForTests()
  resetNodeTokenFilesForTests()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  started = []
  bound = []
  fallbacks = []
  startAnswer = () => 'thread-abc'
  startDelayMs = 0
  bindAnswer = () => {}
  fs.writeFileSync(argvLog, '')
  // The capability arrives through the FILE channel now (0600 under nodeTokenDir(), advertised as
  // NODETERM_NODE_TOKEN_DIR in the endpoint file) — never through the tmux argv. Re-materialised
  // per test because several cases below deliberately poison or remove it.
  fs.rmSync(nodeTokenDir(), { recursive: true, force: true })
  writeNodeTokenFile('node-1', nodeAuthToken(SECRET, 'node-1'))
})

/**
 * NOTE what is NOT here: `NODETERM_CODEX_NODE_TOKEN`. `buildPtyEnv` stopped emitting it (it rode
 * the world-readable tmux `-e` argv), so the launcher's real environment has no per-node credential
 * in it at all — it reads the token file. A test that kept injecting the var would prove the file
 * channel works only by accident.
 */
function baseEnv(): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: dir,
    NODETERM_NODE_ID: 'node-1',
    NODETERM_HOOK_ENDPOINT: hookServer.endpointFilePath(),
    // buildPtyEnv injects these at spawn too. The endpoint FILE is still required (it carries the
    // live coordinates after an app restart), but their presence is why a node whose endpoint file
    // vanished can still report that it fell back.
    NODETERM_HOOK_PORT: String(hookServer.getPort()),
    NODETERM_HOOK_TOKEN: hookServer.getToken()
  }
}

function callLauncher(
  args: string[],
  env: Record<string, string> = {},
  script = launcher
): Promise<{ stdout: string; stderr: string }> {
  const merged = { ...baseEnv(), ...env }
  for (const [k, v] of Object.entries(merged)) if (v === '') delete (merged as any)[k]
  return run('/bin/sh', [script, ...args], { env: merged, cwd: dir })
}

/** What the fake `codex` was exec'd with, one line per invocation. */
function codexArgv(): string[] {
  return fs.readFileSync(argvLog, 'utf8').split('\n').slice(0, -1)
}

/**
 * POST a codex-thread request DIRECTLY, bypassing the launcher's own account-id validation, to
 * exercise the SERVER's gate. Both bearer headers are presented so the request is authenticated and
 * only the account-id check can reject it.
 */
function postCodexThread(
  verb: 'start' | 'bind',
  fields: Record<string, string>
): Promise<number> {
  const body = new URLSearchParams(fields).toString()
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        method: 'POST',
        path: `/codex-thread/${verb}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'x-nodeterm-hook-token': hookServer.getToken(),
          'x-nodeterm-node-token': nodeAuthToken(SECRET, 'node-1')
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('generated Codex launcher', () => {
  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', launcher])).resolves.toBeTruthy()
  })

  it('starts a thread for a fresh node and resumes it on the shared app-server', async () => {
    await callLauncher([])
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
    expect(fallbacks).toEqual([])
  })

  // #350 (the confused deputy): the shared app-server is a PERSISTENT DAEMON started by the FIRST
  // codex node to launch, and reused by every later node. If the launcher starts it while THIS
  // node's per-pane NODETERM_NODE_ID is in the environment, the daemon — and every tool shell it
  // later spawns for EVERY node — inherits that one node's id. The thread→node resolver only
  // recovers the right node when the tool shell has NO NODETERM_NODE_ID (its guard is
  // `[ -z "$NODETERM_NODE_ID" ]`), so a leaked value silently collapses every codex node's identity
  // onto the daemon-starting node: Project B's codex then lists Project A's links and routes to A.
  // The daemon MUST therefore be started with the per-pane vars scrubbed. NODETERM_CODEX_ACCOUNT_ID
  // is the ONE exception — one daemon serves one account, and the resolver reads it to pick scope.
  it('starts the shared app-server daemon WITHOUT this node\'s per-pane NODETERM_NODE_ID (#350)', async () => {
    const envDump = path.join(dir, 'daemon-env.txt')
    const dumpScript = path.join(dir, 'dump-daemon-env.sh')
    fs.writeFileSync(
      dumpScript,
      `#!/bin/sh\n` +
        `printf 'NID=[%s]\\nACC=[%s]\\nHOOK=[%s]\\n' ` +
        `"\${NODETERM_NODE_ID-}" "\${NODETERM_CODEX_ACCOUNT_ID-}" "\${NODETERM_HOOK_ENDPOINT-}" ` +
        `> ${JSON.stringify(envDump)}\n`,
      { mode: 0o755 }
    )
    const script2 = path.join(dir, 'nodeterm-codex-envdump')
    fs.writeFileSync(script2, buildCodexLauncherScript(JSON.stringify(dumpScript), 'false'), {
      mode: 0o755
    })

    await callLauncher([], { NODETERM_CODEX_ACCOUNT_ID: 'acct-A' }, script2)

    const dumped = fs.readFileSync(envDump, 'utf8')
    // The per-pane node id is scrubbed for the daemon (else its tool shells all report node-1).
    expect(dumped).toContain('NID=[]')
    // …and the per-pane hook endpoint too — a tool shell recovers it per-thread from the record.
    expect(dumped).toContain('HOOK=[]')
    // The account scope is deliberately preserved: the resolver needs it to pick the record scope.
    expect(dumped).toContain('ACC=[acct-A]')
  })

  // The #351 interplay, pinned: a failed endpoint preflight (#351's unquoted-path sourcing bug,
  // an unreadable file, an app restart) must NEVER reach the daemon start. This is what makes #350
  // and #351 INDEPENDENT bugs rather than a chain — the daemon-env leak above requires the shared
  // path to have proceeded, and a #351-style failure falls back to plain codex BEFORE that line.
  it('a failed endpoint preflight never starts the daemon (#351 cannot feed #350)', async () => {
    const envDump = path.join(dir, 'daemon-env-endpointfail.txt')
    const dumpScript = path.join(dir, 'dump-daemon-env-endpointfail.sh')
    fs.writeFileSync(dumpScript, `#!/bin/sh\n: > ${JSON.stringify(envDump)}\n`, { mode: 0o755 })
    const script2 = path.join(dir, 'nodeterm-codex-endpointfail')
    fs.writeFileSync(script2, buildCodexLauncherScript(JSON.stringify(dumpScript), 'false'), {
      mode: 0o755
    })

    await callLauncher(['do', 'work'], { NODETERM_HOOK_ENDPOINT: '/nonexistent/hook-endpoint.env' }, script2)

    // Plain codex with the args intact, and the daemon start command was never invoked.
    expect(codexArgv()).toEqual(['do work'])
    expect(fs.existsSync(envDump)).toBe(false)
    expect(fallbacks.map((f) => f.reason)).toContain('hook-endpoint-unavailable')
  })

  it('keeps the caller arguments after the thread it resolved', async () => {
    await callLauncher(['--ask-for-approval', 'never', 'fix the bug'])
    expect(codexArgv()).toEqual([
      '--remote unix:// resume thread-abc --ask-for-approval never fix the bug'
    ])
  })

  it('binds a caller-supplied thread on resume instead of starting a new one', async () => {
    await callLauncher(['resume', 'thread-xyz'])
    expect(bound).toEqual([{ nodeId: 'node-1', threadId: 'thread-xyz' }])
    expect(started).toEqual([])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-xyz'])
  })

  // A daemon update/restart closes every attached `--remote` TUI at once. The launcher used to
  // `exec` the client, so the surviving tmux pane fell back to a shell even though the rollout was
  // intact. Run the generated shell for real and replace the socket inode while the first fake
  // client fails: the same thread must come back automatically, and the one-shot prompt MUST NOT be
  // replayed (that would duplicate the user's turn after a transport-only failure).
  it('resumes the same thread after the shared daemon socket is replaced, without replaying args', async () => {
    const codexHome = path.join(dir, 'daemon-replaced-home')
    const socketDir = path.join(codexHome, 'app-server-control')
    const socket = path.join(socketDir, 'app-server-control.sock')
    const failedOnce = path.join(dir, 'daemon-replaced-once')
    fs.mkdirSync(socketDir, { recursive: true })
    fs.writeFileSync(socket, 'generation-one')
    fs.rmSync(failedOnce, { force: true })
    writeFakeCodex(
      `case "$*" in\n` +
        `  --remote*)\n` +
        `    if [ ! -e ${JSON.stringify(failedOnce)} ]; then\n` +
        `      : > ${JSON.stringify(failedOnce)}\n` +
        // Rename a second inode over the marker; unlink+create may immediately reuse one inode.
        `      printf next > ${JSON.stringify(`${socket}.next`)}\n` +
        `      mv ${JSON.stringify(`${socket}.next`)} ${JSON.stringify(socket)}\n` +
        `      exit 1\n` +
        `    fi\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0`
    )
    const recovering = path.join(dir, 'nodeterm-codex-replaced-daemon')
    fs.writeFileSync(recovering, buildCodexLauncherScript('true', 'true'), { mode: 0o755 })

    const result = await callLauncher(
      ['--ask-for-approval', 'never', 'fix the bug'],
      { CODEX_HOME: codexHome },
      recovering
    )

    expect(codexArgv()).toEqual([
      '--remote unix:// resume thread-abc --ask-for-approval never fix the bug',
      '--remote unix:// resume thread-abc'
    ])
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(result.stderr).toContain('shared Codex connection reset; restoring this session')
  })

  // Mutation guard for the generation/health condition above: an unrelated Codex client failure
  // against the SAME healthy daemon returns to the shell once. Removing that condition makes this
  // test log four launches (and turns every deterministic CLI error into a restart loop).
  it('does not relaunch an unrelated client failure against the same healthy daemon', async () => {
    const codexHome = path.join(dir, 'daemon-healthy-home')
    const socketDir = path.join(codexHome, 'app-server-control')
    fs.mkdirSync(socketDir, { recursive: true })
    fs.writeFileSync(path.join(socketDir, 'app-server-control.sock'), 'same-generation')
    writeFakeCodex('case "$*" in --remote*) exit 7 ;; esac\nexit 0')
    const guarded = path.join(dir, 'nodeterm-codex-healthy-daemon')
    fs.writeFileSync(guarded, buildCodexLauncherScript('true', 'true'), { mode: 0o755 })

    await expect(callLauncher([], { CODEX_HOME: codexHome }, guarded)).rejects.toMatchObject({
      code: 7
    })
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
  })

  it('starts a missing daemon and then resumes the same thread', async () => {
    const codexHome = path.join(dir, 'daemon-missing-home')
    const socketDir = path.join(codexHome, 'app-server-control')
    const socket = path.join(socketDir, 'app-server-control.sock')
    const failedOnce = path.join(dir, 'daemon-missing-once')
    const starts = path.join(dir, 'daemon-starts.log')
    fs.mkdirSync(socketDir, { recursive: true })
    fs.rmSync(socket, { force: true })
    fs.rmSync(failedOnce, { force: true })
    fs.writeFileSync(starts, '')
    writeFakeCodex(
      `case "$*" in\n` +
        `  --remote*)\n` +
        `    if [ ! -e ${JSON.stringify(failedOnce)} ]; then\n` +
        `      : > ${JSON.stringify(failedOnce)}\n` +
        `      rm -f ${JSON.stringify(socket)}\n` +
        `      exit 1\n` +
        `    fi\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0`
    )
    const startCommand =
      `printf 'start\\n' >> ${JSON.stringify(starts)}; ` +
      `mkdir -p ${JSON.stringify(socketDir)}; : > ${JSON.stringify(socket)}`
    const probeCommand = `[ -e ${JSON.stringify(socket)} ]`
    const recovering = path.join(dir, 'nodeterm-codex-missing-daemon')
    fs.writeFileSync(recovering, buildCodexLauncherScript(startCommand, probeCommand), {
      mode: 0o755
    })

    await callLauncher(['resume', 'thread-xyz'], { CODEX_HOME: codexHome }, recovering)

    expect(codexArgv()).toEqual([
      '--remote unix:// resume thread-xyz',
      '--remote unix:// resume thread-xyz'
    ])
    // Once during preflight, once after the fake transport failure removed the socket.
    expect(fs.readFileSync(starts, 'utf8').trim().split('\n')).toEqual(['start', 'start'])
  })

  it('uses a responsive orphaned daemon without invoking its refusing lifecycle start', async () => {
    const running = path.join(dir, 'nodeterm-codex-running-orphan')
    fs.writeFileSync(running, buildCodexLauncherScript('false', 'true'), { mode: 0o755 })

    await callLauncher([], {}, running)

    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(fallbacks).toEqual([])
  })

  // S6: the account scope travels in the POST body, never on argv (Constraint 6), so the record is
  // filed under the right account. An empty id (the system account) reaches the handler as undefined.
  it('threads the managed account id through start (in the body, not on argv)', async () => {
    await callLauncher([], { NODETERM_CODEX_ACCOUNT_ID: 'acct-A' })
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir), accountId: 'acct-A' }])
    // The account id is NOT on the codex command line.
    expect(codexArgv().join(' ')).not.toContain('acct-A')
  })

  it('threads the managed account id through a resume bind too', async () => {
    await callLauncher(['resume', 'thread-xyz'], { NODETERM_CODEX_ACCOUNT_ID: 'acct-A' })
    expect(bound).toEqual([{ nodeId: 'node-1', threadId: 'thread-xyz', accountId: 'acct-A' }])
    expect(codexArgv().join(' ')).not.toContain('acct-A')
  })

  it('an account id that could escape the mapping directory → plain codex, never an unbound bind', async () => {
    await callLauncher(['do', 'work'], { NODETERM_CODEX_ACCOUNT_ID: '../evil' })
    // No thread was started or bound under the hostile scope; codex ran plain with the args intact.
    expect(started).toEqual([])
    expect(bound).toEqual([])
    expect(codexArgv()).toEqual(['do work'])
    expect(fallbacks.map((f) => f.reason)).toContain('codex-account-invalid')
  })

  // The SERVER's own gate, independent of the launcher: a hostile account id posted directly is
  // refused at 400 BEFORE the start handler runs — so `startCodexThread` never creates a thread the
  // record write would then orphan. (Mutation: drop the isSafeAccountId gate ⇒ 200 + a started row.)
  it('the server refuses a hostile account id at 400 before starting a thread', async () => {
    const status = await postCodexThread('start', {
      nodeId: 'node-1',
      cwd: fs.realpathSync(dir),
      accountId: '../evil'
    })
    expect(status).toBe(400)
    expect(started).toEqual([]) // the handler never ran ⇒ no orphaned thread
  })

  it('the server accepts a safe managed account id on a direct post', async () => {
    const status = await postCodexThread('start', {
      nodeId: 'node-1',
      cwd: fs.realpathSync(dir),
      accountId: 'acct-A'
    })
    expect(status).toBe(200)
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir), accountId: 'acct-A' }])
  })
})

// Each case below is a way the managed identity can be unavailable on a real machine. The
// assertion is always the same pair: plain `codex` ran WITH THE ORIGINAL ARGUMENTS, and the
// desktop was told why. Upstream, every one of these exited 69 — a dead node.
describe('falls back to plain codex', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['no node id (a session nodeterm did not spawn)', { NODETERM_NODE_ID: '' }, 'node-id-unavailable'],
    [
      'no hook endpoint',
      { NODETERM_HOOK_ENDPOINT: '' },
      'hook-endpoint-unavailable'
    ],
    [
      'hook endpoint points at nothing (app restarted, tmux session outlived it)',
      { NODETERM_HOOK_ENDPOINT: '/nonexistent/hook-endpoint.env' },
      'hook-endpoint-unavailable'
    ]
  ]

  for (const [name, env, reason] of cases) {
    it(`${name} → exec codex with the same args`, async () => {
      await callLauncher(['--ask-for-approval', 'never', 'do the thing'], env)
      expect(codexArgv()).toEqual(['--ask-for-approval never do the thing'])
      expect(started).toEqual([])
      // A node id is the ONLY thing the fallback report cannot be made without.
      if (env.NODETERM_NODE_ID === '') expect(fallbacks).toEqual([])
      else expect(fallbacks).toEqual([{ nodeId: 'node-1', reason }])
    })
  }

  // Two facts wore one reason before, and the string named only the first ("an older CLI"), which
  // sent a reader of a codex 0.146.0 node hunting for a version problem it did not have.
  it('an older codex with no app-server → plain codex, not a dead node', async () => {
    const runtime = path.join(dir, '.codex', 'packages', 'standalone', 'current')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    try {
      const noServer = path.join(dir, 'nodeterm-codex-no-server')
      fs.writeFileSync(noServer, buildCodexLauncherScript('false', 'false'), { mode: 0o755 })
      await callLauncher(['hello'], {}, noServer)
      expect(codexArgv()).toEqual(['hello'])
      expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'app-server-unavailable' }])
    } finally {
      fs.rmSync(path.join(dir, '.codex'), { recursive: true, force: true })
    }
  })

  it('an npm/snap codex with no standalone runtime → its own reason, not "an older CLI"', async () => {
    // MEASURED: codex-cli 0.146.0 installed via npm answers `app-server daemon start` with
    // "managed standalone Codex install not found at ~/.codex/packages/standalone/current/codex".
    // The caps probe normally keeps this case away from the launcher entirely — but the pane
    // resolves CODEX_HOME from its OWN environment (§8.5) and an install can be removed after boot.
    const noServer = path.join(dir, 'nodeterm-codex-no-standalone')
    fs.writeFileSync(noServer, buildCodexLauncherScript('false', 'false'), { mode: 0o755 })
    await callLauncher(['hello'], {}, noServer)
    expect(codexArgv()).toEqual(['hello'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'codex-standalone-missing' }])
  })

  it('honors CODEX_HOME when deciding which of the two it hit', async () => {
    const home = path.join(dir, 'relocated-codex')
    const runtime = path.join(home, 'packages', 'standalone', 'current')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const noServer = path.join(dir, 'nodeterm-codex-relocated')
    fs.writeFileSync(noServer, buildCodexLauncherScript('false', 'false'), { mode: 0o755 })
    await callLauncher(['hello'], { CODEX_HOME: home }, noServer)
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'app-server-unavailable' }])
  })

  it('a thread owned by another live node → plain codex, never two clients on one thread', async () => {
    bindAnswer = null
    await callLauncher(['resume', 'thread-xyz'])
    expect(codexArgv()).toEqual(['resume thread-xyz'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-bind-refused' }])
  })

  it('the app-server refusing to start a thread → plain codex', async () => {
    startAnswer = null
    await callLauncher([])
    expect(codexArgv()).toEqual([''])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-start-failed' }])
  })

  it('a resume with an unusable session id → plain codex, id left alone', async () => {
    await callLauncher(['resume', 'not a; thread'])
    expect(codexArgv()).toEqual(['resume not a; thread'])
    expect(bound).toEqual([])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-id-unavailable' }])
  })
})

describe('a start handler that takes real time', () => {
  // REGRESSION. `/codex-thread/start` mints a thread through a five-step conversation with an
  // app-server that is typically COLD — the first codex node after boot. The route inherited the
  // 2s slowloris guard (a RECEIVE-phase guard), so the socket was destroyed while the handler was
  // still working: curl failed, the launcher fell back to plain codex, and the server went on to
  // create the thread and write a record for it. An orphan thread and an orphan record, per
  // attempt, in the most common case there is. A handler that resolves synchronously — which is
  // what this suite used to have — cannot see any of that.
  it('is waited for, and its thread is the one codex resumes', async () => {
    startDelayMs = 3000
    await callLauncher([])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
    expect(fallbacks).toEqual([])
  }, 20_000)
})

// The channel and the derivation both changed under this launcher: the token is `kid.mac` (one
// shared derivation with /hook/*) and it arrives in a 0600 FILE, not in the tmux argv. Between the
// two changes the feature was INERT — the launcher read an env var nothing set any more, reported
// `node-token-unavailable` and ran plain codex. These are the tests that say it is not.
describe('the per-node capability, over the file channel', () => {
  it('accepts the kid.mac wire shape — the dot is part of the token, not a charset violation', async () => {
    // THE TRAP. The old gate was `*[!A-Za-z0-9_-]*`, minted from HMAC(secret, nodeId) with no
    // separator in it. The shared derivation puts a `.` between kid and mac, so that gate rejects
    // EVERY current token and degrades every codex node silently.
    const token = nodeAuthToken(SECRET, 'node-1')
    expect(token).toContain('.')
    expect(fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8').trim()).toBe(token)
    await callLauncher([])
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(fallbacks).toEqual([])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
  })

  it('reads the token from the FILE with the env channel gone entirely', async () => {
    expect(baseEnv().NODETERM_CODEX_NODE_TOKEN).toBeUndefined()
    await callLauncher(['resume', 'thread-xyz'])
    expect(bound).toEqual([{ nodeId: 'node-1', threadId: 'thread-xyz' }])
    expect(fallbacks).toEqual([])
  })

  it('is unmoved by a stale env var left over from a pre-upgrade session', async () => {
    // Charset-valid but minted for the WRONG node. If anything still read that variable, the route
    // would 403 and this node would degrade to plain codex.
    await callLauncher([], { NODETERM_CODEX_NODE_TOKEN: nodeAuthToken(SECRET, 'node-2') })
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(fallbacks).toEqual([])
  })

  it('ignores NODETERM_CODEX_NODE_TOKEN entirely — the "one release" fallback was never real', async () => {
    // The fallback shipped for "a session spawned by the previous build", and the test that
    // certified it fed a NEW-format token into the OLD variable — an input the previous build never
    // produced. What that build actually set is base64url(HMAC(secret, nodeId)) with NO dot, which
    // the current verifier reads as a foreign kid ⇒ `legacy` ⇒ 403 on /codex-thread/{start,bind}.
    // So the fallback bought one wasted round-trip and the same degrade. A pre-upgrade session runs
    // plain codex until it is relaunched.
    sweepNodeTokenFile('node-1')
    fs.rmSync(path.join(nodeTokenDir(), 'node-1'), { force: true })
    const oldFormat = createHmac('sha256', SECRET).update('node-1').digest('base64url')
    expect(oldFormat).not.toContain('.') // the shape the previous build actually wrote
    await callLauncher([], { NODETERM_CODEX_NODE_TOKEN: oldFormat })
    expect(started).toEqual([])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'node-token-unavailable' }])
  })

  it('a missing token file and no env var → node-token-unavailable → plain codex', async () => {
    fs.rmSync(path.join(nodeTokenDir(), 'node-1'), { force: true })
    await callLauncher(['--ask-for-approval', 'never', 'do the thing'])
    expect(codexArgv()).toEqual(['--ask-for-approval never do the thing'])
    expect(started).toEqual([])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'node-token-unavailable' }])
  })

  it('a token path that cannot be read as a file → the same degrade, never a crash', async () => {
    // A directory where the token should be: `head` fails, and the launcher must treat that the
    // way it treats every other unavailable identity — plain codex with the arguments intact.
    const file = path.join(nodeTokenDir(), 'node-1')
    fs.rmSync(file, { force: true })
    fs.mkdirSync(file)
    try {
      await callLauncher(['hello'])
      expect(codexArgv()).toEqual(['hello'])
      expect(started).toEqual([])
      expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'node-token-unavailable' }])
    } finally {
      fs.rmSync(file, { recursive: true, force: true })
    }
  })
})

describe('per-node capability (the authorization the shared bearer cannot give)', () => {
  const post = (verb: string, body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${hookServer.getPort()}/codex-thread/${verb}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-hook-token': hookServer.getToken(),
        ...headers
      },
      body
    })

  it('binding node-1 with node-2\'s token is 403 — judged by the SHARED verifier', async () => {
    const res = await post('bind', 'nodeId=node-1&threadId=thread-xyz', {
      'x-nodeterm-node-token': nodeAuthToken(SECRET, 'node-2')
    })
    expect(res.status).toBe(403)
    expect(bound).toEqual([])
  })

  it('our own kid with a mutated mac is 403 on start as well as bind', async () => {
    const good = nodeAuthToken(SECRET, 'node-1')
    const mac = good.slice(good.indexOf('.') + 1)
    const mutated = `${nodeAuthKid(SECRET)}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`
    expect(mutated).not.toBe(good)
    expect((await post('bind', 'nodeId=node-1&threadId=thread-xyz', {
      'x-nodeterm-node-token': mutated
    })).status).toBe(403)
    expect((await post('start', `nodeId=node-1&cwd=${encodeURIComponent(dir)}`, {
      'x-nodeterm-node-token': mutated
    })).status).toBe(403)
    expect(bound).toEqual([])
    expect(started).toEqual([])
  })

  it('start and bind stay STRICT: a tokenless caller is refused, unlike /hook/*', async () => {
    // These routes were strict from day one and have no upgrade population to protect — a
    // pre-#167 session has no launcher that calls them at all — so `legacy` is a 403 here.
    expect((await post('start', `nodeId=node-1&cwd=${encodeURIComponent(dir)}`, {})).status).toBe(403)
    expect((await post('bind', 'nodeId=node-1&threadId=thread-xyz', {})).status).toBe(403)
    expect(started).toEqual([])
    expect(bound).toEqual([])
  })

  it('the fallback report is trusted only when it presents no token at all', async () => {
    // The one route the capability is not required on — because the commonest thing it reports is
    // that there was no capability to present. The exemption is exactly that narrow: a report that
    // DOES carry a token must carry the right one, or a session holding only the shared bearer
    // could flag a sibling node as fallen back.
    const report = (nodeId: string, headers: Record<string, string>) =>
      post('fallback', `nodeId=${nodeId}&reason=broker-unreachable`, headers)
    expect((await report('node-1', {})).status).toBe(204)
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'broker-unreachable' }])
    const wrong = await report('node-1', {
      'x-nodeterm-node-token': nodeAuthToken(SECRET, 'node-2')
    })
    expect(wrong.status).toBe(403)
    expect(fallbacks).toHaveLength(1)
    const right = await report('node-1', {
      'x-nodeterm-node-token': nodeAuthToken(SECRET, 'node-1')
    })
    expect(right.status).toBe(204)
    expect(fallbacks).toHaveLength(2)
  })

  it("refuses a token minted for a SIBLING node, and falls back rather than binding it", async () => {
    // The hijack shape the file channel has to survive: node-1's own token FILE holding a token
    // minted for node-2 (a case-folding collision on APFS, a hand-edited file).
    writeNodeTokenFile('node-1', nodeAuthToken(SECRET, 'node-2'))
    await callLauncher(['resume', 'thread-xyz'])
    // The route rejected it before the handler ran: no binding was recorded for node-1.
    expect(bound).toEqual([])
    expect(codexArgv()).toEqual(['resume thread-xyz'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-bind-refused' }])
  })
})

// THIS PANE'S AGENT LABEL travels in the POST body on both calls.
//
// The pane is the only durable holder of it: a tmux session outlives the app, so a bind arriving
// after a restart is the common case and nothing server-side still remembers what agent a node
// runs. The server re-derives the canvas-control grant from the id rather than trusting a claim
// (see codex-thread-id-route.test.ts), so what travels here is a label, not a capability — and
// like the account id it must stay in the BODY, never on argv, where a shared host's `ps` reads it.
describe('the pane agent id reaches the record', () => {
  it('threads NODETERM_AGENT_ID through start', async () => {
    await callLauncher([], { NODETERM_AGENT_ID: 'custom:abc' })
    expect(started).toEqual([
      { nodeId: 'node-1', cwd: fs.realpathSync(dir), agentId: 'custom:abc' }
    ])
    expect(codexArgv().join(' ')).not.toContain('custom:abc')
  })

  it('threads it through a resume bind too', async () => {
    await callLauncher(['resume', 'thread-xyz'], { NODETERM_AGENT_ID: 'custom:abc' })
    expect(bound).toEqual([
      { nodeId: 'node-1', threadId: 'thread-xyz', agentId: 'custom:abc' }
    ])
    expect(codexArgv().join(' ')).not.toContain('custom:abc')
  })

  it('starts a thread with no label when the pane carries none, rather than failing', async () => {
    // `${NODETERM_AGENT_ID-}` under `set -u` and an unset var: the launch must still work. A node
    // whose label is missing gets a pre-agent record, which is the pre-feature behaviour.
    await callLauncher([], { NODETERM_AGENT_ID: '' })
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(fallbacks).toEqual([])
  })
})
