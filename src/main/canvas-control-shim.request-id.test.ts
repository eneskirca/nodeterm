// A retried open must not open a second node — the real generated shim, run by the real /bin/sh,
// against the real hook server and its request ledger.
//
// The case nothing else can reach: the shim's OWN re-post. The primary endpoint here is a proxy
// that forwards the request to the hook server and then drops the connection instead of relaying
// the reply — so the server did the work and curl saw nothing (`000`). That is exactly what makes
// the shim walk to another endpoint of the same app and POST again (issue #445's failover). Before
// the per-run request id, that re-post was a second call and opened a second node.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CONTROL_SHIM_SCRIPT } from '../core/canvas-control-core'
import { hookServer } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { REQUEST_ID_REPLAYED_LEAD, requestIdAnnounceLine } from '../core/control-request-ledger'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'

const run = promisify(execFile)
const SECRET = Buffer.alloc(32, 13)

let dir = ''
let shim = ''
let tokens = ''
let liveEndpoint = ''
let droppingEndpoint = ''
let home = ''
let proxy: net.Server
let proxied = 0
let handled: { verb: string; args: Record<string, string> }[] = []
/** When set, the handler answers like desktop main after its 120 s wait: indeterminate, with the
 *  real answer handed back later through `onLateAnswer`. */
let timeOutNext = false
let lateAnswer: ((r: { ok: boolean; message?: string }) => void) | undefined
/** When set, the handler parks until the test releases it — a call still in flight. */
let parkNext: Promise<void> | undefined

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-shim-rid-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'userdata') }))
  shim = path.join(dir, 'nodeterm.sh')
  fs.writeFileSync(shim, CONTROL_SHIM_SCRIPT, { mode: 0o755 })
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setControlHandler(async (cmd) => {
    handled.push({ verb: cmd.verb, args: cmd.args })
    if (parkNext) {
      const parked = parkNext
      parkNext = undefined
      await parked
    }
    if (timeOutNext) {
      timeOutNext = false
      lateAnswer = cmd.onLateAnswer
      return { ok: false, error: 'no answer within 120s — the request may still complete', indeterminate: true }
    }
    return { ok: true, message: `opened node #${handled.length}` }
  })

  // Every node proves itself: the ledger keys only VERIFIED callers.
  tokens = path.join(dir, 'tokens')
  fs.mkdirSync(tokens)
  for (const id of ['node-a', 'node-b', 'node-c']) {
    fs.writeFileSync(path.join(tokens, id), `${nodeAuthToken(SECRET, id)}\n`, { mode: 0o600 })
  }
  const endpointFile = (port: number): string =>
    `NODETERM_HOOK_PORT='${port}'\n` +
    `NODETERM_HOOK_TOKEN='${hookServer.getToken()}'\n` +
    "NODETERM_HOOK_VERSION='2'\n" +
    `NODETERM_NODE_TOKEN_DIR='${tokens}'\n`
  liveEndpoint = path.join(dir, 'live.env')
  fs.writeFileSync(liveEndpoint, endpointFile(hookServer.getPort()))

  // The dropping proxy: request through, reply swallowed, connection closed.
  proxy = net.createServer((client) => {
    proxied++
    const upstream = net.connect(hookServer.getPort(), '127.0.0.1')
    client.pipe(upstream)
    upstream.once('data', () => {
      client.destroy()
      upstream.destroy()
    })
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  droppingEndpoint = path.join(dir, 'dropping.env')
  fs.writeFileSync(droppingEndpoint, endpointFile((proxy.address() as net.AddressInfo).port))

  // The live endpoint the walk finds: the Server Edition slot under $HOME, the first candidate
  // `nt_candidates` prints — the same arrangement the #445 failover test uses.
  home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.nodeterm-server'), { recursive: true })
  fs.writeFileSync(path.join(home, '.nodeterm-server', 'hook-endpoint.env'), endpointFile(hookServer.getPort()))
})

beforeEach(() => {
  handled = []
  proxied = 0
  timeOutNext = false
  lateAnswer = undefined
  parkNext = undefined
})

afterAll(async () => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

function callShim(
  node: string,
  endpoint: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return run('/bin/sh', [shim, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_NODE_ID: node,
      NODETERM_HOOK_ENDPOINT: endpoint,
      HOME: home
    }
  })
}

