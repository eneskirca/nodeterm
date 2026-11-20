import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import net, { type Socket } from 'net'
import os from 'os'
import path from 'path'
import { build, type Plugin } from 'esbuild'
import {
  LineFramer,
  encodeFrame,
  type SessionHostFrame,
  type SessionHostResponse,
  type SessionHostSpawnOptions
} from './protocol'
import { sessionHostPaths, type SessionHostState } from './paths'

function fakePtyPlugin(killMode: 'throw' | 'deferred-exit'): Plugin {
  const killBody =
    killMode === 'throw'
      ? `throw new Error('synthetic kill refusal')`
      : `setTimeout(() => onExit?.({ exitCode: 0 }), 150)`
  return {
    name: 'session-host-routing-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({
        path: 'node-pty',
        namespace: 'host-routing'
      }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'host-routing' }, () => ({
        loader: 'js',
        contents: `
          export function spawn() {
            let onExit
            return {
              pid: 4242,
              onData() {},
              onExit(callback) { onExit = callback },
              write() {},
              resize() {},
              pause() {},
              resume() {},
              kill() { ${killBody} }
            }
          }
        `
      }))
    }
  }
}

async function waitForIdentity(dataDir: string): Promise<{ state: SessionHostState; token: string }> {
  const paths = sessionHostPaths(dataDir)
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as SessionHostState
      const token = readFileSync(paths.tokenPath, 'utf8').trim()
      if (state.endpoint && token) return { state, token }
    } catch {
      /* publication is intentionally asynchronous; keep polling within the test bound */
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('session host did not publish its identity')
}

function connectFrames(endpoint: string): Promise<{
  socket: Socket
  response(id: number): Promise<SessionHostResponse>
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    const framer = new LineFramer()
    const received = new Map<number, SessionHostResponse>()
    const waiters = new Map<number, (frame: SessionHostResponse) => void>()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of framer.push<SessionHostFrame>(chunk.toString('utf8'))) {
        if (!('id' in frame)) continue
        const waiter = waiters.get(frame.id)
        if (waiter) {
          waiters.delete(frame.id)
          waiter(frame)
        } else {
          received.set(frame.id, frame)
        }
      }
    })
    socket.once('error', reject)
    socket.once('connect', () =>
      resolve({
        socket,
        response: (id) => {
          const frame = received.get(id)
          if (frame) {
            received.delete(id)
            return Promise.resolve(frame)
          }
          return new Promise<SessionHostResponse>((resolveResponse, rejectResponse) => {
            const timer = setTimeout(
              () => rejectResponse(new Error(`timed out waiting for response ${id}`)),
              2_000
            )
            waiters.set(id, (next) => {
              clearTimeout(timer)
              resolveResponse(next)
            })
          })
        }
      })
    )
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

