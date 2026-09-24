// Issue #914: a session-host session follows its most recently ACTIVE viewer (tmux's
// `window-size latest`) instead of the smallest one, and every viewer is told the size the pty
// really runs at. These drive the real client against a fake host over a real socket.
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionHostPaths } from '../session-host/paths'
import {
  SESSION_HOST_PROTOCOL_VERSION,
  LineFramer,
  encodeFrame,
  type SessionHostRequest,
  type SessionHostSpawnOptions
} from '../session-host/protocol'
import { SessionHostClient } from './session-host-client'
import { SessionHostPty } from './session-host-pty'

const openServers = new Set<net.Server>()
const openSockets = new Set<net.Socket>()
const tempDirs = new Set<string>()
const livePtys = new Set<SessionHostPty>()
const GENERATION = 'geometry-generation'

function within<T>(promise: Promise<T>, label: string, ms = 2_500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Resolves once `check` holds, polled on the event loop. */
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_500
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} never happened`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fixture(prefix: string): { userDataDir: string; endpoint: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(userDataDir)
  const paths = sessionHostPaths(userDataDir)
  fs.writeFileSync(paths.tokenPath, 'a'.repeat(64))
  fs.writeFileSync(
    paths.statePath,
    JSON.stringify({
      pid: process.pid,
      endpoint: paths.endpoint,
      tokenPath: paths.tokenPath,
      startedAt: Date.now(),
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION
    })
  )
  return { userDataDir, endpoint: paths.endpoint }
}

function spawnOptions(userDataDir: string, cols: number, rows: number): SessionHostSpawnOptions {
  return { cwd: userDataDir, shell: process.execPath, args: [], env: {}, cols, rows }
}

type FakeHost = {
  requests: SessionHostRequest[]
  resizes: Array<{ cols: number; rows: number }>
  writes: string[]
  /** Push a frame to every connection (the client under test has exactly one). */
  push(frame: unknown): void
}

/**
 * A host that answers the protocol. `geometry` makes it a host that negotiated the feature: it
 * advertises it at hello, returns `hostSize` in attach replies, and pushes a `geometry` event
 * for every resize it applies.
 */
async function fakeHost(
  endpoint: string,
  opts: { geometry?: boolean; hostSize?: { cols: number; rows: number } } = {}
): Promise<FakeHost> {
  const sockets = new Set<net.Socket>()
  const host: FakeHost = {
    requests: [],
    resizes: [],
    writes: [],
    push: (frame) => {
      for (const socket of sockets) socket.write(encodeFrame(frame))
    }
  }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    openSockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      openSockets.delete(socket)
    })
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
        host.requests.push(request)
        const reply = (result?: unknown): void => {
          socket.write(encodeFrame({ id: request.id, ok: true, result }))
        }
        switch (request.cmd) {
          case 'hello':
            reply({
              protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
              ...(opts.geometry ? { features: ['geometry'] } : {})
            })
            break
          case 'attach':
          case 'attachExisting': {
            const own =
              request.cmd === 'attach'
                ? { cols: request.spawn.cols, rows: request.spawn.rows }
                : { cols: request.cols ?? 80, rows: request.rows ?? 24 }
            reply({
              fresh: request.cmd === 'attach',
              generation: GENERATION,
              ...(opts.geometry ? { geometry: opts.hostSize ?? own } : {})
            })
            break
          }
          case 'resize':
            host.resizes.push({ cols: request.cols, rows: request.rows })
            if (opts.geometry) {
              host.push({
                type: 'geometry',
                name: request.name,
                cols: request.cols,
                rows: request.rows,
                generation: GENERATION
              })
            }
            reply()
            break
          case 'write':
            host.writes.push(request.data)
            reply()
            break
          default:
            reply()
        }
      }
    })
  })
  openServers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return host
}

type View = { pty: SessionHostPty; sizes: Array<{ cols: number; rows: number }>; exits: number[] }

async function view(
  client: SessionHostClient,
  userDataDir: string,
  cols: number,
  rows: number
): Promise<View> {
  const pty = new SessionHostPty(client, 'nt-geometry', spawnOptions(userDataDir, cols, rows), 100)
  livePtys.add(pty)
  const sizes: View['sizes'] = []
  const exits: number[] = []
  pty.onSize((size) => sizes.push(size))
  pty.onExit(({ exitCode }) => exits.push(exitCode))
  await within(pty.ready, `attach ${cols}x${rows}`)
  return { pty, sizes, exits }
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1]
}

afterEach(async () => {
  for (const pty of livePtys) pty.destroy()
  livePtys.clear()
  await new Promise((resolve) => setImmediate(resolve))
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve()
          server.close(() => resolve())
        })
    )
  )
  openServers.clear()
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

describe('SessionHostClient geometry (issue #914)', () => {
  it('asks the host for the geometry feature at hello', async () => {
    const { userDataDir, endpoint } = fixture('nt-geo-hello-')
    const host = await fakeHost(endpoint)
    const client = new SessionHostClient({ userDataDir })
    await view(client, userDataDir, 80, 24)
    const hello = host.requests.find((request) => request.cmd === 'hello')
    expect(hello).toMatchObject({ features: ['geometry'] })
  })

  it('gives the session to a view that types, but not to one that only answers a query', async () => {
    const { userDataDir, endpoint } = fixture('nt-geo-typing-')
    const host = await fakeHost(endpoint)
    const client = new SessionHostClient({ userDataDir })
    const desktop = await view(client, userDataDir, 120, 30)
    // The phone attaches last, so it is the most recently active view: the session takes its size.
    const phone = await view(client, userDataDir, 80, 40)
    expect(host.requests.filter((r) => r.cmd === 'attachExisting')).toMatchObject([
      { cols: 80, rows: 40 }
    ])

    // xterm answering a device-attributes query is not the user: no resize. A resize it caused
    // would be queued right behind the write, so give it room to arrive before judging.
    desktop.pty.write('\x1b[?1;2c')
    await until(() => host.writes.length === 1, 'the report reaches the host')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.resizes).toEqual([])
    // A keystroke is: the desktop view becomes active and the session follows it.
    desktop.pty.write('x')
    await until(() => host.resizes.length > 0, 'resize after the keystroke')
    expect(host.writes).toEqual(['\x1b[?1;2c', 'x'])
    expect(host.resizes).toEqual([{ cols: 120, rows: 30 }])
    // Both views are told the new size — the phone's is not its own any more.
    await until(() => last(phone.sizes)?.cols === 120, 'phone told the new size')
    expect(last(phone.sizes)).toEqual({ cols: 120, rows: 30 })
    expect(last(desktop.sizes)).toEqual({ cols: 120, rows: 30 })
  })

  it('never grows the session past a view that cannot adapt to it', async () => {
    const { userDataDir, endpoint } = fixture('nt-geo-bounding-')
    const host = await fakeHost(endpoint)
    const client = new SessionHostClient({ userDataDir })
    const desktop = await view(client, userDataDir, 120, 30)
    const phone = await view(client, userDataDir, 45, 40)
    // Same size, now marked as a ceiling: nothing moves yet.
    phone.pty.resize(45, 40, true)
    desktop.pty.write('x')
    await until(() => host.resizes.length > 0, 'resize after the keystroke')
    // The desktop is active, but a 120-column pty would wrap into garbage on the phone.
    expect(host.resizes).toEqual([{ cols: 45, rows: 30 }])
  })

  it('reports its own applied size to every view on a host without the feature', async () => {
    const { userDataDir, endpoint } = fixture('nt-geo-legacy-')
    await fakeHost(endpoint)
    const client = new SessionHostClient({ userDataDir })
    const first = await view(client, userDataDir, 120, 30)
    await until(() => first.sizes.length > 0, 'first view told its size')
    expect(last(first.sizes)).toEqual({ cols: 120, rows: 30 })
    await view(client, userDataDir, 80, 40)
    await until(() => last(first.sizes)?.cols === 80, 'first view told the new size')
    expect(last(first.sizes)).toEqual({ cols: 80, rows: 40 })
  })

  it('renders what the host says, and never reads a geometry frame as an exit', async () => {
    const { userDataDir, endpoint } = fixture('nt-geo-aware-')
    // The host is already running smaller than our claim — another app's viewer is attached.
    const host = await fakeHost(endpoint, { geometry: true, hostSize: { cols: 70, rows: 20 } })
    const client = new SessionHostClient({ userDataDir })
    const only = await view(client, userDataDir, 120, 30)
    await until(() => only.sizes.length > 0, 'told the host size')
    expect(last(only.sizes)).toEqual({ cols: 70, rows: 20 })

    host.push({ type: 'geometry', name: 'nt-geometry', cols: 50, rows: 15, generation: GENERATION })
    await until(() => last(only.sizes)?.cols === 50, 'told the pushed size')
    expect(last(only.sizes)).toEqual({ cols: 50, rows: 15 })
    // A frame from another generation, or with a nonsense grid, changes nothing.
    host.push({ type: 'geometry', name: 'nt-geometry', cols: 9, rows: 9, generation: 'other-generation' })
    host.push({ type: 'geometry', name: 'nt-geometry', cols: -1, rows: 0, generation: GENERATION })
    only.pty.write('y')
    await until(() => host.writes.includes('y'), 'a later request round-trips')
    expect(last(only.sizes)).toEqual({ cols: 50, rows: 15 })
    expect(only.exits).toEqual([])
  })
})