describe('canvas-control shim: a retried open does not open a second node', () => {
  it("the shim's own re-post after a dropped reply is recognised: ONE node, and the reply says so", async () => {
    const { stdout } = await callShim('node-a', droppingEndpoint, ['open-agent', '--agent', 'claude'])
    // The first POST went through the proxy and was dropped; the walk re-posted to the live one.
    expect(proxied).toBeGreaterThanOrEqual(1)
    expect(handled).toHaveLength(1)
    expect(stdout.split('\n')[0]).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(stdout).toContain('opened node #1')
  })

  it('an agent that re-runs the command with the same --request-id gets the first reply, not a second node', async () => {
    const args = ['open-agent', '--agent', 'claude', '--prompt', 'review it', '--request-id', 'review-1']
    const first = await callShim('node-b', liveEndpoint, args)
    expect(first.stdout.trim()).toBe('opened node #1')
    const again = await callShim('node-b', liveEndpoint, args)
    expect(again.stdout).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(again.stdout).toContain('opened node #1')
    expect(handled).toHaveLength(1)
    expect(handled[0].args).toEqual({ agent: 'claude', prompt: 'review it' })
  })

  it('the same --request-id with a different call is refused, and nothing is opened', async () => {
    await callShim('node-c', liveEndpoint, ['open-agent', '--agent', 'claude', '--request-id', 'x-1'])
    const err = await callShim('node-c', liveEndpoint, ['open-agent', '--agent', 'codex', '--request-id', 'x-1']).then(
      () => null,
      (e: { code: number; stderr: string }) => e
    )
    expect(err?.code).toBe(1)
    expect(err?.stderr).toMatch(/request-id-conflict/)
    expect(handled).toHaveLength(1)
  })

  // Review follow-up to #1027. The per-run id is invisible to the agent — until a call times out,
  // when it is the only handle on a call that may still complete. The reply prints it; passing it
  // back as --request-id turns the retry into the SAME call, which answers with what really happened.
  it('a timed-out run prints its per-run id, and passing it back recovers the late answer — one node', async () => {
    timeOutNext = true
    const err = await callShim('node-b', liveEndpoint, ['open-agent', '--agent', 'claude']).then(
      () => null,
      (e: { code: number; stderr: string }) => e
    )
    expect(err?.code).toBe(1)
    const id = /--request-id (cli-[0-9a-f]+)/.exec(err?.stderr ?? '')?.[1]
    expect(id, err?.stderr).toBeDefined()
    lateAnswer?.({ ok: true, message: 'opened node #1 (late)' })
    const retry = await callShim('node-b', liveEndpoint, ['open-agent', '--agent', 'claude', '--request-id', id!])
    expect(retry.stdout).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(retry.stdout).toContain('opened node #1 (late)')
    expect(handled).toHaveLength(1)
  })

  // Review follow-up to #1033. The `request id:` line on a timed-out reply only helps a caller that
  // SEES the reply, and an agent's tool call is usually killed at 120 s — the same instant the app
  // gives up. So the id is on stderr BEFORE the POST: here while the call is still in flight, with no
  // reply anywhere, and it is the id the ledger holds (passing it back replays, never re-runs).
  it('announces the per-run id on stderr before any reply exists, and that id is the one the ledger holds', async () => {
    let release!: () => void
    parkNext = new Promise<void>((resolve) => (release = resolve))
    const child = spawn('/bin/sh', [shim, 'open-worktree', '--branch', 'feat-slow'], {
      env: {
        PATH: process.env.PATH ?? '',
        NODETERM_CANVAS_CONTROL: '1',
        NODETERM_NODE_ID: 'node-c',
        NODETERM_HOOK_ENDPOINT: liveEndpoint,
        HOME: home
      }
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    for (let i = 0; i < 400 && !(handled.length === 1 && /request id: /.test(stderr)); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    // In flight: the server is holding the call and has answered nothing, yet the id is on screen.
    expect(handled).toHaveLength(1)
    expect(stdout).toBe('')
    const id = /request id: (cli-[0-9a-f]+) /.exec(stderr)?.[1]
    expect(id, stderr).toBeDefined()
    expect(stderr).toContain(requestIdAnnounceLine(id!))
    release()
    expect(await exited).toBe(0)
    const retry = await callShim('node-c', liveEndpoint, ['open-worktree', '--branch', 'feat-slow', '--request-id', id!])
    expect(retry.stdout).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(handled).toHaveLength(1)
  })

  it('two runs without --request-id are two calls: the per-run id protects a run, not a repeat', async () => {
    await callShim('node-a', liveEndpoint, ['open-terminal'])
    await callShim('node-a', liveEndpoint, ['open-terminal'])
    expect(handled).toHaveLength(2)
  })
})
