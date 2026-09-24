import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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
      // These fixtures must model a CURRENT host: the flows here create terminals, and creation is
      // a v2-only operation the client rightly refuses against a legacy host. So the published
      // version, the advertised hello version and the per-attach `generation` all have to agree —
      // a fake host that publishes 2 while answering like a v1 host is inconsistent, not legacy.
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION
    })
  )
  return { userDataDir, endpoint: paths.endpoint }
}

function spawnOptions(
  userDataDir: string,
  cols: number,
  rows: number,
  args: string[] = []
): SessionHostSpawnOptions {
  return {
    cwd: userDataDir,
    shell: process.execPath,
    args,
    env: {},
    cols,
    rows
  }
}

function trackSocket(socket: net.Socket): void {
  openSockets.add(socket)
  socket.once('close', () => openSockets.delete(socket))
}

function sessionPty(
  client: SessionHostClient,
  name: string,
  spawn: SessionHostSpawnOptions,
  scrollback: number
): SessionHostPty {
  const pty = new SessionHostPty(client, name, spawn, scrollback)
  livePtys.add(pty)
  return pty
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  openServers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
}

afterEach(async () => {
  for (const pty of livePtys) pty.destroy()
  livePtys.clear()
  // Let synchronous unsubscribe bookkeeping cancel every idle reconnect timer before its socket
  // is torn down by the harness. A failed assertion must not leak a client into the next Chut.
  await eventLoopTurn()
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        })
    )
  )
  openServers.clear()
  for (const dir of tempDirs) {
    const endpoint = sessionHostPaths(dir).endpoint
    if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  tempDirs.clear()
})

