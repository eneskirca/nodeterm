// The 2026-09-28/29 incident, rebuilt as a fixture and run for real: the generated canvas-control
// and context-link shims, under the real /bin/sh, on an SSH host whose desktop has gone to sleep.
//
// What the host looked like, measured at the time:
//  - the session's endpoint file named a per-project reverse-tunnel socket under ~/.nodeterm that
//    still EXISTED but had no listener (the sshd that held it was gone with the connection);
//  - its siblings — every other project's tunnel from the same desktop — were dead the same way;
//  - an unrelated Server Edition ran on the same host, and its endpoint file sat in the first slot
//    the failover walk tries.
// The walk reached that Server Edition, which answered `control-unsupported-on-this-edition: …
// This is permanent on this host, not a temporary failure — do not retry.` for every control verb
// and "No linked nodes" for every context read. Both answers were true about the Server Edition
// and false about this session, and the first one tells an agent to stop for good over a tunnel
// that came back minutes later.
//
// The foreign endpoint here is not a stub: it is the real HookServer, started under a
// `.nodeterm-server` data dir so it writes its own endpoint file exactly where a Server Edition
// does, answering with the handlers src/server/index.ts and src/server/context-link.ts install.
// The first test proves that, so the rest cannot pass by pointing at an endpoint that says nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CONTROL_SHIM_SCRIPT, CONTROL_UNREACHABLE_MSG } from '../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT, CONTEXT_UNREACHABLE_MSG } from '../core/context-link-core'
import { FOREIGN_ENDPOINT_HINT } from '../core/agents/hook-endpoint-failover-sh'
import { hookServer } from '../core/agents/hook-server'
import { handleContextLinkRequest } from '../core/context-link'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import {
  CONTROL_UNSUPPORTED_ERROR,
  CONTROL_UNSUPPORTED_SENTENCE,
  serverEditionControlHandler
} from './control-unsupported'

const run = promisify(execFile)
const NODE_ID = 'node-desk-b'
const OWNER_TOKEN = 'owner-kid.owner-mac'

let dir = ''
let home = ''
let primaryEndpoint = ''
let primarySock = ''
let foreignEndpoint = ''
let owner: Server | null = null
const ownerRequests: { url: string; nodeToken: string | undefined }[] = []
const foreignControl: string[] = []
const foreignContext: string[] = []

/** A unix socket FILE with nobody listening: bind it in a child and SIGKILL the child, so nothing
 *  runs the unlink a clean close would. That is what a dead sshd leaves behind. */
async function staleSocket(p: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', "require('net').createServer().listen(process.argv[1], () => process.stdout.write('up'))", p],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
  if (!fs.statSync(p).isSocket()) throw new Error(`fixture: ${p} is not a stale socket`)
}

function tunnelEndpoint(file: string, sock: string, withTokenDir = true): void {
  fs.writeFileSync(
    file,
    `NODETERM_HOOK_SOCK='${sock}'\nNODETERM_HOOK_TOKEN='desktop-bearer'\n` +
      (withTokenDir
        ? `NODETERM_HOOK_VERSION='2'\nNODETERM_NODE_TOKEN_DIR='${path.join(home, '.nodeterm/node-tokens')}'\n`
        : 'NODETERM_HOOK_VERSION=1\n')
  )
}

beforeAll(async () => {
  // Short on purpose: socket paths must fit sun_path (104 bytes on macOS).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-td-'))
  home = path.join(dir, 'h')
  const desktop = path.join(home, '.nodeterm')
  fs.mkdirSync(path.join(desktop, 'node-tokens'), { recursive: true })
  fs.writeFileSync(path.join(desktop, 'node-tokens', NODE_ID), `${OWNER_TOKEN}\n`)

  // The session's own tunnel, and two siblings from the same desktop: one current, one pre-v2
  // (no advertised token dir, so the walk derives `<dir>/node-tokens`). All three are dead.
  primarySock = path.join(desktop, 'hook-a.sock')
  await staleSocket(primarySock)
  primaryEndpoint = path.join(desktop, 'hook-endpoint-project-a-e1b3.env')
  tunnelEndpoint(primaryEndpoint, primarySock)
  await staleSocket(path.join(desktop, 'hook-b.sock'))
  tunnelEndpoint(path.join(desktop, 'hook-endpoint-project-b.env'), path.join(desktop, 'hook-b.sock'))
  await staleSocket(path.join(desktop, 'hook-c.sock'))
  tunnelEndpoint(path.join(desktop, 'hook-endpoint-project-c.env'), path.join(desktop, 'hook-c.sock'), false)

  // The unrelated Server Edition, booted by the real code under its real data dir name.
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(home, '.nodeterm-server') }))
  await hookServer.start()
  hookServer.setControlHandler(async (req) => {
    foreignControl.push(req.verb)
    return serverEditionControlHandler(req)
  })
  hookServer.setContextLinkHandler(async (req) => {
    foreignContext.push(req.verb)
    return handleContextLinkRequest(req)
  })
  for (const [name, script] of [['nodeterm.sh', CONTROL_SHIM_SCRIPT], ['context.sh', CONTEXT_SHIM_SCRIPT]]) {
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 })
  }

  foreignEndpoint = path.join(home, '.nodeterm-server', 'hook-endpoint.env')
  const advertised = fs.readFileSync(foreignEndpoint, 'utf8')
  // The shape measured on the host: a port, a token dir, and (off Windows) a unix socket — all of
  // it inside this fixture, never the developer's own ~/.nodeterm.
  expect(advertised).toContain(`NODETERM_NODE_TOKEN_DIR='${path.join(home, '.nodeterm-server/node-tokens')}'`)
  const sock = /NODETERM_HOOK_SOCK='([^']+)'/.exec(advertised)?.[1]
  if (sock) expect(sock.startsWith(dir)).toBe(true)
})

