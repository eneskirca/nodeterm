// Wiring test for the additive agent-operation verbs: drives the REAL bundled host over its real
// socket protocol against a fake node-pty that logs its writes (the host is its own process, so a
// spy cannot be shared). `terminate-owner.test.ts` pins the kill's refusal matrix; this pins that
// the host dispatches both verbs, and that `writeDetachedV1` needs no attachment.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import net, { type Socket } from 'net'
import os from 'os'
import path from 'path'
import { build, type Plugin } from 'esbuild'
import { LineFramer, encodeFrame, type SessionHostFrame, type SessionHostResponse } from './protocol'
import { sessionHostPaths, type SessionHostState } from './paths'
import { WINDOWS_PANE_PROBE_TIMEOUT_MS } from '../core/agents/pane-probe'

/** On win32 `terminateOwnerV1` runs the real PowerShell owner probe: a cold worker may take its
 *  whole first-request deadline (6 s) and then the one-shot fallback (4 s). A 6 s wait here gave
 *  up exactly when the worker did, so the CI runner failed whenever PowerShell started slowly.
 *  Wait as long as the core does for the same probe. */
const CALL_TIMEOUT_MS = WINDOWS_PANE_PROBE_TIMEOUT_MS

/** A fake shell that exits by itself (see fakePtyPlugin). */
const EXITING_SHELL = 'fake-exiting-shell'

function fakePtyPlugin(): Plugin {
  return {
    name: 'session-host-agent-ops-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({ path: 'node-pty', namespace: 'agent-ops' }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'agent-ops' }, () => ({
        loader: 'js',
        contents: `
          const fs = require('fs')
          export function spawn(file) {
            let onExit, output
            return {
              pid: 4242,
              onData(cb) {
                output = cb
                if (process.env.NT_TEST_ENVELOPE_SURFACE) setTimeout(() => cb('\\x1b[?2004h› \\r\\n\\r\\n← for agents · ? for shortcuts'), 0)
              },
              // A shell named EXITING_SHELL ends on its own shortly after the host listens for it —
              // the pty's OWN exit path, identical on every platform (unlike killSession, which on
              // win32 goes through a real taskkill of this never-spawned pid and reports ok:false).
              onExit(cb) {
                onExit = cb
                if (file === '${EXITING_SHELL}') setTimeout(() => onExit?.({ exitCode: 0 }), 50)
              },
              write(data) {
                fs.appendFileSync(process.env.NT_TEST_WRITE_LOG, JSON.stringify(data) + '\\n')
                if (process.env.NT_TEST_ENVELOPE_SURFACE && data.startsWith('\\x1b[200~')) {
                  const screen = process.env.NT_TEST_ENVELOPE_SURFACE === 'dialog'
                    ? 'Would you like to run the following command?\\r\\n1. Yes, proceed\\r\\n2. No'
                    : '› ' + data.slice(6, -6).replace(/\\n/g, '\\r\\n') + '\\r\\n\\r\\n← for agents · ? for shortcuts'
                  output?.('\\x1b[2J\\x1b[H' + screen)
                }
              },
              resize() {}, pause() {}, resume() {},
              kill() { setTimeout(() => onExit?.({ exitCode: 0 }), 20) }
            }
          }
        `
      }))
    }
  }
}

