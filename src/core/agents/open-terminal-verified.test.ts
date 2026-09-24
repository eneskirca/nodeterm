import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'

const secret = Buffer.alloc(32, 5)
const foreign = Buffer.alloc(32, 9)
let dir: string
let handled: boolean[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cmd-auth-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(secret)
  hookServer.setControlHandler(async ({ verified }) => {
    handled.push(verified)
    return { ok: true, message: 'fixture only; no terminal spawned' }
  })
})
beforeEach(() => { handled = [] })
afterAll(() => {
  hookServer.setIdentityStrictOverride(() => undefined)
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

function post(socket: boolean, json: boolean, args: Record<string, string>, token?: string) {
  const body = json ? JSON.stringify({ nodeId: 'source', args }) : new URLSearchParams({
    nodeId: 'source', ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`arg.${k}`, v]))
  }).toString()
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      ...(socket ? { socketPath: hookServer.getSockPath() } : { host: '127.0.0.1', port: hookServer.getPort() }),
      path: '/control/open-terminal', method: 'POST',
      headers: {
        'x-nodeterm-hook-token': hookServer.getToken(),
        ...(token === undefined ? {} : { 'x-nodeterm-node-token': token }),
        'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        accept: json ? 'application/json' : 'text/plain'
      }
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

for (const socket of [false, true]) {
  describe(socket ? 'unix socket' : 'TCP', () => {
    for (const json of [false, true]) {
      it(`requires identity whenever cmd is present (${json ? 'JSON' : 'form/text'})`, async () => {
        for (const strict of [false, true, undefined]) {
          hookServer.setIdentityStrictOverride(() => strict)
          const cases: Record<string, string>[] = [
            { cmd: 'fixture-command' }, { cmd: '' }, { cmd: ' ', 'dry-run': '' }
          ]
          for (const args of cases) {
            for (const token of [undefined, '', nodeAuthToken(foreign, 'source')]) {
              const res = await post(socket, json, args, token)
              expect(res.status).toBe(403)
              expect(json ? JSON.parse(res.body).error : res.body.trim()).toBe('Terminal command refused.')
            }
            expect(handled).toEqual([])
            expect((await post(socket, json, args, nodeAuthToken(secret, 'other'))).status).toBe(403)
            expect(handled).toEqual([])
            expect((await post(socket, json, args, nodeAuthToken(secret, 'source'))).status).toBe(200)
            expect(handled).toEqual([true])
            handled = []
          }
        }
      })
    }
    it('preserves plain terminal policy and fails closed without an identity secret', async () => {
      hookServer.setIdentityStrictOverride(() => false)
      expect((await post(socket, true, {})).status).toBe(200)
      expect(handled).toEqual([false])
      handled = []
      hookServer.clearNodeAuthSecretForTests()
      try {
        expect((await post(socket, true, { cmd: 'fixture-command' })).status).toBe(403)
        expect(handled).toEqual([])
        expect((await post(socket, true, {})).status).toBe(200)
        expect(handled).toEqual([false])
      } finally { hookServer.setNodeAuthSecret(secret) }
    })
  })
}
