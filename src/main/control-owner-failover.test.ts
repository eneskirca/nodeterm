// Exercise generated POSIX clients with a dead Desktop tunnel, an unrelated local server,
// and a second tunnel. No control request may reach the unrelated server, even for `close`.
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROL_SHIM_SCRIPT } from '../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT } from '../core/context-link-core'
import { FOREIGN_ENDPOINT_HINT } from '../core/agents/hook-endpoint-failover-sh'

const run = promisify(execFile)
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
async function endpoint(status: number, message: string) {
  const requests: { url: string; body: string; nodeToken: string | string[] | undefined }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url!, body, nodeToken: req.headers['x-nodeterm-node-token'] })
    res.writeHead(status); res.end(message)
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, requests }
}
const clients = [
  { name: 'control', script: CONTROL_SHIM_SCRIPT, args: ['close', '--node', 'finished-a,finished-b'], route: '/control/close' },
  { name: 'context', script: CONTEXT_SHIM_SCRIPT, args: ['list'], route: '/context-link' }
]

describe.skipIf(process.platform === 'win32')('node identity survives endpoint failover', () => {
  for (const client of clients) {
    it.each(['missing', 'different'])(`${client.name}: skips a local server with %s node identity and reaches its own tunnel`, async kind => {
      const fixture = await setup(client, kind)
      const result = await fixture.call()
      expect(result.stdout).toBe('owner reply')
      expect(fixture.foreign.requests).toEqual([])
      expect(fixture.owner.requests).toHaveLength(1)
      expect(fixture.owner.requests[0].nodeToken).toBe('owner-capability')
      if (client.name === 'control') {
        expect(fixture.owner.requests[0].url).toBe(client.route)
        expect(new URLSearchParams(fixture.owner.requests[0].body).get('arg.node')).toBe('finished-a,finished-b')
      }
    })
    it(`${client.name}: accepts an old owning endpoint with adjacent tokens after three foreign candidates`, async () => {
      const fixture = await setup(client, 'missing')
      const home = path.dirname(path.dirname(fixture.fallback))
      const foreignFile = path.join(home, '.nodeterm-server/hook-endpoint.env')
      for (const relative of ['.config/node-terminal', 'Library/Application Support/node-terminal']) {
        const directory = path.join(home, relative)
        fs.mkdirSync(directory, { recursive: true })
        fs.copyFileSync(foreignFile, path.join(directory, 'hook-endpoint.env'))
      }
      fs.writeFileSync(fixture.fallback, fs.readFileSync(fixture.fallback, 'utf8')
        .replace(/^NODETERM_NODE_TOKEN_DIR=.*\n/m, ''))
      expect((await fixture.call()).stdout).toBe('owner reply')
      expect(fixture.foreign.requests).toEqual([])
      expect(fixture.owner.requests).toHaveLength(1)
    })
    it(`${client.name}: reports the missing owning connection, not a foreign edition refusal`, async () => {
      const fixture = await setup(client, 'missing')
      fs.unlinkSync(fixture.fallback)
      const error = await fixture.call().catch(e => e)
      expect(error.code).toBe(1)
      expect(error.stderr).toContain(FOREIGN_ENDPOINT_HINT)
      expect(error.stderr).not.toContain('control-unsupported-on-this-edition')
      expect(error.stderr).not.toContain('owner-capability')
      expect(fixture.foreign.requests).toEqual([])
      expect(fixture.owner.requests).toEqual([])
    })
    it.each([400, 403])(`${client.name}: keeps an owning endpoint's %s refusal final`, async status => {
      const fixture = await setup(client, 'missing', status)
      const error = await fixture.call().catch(e => e)
      expect(error.code).toBe(1)
      expect(error.stderr).toContain('owner refused')
      expect(error.stderr).not.toContain(FOREIGN_ENDPOINT_HINT)
      expect(fixture.owner.requests).toHaveLength(1)
      expect(fixture.foreign.requests).toEqual([])
    })
  }
})

async function setup(client: typeof clients[number], kind: string, ownerStatus = 200) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-control-owner-')); dirs.push(dir)
  const foreign = await endpoint(400, 'control-unsupported-on-this-edition')
  const owner = await endpoint(ownerStatus, ownerStatus === 200 ? 'owner reply' : 'owner refused')
  const ownTokens = path.join(dir, '.nodeterm/node-tokens')
  const foreignTokens = path.join(dir, '.nodeterm-server/node-tokens')
  fs.mkdirSync(ownTokens, { recursive: true }); fs.mkdirSync(foreignTokens, { recursive: true })
  fs.writeFileSync(path.join(ownTokens, 'node-1'), 'owner-capability\n')
  if (kind === 'different') fs.writeFileSync(path.join(foreignTokens, 'node-1'), 'foreign-capability\n')
  const writeEndpoint = (file: string, port: number, tokens: string) => fs.writeFileSync(file,
    `NODETERM_HOOK_PORT='${port}'\nNODETERM_HOOK_TOKEN='fixture-bearer'\nNODETERM_NODE_TOKEN_DIR='${tokens}'\n`)
  const primary = path.join(dir, '.nodeterm/primary.env')
  const fallback = path.join(dir, '.nodeterm/hook-endpoint-live.env')
  writeEndpoint(primary, 1, ownTokens)
  writeEndpoint(path.join(dir, '.nodeterm-server/hook-endpoint.env'), foreign.port, foreignTokens)
  writeEndpoint(fallback, owner.port, ownTokens)
  const shim = path.join(dir, 'client.sh'); fs.writeFileSync(shim, client.script)
  return { foreign, owner, fallback, call: () => run('/bin/sh', [shim, ...client.args], {
    timeout: 5000,
    env: { PATH: process.env.PATH, HOME: dir, NODETERM_CANVAS_CONTROL: '1', NODETERM_NODE_ID: 'node-1', NODETERM_HOOK_ENDPOINT: primary }
  }) }
}