/** Only the OS observation is synthetic; production process-identity and surface predicates remain real. */
function fakeEnvelopeProbe(): Plugin {
  return { name: 'synthetic-envelope-os-probe', setup(bundle) {
    bundle.onResolve({ filter: /^\.\/(windows|linux)-pane-owner$/ }, args => ({ path: args.path.includes('linux') ? 'linux' : 'windows', namespace: 'synthetic-envelope-owner' }))
    bundle.onLoad({ filter: /.*/, namespace: 'synthetic-envelope-owner' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: `
      export * from ${JSON.stringify(path.resolve(`src/session-host/${args.path}-pane-owner.ts`))}
      import fs from 'fs'
      export async function ${args.path === 'linux' ? 'readLinuxPaneOwner' : 'readWindowsConsoleOwner'}(pid, generation) {
        const changed = process.env.NT_TEST_ENVELOPE_SURFACE === 'owner' && fs.readFileSync(process.env.NT_TEST_WRITE_LOG, 'utf8').length > 0
        return { panePid: pid, tty: ${args.path === 'linux' ? "'/dev/pts/9'" : "'win32-console:' + pid"}, paneId: '${args.path === 'linux' ? 'host-linux' : 'win32'}:' + generation + ':root',
          command: 'codex', argv: ['codex'], pids: [pid + 1], processBirths: [changed ? 'replacement' : 'original'] }
      }
    ` }))
  } }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function bootHost(features?: string[], surface?: 'ready' | 'dialog' | 'owner'): Promise<{ connect(): Promise<Conn>; writes(): string[] }> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-agent-ops-'))
  cleanup.push(() => rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const dataDir = path.join(fixtureDir, 'user-data')
  mkdirSync(dataDir)
  const paths = sessionHostPaths(dataDir)
  if (process.platform !== 'win32') cleanup.push(() => rmSync(paths.endpoint, { force: true }))
  const writeLog = path.join(fixtureDir, 'writes.log')
  writeFileSync(writeLog, '')
  const bundlePath = path.join(fixtureDir, 'host.cjs')
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/session-host/host.ts'],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [fakePtyPlugin(), ...(surface ? [fakeEnvelopeProbe()] : [])],
    logLevel: 'silent'
  })
  const child: ChildProcess = spawn(process.execPath, [bundlePath, dataDir], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, NT_TEST_WRITE_LOG: writeLog, ...(surface ? { NT_TEST_ENVELOPE_SURFACE: surface } : {}) }
  })
  cleanup.push(async () => {
    child.kill()
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  let identity: { state: SessionHostState; token: string } | null = null
  for (let attempt = 0; attempt < 200 && !identity; attempt++) {
    try {
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as SessionHostState
      const token = readFileSync(paths.tokenPath, 'utf8').trim()
      if (state.endpoint && token) identity = { state, token }
    } catch { /* published asynchronously */ }
    if (!identity) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!identity) throw new Error('session host did not publish its identity')
  const { state, token } = identity
  return {
    connect: async () => {
      const conn = await connect(state.endpoint)
      cleanup.push(() => void conn.socket.destroy())
      await expect(conn.call({ cmd: 'hello', token, ...(features ? { protocolVersion: 2, features } : {}) })).resolves.toMatchObject({ ok: true })
      return conn
    },
    writes: () => readFileSync(writeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string)
  }
}

interface Conn {
  socket: Socket
  call(body: Record<string, unknown>): Promise<SessionHostResponse>
}

function connect(endpoint: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    const framer = new LineFramer()
    const waiters = new Map<number, (frame: SessionHostResponse) => void>()
    let nextId = 1
    socket.on('data', (chunk: Buffer) => {
      for (const frame of framer.push<SessionHostFrame>(chunk.toString('utf8'))) {
        if ('id' in frame) waiters.get(frame.id)?.(frame)
      }
    })
    socket.once('error', reject)
    socket.once('connect', () =>
      resolve({
        socket,
        call: (body) => {
          const id = nextId++
          return new Promise<SessionHostResponse>((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`no response to ${String(body.cmd)}`)), CALL_TIMEOUT_MS)
            waiters.set(id, (frame) => {
              clearTimeout(timer)
              res(frame)
            })
            socket.write(encodeFrame({ id, ...body }))
          })
        }
      })
    )
  })
}

const SPAWN = { cwd: '.', shell: 'fake-shell', args: [], env: {}, cols: 80, rows: 24 }
const OWNER = {
  panePid: 4242, tty: 'win32-console:4242', paneId: 'win32:g:b', command: 'node', argv: ['claude'],
  pids: [4243], processBirths: ['b']
}