describe('SessionHostClient subscriber flow and reconnect barriers', () => {
  it('holds one host pause ticket until the last exact local owner resumes or unsubscribes', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-owner-')
    const flowCommands: Array<'pause' | 'resume' | 'detach'> = []
    const firstPause = deferred<void>()
    const firstResume = deferred<void>()
    const secondPause = deferred<void>()
    const secondResume = deferred<void>()
    const detached = deferred<void>()
    const ownerBoundaryResize = deferred<void>()
    const unsubscribeBoundaryResize = deferred<void>()
    let pauseCount = 0
    let resumeCount = 0

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            // The second local subscriber co-attaches to the same already-live generation, so the
            // client sends `attachExisting` (warm, no spawn plan) rather than a second `attach`.
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false, generation: 'flow-generation' } }))
          } else if (request.cmd === 'pause') {
            flowCommands.push('pause')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            pauseCount++
            if (pauseCount === 1) firstPause.resolve()
            if (pauseCount === 2) secondPause.resolve()
          } else if (request.cmd === 'resume') {
            flowCommands.push('resume')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            resumeCount++
            if (resumeCount === 1) firstResume.resolve()
            if (resumeCount === 2) secondResume.resolve()
          } else if (request.cmd === 'detach') {
            flowCommands.push('detach')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            detached.resolve()
          } else if (request.cmd === 'resize') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
            if (request.cols === 79 && request.rows === 23) ownerBoundaryResize.resolve()
            if (request.cols === 78 && request.rows === 22) unsubscribeBoundaryResize.resolve()
          } else if (request.cmd === 'write') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const first = sessionPty(client, 'nt-flow-owner', spawnOptions(userDataDir, 120, 40), 500)
    const second = sessionPty(client, 'nt-flow-owner', spawnOptions(userDataDir, 80, 24), 500)
    await expect(within(Promise.all([first.ready, second.ready]), 'both local attaches')).resolves.toHaveLength(2)

    first.pause()
    await within(firstPause.promise, 'first aggregate pause')
    second.pause()
    first.resume()
    first.resize(79, 23)
    await within(ownerBoundaryResize.promise, 'co-owner flow boundary')
    expect(flowCommands).toEqual(['pause'])
    second.resume()
    await within(firstResume.promise, 'last-owner resume')

    first.pause()
    await within(secondPause.promise, 'second aggregate pause')
    second.destroy()
    first.resize(78, 22)
    await within(unsubscribeBoundaryResize.promise, 'surviving-owner flow boundary')
    expect(flowCommands).toEqual(['pause', 'resume', 'pause'])
    first.destroy()
    await within(secondResume.promise, 'unsubscribe-owned resume')
    await within(detached.promise, 'last-subscriber detach')
    await eventLoopTurn()

    expect(flowCommands).toEqual(['pause', 'resume', 'pause', 'resume', 'detach'])
  })

  it('returns a pause acknowledged during last-subscriber teardown before detaching', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-retiring-pause-')
    const pauseReachedHost = deferred<void>()
    const resumed = deferred<void>()
    const detached = deferred<void>()
    const flowCommands: Array<'pause' | 'resume' | 'detach'> = []

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            // The second local subscriber co-attaches to the same already-live generation, so the
            // client sends `attachExisting` (warm, no spawn plan) rather than a second `attach`.
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false, generation: 'flow-generation' } }))
          } else if (request.cmd === 'pause') {
            flowCommands.push('pause')
            // Resolve in this same server callback after writing the acknowledgement. The test's
            // continuation removes the owners before the client socket can consume that frame.
            socket.write(encodeFrame({ id: request.id, ok: true }))
            pauseReachedHost.resolve()
          } else if (request.cmd === 'resume') {
            flowCommands.push('resume')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            resumed.resolve()
          } else if (request.cmd === 'detach') {
            flowCommands.push('detach')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            detached.resolve()
          } else if (request.cmd === 'resize' || request.cmd === 'write') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const first = sessionPty(
      client,
      'nt-retiring-pause',
      spawnOptions(userDataDir, 100, 32),
      500
    )
    const second = sessionPty(
      client,
      'nt-retiring-pause',
      spawnOptions(userDataDir, 80, 24),
      500
    )
    await within(Promise.all([first.ready, second.ready]), 'retiring-pause co-attach')

    first.pause()
    await within(pauseReachedHost.promise, 'in-flight pause acknowledgement')
    first.destroy()
    second.destroy()
    await within(resumed.promise, 'retiring pause resume')
    await within(detached.promise, 'retiring pause detach')
    await eventLoopTurn()
    expect(flowCommands).toEqual(['pause', 'resume', 'detach'])
  })

  it('returns the surviving pause ticket and detaches when a delayed co-attach rejects after its neighbor leaves', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-rejected-neighbor-')
    const pauseReachedHost = deferred<void>()
    const rejectedAttach = deferred<{ socket: net.Socket; id: number }>()
    const resumed = deferred<void>()
    const detached = deferred<void>()
    const commands: string[] = []

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            // The owner is the only fresh create for this name; the neighbor co-attaches to the
            // already-live generation and therefore sends `attachExisting` instead (below).
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            commands.push('attach:rejected-neighbor')
            rejectedAttach.resolve({ socket, id: request.id })
          } else if (request.cmd === 'pause') {
            commands.push('pause')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            pauseReachedHost.resolve()
          } else if (request.cmd === 'resume') {
            commands.push('resume')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            resumed.resolve()
          } else if (request.cmd === 'detach') {
            commands.push('detach')
            socket.write(encodeFrame({ id: request.id, ok: true }))
            detached.resolve()
          } else if (request.cmd === 'resize' || request.cmd === 'write') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const owner = sessionPty(
      client,
      'nt-rejected-neighbor',
      spawnOptions(userDataDir, 100, 30, ['surviving-owner']),
      500
    )
    await within(owner.ready, 'surviving owner attach')
    owner.pause()
    await within(pauseReachedHost.promise, 'surviving owner pause')

    const neighbor = sessionPty(
      client,
      'nt-rejected-neighbor',
      spawnOptions(userDataDir, 80, 24, ['rejected-neighbor']),
      500
    )
    const heldAttach = await within(rejectedAttach.promise, 'delayed neighbor attach')
    owner.destroy()
    await eventLoopTurn()
    expect(commands).toEqual(['pause', 'attach:rejected-neighbor'])

    heldAttach.socket.write(
      encodeFrame({ id: heldAttach.id, ok: false, error: 'neighbor attach rejected' })
    )
    await expect(within(neighbor.ready, 'rejected neighbor settlement')).rejects.toThrow(
      'neighbor attach rejected'
    )
    await within(resumed.promise, 'rejected-neighbor resume')
    await within(detached.promise, 'rejected-neighbor detach')
    expect(commands).toEqual(['pause', 'attach:rejected-neighbor', 'resume', 'detach'])
  })

  it('buffers a cold session data frame received before attach acknowledgement and delivers it exactly once', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-cold-data-')
    const attachHeld = deferred<{ socket: net.Socket; id: number }>()
    const preAckFrameWritten = deferred<void>()
    const delivered: string[] = []
    const order: string[] = []

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            attachHeld.resolve({ socket, id: request.id })
            // A v2 event frame is dropped by the client unless it carries a valid `generation`
            // (session-host-client.ts's `handleFrame`); a pre-ack frame with no expected generation
            // yet is what the client adopts as this session's generation, so it must match the
            // generation the held attach acknowledgement below eventually confirms.
            socket.write(
              encodeFrame({
                type: 'data',
                name: request.name,
                data: 'COLD-PRE-ACK',
                generation: 'flow-generation'
              }),
              () => preAckFrameWritten.resolve()
            )
          } else if (request.cmd === 'hasSession') {
            socket.write(
              encodeFrame({
                type: 'data',
                name: request.name,
                data: 'POST-ACK',
                generation: 'flow-generation'
              }) + encodeFrame({ id: request.id, ok: true, result: { exists: true, generation: 'flow-generation' } })
            )
          } else if (request.cmd === 'detach' || request.cmd === 'resize') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const pty = sessionPty(
      client,
      'nt-cold-pre-ack',
      spawnOptions(userDataDir, 80, 24),
      500
    )
    pty.onData((data) => {
      delivered.push(data)
      order.push(`data:${data}`)
    })
    const ready = pty.ready.then((result) => {
      order.push('ready')
      return result
    })

    const heldAttach = await within(attachHeld.promise, 'cold attach request')
    await within(preAckFrameWritten.promise, 'pre-ack data write')
    await eventLoopTurn()
    expect(delivered).toEqual([])
    heldAttach.socket.write(
      encodeFrame({ id: heldAttach.id, ok: true, result: { fresh: true, generation: 'flow-generation' } })
    )
    await expect(within(ready, 'cold attach acknowledgement')).resolves.toEqual({ fresh: true, generation: 'flow-generation' })
    expect(order).toEqual(['data:COLD-PRE-ACK', 'ready'])

    await expect(within(client.hasSession('nt-cold-pre-ack'), 'post-ack data barrier')).resolves.toBe(
      true
    )
    expect(delivered).toEqual(['COLD-PRE-ACK', 'POST-ACK'])
  })

  it('follows the most recently active view, normalizes invalid axes, and falls back when it leaves (issue #914)', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-geometry-')
    // `narrow`'s attach co-attaches to the already-live generation `wide` created, so it reaches
    // the host as `attachExisting` rather than a second `attach` — and `attachExisting` deliberately
    // carries no spawn plan (session-host-client.ts's `SubscriberEntry.spawn` doc comment), so only
    // cols/rows are checkable for it, not `args`.
    const attachClaims: Array<{ cmd: 'attach' | 'attachExisting'; cols: number; rows: number }> = []
    const resizeRequests: Array<{ cols: number; rows: number }> = []
    const normalizedFirst = deferred<void>()
    const normalizedSecond = deferred<void>()
    const wideLatest = deferred<void>()
    const fellBackAfterDetach = deferred<void>()

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            attachClaims.push({
              cmd: 'attach',
              cols: request.spawn.cols,
              rows: request.spawn.rows
            })
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            attachClaims.push({
              cmd: 'attachExisting',
              cols: request.cols ?? -1,
              rows: request.rows ?? -1
            })
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false, generation: 'flow-generation' } }))
          } else if (request.cmd === 'resize') {
            resizeRequests.push({ cols: request.cols, rows: request.rows })
            socket.write(encodeFrame({ id: request.id, ok: true }))
            if (request.cols === 120 && request.rows === 1) normalizedFirst.resolve()
            if (request.cols === 90 && request.rows === 40) {
              if (resizeRequests.length === 2) normalizedSecond.resolve()
              else fellBackAfterDetach.resolve()
            }
            if (request.cols === 100 && request.rows === 20) wideLatest.resolve()
          } else if (request.cmd === 'detach' || request.cmd === 'write') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const wide = sessionPty(
      client,
      'nt-local-geometry',
      spawnOptions(userDataDir, 120, 30, ['wide-short']),
      500
    )
    await within(wide.ready, 'wide geometry attach')
    const narrow = sessionPty(
      client,
      'nt-local-geometry',
      spawnOptions(userDataDir, 80, 40, ['narrow-tall']),
      500
    )
    await within(narrow.ready, 'narrow geometry attach')
    // The newly attached view is the most recently active one, so the session takes ITS size —
    // not the componentwise minimum (80x30) it used to, which is what left a phone that dismissed
    // its keyboard stuck at a shorter desktop view's rows.
    expect(attachClaims).toEqual([
      { cmd: 'attach', cols: 120, rows: 30 },
      { cmd: 'attachExisting', cols: 80, rows: 40 }
    ])

    // A CHANGED claim makes that view the active one; each axis still normalizes independently.
    wide.resize(Number.NaN, -5)
    await within(normalizedFirst.promise, 'NaN and negative geometry normalization')
    narrow.resize(90.9, Number.POSITIVE_INFINITY)
    await within(normalizedSecond.promise, 'fractional and infinite geometry normalization')
    wide.resize(100, 20)
    await within(wideLatest.promise, 'the resized view becomes the active one')
    // The active view leaves: the session falls back to the one that was active before it.
    wide.destroy()
    await within(fellBackAfterDetach.promise, 'fallback to the previous view after detach')

    expect(resizeRequests).toEqual([
      { cols: 120, rows: 1 },
      { cols: 90, rows: 40 },
      { cols: 100, rows: 20 },
      { cols: 90, rows: 40 }
    ])
  })

  it('finishes paused geometry replay before normal requests and releases buffered repaint data only after resume', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-replay-')
    const firstClosed = deferred<void>()
    const initialPause = deferred<void>()
    // v2 reconnect restoration warm-replays via `attachExisting`, not a second `attach` — see
    // `restoreSocket` in session-host-client.ts, which never sends a spawn plan on reattach.
    const replayAttach = deferred<Extract<SessionHostRequest, { cmd: 'attachExisting' }>>()
    const bothNormalRequests = deferred<void>()
    const replayResume = deferred<{ socket: net.Socket; id: number }>()
    const replayBufferFlushed = deferred<void>()
    const sequence: string[] = []
    const secondNormalCommands: string[] = []
    let connection = 0
    let firstSocket: net.Socket | undefined
    let replaySocket: net.Socket | undefined
    let replayRequestId: number | undefined
    let normalCount = 0

    const server = net.createServer((socket) => {
      const ownConnection = ++connection
      if (ownConnection === 1) firstSocket = socket
      trackSocket(socket)
      socket.once('close', () => {
        if (ownConnection === 1) firstClosed.resolve()
      })
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            if (ownConnection === 2) sequence.push('request:hello')
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            // Only the initial cold create (`larger`) arrives here — `smaller` co-attaches below,
            // and the reconnect below that, both via `attachExisting`.
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            if (ownConnection === 1) {
              // `smaller` co-attaches to the already-live generation `larger` just created.
              socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false, generation: 'flow-generation' } }))
            } else {
              // The label stays `request:attach` — it names the attach-family step in the test's
              // own sequence, not the literal wire command.
              sequence.push('request:attach')
              replaySocket = socket
              replayRequestId = request.id
              replayAttach.resolve(request)
            }
          } else if (request.cmd === 'pause') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
            if (ownConnection === 1) initialPause.resolve()
          } else if (request.cmd === 'resume') {
            sequence.push('request:resume')
            replayResume.resolve({ socket, id: request.id })
          } else if (request.cmd === 'hasSession') {
            sequence.push('request:hasSession')
            secondNormalCommands.push(request.cmd)
            socket.write(
              encodeFrame({ id: request.id, ok: true, result: { exists: true, generation: 'flow-generation' } })
            )
            if (++normalCount === 2) bothNormalRequests.resolve()
          } else if (request.cmd === 'write') {
            sequence.push('request:write')
            secondNormalCommands.push(request.cmd)
            socket.write(encodeFrame({ id: request.id, ok: true }))
            if (++normalCount === 2) bothNormalRequests.resolve()
          } else if (request.cmd === 'resize' || request.cmd === 'detach') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const largerDelivered: string[] = []
    const smallerDelivered: string[] = []
    const maybeFinishReplayDelivery = (): void => {
      if (
        largerDelivered.join('').includes('REPLAY-SCREEN') &&
        largerDelivered.join('').includes('LIVE-WHILE-PAUSED') &&
        smallerDelivered.join('').includes('REPLAY-SCREEN') &&
        smallerDelivered.join('').includes('LIVE-WHILE-PAUSED')
      ) {
        replayBufferFlushed.resolve()
      }
    }
    const client = new SessionHostClient({ userDataDir })
    const larger = sessionPty(
      client,
      'nt-replay-barrier',
      spawnOptions(userDataDir, 120, 40, ['larger']),
      500
    )
    const smaller = sessionPty(
      client,
      'nt-replay-barrier',
      spawnOptions(userDataDir, 80, 24, ['smaller']),
      500
    )
    larger.onData((data) => {
      sequence.push('data:larger')
      largerDelivered.push(data)
      maybeFinishReplayDelivery()
    })
    smaller.onData((data) => {
      sequence.push('data:smaller')
      smallerDelivered.push(data)
      maybeFinishReplayDelivery()
    })
    await within(Promise.all([larger.ready, smaller.ready]), 'initial co-attach')
    larger.pause()
    await within(initialPause.promise, 'initial pause acknowledgement')

    firstSocket?.destroy()
    await within(firstClosed.promise, 'first socket close')
    const replay = await within(replayAttach.promise, 'automatic reconnect attach')
    const hasSession = client.hasSession('nt-replay-barrier')
    smaller.write('normal-write-after-replay')

    await eventLoopTurn()
    expect(sequence.slice(0, 2)).toEqual(['request:hello', 'request:attach'])
    expect(secondNormalCommands).toEqual([])
    expect(largerDelivered).toEqual([])
    expect(smallerDelivered).toEqual([])
    expect(replay.paused).toBe(true)
    expect(replay.cols).toBe(80)
    expect(replay.rows).toBe(24)

    // Written as two SEPARATE socket writes, the second only once the first's bytes have flushed:
    // the repaint screen the response carries is delivered through `restoreSocket`'s own awaited
    // continuation (a microtask, scheduled once the response frame is parsed), while a raw `data`
    // event frame is delivered synchronously the instant it is parsed. Concatenating both frames
    // into one write lets the client parse them in the same synchronous pass, which would hand the
    // live marker to `deliverData` before the repaint's continuation has even run — reversing the
    // very ordering this test exists to prove. A real flush boundary between the two writes is what
    // gives the response's continuation a chance to run first.
    replaySocket!.write(
      encodeFrame({
        id: replayRequestId!,
        ok: true,
        result: { fresh: false, screen: 'REPLAY-SCREEN', generation: 'flow-generation' }
      }),
      () => {
        replaySocket!.write(
          encodeFrame({
            type: 'data',
            name: 'nt-replay-barrier',
            data: 'LIVE-WHILE-PAUSED',
            generation: 'flow-generation'
          })
        )
      }
    )
    await expect(within(hasSession, 'post-replay hasSession')).resolves.toBe(true)
    await within(bothNormalRequests.promise, 'both requests held behind replay')
    expect(largerDelivered).toEqual([])
    expect(smallerDelivered).toEqual([])

    larger.resume()
    const heldResume = await within(replayResume.promise, 'reconnect resume request')
    await eventLoopTurn()
    expect(largerDelivered).toEqual([])
    expect(smallerDelivered).toEqual([])
    heldResume.socket.write(encodeFrame({ id: heldResume.id, ok: true }))
    await within(replayBufferFlushed.promise, 'buffered reconnect data release')
    for (const delivered of [largerDelivered, smallerDelivered]) {
      const repaintIndex = delivered.findIndex((data) => data.includes('REPLAY-SCREEN'))
      const liveIndex = delivered.findIndex((data) => data.includes('LIVE-WHILE-PAUSED'))
      expect(repaintIndex).toBeGreaterThanOrEqual(0)
      expect(repaintIndex).toBeLessThan(liveIndex)
    }
    expect(sequence.indexOf('request:attach')).toBeLessThan(sequence.indexOf('request:hasSession'))
    expect(sequence.indexOf('request:attach')).toBeLessThan(sequence.indexOf('request:write'))
    expect(sequence.indexOf('request:resume')).toBeLessThan(sequence.indexOf('data:larger'))
  })

  it('reconnects and reattaches an idle live subscriber without another client API call', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-idle-')
    const firstClosed = deferred<void>()
    const idleReplay = deferred<void>()
    const markerDelivered = deferred<string>()
    let connection = 0
    let firstSocket: net.Socket | undefined

    const server = net.createServer((socket) => {
      const ownConnection = ++connection
      if (ownConnection === 1) firstSocket = socket
      trackSocket(socket)
      socket.once('close', () => {
        if (ownConnection === 1) firstClosed.resolve()
      })
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            // Only the initial cold create arrives here; v2 reconnect replay warm-reattaches via
            // `attachExisting` (below), never a second `attach`.
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
          } else if (request.cmd === 'attachExisting') {
            socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false, generation: 'flow-generation' } }))
            idleReplay.resolve()
            socket.write(
              encodeFrame({
                type: 'data',
                name: request.name,
                data: 'IDLE-RECONNECT-MARKER',
                generation: 'flow-generation'
              })
            )
          } else if (request.cmd === 'detach' || request.cmd === 'resize') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const pty = sessionPty(
      client,
      'nt-idle-reconnect',
      spawnOptions(userDataDir, 90, 30),
      500
    )
    pty.onData((data) => {
      if (data.includes('IDLE-RECONNECT-MARKER')) markerDelivered.resolve(data)
    })
    await within(pty.ready, 'initial idle attach')

    firstSocket?.destroy()
    await within(firstClosed.promise, 'idle socket close')
    await within(idleReplay.promise, 'automatic idle replay', 4_000)
    await expect(within(markerDelivered.promise, 'idle replay data', 4_000)).resolves.toContain(
      'IDLE-RECONNECT-MARKER'
    )
    expect(connection).toBeGreaterThanOrEqual(2)
  })

  it('compensates a canceled delayed attach with detach and never replays the retired subscriber', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-cancel-')
    const attachSeen = deferred<void>()
    const detachSeen = deferred<void>()
    const firstClosed = deferred<void>()
    let connection = 0
    let firstSocket: net.Socket | undefined
    let delayedAttachId: number | undefined
    const reconnectCommands: string[] = []
    const firstDetachNames: string[] = []

    const server = net.createServer((socket) => {
      const ownConnection = ++connection
      if (ownConnection === 1) firstSocket = socket
      trackSocket(socket)
      socket.once('close', () => {
        if (ownConnection === 1) firstClosed.resolve()
      })
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            if (ownConnection === 1) {
              delayedAttachId = request.id
              attachSeen.resolve()
            } else {
              reconnectCommands.push(request.cmd)
              socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: false } }))
            }
          } else if (request.cmd === 'detach') {
            if (ownConnection === 1) {
              firstDetachNames.push(request.name)
              detachSeen.resolve()
            }
            socket.write(encodeFrame({ id: request.id, ok: true }))
          } else if (request.cmd === 'hasSession') {
            if (ownConnection === 1) {
              // Give the test a client-observed disconnect: awaiting this request's rejection is
              // stronger than observing the peer socket's local close event.
              socket.destroy()
            } else {
              reconnectCommands.push(request.cmd)
              socket.write(
                encodeFrame({ id: request.id, ok: true, result: { exists: true, generation: 'flow-generation' } })
              )
            }
          } else if (request.cmd === 'listSessions') {
            reconnectCommands.push(request.cmd)
            socket.write(encodeFrame({ id: request.id, ok: true, result: { names: [] } }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const pty = sessionPty(
      client,
      'nt-canceled-attach',
      spawnOptions(userDataDir, 80, 24),
      500
    )
    const readySettled = pty.ready.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await within(attachSeen.promise, 'delayed attach request')
    pty.destroy()
    firstSocket!.write(
      encodeFrame({ id: delayedAttachId!, ok: true, result: { fresh: true, generation: 'flow-generation' } })
    )
    await within(detachSeen.promise, 'compensating detach')
    await expect(within(readySettled, 'canceled ready settlement')).resolves.toBe('rejected')

    await expect(
      within(client.hasSession('nt-canceled-attach'), 'disconnect observation probe')
    ).rejects.toThrow(/connection lost/i)
    await within(firstClosed.promise, 'canceled attach socket close')
    await expect(within(client.hasSession('nt-canceled-attach'), 'forced reconnect')).resolves.toBe(
      true
    )
    await expect(within(client.listSessions(), 'post-reconnect request barrier')).resolves.toEqual([])
    expect(reconnectCommands).toEqual(['hasSession', 'listSessions'])
    expect(firstDetachNames).toEqual(['nt-canceled-attach'])
  })

  it('keeps kill ordered ahead of a replacement attach after the old local state retires', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-kill-lane-')
    const oldWriteReachedHost = deferred<void>()
    const releaseOldWrite = deferred<void>()
    const killReachedHost = deferred<void>()
    const replacementAttachReachedHost = deferred<void>()
    const afterInitial: string[] = []
    let killCount = 0

    const server = net.createServer((socket) => {
      trackSocket(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            if (request.spawn.args[0] === 'old-generation') {
              socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'flow-generation' } }))
            } else {
              afterInitial.push('attach:replacement')
              replacementAttachReachedHost.resolve()
              socket.write(
                encodeFrame({
                  id: request.id,
                  ok: true,
                  result: { fresh: true, generation: 'replacement-generation-id' }
                })
              )
            }
          } else if (request.cmd === 'write') {
            afterInitial.push('write:old')
            oldWriteReachedHost.resolve()
            void releaseOldWrite.promise.then(() => {
              if (!socket.destroyed) socket.write(encodeFrame({ id: request.id, ok: true }))
            })
          } else if (request.cmd === 'killSession') {
            afterInitial.push('kill')
            killCount++
            socket.write(encodeFrame({ id: request.id, ok: true, result: {} }))
            killReachedHost.resolve()
          } else if (request.cmd === 'detach' || request.cmd === 'resize') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const old = sessionPty(
      client,
      'nt-kill-name-lane',
      spawnOptions(userDataDir, 100, 32, ['old-generation']),
      500
    )
    await within(old.ready, 'old generation attach')
    old.write('hold-old-name-lane')
    await within(oldWriteReachedHost.promise, 'old queued write')

    const killedOld = client.killSession('nt-kill-name-lane')
    old.destroy()
    await eventLoopTurn()
    expect(afterInitial).toEqual(['write:old'])

    releaseOldWrite.resolve()
    await within(killReachedHost.promise, 'old generation kill')
    // The kill barrier (`killReplayBarriers` in session-host-client.ts) refuses ANY attach for
    // this name — cold create included, not just reconnect replay — until the kill is confirmed;
    // see session-host-client.test.ts's "rejects a concurrent attach while kill confirmation is
    // in progress" for the same contract asserted directly. The replacement therefore only
    // attaches once the kill has actually settled, which is what keeps its wire request ordered
    // strictly behind the kill's rather than racing it.
    await expect(within(killedOld, 'old generation kill acknowledgement')).resolves.toBeUndefined()

    const replacement = sessionPty(
      client,
      'nt-kill-name-lane',
      spawnOptions(userDataDir, 80, 24, ['replacement-generation']),
      500
    )
    await within(replacementAttachReachedHost.promise, 'post-kill replacement attach')
    await expect(within(replacement.ready, 'replacement generation attach')).resolves.toEqual({
      fresh: true,
      generation: 'replacement-generation-id'
    })
    expect(afterInitial).toEqual(['write:old', 'kill', 'attach:replacement'])
    expect(killCount).toBe(1)
  })

  it('retires an exiting generation before a synchronous replacement attach and replays only the replacement', async () => {
    const { userDataDir, endpoint } = fixture('nodeterm-session-flow-generation-')
    const oldExit = vi.fn()
    const replacementExit = vi.fn()
    const replacementCreated = deferred<SessionHostPty>()
    const replacementData = deferred<string>()
    const firstClosed = deferred<void>()
    // v2 reconnect restoration warm-replays via `attachExisting`, not a second `attach` — see
    // `restoreSocket` in session-host-client.ts, which never sends a spawn plan on reattach.
    const replayAttach = deferred<Extract<SessionHostRequest, { cmd: 'attachExisting' }>>()
    let connection = 0
    let firstSocket: net.Socket | undefined
    const firstConnectionAttachArgs: string[][] = []
    // `attachExisting` deliberately carries no spawn plan, so the reconnect is identified by the
    // exact generation it expects rather than by `spawn.args`.
    const reconnectExpectedGenerations: Array<string | undefined> = []

    const server = net.createServer((socket) => {
      const ownConnection = ++connection
      if (ownConnection === 1) firstSocket = socket
      trackSocket(socket)
      socket.once('close', () => {
        if (ownConnection === 1) firstClosed.resolve()
      })
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            // Both `old` and its replacement are cold creates (the replacement attaches only after
            // `old`'s state has fully retired, so there is nothing local to co-attach onto) — both
            // therefore arrive here as plain `attach`, distinguished by generation below.
            if (request.spawn.args[0] === 'old-generation') {
              firstConnectionAttachArgs.push(request.spawn.args)
              socket.write(encodeFrame({ id: request.id, ok: true, result: { fresh: true, generation: 'old-generation-id' } }))
            } else {
              firstConnectionAttachArgs.push(request.spawn.args)
              socket.write(
                encodeFrame({
                  id: request.id,
                  ok: true,
                  result: { fresh: true, generation: 'replacement-generation-id' }
                })
              )
            }
          } else if (request.cmd === 'attachExisting') {
            // The automatic reconnect warm-replays whichever generation is still locally attached —
            // proven below to be the replacement's, never the retired old one.
            reconnectExpectedGenerations.push(request.expectedGeneration)
            replayAttach.resolve(request)
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { fresh: false, generation: 'replacement-generation-id' }
              }) +
                encodeFrame({
                  type: 'data',
                  name: request.name,
                  data: 'REPLACEMENT-REPLAY-MARKER',
                  generation: 'replacement-generation-id'
                })
            )
          } else if (request.cmd === 'hasSession') {
            socket.write(
              encodeFrame({ id: request.id, ok: true, result: { exists: true, generation: 'flow-generation' } })
            )
          } else if (request.cmd === 'detach' || request.cmd === 'resize') {
            socket.write(encodeFrame({ id: request.id, ok: true }))
          }
        }
      })
    })
    await listen(server, endpoint)

    const client = new SessionHostClient({ userDataDir })
    const old = sessionPty(
      client,
      'nt-generation-replace',
      spawnOptions(userDataDir, 100, 32, ['old-generation']),
      500
    )
    old.onExit((event) => {
      oldExit(event)
      const replacement = sessionPty(
        client,
        'nt-generation-replace',
        spawnOptions(userDataDir, 70, 20, ['replacement-generation']),
        500
      )
      replacement.onExit(replacementExit)
      replacement.onData((data) => {
        if (data.includes('REPLACEMENT-REPLAY-MARKER')) replacementData.resolve(data)
      })
      replacementCreated.resolve(replacement)
    })
    await within(old.ready, 'old generation attach')

    firstSocket!.write(
      encodeFrame({ type: 'exit', name: 'nt-generation-replace', exitCode: 17, generation: 'old-generation-id' })
    )
    const replacement = await within(replacementCreated.promise, 'synchronous replacement creation')
    await within(replacement.ready, 'replacement attach')
    expect(oldExit).toHaveBeenCalledTimes(1)
    expect(oldExit).toHaveBeenCalledWith({ exitCode: 17 })
    expect(replacementExit).not.toHaveBeenCalled()
    expect(firstConnectionAttachArgs).toEqual([['old-generation'], ['replacement-generation']])

    firstSocket?.destroy()
    await within(firstClosed.promise, 'replacement socket close')
    const replay = await within(replayAttach.promise, 'replacement automatic replay', 4_000)
    expect(replay.expectedGeneration).toBe('replacement-generation-id')
    await expect(
      within(replacementData.promise, 'replacement replay data', 4_000)
    ).resolves.toContain('REPLACEMENT-REPLAY-MARKER')
    await expect(
      within(client.hasSession('nt-generation-replace'), 'replacement replay request barrier')
    ).resolves.toBe(true)
    expect(reconnectExpectedGenerations).toEqual(['replacement-generation-id'])
    expect(replacementExit).not.toHaveBeenCalled()
  })
})
