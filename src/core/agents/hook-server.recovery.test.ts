// Issue #445, the server half: endpoint publication must reflect listener liveness, and a failed
// listen must not wedge the singleton. Before this, `start()` assigned `this.server` before the
// bind completed — a rejected listen left the field set, so every later `start()` returned early
// with port 0 while a PREVIOUS run's `hook-endpoint.env` kept advertising a dead port to every
// tmux session on the machine; and `stop()` cleared the in-memory port/token but left the file.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Armed per-test: the next createServer() returns a server whose listen() fails asynchronously,
 *  the way a real bind error (EADDRINUSE, EADDRNOTAVAIL) arrives. Everything else is real http. */
const listenControl = { failNext: false }

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>()
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const srv = actual.createServer(...args)
      if (listenControl.failNext) {
        listenControl.failNext = false
        srv.listen = ((): typeof srv => {
          process.nextTick(() =>
            srv.emit(
              'error',
              Object.assign(new Error('listen EADDRINUSE (injected)'), { code: 'EADDRINUSE' })
            )
          )
          return srv
        }) as typeof srv.listen
      }
      return srv
    }
  }
})

import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

let dir = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-hs-recovery-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('hook server start/stop lifecycle (issue #445)', () => {
  it('a failed listen leaves the singleton retryable and preserves an advertisement it did not publish', async () => {
    // The file a previous app run left behind — it advertises a port nothing listens on.
    const ep = hookServer.endpointFilePath()
    fs.mkdirSync(path.dirname(ep), { recursive: true })
    fs.writeFileSync(ep, "NODETERM_HOOK_PORT='59999'\nNODETERM_HOOK_TOKEN='stale'\n")

    listenControl.failNext = true
    await expect(hookServer.start()).rejects.toThrow('EADDRINUSE')
    // The singleton is back in the clean never-started state, not wedged with a dead Server…
    expect(hookServer.getPort()).toBe(0)
    expect(hookServer.getToken()).toBe('')
    // A failed boot never takes ownership of a previous advertisement, even a stale one.
    expect(fs.readFileSync(ep, 'utf8')).toContain("NODETERM_HOOK_TOKEN='stale'")

    // A retry — same process, no app restart — comes up and re-advertises.
    await hookServer.start()
    expect(hookServer.getPort()).toBeGreaterThan(0)
    expect(fs.existsSync(ep)).toBe(true)
    expect(fs.readFileSync(ep, 'utf8')).toContain(`NODETERM_HOOK_PORT='${hookServer.getPort()}'`)
  })

  it('stop() removes the endpoint file so it never advertises a dead listener', () => {
    const ep = hookServer.endpointFilePath()
    expect(fs.existsSync(ep)).toBe(true)
    hookServer.stop()
    expect(fs.existsSync(ep)).toBe(false)
    expect(hookServer.getPort()).toBe(0)
  })

  it('a stop/start cycle republishes the endpoint (the restart-handoff contract is unchanged)', async () => {
    await hookServer.start()
    const ep = hookServer.endpointFilePath()
    expect(fs.readFileSync(ep, 'utf8')).toContain(`NODETERM_HOOK_PORT='${hookServer.getPort()}'`)
  })
})