describe('session-host agent-operation verbs', () => {
  it.each(['ready', 'dialog', 'owner'] as const)('real negotiated V2 host writes only the allowed envelope/Enter (%s)', async surface => {
    const host = await bootHost(['envelope-surface-v2'], surface), conn = await host.connect()
    await conn.call({ cmd: 'attach', name: 'nt-v2', spawn: SPAWN, scrollback: 100 })
    await expect.poll(async () => conn.call({ cmd: 'messagePasteReadyV1', name: 'nt-v2' }), { timeout: 1000, interval: 5 })
      .toMatchObject({ ok: true, result: true })
    const observed = await conn.call({ cmd: 'messageOwnerV1', name: 'nt-v2' })
    if (!observed.ok) throw new Error('synthetic owner unavailable')
    const reply = await conn.call({ cmd: 'messageEnvelopeV2', name: 'nt-v2', envelope: 'SYNTHETIC BODY\nEND', expected: observed.result })
    expect(reply, JSON.stringify({ writes: host.writes() })).toMatchObject({ ok: true, result: true })
    expect(host.writes().filter(w => w.startsWith('\x1b[200~'))).toHaveLength(1)
    expect(host.writes().filter(w => w === '\r')).toHaveLength(surface === 'ready' ? 1 : 0)
  }, 30000)

  it('refuses both the legacy envelope and unnegotiated V2 without any PTY writes', async () => {
    const host = await bootHost(), conn = await host.connect()
    await conn.call({ cmd: 'attach', name: 'nt-envelope-gate', spawn: SPAWN, scrollback: 100 })
    for (const cmd of ['messageEnvelopeV1', 'messageEnvelopeV2'])
      await expect(conn.call({ cmd, name: 'nt-envelope-gate', envelope: 'SYNTHETIC', expected: OWNER }))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining('capability required') })
    expect(host.writes()).toEqual([])
  }, 30000)
  it('negotiates the additive feature but still refuses V2 for an absent session, without fallback', async () => {
    const host = await bootHost(['envelope-surface-v2']), conn = await host.connect()
    await expect(conn.call({ cmd: 'messageEnvelopeV2', name: 'nt-absent', envelope: 'SYNTHETIC', expected: OWNER }))
      .resolves.toMatchObject({ ok: true, result: false })
    expect(host.writes()).toEqual([])
  }, 30000)
  it('writeDetachedV1 types verbatim into a session this connection never attached', async () => {
    const host = await bootHost()
    const owner = await host.connect()
    await expect(owner.call({ cmd: 'attach', name: 'nt-a', spawn: SPAWN, scrollback: 100 }))
      .resolves.toMatchObject({ ok: true })
    const stranger = await host.connect()
    // The ordinary `write` still demands an attachment — the new verb is the only way around it.
    await expect(stranger.call({ cmd: 'write', name: 'nt-a', data: 'no' }))
      .resolves.toMatchObject({ ok: false, error: 'not attached to session' })
    await expect(stranger.call({ cmd: 'writeDetachedV1', name: 'nt-a', data: '\x1b[Aline\r' }))
      .resolves.toMatchObject({ ok: true })
    await expect(stranger.call({ cmd: 'writeDetachedV1', name: 'nt-missing', data: 'x' }))
      .resolves.toMatchObject({ ok: false, error: 'no such session' })
    await expect(stranger.call({ cmd: 'writeDetachedV1', name: 'nt-a', data: '' }))
      .resolves.toMatchObject({ ok: false })
    await expect(stranger.call({ cmd: 'noSuchVerbV9', name: 'nt-a' }))
      .resolves.toMatchObject({ ok: false, error: 'unknown command' })
    expect(host.writes()).toEqual(['\x1b[Aline\r'])
  }, 30_000)

  it('writeDetachedV1 refuses an exited session', async () => {
    const host = await bootHost()
    const owner = await host.connect()
    await expect(owner.call({ cmd: 'attach', name: 'nt-b', spawn: { ...SPAWN, shell: EXITING_SHELL }, scrollback: 100 }))
      .resolves.toMatchObject({ ok: true })
    // Wait for the host to observe the exit. Not killSession: on win32 that kills through a real
    // taskkill of the fixture's never-spawned pid and (correctly) answers ok:false — see the same
    // note in host-routing.test.ts. The invariant here is about an EXITED session, however it ended.
    let gone = false
    for (let i = 0; i < 200 && !gone; i++) {
      const r = await owner.call({ cmd: 'hasSession', name: 'nt-b' })
      gone = (r as { result?: { exists?: boolean } }).result?.exists === false
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(gone).toBe(true)
    await expect(owner.call({ cmd: 'writeDetachedV1', name: 'nt-b', data: 'x' }))
      .resolves.toMatchObject({ ok: false, error: 'no such session' })
    expect(host.writes()).toEqual([])
  }, 30_000)

  it('terminateOwnerV1 answers terminated:false when the owner cannot be proven (no Windows console here)', async () => {
    const host = await bootHost()
    const conn = await host.connect()
    await conn.call({ cmd: 'attach', name: 'nt-c', spawn: SPAWN, scrollback: 100 })
    await expect(conn.call({ cmd: 'terminateOwnerV1', name: 'nt-c', expected: OWNER }))
      .resolves.toMatchObject({ ok: true, result: { terminated: false } })
    await expect(conn.call({ cmd: 'terminateOwnerV1', name: 'nt-missing', expected: OWNER }))
      .resolves.toMatchObject({ ok: true, result: { terminated: false } })
    // The session survived and nothing was typed into it.
    await expect(conn.call({ cmd: 'hasSession', name: 'nt-c' })).resolves.toMatchObject({ result: { exists: true } })
    expect(host.writes()).toEqual([])
  }, 45_000) // two probe-bound calls, each up to CALL_TIMEOUT_MS on a cold win32 runner
})
