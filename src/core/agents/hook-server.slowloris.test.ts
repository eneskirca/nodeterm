// The slowloris guard is a RECEIVE-phase guard, and this pins that it stays one.
//
// A destructive /control/ verb (write, close) parks in the renderer for as long as the user takes
// to answer the confirmation dialog — by design, up to the desktop's 120s `pendingControl` bound.
// The 2s guard used to apply to the whole request lifetime, so it destroyed that socket mid-dialog:
// the sh shim reported "control endpoint unreachable" (curl exit 52 at ~2019ms) while a late
// confirm STILL delivered the text — the agent was told nothing happened when it had, and may
// retry, which is a silent duplicate delivery.
//
// The guard is raised, not removed: nothing may park forever, so both routes keep a bounded
// ceiling and the context-link route additionally races its handler. Spins the real hookServer,
// same harness precedent as context-link.cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

// Comfortably past the 2s receive-phase guard, and short enough to keep the suite quick.
const HANDLER_PARK_MS = 3500

let dir = ''

function post(path: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}${path}`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/plain'
    },
    body
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-slowloris-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  // Stands in for the renderer holding the request open on the confirmation dialog.
  hookServer.setControlHandler(async () => {
    await new Promise((r) => setTimeout(r, HANDLER_PARK_MS))
    return { ok: true, message: 'sent' }
  })
  // Stands in for a linked-transcript read whose remote leg is slow (but not wedged).
  hookServer.setContextLinkHandler(async () => {
    await new Promise((r) => setTimeout(r, HANDLER_PARK_MS))
    return 'linked transcript'
  })
})

afterAll(() => {
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

// Concurrent: the two routes are independent, and each has to sit out the guard in real time.
// Run serially this file parks for 2 x HANDLER_PARK_MS of pure wall clock, which is dead weight
// on every suite run and needless scheduling pressure on the other files sharing the machine.
describe.concurrent('hook server: the slowloris guard is receive-phase only', () => {
  it('/control/ survives a handler that parks longer than the guard', async () => {
    const res = await post('/control/write', 'nodeId=n1&arg.node=n2&arg.text=hi')
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('sent')
  }, 15000)

  it('/context-link/ survives a read that takes longer than the guard', async () => {
    const res = await post('/context-link/transcript', 'nodeId=n1&arg.node=n2')
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('linked transcript')
  }, 15000)
})
