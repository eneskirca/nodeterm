import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

let dir: string
const servers: HookServer[] = []
function hook(): HookServer { const h = new HookServer(); servers.push(h); return h }
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-boot-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})
afterEach(() => {
  for (const h of servers.splice(0)) h.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
describe('nonfatal hook startup used by both application shells', () => {
  it('continues boot with an actionable warning and preserves a malformed file', async () => {
    const h = hook()
    fs.writeFileSync(h.endpointFilePath(), 'NODETERM_HOOK_PO')
    const warning = await h.startForApp()
    expect(warning).toContain('Agent hooks are disabled')
    expect(warning).toContain(h.endpointFilePath())
    expect(warning).toContain('restart nodeterm')
    expect(h.getPort()).toBe(0)
    expect(h.getToken()).toBe('')
    expect(fs.readFileSync(h.endpointFilePath(), 'utf8')).toBe('NODETERM_HOOK_PO')
  })
  it('continues boot without replacing an unrelated HTTP listener advertisement', async () => {
    const foreign = createServer((_req, res) => { res.writeHead(404); res.end() })
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    const h = hook()
    const content = `NODETERM_HOOK_PORT='${(foreign.address() as { port: number }).port}'\n`
    fs.writeFileSync(h.endpointFilePath(), content)
    try {
      expect(await h.startForApp()).toContain('Agent hooks are disabled')
      expect(h.getPort()).toBe(0)
      expect(fs.readFileSync(h.endpointFilePath(), 'utf8')).toBe(content)
    } finally { await new Promise<void>((resolve) => foreign.close(() => resolve())) }
  })
  it('continues boot with hooks disabled while a real owner keeps serving', async () => {
    const owner = hook()
    expect(await owner.startForApp()).toBeNull()
    const contents = fs.readFileSync(owner.endpointFilePath(), 'utf8')
    const other = hook()
    expect(await other.startForApp()).toContain('Close any other nodeterm instance')
    expect(other.getPort()).toBe(0)
    expect(fs.readFileSync(owner.endpointFilePath(), 'utf8')).toBe(contents)
    const response = await fetch(`http://127.0.0.1:${owner.getPort()}/verify`, {
      method: 'POST', headers: { 'x-nodeterm-hook-token': owner.getToken() }
    })
    expect(response.status).toBe(204)
  })
  it('reclaims a stale advertisement and retains its local bearer for SSH upgrade proof', async () => {
    const h = hook()
    fs.writeFileSync(h.endpointFilePath(), `NODETERM_HOOK_SOCK='${path.join(dir, 'sock', 'hook.sock')}'\nNODETERM_HOOK_TOKEN='previous-run'\n`)
    expect(await h.startForApp()).toBeNull()
    expect(h.getPreviousEndpointToken()).toBe('previous-run')
    expect(h.getPort()).toBeGreaterThan(0)
  })
})
