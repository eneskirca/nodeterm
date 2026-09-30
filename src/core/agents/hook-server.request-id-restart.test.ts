// The request ledger survives an app restart: exercised at the route, with a real stop → start of
// the hook server over the SAME data dir (what an app restart is to the ledger).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, makeFakeUserDataDir } from '../platform-fake'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { REQUEST_ID_REPLAYED_LEAD } from '../control-request-ledger'
import { DURABLE_STATE_DIR } from '../durable-state'

const secret = Buffer.alloc(32, 9)
let dir: string
let handled = 0
let next: () => Promise<{ ok: boolean; message?: string; result?: unknown; indeterminate?: boolean }>

async function boot(): Promise<void> {
  await hookServer.start()
  hookServer.setNodeAuthSecret(secret)
  hookServer.setControlHandler(async () => {
    handled++
    return next()
  })
}

beforeAll(async () => {
  dir = makeFakeUserDataDir()
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await boot()
})
afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
})

async function restart(): Promise<void> {
  hookServer.stop()
  await boot()
}

function post(
  verb: string,
  opts: {
    node: string
    args?: Record<string, string>
    cliRequestId?: string
    json?: boolean
    verified?: boolean
  }
): Promise<{ status: number; body: string }> {
  const { node, args = {}, cliRequestId, json = false, verified = true } = opts
  const body = json
    ? JSON.stringify({ nodeId: node, args, ...(cliRequestId ? { requestId: cliRequestId } : {}) })
    : new URLSearchParams({
        nodeId: node,
        ...(cliRequestId ? { requestId: cliRequestId } : {}),
        ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`arg.${k}`, v]))
      }).toString()
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: `/control/${verb}`,
        method: 'POST',
        headers: {
          'x-nodeterm-hook-token': hookServer.getToken(),
          ...(verified ? { 'x-nodeterm-node-token': nodeAuthToken(secret, node) } : {}),
          'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
          accept: json ? 'application/json' : 'text/plain'
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, body: text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}


describe('control request ledger across an app restart', () => {
  it('a retry after a restart replays the reply instead of opening a second node', async () => {
    next = async () => ({ ok: true, message: 'opened a1', result: { ids: ['a1'] } })
    const args = { agent: 'claude', 'request-id': 'restart-1' }
    expect((await post('open-agent', { node: 'src-r1', args })).body).toBe('opened a1\n')
    await restart()
    const again = await post('open-agent', { node: 'src-r1', args })
    expect(again.body.split('\n')[0]).toContain(REQUEST_ID_REPLAYED_LEAD)
    expect(again.body).toContain('opened a1')
    expect(handled).toBe(1)
    expect(fs.existsSync(path.join(dir, DURABLE_STATE_DIR, 'control-requests.json'))).toBe(true)
  })

  it('a call still IN FLIGHT when the process ended is UNKNOWN after the restart — refused, never re-run', async () => {
    handled = 0
    let release: (v: { ok: boolean; message: string }) => void = () => {}
    next = () => new Promise((r) => (release = r))
    const args = { agent: 'claude', 'request-id': 'restart-2' }
    const pending = post('open-agent', { node: 'src-r2', args }).catch(() => null)
    await new Promise((r) => setTimeout(r, 50))
    expect(handled).toBe(1)
    await restart()
    next = async () => ({ ok: true, message: 'opened TWICE' })
    const again = await post('open-agent', { node: 'src-r2', args })
    expect(again.body).toMatch(/^request-outcome-unknown/)
    expect(again.body).not.toContain('opened TWICE')
    expect(handled).toBe(1)
    // …and it stays unknown across a second restart: nothing can settle it any more.
    await restart()
    expect((await post('open-agent', { node: 'src-r2', args })).body).toMatch(/^request-outcome-unknown/)
    expect(handled).toBe(1)
    release({ ok: true, message: 'late' })
    await pending
  })

  it('a corrupt ledger file starts empty and the server still boots', async () => {
    hookServer.stop()
    const file = path.join(dir, DURABLE_STATE_DIR, 'control-requests.json')
    fs.writeFileSync(file, 'garbage{')
    await boot()
    handled = 0
    next = async () => ({ ok: true, message: 'opened fresh' })
    expect((await post('open-agent', { node: 'src-r3', args: { agent: 'claude', 'request-id': 'restart-3' } })).body).toBe(
      'opened fresh\n'
    )
    expect(handled).toBe(1)
  })
})
