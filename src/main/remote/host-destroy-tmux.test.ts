// Issue #581 regression — the relay's `pty.destroy` against a REAL tmux session.
//
// The destroy chain (`destroySession` → tmux kill fan-out) swallows its per-step failures by
// design ("session may not exist on this socket" is a normal case), so the promise resolving
// proves only that nothing threw. Measured while root-causing #581: a chain that quietly ended
// NOTHING answered `ok:true`, and the phone — whose alert path only speaks on `ok:false` — had
// nothing to show over a session that kept running. `handleDestroy` therefore verifies the
// OUTCOME (`sessionExists` after the destroy must say gone) before answering.
//
// This suite runs the verb against tmux for real, on the real `node-terminal` socket with a
// unique throwaway session name — the same discipline as the canvas-control shim and
// remote-usage suites (generated side-effects are proven on the real interpreter, not a fake).
// node-pty stays mocked (suite convention: it is built for Electron's ABI); the pty spawn is
// irrelevant here — the tmux side-calls and the kill are real subprocesses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { fakePlatform } from '../../core/platform-fake'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { TMUX_SOCKET, sessionName } from '../../core/tmux-naming'
import { createHostHandlers, type HostFsOps, type HostRelaySocket } from './host-service'

const run = promisify(execFile)
// Same fixed candidates findTmux tries first; a machine with tmux elsewhere just skips the suite.
const TMUX =
  ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p)) ??
  null

vi.mock('../../core/session-host-backend', async () =>
  (await import('../../core/__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 4321
  })
}))
vi.mock('../../core/pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe.skipIf(!TMUX || process.platform === 'win32')(
  'pty.destroy against a real tmux session (issue #581)',
  () => {
    let userData: string
    let nodeId: string

    const hasSession = async (): Promise<boolean> => {
      try {
        await run(TMUX!, ['-L', TMUX_SOCKET, 'has-session', '-t', `=${sessionName(nodeId)}`])
        return true
      } catch {
        return false
      }
    }

    beforeEach(async () => {
      userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-destroy-'))
      initPlatform(fakePlatform({ userDataDir: userData }))
      // Unique per run: this socket is the REAL one, shared with whatever else the machine runs.
      nodeId = `e581-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await run(TMUX!, ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName(nodeId), 'sleep', '600'])
      expect(await hasSession()).toBe(true)
    })
    afterEach(async () => {
      resetPlatformForTests()
      try {
        await run(TMUX!, ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(nodeId)}`])
      } catch {
        /* already gone — the expected case */
      }
      await fs.rm(userData, { recursive: true, force: true })
    })

    interface Rig {
      manager: import('../../core/pty-manager').PtyManager
      handlers: ReturnType<typeof createHostHandlers>
      responses: Array<{ id: string; ok: boolean; body: unknown }>
    }

    // `destroyNode` receives the rig so a test can wire it to the real manager (the production
    // shape) or to a silent no-op (the #581 shape).
    async function rig(destroyNode: (id: string, r: Rig) => Promise<void>): Promise<Rig> {
      const { PtyManager } = await import('../../core/pty-manager')
      const manager = new PtyManager()
      manager.init(() => DEFAULT_SETTINGS)
      const responses: Rig['responses'] = []
      const socket: HostRelaySocket = {
        respond: (id, ok, body) => responses.push({ id, ok, body }),
        sendFrame: () => true
      }
      const fsOps: HostFsOps = {
        listDir: async () => [],
        readText: async () => '',
        readBinary: async () => '',
        writeText: async () => true
      }
      const r: Partial<Rig> = { manager, responses }
      r.handlers = createHostHandlers(
        manager,
        socket,
        fsOps,
        () => [],
        async () => '',
        () => null,
        undefined,
        undefined,
        (id) => destroyNode(id, r as Rig)
      )
      return r as Rig
    }

    async function attachAndDestroy(r: Rig): Promise<void> {
      r.handlers.onRpc({ id: 'a', method: 'pty.attach', params: { nodeId, cols: 80, rows: 24 } })
      await vi.waitFor(() => expect(r.responses.length).toBeGreaterThan(0), { timeout: 10_000 })
      r.handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
      await vi.waitFor(() => expect(r.responses.length).toBeGreaterThan(1), { timeout: 15_000 })
    }

    it('the production wiring kills the real session and answers a verified ok', async () => {
      const r = await rig((id, { manager }) => manager.destroySession(null, id, { everySocket: true }))
      await attachAndDestroy(r)
      expect(r.responses.at(-1)).toMatchObject({ id: 'd', ok: true })
      expect(await hasSession()).toBe(false)
    }, 30_000)

    it('a destroy chain that quietly ends NOTHING now answers an honest error (the #581 symptom)', async () => {
      const r = await rig(async () => {}) // resolves without killing anything — the silent no-op
      await attachAndDestroy(r)
      // The REAL session is still running — and the verb now says so instead of `ok:true`.
      expect(await hasSession()).toBe(true)
      expect(r.responses.at(-1)).toEqual({
        id: 'd',
        ok: false,
        body: { message: expect.stringContaining('still running') }
      })
    }, 30_000)
  }
)
