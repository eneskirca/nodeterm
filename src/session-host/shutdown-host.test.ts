// Issue #829: the prepare-for-update `shutdown` command, driven against the REAL bundled host over
// its socket protocol (the same harness as geometry-host.test.ts). The rules it pins: only a
// connection that negotiated the feature may ask, every session ends through the ordinary kill
// path (an exit frame each) before the reply, the host exits only after a COMPLETE shutdown, and a
// kill it cannot confirm fails the whole shutdown by name while the host keeps serving.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import net, { type Socket } from 'net'
import os from 'os'
import path from 'path'
import { build, type Plugin } from 'esbuild'
import {
  LineFramer,
  SESSION_HOST_PROTOCOL_VERSION,
  encodeFrame,
  type SessionHostEvent,
  type SessionHostFrame,
  type SessionHostResponse,
  type SessionHostSpawnOptions
} from './protocol'
import { sessionHostPaths, type SessionHostState } from './paths'

function fakePtyPlugin(): Plugin {
  return {
    name: 'session-host-shutdown-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'sd' }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'sd' }, () => ({
        loader: 'js',
        contents: `
          export function spawn(file) {
            let onExit
            return {
              pid: 4343,
              onData() {},
              onExit(cb) { onExit = cb },
              write() {},
              resize() {},
              pause() {},
              resume() {},
              kill() {
                if (file === 'unkillable-shell') throw new Error('kill refused')
                setTimeout(() => onExit?.({ exitCode: 0 }), 20)
              }
            }
          }
        `
      }))
    }
  }
}

async function waitForIdentity(dataDir: string): Promise<{ state: SessionHostState; token: string }> {
  const paths = sessionHostPaths(dataDir)
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as SessionHostState
      const token = readFileSync(paths.tokenPath, 'utf8').trim()
      if (state.endpoint && token) return { state, token }
    } catch {
      /* publication is asynchronous by design; keep polling within the test bound */
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('session host did not publish its identity')
}

type Connection = {
  socket: Socket
  events: SessionHostEvent[]
  request(frame: Record<string, unknown> & { id: number }): Promise<SessionHostResponse>
}

function connect(endpoint: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    const framer = new LineFramer()
    const events: SessionHostEvent[] = []
    const waiters = new Map<number, (frame: SessionHostResponse) => void>()
    socket.on('data', (chunk: Buffer) => {
      for (const frame of framer.push<SessionHostFrame>(chunk.toString('utf8'))) {
        if ('type' in frame) {
          events.push(frame)
          continue
        }
        waiters.get(frame.id)?.(frame)
        waiters.delete(frame.id)
      }
    })
    socket.once('error', reject)
    socket.once('connect', () =>
      resolve({
        socket,
        events,
        request: (frame) =>
          new Promise<SessionHostResponse>((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`timed out on ${frame.id}`)), 4_000)
            waiters.set(frame.id, (response) => {
              clearTimeout(timer)
              done(response)
            })
            socket.write(encodeFrame(frame))
          })
      })
    )
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

const SPAWN: SessionHostSpawnOptions = {
  cwd: '.',
  shell: 'fake-shell',
  args: [],
  env: {},
  cols: 80,
  rows: 24
}

const cleanupPaths: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})


// On win32 the host's kill path never calls the fake node-pty kill(): it runs
// terminateWindowsProcessTree (real taskkill) against the fixture's fake pid, so a session can
// never be confirmed ended through this harness there. Same limit and precedent as
// host-routing.test.ts. These two run on POSIX; the Windows kill path itself is covered by
// windows-process-tree.test.ts, and the end-to-end shutdown is on the device checklist.
const posixKillPath = it.skipIf(process.platform === 'win32')

const SHUTDOWN_FEATURES = ['geometry', 'shutdown']

async function startHost(): Promise<{
  child: ChildProcess
  dataDir: string
  state: SessionHostState
  token: string
}> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-shutdown-'))
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
    plugins: [fakePtyPlugin()],
    logLevel: 'silent'
  })
  const child = spawn(process.execPath, [bundlePath, dataDir], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true
  })
  const { state, token } = await waitForIdentity(dataDir)
  return { child, dataDir, state, token }
}