const cleanupPaths: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('bundled session-host request boundaries', () => {
  it('keeps same-name wire order, enforces membership, and retains a generation on kill failure', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-routing-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    const bundlePath = path.join(fixtureDir, 'host.cjs')
    await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['src/session-host/host.ts'],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [fakePtyPlugin('throw')],
      logLevel: 'silent'
    })
    const child = spawn(process.execPath, [bundlePath, dataDir], {
      cwd: process.cwd(),
      stdio: 'ignore',
      windowsHide: true
    })
    let socket: Socket | null = null
    try {
      const { state, token } = await waitForIdentity(dataDir)
      const connected = await connectFrames(state.endpoint)
      socket = connected.socket
      socket.write(encodeFrame({ id: 0, cmd: 'hello', token }))
      await expect(connected.response(0)).resolves.toMatchObject({ id: 0, ok: true })

      // A second connection presenting the WRONG token is refused and dropped — the bearer token
      // is the only command gate, so this is the load-bearing negative. A same-length wrong token
      // exercises the constant-time compare's real path rather than the length short-circuit.
      const impostor = await connectFrames(state.endpoint)
      try {
        const wrong = 'f'.repeat(token.length)
        impostor.socket.write(encodeFrame({ id: 0, cmd: 'hello', token: wrong }))
        await expect(impostor.response(0)).resolves.toMatchObject({ id: 0, ok: false, error: 'unauthorized' })
      } finally {
        impostor.socket.destroy()
      }

      const spawnOptions: SessionHostSpawnOptions = {
        cwd: '.',
        shell: 'fake-shell',
        args: [],
        env: {},
        cols: 80,
        rows: 24
      }
      // One transport chunk is the old inversion: dispatching each parsed frame independently let
      // detach observe no session while attach was waiting on its first generation microtask.
      socket.write(
        encodeFrame({
          id: 1,
          cmd: 'attach',
          name: 'ordered',
          spawn: spawnOptions,
          scrollback: 100
        }) + encodeFrame({ id: 2, cmd: 'detach', name: 'ordered' })
      )
      await expect(connected.response(1)).resolves.toMatchObject({ id: 1, ok: true })
      await expect(connected.response(2)).resolves.toMatchObject({ id: 2, ok: true })

      socket.write(
        encodeFrame({ id: 3, cmd: 'write', name: 'ordered', data: 'must-not-land' }) +
          encodeFrame({ id: 4, cmd: 'resize', name: 'ordered', cols: 120, rows: 40 }) +
          encodeFrame({ id: 5, cmd: 'pause', name: 'ordered' })
      )
      for (const id of [3, 4, 5]) {
        await expect(connected.response(id)).resolves.toMatchObject({
          id,
          ok: false,
          error: 'not attached to session'
        })
      }

      socket.write(encodeFrame({ id: 6, cmd: 'killSession', name: 'ordered' }))
      if (process.platform === 'win32') {
        // On win32, host.ts's killSession handler never calls the (fake) node-pty proc.kill() at
        // all: it goes through terminateWindowsProcessTree instead, because node-pty defers
        // WindowsTerminal.kill() until first output (see windows-process-tree.ts). That real
        // taskkill call fails for the fixture's hardcoded, never-actually-spawned pid 4242, and
        // host.ts intentionally reports that failure with its own fixed, non-leaking message
        // rather than the underlying taskkill diagnostic — so the fake plugin's 'synthetic kill
        // refusal' text (which only ever reaches session.proc.kill() on non-Windows) is never
        // seen here. The invariant this assertion exists to prove — a failed kill still reports
        // ok:false and leaves the session's generation intact (checked below via hasSession) —
        // holds identically on both platforms; only the wire-visible error text differs.
        await expect(connected.response(6)).resolves.toMatchObject({
          id: 6,
          ok: false,
          error: 'session-host could not confirm terminal process termination'
        })
      } else {
        await expect(connected.response(6)).resolves.toMatchObject({
          id: 6,
          ok: false,
          error: expect.stringContaining('synthetic kill refusal')
        })
      }
      socket.write(encodeFrame({ id: 7, cmd: 'hasSession', name: 'ordered' }))
      await expect(connected.response(7)).resolves.toMatchObject({
        id: 7,
        ok: true,
        result: { exists: true }
      })
      socket.write(
        encodeFrame({
          id: 8,
          cmd: 'attach',
          name: 'ordered',
          spawn: spawnOptions,
          scrollback: 100
        })
      )
      await expect(connected.response(8)).resolves.toMatchObject({
        id: 8,
        ok: true,
        result: { fresh: true }
      })
      socket.write(
        encodeFrame({
          id: 9,
          cmd: 'attach',
          name: 'ordered',
          spawn: spawnOptions,
          scrollback: 100
        })
      )
      await expect(connected.response(9)).resolves.toMatchObject({
        id: 9,
        ok: true,
        result: { fresh: false }
      })
      expect(existsSync(paths.statePath)).toBe(true)
    } finally {
      socket?.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 15_000)

  // On win32, host.ts's killSession handler for a 'ordered'/'exit-barrier'-style session never
  // calls the fake node-pty proc.kill()/onExit() this test controls: it dispatches
  // terminateWindowsProcessTree instead (see the same win32 branch documented in the previous
  // test), because node-pty defers WindowsTerminal.kill() until first output. That real taskkill
  // call targets the fixture's hardcoded, never-actually-spawned pid 4242, fails fast (there is no
  // such process to terminate), and resolves the kill near-instantly — the fake plugin's
  // 'deferred-exit' onExit timer is simply never reached, so the "acknowledgment held back until
  // real exit" scenario this test exists to prove cannot be exercised at all through this fake
  // pty on Windows. Proving the Windows-equivalent invariant (acknowledgment held back until
  // taskkill's PID-absence poll actually confirms termination) needs a fake/mock of
  // terminateWindowsProcessTree itself, not of node-pty — a different fixture design, out of
  // scope here. Precedent: 99dfb2db (src/core/codex-session-name.test.ts) skips suites on win32
  // whose fixture cannot reach the code path under test in this environment.
  it.skipIf(process.platform === 'win32')(
    'holds kill acknowledgement and cross-socket replacement behind actual onExit',
    async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-kill-exit-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    const bundlePath = path.join(fixtureDir, 'host.cjs')
    await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['src/session-host/host.ts'],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [fakePtyPlugin('deferred-exit')],
      logLevel: 'silent'
    })
    const child = spawn(process.execPath, [bundlePath, dataDir], {
      cwd: process.cwd(),
      stdio: 'ignore',
      windowsHide: true
    })
    let firstSocket: Socket | null = null
    let secondSocket: Socket | null = null
    try {
      const { state, token } = await waitForIdentity(dataDir)
      const first = await connectFrames(state.endpoint)
      const second = await connectFrames(state.endpoint)
      firstSocket = first.socket
      secondSocket = second.socket
      firstSocket.write(encodeFrame({ id: 0, cmd: 'hello', token }))
      secondSocket.write(encodeFrame({ id: 0, cmd: 'hello', token }))
      await Promise.all([first.response(0), second.response(0)])

      const spawnOptions: SessionHostSpawnOptions = {
        cwd: '.',
        shell: 'fake-shell',
        args: [],
        env: {},
        cols: 80,
        rows: 24
      }
      firstSocket.write(
        encodeFrame({
          id: 1,
          cmd: 'attach',
          name: 'exit-barrier',
          spawn: spawnOptions,
          scrollback: 100
        })
      )
      await expect(first.response(1)).resolves.toMatchObject({ id: 1, ok: true })

      firstSocket.write(encodeFrame({ id: 2, cmd: 'killSession', name: 'exit-barrier' }))
      // Let the host synchronously dispatch proc.kill() and publish its `retiring` name claim.
      await new Promise((resolve) => setTimeout(resolve, 20))
      secondSocket.write(
        encodeFrame({
          id: 2,
          cmd: 'attach',
          name: 'exit-barrier',
          spawn: spawnOptions,
          scrollback: 100
        })
      )

      let killSettled = false
      let attachSettled = false
      const killed = first.response(2).then((response) => {
        killSettled = true
        return response
      })
      const replacement = second.response(2).then((response) => {
        attachSettled = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(killSettled).toBe(false)
      expect(attachSettled).toBe(false)

      await expect(killed).resolves.toMatchObject({ id: 2, ok: true })
      await expect(replacement).resolves.toMatchObject({
        id: 2,
        ok: true,
        result: { fresh: true }
      })
    } finally {
      firstSocket?.destroy()
      secondSocket?.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 15_000)
})
