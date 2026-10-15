// Live links on the session host: drives the REAL bundled host over its real socket protocol for the
// three negotiated additions — `watch-attach` (a viewer subscribes with NO geometry claim and cannot
// type or resize), `captureVisible` (the keyframe: visible rows + cursor + active buffer) and `paneCwd`
// (the cwd the pane REPORTED, never the spawn cwd). The fake pty echoes every write back as output,
// so a test types escape sequences in and reads what the host's emulator made of them.
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
    name: 'session-host-live-links-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'geo' }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'geo' }, () => ({
        loader: 'js',
        contents: `
          export function spawn() {
            let onExit
            const onData = []
            return {
              pid: 4343,
              onData(cb) { onData.push(cb) },
              onExit(cb) { onExit = cb },
              write(d) { setTimeout(() => { for (const cb of onData) cb(d) }, 0) },
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


async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} never happened`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function dataSeen(events: SessionHostEvent[], marker: string): boolean {
  return events.some((event) => event.type === 'data' && event.data.includes(marker))
}

describe('session-host live link features', () => {
  it('watch-attach, captureVisible and paneCwd over the real protocol', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-live-'))
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
      const owner = await connect(state.endpoint)
      const viewer = await connect(state.endpoint)
      const legacy = await connect(state.endpoint)
      sockets.push(owner.socket, viewer.socket, legacy.socket)
      const features = ['geometry', 'watch-attach', 'captureVisible', 'paneCwd']
      for (const conn of [owner, viewer]) {
        await expect(
          conn.request({ id: 1, cmd: 'hello', token, protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features })
        ).resolves.toMatchObject({ ok: true, result: { features } })
      }
      await expect(
        legacy.request({ id: 1, cmd: 'hello', token, protocolVersion: SESSION_HOST_PROTOCOL_VERSION })
      ).resolves.toEqual({ id: 1, ok: true, result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION } })

      await expect(
        owner.request({ id: 2, cmd: 'attach', name: 'live', spawn: { ...SPAWN, cols: 100, rows: 30 }, scrollback: 100 })
      ).resolves.toMatchObject({ ok: true, result: { fresh: true, geometry: { cols: 100, rows: 30 } } })

      // A watch attach of a name that does not exist never spawns one.
      const missing = await viewer.request({ id: 2, cmd: 'attachExisting', name: 'nope', watch: true })
      expect(missing.ok).toBe(false)
      await expect(viewer.request({ id: 3, cmd: 'hasSession', name: 'nope' })).resolves.toMatchObject({
        ok: true,
        result: { exists: false }
      })

      // The viewer joins with no geometry claim at all…
      await expect(
        viewer.request({ id: 4, cmd: 'attachExisting', name: 'live', watch: true })
      ).resolves.toMatchObject({ ok: true, result: { fresh: false, geometry: { cols: 100, rows: 30 } } })
      // …a connection that never negotiated the feature cannot do the same…
      const refused = await legacy.request({ id: 2, cmd: 'attachExisting', name: 'live', watch: true })
      expect(refused.ok).toBe(false)
      // …and the owner's size alone decides the pty's: growing it is NOT capped by the viewer.
      await expect(
        owner.request({ id: 3, cmd: 'resize', name: 'live', cols: 120, rows: 40 })
      ).resolves.toMatchObject({ ok: true })
      await until(
        () => viewer.events.some((e) => e.type === 'geometry' && e.cols === 120 && e.rows === 40),
        'the viewer learning the owner size'
      )

      // Read-only end to end: a watch connection can neither type nor resize.
      await expect(viewer.request({ id: 5, cmd: 'write', name: 'live', data: 'x' })).resolves.toMatchObject({
        ok: false,
        error: 'watch attachment is read-only'
      })
      await expect(
        viewer.request({ id: 6, cmd: 'resize', name: 'live', cols: 10, rows: 5 })
      ).resolves.toMatchObject({ ok: false })
      await expect(viewer.request({ id: 7, cmd: 'pause', name: 'live' })).resolves.toMatchObject({ ok: true })

      // paneCwd: null until the pane REPORTS one (never the spawn cwd), then the reported path.
      await expect(viewer.request({ id: 8, cmd: 'paneCwd', name: 'live' })).resolves.toMatchObject({
        ok: true,
        result: { cwd: null }
      })
      await owner.request({ id: 4, cmd: 'write', name: 'live', data: 'one\r\n\x1b]9;9;"C:\\work"\x07two\r\n' })
      // The viewer's pause was ignored: output keeps flowing to it.
      await until(() => dataSeen(viewer.events, 'two'), 'output reaching the viewer')
      await expect(viewer.request({ id: 9, cmd: 'paneCwd', name: 'live' })).resolves.toMatchObject({
        ok: true,
        result: { cwd: 'C:\\work' }
      })
      await owner.request({ id: 5, cmd: 'write', name: 'live', data: '\x1b]7;file://pc/C:/Users/me\x1b\\' })
      await until(() => dataSeen(viewer.events, 'file://pc'), 'the OSC 7 echo')
      await expect(viewer.request({ id: 10, cmd: 'paneCwd', name: 'live' })).resolves.toMatchObject({
        result: { cwd: 'C:\\Users\\me' }
      })

      // captureVisible: the visible rows + cursor, then the alternate screen alone.
      const kf = (await viewer.request({ id: 11, cmd: 'captureVisible', name: 'live' })) as {
        ok: true
        result: { screen: string; cursor: { x: number; y: number }; altScreen: boolean }
      }
      expect(kf.ok).toBe(true)
      expect(kf.result.altScreen).toBe(false)
      expect(kf.result.screen).toContain('one\ntwo\n')
      expect(kf.result.cursor).toEqual({ x: 0, y: 2 })
      await owner.request({ id: 6, cmd: 'write', name: 'live', data: '\x1b[?1049h\x1b[HTUI' })
      await until(() => dataSeen(viewer.events, 'TUI'), 'the alternate-screen echo')
      const alt = (await viewer.request({ id: 12, cmd: 'captureVisible', name: 'live' })) as typeof kf
      expect(alt.result.altScreen).toBe(true)
      expect(alt.result.screen).toContain('TUI')
      expect(alt.result.screen).not.toContain('one')
      await expect(viewer.request({ id: 13, cmd: 'captureVisible', name: 'nope' })).resolves.toMatchObject({
        ok: false
      })

      // The owner leaves: the viewer stays subscribed and the pty keeps the owner's last size.
      const before = geometryEvents(viewer.events).length
      await owner.request({ id: 7, cmd: 'detach', name: 'live' })
      await expect(viewer.request({ id: 14, cmd: 'ping' })).resolves.toMatchObject({ ok: true })
      expect(geometryEvents(viewer.events).length).toBe(before)

      // A claim-carrying attach on the viewer's connection upgrades it; a watch attach withdraws it.
      await expect(
        viewer.request({ id: 15, cmd: 'attachExisting', name: 'live', cols: 90, rows: 20 })
      ).resolves.toMatchObject({ ok: true, result: { geometry: { cols: 90, rows: 20 } } })
      await expect(viewer.request({ id: 16, cmd: 'write', name: 'live', data: 'ok' })).resolves.toMatchObject({
        ok: true
      })
      await expect(
        viewer.request({ id: 17, cmd: 'attachExisting', name: 'live', watch: true })
      ).resolves.toMatchObject({ ok: true, result: { geometry: { cols: 90, rows: 20 } } })
      await expect(viewer.request({ id: 18, cmd: 'write', name: 'live', data: 'no' })).resolves.toMatchObject({
        ok: false
      })
    } finally {
      for (const socket of sockets) socket.destroy()
      child.kill()
      await waitForExit(child)
    }
  }, 30_000)
})
