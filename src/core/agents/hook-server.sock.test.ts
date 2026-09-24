// The hook server's unix-socket listener (issue #367), exercised with the REAL curl against the
// REAL server — the same discipline as canvas-control-shim.test.ts, because the consumers of this
// listener are generated sh clients whose transport is exactly `curl --unix-socket`.
//
// What must hold: the socket answers the SAME routes through the SAME handler under the SAME auth
// as loopback TCP (it is a second door to one room, never a side entrance around the bearer or the
// per-node verdict); it sits at 0600 inside a 0700 dir; a stale socket file from a crash never
// blocks the next boot; and it is advertised — posixQuoted in the endpoint file (#358) and as
// NODETERM_HOOK_SOCK in the session env — only when it actually bound.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { HookServer, hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { parseEndpointEnv } from './hook-endpoint-parse'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

const run = promisify(execFile)

let dir = ''
let received: { verb: string; nodeId: string; verified: boolean }[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-sockls-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setControlHandler(async (cmd) => {
    received.push({ verb: cmd.verb, nodeId: cmd.nodeId, verified: cmd.verified })
    return { ok: true, message: `did ${cmd.verb}` }
  })
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

interface CurlReply {
  status: string
  body: string
}

/** POST a /control/ request with the real curl, over the socket or over loopback TCP. */
async function post(
  transport: { sock?: string; port?: number },
  verb: string,
  headers: Record<string, string>,
  nodeId = 'node-1'
): Promise<CurlReply> {
  const out = path.join(dir, `curl-out-${Math.random().toString(36).slice(2)}`)
  const args = ['-sS', '-o', out, '-w', '%{http_code}', '-X', 'POST']
  if (transport.sock) args.push('--unix-socket', transport.sock, `http://localhost/control/${verb}`)
  else args.push(`http://127.0.0.1:${transport.port}/control/${verb}`)
  args.push('-H', 'Accept: text/plain')
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  args.push('--data-urlencode', `nodeId=${nodeId}`)
  const { stdout } = await run('curl', args)
  const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  fs.rmSync(out, { force: true })
  return { status: stdout.trim(), body }
}

describe('hook server unix-socket listener', () => {
  it('binds hook.sock at 0600 inside a 0700 sock/ dir under the data dir', () => {
    const sock = hookServer.getSockPath()
    expect(sock).toBe(path.join(dir, 'sock', 'hook.sock'))
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700)
  })

  it('advertises it quoted in the endpoint file (#358 parser reads it back) and in buildPtyEnv', () => {
    const sock = hookServer.getSockPath()
    const raw = fs.readFileSync(hookServer.endpointFilePath(), 'utf8')
    expect(raw).toContain(`NODETERM_HOOK_SOCK='${sock}'\n`)
    expect(parseEndpointEnv(raw).NODETERM_HOOK_SOCK).toBe(sock)
    // ...while the TCP coordinates STAY: sessions holding a pre-socket script still connect.
    expect(Number(parseEndpointEnv(raw).NODETERM_HOOK_PORT)).toBe(hookServer.getPort())
    expect(hookServer.buildPtyEnv('n1', 'claude').NODETERM_HOOK_SOCK).toBe(sock)
  })

  it('answers the same route, through the same handler, on both transports', async () => {
    received = []
    const auth = { 'X-Nodeterm-Hook-Token': hookServer.getToken() }
    const viaSock = await post({ sock: hookServer.getSockPath() }, 'list', auth)
    const viaTcp = await post({ port: hookServer.getPort() }, 'list', auth)
    expect(viaSock).toEqual({ status: '200', body: 'did list\n' })
    expect(viaTcp).toEqual(viaSock)
    expect(received).toEqual([
      { verb: 'list', nodeId: 'node-1', verified: false },
      { verb: 'list', nodeId: 'node-1', verified: false }
    ])
  })

  // THE MUTATION GUARD the socket must carry: it is a second transport, not an auth bypass. A
  // mutation that skips (or always-passes) the bearer check turns both cases red.
  it('refuses a missing or wrong bearer over the socket, without reaching the handler', async () => {
    received = []
    const sock = hookServer.getSockPath()
    expect((await post({ sock }, 'list', {})).status).toBe('403')
    expect((await post({ sock }, 'list', { 'X-Nodeterm-Hook-Token': 'wrong' })).status).toBe('421')
    expect(received).toEqual([])
  })

  it('refuses a second live owner without touching its socket or endpoint', async () => {
    const sock = hookServer.getSockPath()
    const endpoint = fs.readFileSync(hookServer.endpointFilePath(), 'utf8')
    const other = new HookServer()
    await expect(other.start()).rejects.toThrow('hook-endpoint-owned')
    other.stop()
    expect(fs.readFileSync(hookServer.endpointFilePath(), 'utf8')).toBe(endpoint)
    expect(await post({ sock }, 'list', { 'X-Nodeterm-Hook-Token': hookServer.getToken() }))
      .toEqual({ status: '200', body: 'did list\n' })
  })
})

// The per-node identity machinery must be transport-agnostic: the verified-only verbs (sticky &
// co.) demand a token THIS instance minted for THAT node id, on the socket exactly as on TCP.
describe('unix-socket listener — verified-only verbs keep their gate', () => {
  const SECRET = Buffer.alloc(32, 9)

  beforeAll(() => {
    hookServer.setNodeAuthSecret(SECRET)
  })

  afterAll(() => {
    hookServer.clearNodeAuthSecretForTests()
  })

  it('sticky over the socket: refused without the per-node token, verified with it', async () => {
    const sock = hookServer.getSockPath()
    const bearer = { 'X-Nodeterm-Hook-Token': hookServer.getToken() }
    const refused = await post({ sock }, 'sticky', bearer)
    expect(refused.status).toBe('403')
    expect(refused.body).toContain('Sticky write refused.')
    received = []
    const ok = await post({ sock }, 'sticky', {
      ...bearer,
      'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, 'node-1')
    })
    expect(ok.status).toBe('200')
    expect(received).toEqual([{ verb: 'sticky', nodeId: 'node-1', verified: true }])
  })

  it("another node's token is refused over the socket too (forged, hard 403)", async () => {
    const reply = await post({ sock: hookServer.getSockPath() }, 'list', {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, 'node-OTHER')
    })
    expect(reply.status).toBe('403')
  })
})
