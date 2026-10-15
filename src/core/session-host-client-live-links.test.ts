// Live links on the session host, client side: a watcher's attachment (`watch-attach`) carries no
// size claim, no pause ticket and no input; the client up/downgrades its one connection's attachment
// as voting subscribers come and go; and the two negotiated reads (`captureVisible`, `paneCwd`) are
// never sent to a host that did not advertise them. Real client, fake host, real socket.
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
const GENERATION = 'watch-generation-1'

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
  push(frame: unknown): void
}

async function fakeHost(endpoint: string, features: string[]): Promise<FakeHost> {
  const sockets = new Set<net.Socket>()
  const host: FakeHost = {
    requests: [],
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
            reply({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, features })
            break
          case 'attach':
          case 'attachExisting':
            reply({ fresh: request.cmd === 'attach', generation: GENERATION, screen: 'SCREEN' })
            break
          case 'hasSession':
            reply({ exists: true, generation: GENERATION })
            break
          case 'captureVisible':
            reply({ screen: 'row\n', cursor: { x: 3, y: 0 }, altScreen: true })
            break
          case 'paneCwd':
            reply({ cwd: 'C:\\work' })
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

const ALL = ['geometry', 'watch-attach', 'captureVisible', 'paneCwd']
const NAME = 'nt-watched'

function track(pty: SessionHostPty): SessionHostPty {
  livePtys.add(pty)
  return pty
}
function attaches(host: FakeHost): Array<Record<string, unknown>> {
  return host.requests
    .filter((r) => r.cmd === 'attachExisting' || r.cmd === 'attach')
    .map((r) => {
      const { id: _id, ...rest } = r as Record<string, unknown>
      return rest
    })
}

describe('SessionHostClient watch-attach', () => {
  it('attaches a lone watcher WITHOUT a claim, and never sends its writes, resizes or pauses', async () => {
    const { userDataDir, endpoint } = fixture('nt-watch-alone-')
    const host = await fakeHost(endpoint, ALL)
    const client = new SessionHostClient({ userDataDir })
    const watcher = track(new SessionHostPty(client, NAME, null, 0, 'watch'))
    await expect(within(watcher.ready, 'watch attach')).resolves.toMatchObject({ fresh: false })
    expect(attaches(host)).toEqual([
      { cmd: 'attachExisting', name: NAME, expectedGeneration: undefined, watch: true }
    ])
    watcher.write('typed')
    watcher.resize(10, 5)
    watcher.pause()
    // Anything queued would ride behind this round trip.
    await client.listSessions().catch(() => [])
    expect(host.requests.map((r) => r.cmd)).not.toContain('write')
    expect(host.requests.map((r) => r.cmd)).not.toContain('resize')
    expect(host.requests.map((r) => r.cmd)).not.toContain('pause')
  })

  it('refuses a watcher outright on a host without the feature — no attach, no size vote', async () => {
    const { userDataDir, endpoint } = fixture('nt-watch-old-')
    const host = await fakeHost(endpoint, ['geometry'])
    const client = new SessionHostClient({ userDataDir })
    const watcher = track(new SessionHostPty(client, NAME, null, 0, 'watch'))
    await expect(within(watcher.ready, 'refused watch')).rejects.toThrow(/does not support read-only watch/)
    expect(attaches(host)).toEqual([])
  })

  it('upgrades for an owner who joins and downgrades again when the owner leaves', async () => {
    const { userDataDir, endpoint } = fixture('nt-watch-up-')
    const host = await fakeHost(endpoint, ALL)
    const client = new SessionHostClient({ userDataDir })
    const watcher = track(new SessionHostPty(client, NAME, null, 0, 'watch'))
    await within(watcher.ready, 'watch attach')
    const owner = track(
      new SessionHostPty(
        client,
        NAME,
        spawnOptions(userDataDir, 100, 30),
        100
      )
    )
    await within(owner.ready, 'owner attach')
    // The owner joins an attached state: a claim-carrying warm attach upgrades the connection.
    expect(attaches(host).at(-1)).toMatchObject({ cmd: 'attachExisting', cols: 100, rows: 30 })
    expect(attaches(host).at(-1)).not.toHaveProperty('watch')
    owner.write('ls')
    await until(() => host.requests.some((r) => r.cmd === 'write'), 'the owner typing')

    owner.destroy()
    await until(() => attaches(host).length === 3, 'the downgrade')
    expect(attaches(host).at(-1)).toEqual({
      cmd: 'attachExisting',
      name: NAME,
      expectedGeneration: GENERATION,
      watch: true
    })
    // A detach would have ended the watcher's subscription too: never sent while it remains.
    expect(host.requests.map((r) => r.cmd)).not.toContain('detach')
    watcher.destroy()
    await until(() => host.requests.some((r) => r.cmd === 'detach'), 'the last subscriber detaching')
  })

  it('a watcher joining an owner rides the owner claim and casts none of its own', async () => {
    const { userDataDir, endpoint } = fixture('nt-watch-co-')
    const host = await fakeHost(endpoint, ALL)
    const client = new SessionHostClient({ userDataDir })
    const owner = track(
      new SessionHostPty(
        client,
        NAME,
        spawnOptions(userDataDir, 120, 40),
        100
      )
    )
    await within(owner.ready, 'owner attach')
    const watcher = track(new SessionHostPty(client, NAME, null, 0, 'watch'))
    await within(watcher.ready, 'watcher joins')
    expect(attaches(host).at(-1)).toMatchObject({ cmd: 'attachExisting', cols: 120, rows: 40 })
    // The watcher's own "size" never moves the pty.
    watcher.resize(20, 10)
    await client.listSessions().catch(() => [])
    expect(host.requests.map((r) => r.cmd)).not.toContain('resize')
  })
})

describe('SessionHostClient negotiated reads', () => {
  it('returns the host answers when the feature was negotiated', async () => {
    const { userDataDir, endpoint } = fixture('nt-reads-on-')
    await fakeHost(endpoint, ALL)
    const client = new SessionHostClient({ userDataDir })
    await expect(client.captureVisible(NAME)).resolves.toEqual({
      screen: 'row\n',
      cursor: { x: 3, y: 0 },
      altScreen: true
    })
    await expect(client.paneCwd(NAME)).resolves.toBe('C:\\work')
  })

  it('answers null WITHOUT sending when the host never advertised the feature', async () => {
    const { userDataDir, endpoint } = fixture('nt-reads-off-')
    const host = await fakeHost(endpoint, ['geometry'])
    const client = new SessionHostClient({ userDataDir })
    await expect(client.captureVisible(NAME)).resolves.toBeNull()
    await expect(client.paneCwd(NAME)).resolves.toBeNull()
    expect(host.requests.map((r) => r.cmd)).toEqual(['hello'])
  })
})