async function hello(conn: Connection, token: string, features?: string[]): Promise<void> {
  const res = await conn.request({
    id: 1,
    cmd: 'hello',
    token,
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    ...(features ? { features } : {})
  })
  expect(res.ok).toBe(true)
}

describe('session-host shutdown (issue #829)', () => {
  // U3: prepare-for-update tells a staged host (a plain quit is enough) from one that holds the
  // installation by the image the host itself publishes. No kill involved, so it runs on Windows.
  it('publishes its own executable in the state file', async () => {
    const { child, state } = await startHost()
    try {
      expect(state.exe).toBe(process.execPath)
    } finally {
      child.kill()
      await waitForExit(child)
    }
  })

  posixKillPath('ends every session, replies with their names, then exits and removes its identity', async () => {
    const { child, dataDir, state, token } = await startHost()
    const sockets: Socket[] = []
    try {
      const conn = await connect(state.endpoint)
      sockets.push(conn.socket)
      const res = await conn.request({
        id: 1,
        cmd: 'hello',
        token,
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        features: SHUTDOWN_FEATURES
      })
      expect(res).toMatchObject({ ok: true, result: { features: SHUTDOWN_FEATURES } })
      for (const [id, name] of [[2, 'nt-a'], [3, 'nt-b']] as const) {
        const created = await conn.request({ id, cmd: 'attach', name, spawn: SPAWN, scrollback: 100 })
        expect(created.ok).toBe(true)
      }
      const exited = waitForExit(child)
      const done = await conn.request({ id: 4, cmd: 'shutdown' })
      expect(done.ok).toBe(true)
      expect(((done as { result: { ended: string[] } }).result.ended).sort()).toEqual(['nt-a', 'nt-b'])
      await exited
      expect(child.exitCode).toBe(0)
      // Each session got its ordinary exit frame first: the client sees a normal session end.
      expect(conn.events.filter((e) => e.type === 'exit').map((e) => e.name).sort()).toEqual([
        'nt-a',
        'nt-b'
      ])
      expect(existsSync(sessionHostPaths(dataDir).statePath)).toBe(false)
      expect(existsSync(sessionHostPaths(dataDir).tokenPath)).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)

  it('refuses a connection that did not negotiate the feature, and keeps serving', async () => {
    const { child, state, token } = await startHost()
    const sockets: Socket[] = []
    try {
      const conn = await connect(state.endpoint)
      sockets.push(conn.socket)
      await hello(conn, token, ['geometry'])
      const created = await conn.request({ id: 2, cmd: 'attach', name: 'nt-a', spawn: SPAWN, scrollback: 100 })
      expect(created.ok).toBe(true)
      const refused = await conn.request({ id: 3, cmd: 'shutdown' })
      expect(refused).toMatchObject({ ok: false })
      const still = await conn.request({ id: 4, cmd: 'hasSession', name: 'nt-a' })
      expect(still).toMatchObject({ ok: true, result: { exists: true } })
      expect(child.exitCode).toBeNull()
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)

  posixKillPath('names a session it could not end, stays up, and accepts attaches again', async () => {
    const { child, state, token } = await startHost()
    const sockets: Socket[] = []
    try {
      const conn = await connect(state.endpoint)
      sockets.push(conn.socket)
      await hello(conn, token, SHUTDOWN_FEATURES)
      expect((await conn.request({ id: 2, cmd: 'attach', name: 'nt-ok', spawn: SPAWN, scrollback: 100 })).ok).toBe(true)
      const stuck = { ...SPAWN, shell: 'unkillable-shell' }
      expect((await conn.request({ id: 3, cmd: 'attach', name: 'nt-stuck', spawn: stuck, scrollback: 100 })).ok).toBe(true)
      const res = await conn.request({ id: 4, cmd: 'shutdown' })
      expect(res.ok).toBe(false)
      expect((res as { error: string }).error).toContain('nt-stuck')
      expect((res as { error: string }).error).not.toContain('nt-ok')
      // Not shutting down any more: a new session can be created.
      const again = await conn.request({ id: 5, cmd: 'attach', name: 'nt-new', spawn: SPAWN, scrollback: 100 })
      expect(again.ok).toBe(true)
      expect(child.exitCode).toBeNull()
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)
})
