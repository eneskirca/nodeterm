// The tunnel probe gets a route of its own, and that route is deliberately identity-free.
//
// Before this, `RemoteHooks.verifyTunnel` POSTed `nodeId=verify` at `/hook/verify` — there was no
// such route; `verify` was an agentId falling through the generic `/hook/<agentId>` branch, and it
// answered 204 only because the probe sends no `payload` field. That is a coincidence, not a
// contract, and it is the kind that breaks silently: the FIRST identity check to land on `/hook/*`
// would have started judging the probe, and a probe that stops answering 204 disables the whole
// remote hook + skill install for that host with no error anyone sees.
//
// So: `/verify` answers 204 on the bearer alone, forever, and `/hook/verify` keeps doing the same
// forever too, because a host connected by an older desktop still has the old script on disk.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

const SECRET = Buffer.alloc(32, 3)

let dir = ''
let listenerCalls = 0
let rawCalls = 0

// Byte-for-byte what remote-hooks' curl sends: bearer header, form body, nodeId=verify.
function probe(path: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}${path}`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded',
      ...extra
    },
    body: 'nodeId=verify'
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-verify-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  // Identity ARMED — the whole point is that the probe is unaffected by it.
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setListener(() => {
    listenerCalls++
  })
  hookServer.setRawListener(() => {
    rawCalls++
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  listenerCalls = 0
  rawCalls = 0
})

describe('the tunnel probe', () => {
  it('answers 204 on the BEARER ALONE — no node token, ever', async () => {
    const res = await probe('/verify')
    expect(res.status).toBe(204)
    // It is a liveness probe, not an event: nothing downstream should hear about it.
    expect(listenerCalls).toBe(0)
    expect(rawCalls).toBe(0)
  })

  it('still answers /hook/verify for a host whose script predates this release', async () => {
    const res = await probe('/hook/verify')
    expect(res.status).toBe(204)
    expect(listenerCalls).toBe(0)
    expect(rawCalls).toBe(0)
  })

  // The route takes NO identity at all, so there is nothing for a token — good, absent or forged —
  // to fail. `verify` is not a node id and never will be, so a 403 here could only ever be a
  // false one, and a false 403 here silently costs the host its hooks.
  it('answers 204 even when a FORGED node token is presented — it judges no identity', async () => {
    const good = nodeAuthToken(SECRET, 'verify')
    const forged = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A')
    expect((await probe('/verify', { 'X-Nodeterm-Node-Token': forged })).status).toBe(204)
    expect((await probe('/hook/verify', { 'X-Nodeterm-Node-Token': forged })).status).toBe(204)
  })

  // Identity-free is not auth-free: the app-wide bearer still gates the socket.
  it('is still refused without the bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${hookServer.getPort()}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'nodeId=verify'
    })
    expect(res.status).toBe(403)
  })

  it('is a POST-only route, like every other', async () => {
    const res = await fetch(`http://127.0.0.1:${hookServer.getPort()}/verify`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('is what the remote tunnel probe actually curls', () => {
    const src = readFileSync(
      resolve(__dirname, '../../..', 'src/main/remote-ssh/remote-hooks.ts'),
      'utf8'
    )
    expect(src).toContain('http://localhost/verify')
    expect(src).not.toContain('http://localhost/hook/verify')
  })
})