afterAll(async () => {
  hookServer.stop()
  if (owner) await new Promise<void>((r) => owner!.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run a shim the way an agent on the SSH host does, with the env its tmux session was born with. */
async function call(
  name: string,
  args: string[],
  endpoint = primaryEndpoint
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('/bin/sh', [path.join(dir, name), ...args], {
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NODETERM_CANVAS_CONTROL: '1',
        NODETERM_NODE_ID: NODE_ID,
        NODETERM_HOOK_ENDPOINT: endpoint
      }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const control = (args: string[], endpoint?: string) => call('nodeterm.sh', args, endpoint)
const context = (args: string[], endpoint?: string) => call('context.sh', args, endpoint)

/** The claims that made the incident expensive. None of them may reach an agent whose own
 *  connection is merely down. */
function expectNoForeignVerdict(r: { stdout: string; stderr: string }): void {
  const all = `${r.stdout}\n${r.stderr}`
  expect(all).not.toContain(CONTROL_UNSUPPORTED_ERROR)
  expect(all).not.toContain(CONTROL_UNSUPPORTED_SENTENCE)
  expect(all).not.toMatch(/permanent/i)
  expect(all).not.toMatch(/do not retry/i)
  expect(all).not.toMatch(/Server Edition/)
  expect(all).not.toMatch(/No linked nodes/)
}

/** The sentence that replaces them: the owning connection is unreachable, it is temporary, and
 *  the thing to wait for is the desktop's tunnel coming back. */
function expectOwnerUnreachable(stderr: string): void {
  expect(stderr).toContain(FOREIGN_ENDPOINT_HINT)
  expect(stderr).toMatch(/owns this node is unreachable/)
  expect(stderr).toMatch(/temporary/i)
  expect(stderr).toMatch(/tunnel/)
  expect(stderr).toMatch(/reconnect/)
}

describe.skipIf(process.platform === 'win32')('owning desktop tunnel down, unrelated Server Edition up', () => {
  it('the fixture is the incident: reached directly, that Server Edition answers the permanent refusal', async () => {
    const ctl = await control(['list'], foreignEndpoint)
    expect(ctl.code).toBe(1)
    expect(ctl.stderr).toContain(CONTROL_UNSUPPORTED_SENTENCE)
    const ctx = await context(['list'], foreignEndpoint)
    expect(ctx.stdout).toContain('No linked nodes')
    // Reset: everything below must reach it zero times.
    foreignControl.length = 0
    foreignContext.length = 0
  })

  it('control: skips the foreign endpoint and says the owning connection is down, not that control is unsupported', async () => {
    for (const args of [['list'], ['close', '--node', 'finished-a,finished-b']]) {
      const r = await control(args)
      expect(r.code).toBe(1)
      expectOwnerUnreachable(r.stderr)
      expect(r.stderr).toContain(CONTROL_UNREACHABLE_MSG)
      expectNoForeignVerdict(r)
    }
    expect(foreignControl).toEqual([])
  })

  it('context: skips the foreign endpoint instead of reporting its "No linked nodes"', async () => {
    const r = await context(['list'])
    expect(r.code).toBe(1)
    expectOwnerUnreachable(r.stderr)
    expect(r.stderr).toContain(CONTEXT_UNREACHABLE_MSG)
    expectNoForeignVerdict(r)
    expect(foreignContext).toEqual([])
  })

  // The advice has to be true: once the desktop reconnects (sshd rebinds the same socket path),
  // the SAME command, retried unchanged, reaches the owner and presents the owner's capability.
  it('retrying after the tunnel comes back reaches the owning desktop', async () => {
    fs.unlinkSync(primarySock)
    owner = createServer((req, res) => {
      const tok = req.headers['x-nodeterm-node-token']
      ownerRequests.push({ url: req.url ?? '', nodeToken: Array.isArray(tok) ? tok[0] : tok })
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('owner reply')
      })
    })
    await new Promise<void>((r) => owner!.listen(primarySock, r))

    const ctl = await control(['close', '--node', 'finished-a,finished-b'])
    expect(ctl).toMatchObject({ code: 0, stdout: 'owner reply' })
    const ctx = await context(['list'])
    expect(ctx).toMatchObject({ code: 0, stdout: 'owner reply' })

    expect(ownerRequests.map((q) => q.url)).toEqual(['/control/close', '/context-link/list'])
    expect(ownerRequests.every((q) => q.nodeToken === OWNER_TOKEN)).toBe(true)
    expect(foreignControl).toEqual([])
    expect(foreignContext).toEqual([])
  })
})
