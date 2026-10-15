// `sessionDetails` (Windows parity: session reaper, session-memory panel, dev-server ports): the
// per-session rows `listSessions` carries for a connection that negotiated the feature, driven
// against the REAL bundled host over its socket protocol (same harness as shutdown-host.test.ts).
// Pinned: an older client still gets `{names}` only; subscriber counts follow attach/detach; the
// output clock moves on pty output and on NOTHING that merely looks (attach, capture).
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import net, { type Socket } from 'net'
import os from 'os'
import path from 'path'
import { build, type Plugin } from 'esbuild'
import {
  LineFramer,
  SESSION_HOST_PROTOCOL_VERSION,
  encodeFrame,
  type ListSessionsResult,
  type SessionHostEvent,
  type SessionHostFrame,
  type SessionHostResponse,
  type SessionHostSpawnOptions
} from './protocol'
import { sessionHostPaths, type SessionHostState } from './paths'

/** A pty that echoes every write back as output, after a short delay. */
function fakePtyPlugin(): Plugin {
  return {
    name: 'session-host-details-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'sd' }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'sd' }, () => ({
        loader: 'js',
        contents: `
          let nextPid = 5100
          export function spawn() {
            let onData
            let onExit
            return {
              pid: nextPid++,
              onData(cb) { onData = cb },
              onExit(cb) { onExit = cb },
              write(d) { setTimeout(() => onData?.(d), 5) },
              resize() {},
              pause() {},
              resume() {},
              kill() { setTimeout(() => onExit?.({ exitCode: 0 }), 20) }
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

const SPAWN: SessionHostSpawnOptions = { cwd: '.', shell: 'fake-shell', args: [], env: {}, cols: 80, rows: 24 }

const cleanupPaths: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

async function startHost(): Promise<{ child: ChildProcess; state: SessionHostState; token: string }> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-details-'))
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
  const child = spawn(process.execPath, [bundlePath, dataDir], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true })
  const { state, token } = await waitForIdentity(dataDir)
  return { child, state, token }
}

let nextId = 100
const req = (conn: Connection, body: Record<string, unknown>): Promise<SessionHostResponse> =>
  conn.request({ id: nextId++, ...body })

async function hello(conn: Connection, token: string, features?: string[]): Promise<SessionHostResponse> {
  return req(conn, {
    cmd: 'hello',
    token,
    protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
    ...(features ? { features } : {})
  })
}

const list = async (conn: Connection): Promise<ListSessionsResult> => {
  const res = await req(conn, { cmd: 'listSessions' })
  expect(res.ok).toBe(true)
  return (res as { result: ListSessionsResult }).result
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('session-host sessionDetails', () => {
  it('describes each live session only to a connection that negotiated it', async () => {
    const { child, state, token } = await startHost()
    const sockets: Socket[] = []
    try {
      const modern = await connect(state.endpoint)
      const legacy = await connect(state.endpoint)
      sockets.push(modern.socket, legacy.socket)
      const negotiated = await hello(modern, token, ['geometry', 'shutdown', 'sessionDetails'])
      expect(negotiated).toMatchObject({ ok: true, result: { features: ['geometry', 'shutdown', 'sessionDetails'] } })
      await hello(legacy, token, ['geometry', 'shutdown'])

      const before = Date.now()
      expect((await req(modern, { cmd: 'attach', name: 'nt-a', spawn: SPAWN, scrollback: 100 })).ok).toBe(true)
      expect((await req(modern, { cmd: 'attach', name: 'nt-b', spawn: SPAWN, scrollback: 100 })).ok).toBe(true)

      // An older client reads exactly what it always did.
      expect(await list(legacy)).toEqual({ names: ['nt-a', 'nt-b'] })

      const detailed = await list(modern)
      expect(detailed.names).toEqual(['nt-a', 'nt-b'])
      expect(detailed.sessions).toHaveLength(2)
      for (const row of detailed.sessions ?? []) {
        expect(row.subscribers).toBe(1)
        expect(row.pid).toBeGreaterThanOrEqual(5100)
        expect(row.generation).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
        expect(row.createdMs).toBeGreaterThanOrEqual(before - 5)
        expect(row.lastOutputMs).toBe(row.createdMs) // nothing has printed yet
      }
      expect(new Set(detailed.sessions?.map((r) => r.pid)).size).toBe(2)

      // Detach: the subscriber count drops; the other connection attaching raises it again.
      expect((await req(modern, { cmd: 'detach', name: 'nt-a' })).ok).toBe(true)
      const afterDetach = await list(modern)
      expect(afterDetach.sessions?.find((r) => r.name === 'nt-a')?.subscribers).toBe(0)
      expect(afterDetach.sessions?.find((r) => r.name === 'nt-b')?.subscribers).toBe(1)
      expect((await req(legacy, { cmd: 'attachExisting', name: 'nt-b' })).ok).toBe(true)
      expect((await list(modern)).sessions?.find((r) => r.name === 'nt-b')?.subscribers).toBe(2)
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)

  it('the output clock moves on pty output and not on attach or capture', async () => {
    const { child, state, token } = await startHost()
    const sockets: Socket[] = []
    try {
      const conn = await connect(state.endpoint)
      sockets.push(conn.socket)
      await hello(conn, token, ['sessionDetails'])
      expect((await req(conn, { cmd: 'attach', name: 'nt-a', spawn: SPAWN, scrollback: 100 })).ok).toBe(true)
      const created = (await list(conn)).sessions?.[0]
      await sleep(30)
      // Looking moves nothing.
      expect((await req(conn, { cmd: 'detach', name: 'nt-a' })).ok).toBe(true)
      expect((await req(conn, { cmd: 'attachExisting', name: 'nt-a' })).ok).toBe(true)
      expect((await req(conn, { cmd: 'capture', name: 'nt-a', full: true })).ok).toBe(true)
      expect((await list(conn)).sessions?.[0].lastOutputMs).toBe(created?.lastOutputMs)
      // Output does.
      expect((await req(conn, { cmd: 'write', name: 'nt-a', data: 'hi' })).ok).toBe(true)
      let moved = false
      for (let i = 0; i < 100 && !moved; i++) {
        await sleep(10)
        moved = ((await list(conn)).sessions?.[0].lastOutputMs ?? 0) > (created?.lastOutputMs ?? 0)
      }
      expect(moved).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)
})
