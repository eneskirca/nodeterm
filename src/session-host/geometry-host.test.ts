// Issue #914 wiring test: drives the REAL bundled host over its real socket protocol. The rule it
// exists for is the one a unit test of `session.ts` cannot see — a `geometry` push reaches ONLY a
// connection that negotiated the feature at hello. An older client treats every push frame that is
// not `data` as an EXIT, so leaking one to it would retire a live session on the first resize.
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
  type SessionHostEvent,
  type SessionHostFrame,
  type SessionHostResponse,
  type SessionHostSpawnOptions
} from './protocol'
import { sessionHostPaths, type SessionHostState } from './paths'

function fakePtyPlugin(): Plugin {
  return {
    name: 'session-host-geometry-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'geo' }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'geo' }, () => ({
        loader: 'js',
        contents: `
          export function spawn() {
            let onExit
            return {
              pid: 4343,
              onData() {},
              onExit(cb) { onExit = cb },
              write() {},
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

function geometryEvents(events: SessionHostEvent[]): Array<{ cols: number; rows: number }> {
  return events.flatMap((event) =>
    event.type === 'geometry' ? [{ cols: event.cols, rows: event.rows }] : []
  )
}

describe('session-host geometry feature (issue #914)', () => {
  it('pushes geometry only to the connection that negotiated it', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-geometry-'))
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
    const sockets: Socket[] = []
    try {
      const { state, token } = await waitForIdentity(dataDir)
      const aware = await connect(state.endpoint)
      const legacy = await connect(state.endpoint)
      sockets.push(aware.socket, legacy.socket)

      const awareHello = await aware.request({
        id: 1,
        cmd: 'hello',
        token,
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        features: ['geometry', 'not-a-feature']
      })
      expect(awareHello).toMatchObject({
        ok: true,
        result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features: ['geometry'] }
      })
      const legacyHello = await legacy.request({
        id: 1,
        cmd: 'hello',
        token,
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION
      })
      expect(legacyHello).toEqual({
        id: 1,
        ok: true,
        result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
      })

      const created = await aware.request({
        id: 2,
        cmd: 'attach',
        name: 'geo',
        spawn: SPAWN,
        scrollback: 100
      })
      expect(created).toMatchObject({ ok: true, result: { geometry: { cols: 80, rows: 24 } } })

      // The legacy connection joins with a smaller claim, which shrinks the pty (the host still
      // takes the minimum across connections). Its own reply carries no geometry field…
      const joined = await legacy.request({
        id: 2,
        cmd: 'attachExisting',
        name: 'geo',
        cols: 60,
        rows: 20
      })
      expect(joined.ok).toBe(true)
      expect((joined as { result?: Record<string, unknown> }).result).not.toHaveProperty('geometry')

      // …while the aware subscriber is told what the pty now runs at.
      const shrunk = await aware.request({ id: 3, cmd: 'resize', name: 'geo', cols: 50, rows: 10 })
      expect(shrunk.ok).toBe(true)
      await expect(legacy.request({ id: 3, cmd: 'ping' })).resolves.toMatchObject({ ok: true })
      expect(geometryEvents(aware.events)).toEqual([
        { cols: 60, rows: 20 },
        { cols: 50, rows: 10 }
      ])
      // The pty resized twice while the legacy connection was a subscriber for the second one.
      // It must have been sent nothing but data: to that client a geometry frame reads as EXIT.
      expect(legacy.events.filter((event) => event.type !== 'data')).toEqual([])
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)
})
