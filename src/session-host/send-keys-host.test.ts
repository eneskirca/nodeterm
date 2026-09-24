// The wiring test for #686: it drives the REAL bundled host over its real socket protocol and
// reads the bytes a fake node-pty received. `send-keys-delivery.test.ts` pins what the plan says;
// this pins that `sendKeys` still runs it. Without one of these two, deleting the call (or the
// framing inside it) leaves a green suite and an injected prompt that never submits again.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { PASTE_END, PASTE_START } from '../core/paste-injection'

/**
 * A node-pty stand-in that logs every write to a file (the host runs in its own process, so a
 * spy object cannot be shared) and replays a canned output stream — `CSI ?2004h` for the
 * bracketed-paste case, i.e. what an agent TUI's composer does when it starts.
 */
function fakePtyPlugin(): Plugin {
  return {
    name: 'session-host-send-keys-fake-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({
        path: 'node-pty',
        namespace: 'send-keys'
      }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'send-keys' }, () => ({
        loader: 'js',
        contents: `
          const fs = require('fs')
          export function spawn() {
            let onExit, output, draining = false
            const log = process.env.NT_TEST_WRITE_LOG
            const announce = process.env.NT_TEST_PTY_OUTPUT
            return {
              pid: 4242,
              onData(cb) {
                output = cb
                // Repeated so the announcement cannot be lost to the host registering late; a
                // DECSET is idempotent, and every repeat crosses the same emulator tail.
                if (announce) for (let i = 1; i <= 5; i++) setTimeout(() => cb(announce), i * 20)
              },
              onExit(cb) { onExit = cb },
              write(data) {
                fs.appendFileSync(log, JSON.stringify(draining && data === '\\r' ? 'SWALLOWED' : data) + '\\n')
                if (data.startsWith('\\x1b[200~') && process.env.NT_TEST_RENDER !== 'false') {
                  draining = true
                  setTimeout(() => {
                    draining = false
                    output?.(process.env.NT_TEST_RENDER === 'folded' ? '[Pasted text #1 +40 lines]' : data.slice(6, -6))
                  }, 150)
                }
              },
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
              4_000
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

const SPAWN_OPTIONS: SessionHostSpawnOptions = {
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

/** Boot the real bundled host against the fake pty and return the writes one sendKeys produced. */
async function writesForSendKeys(opts: {
  announce?: string
  render?: boolean | 'folded'
  text: string
  enter: boolean
  /** Poll `capture` until the serialized screen proves this mode reached the emulator. */
  awaitMode?: string
}): Promise<string[]> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-send-keys-'))
  cleanupPaths.push(fixtureDir)
  const dataDir = path.join(fixtureDir, 'user-data')
  mkdirSync(dataDir)
  const paths = sessionHostPaths(dataDir)
  if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
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
    plugins: [fakePtyPlugin()],
    logLevel: 'silent'
  })
  const child = spawn(process.execPath, [bundlePath, dataDir], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, NT_TEST_WRITE_LOG: writeLog, NT_TEST_PTY_OUTPUT: opts.announce ?? '', NT_TEST_RENDER: String(opts.render ?? true) }
  })
  let socket: Socket | null = null
  try {
    const { state, token } = await waitForIdentity(dataDir)
    const connected = await connectFrames(state.endpoint)
    socket = connected.socket
    socket.write(encodeFrame({ id: 0, cmd: 'hello', token }))
    await expect(connected.response(0)).resolves.toMatchObject({ id: 0, ok: true })
    socket.write(
      encodeFrame({ id: 1, cmd: 'attach', name: 'keys', spawn: SPAWN_OPTIONS, scrollback: 100 })
    )
    await expect(connected.response(1)).resolves.toMatchObject({ id: 1, ok: true })

    if (opts.awaitMode) {
      // `serialize()` restores DEC private modes, so the captured screen is the observable proof
      // that the announcement crossed the emulator tail — no sleep-and-hope.
      let seen = false
      for (let attempt = 2; attempt < 60 && !seen; attempt++) {
        socket.write(encodeFrame({ id: attempt, cmd: 'capture', name: 'keys', full: true }))
        const frame = (await connected.response(attempt)) as { result?: { text?: string } }
        seen = (frame.result?.text ?? '').includes(opts.awaitMode)
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(seen).toBe(true)
    }

    socket.write(
      encodeFrame({ id: 900, cmd: 'sendKeysV2', name: 'keys', text: opts.text, enter: opts.enter })
    )
    await expect(connected.response(900)).resolves.toMatchObject({ id: 900, ok: true, result: { delivery: opts.render === false || opts.render === 'folded' ? 'pasted-not-submitted' : true } })
    return readFileSync(writeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
  } finally {
    socket?.destroy()
    child.kill()
    await waitForExit(child)
  }
}

describe('session-host sendKeys delivery', () => {
  it('frames the payload and sends Enter separately once the pane asked for bracketed paste', async () => {
    // The #686 failure: with the Enter inside an unmarked burst, a paste-aware composer (Codex,
    // Claude) keeps the whole thing as pasted content and the prompt is never submitted.
    const writes = await writesForSendKeys({
      announce: '\x1b[?2004h',
      awaitMode: '\x1b[?2004h',
      text: 'summarise the linked context',
      enter: true
    })
    expect(writes).toEqual([`${PASTE_START}summarise the linked context${PASTE_END}`, '\r'])
  }, 30_000)

  it('returns partial delivery over the wire for a folded multiline paste', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(await writesForSendKeys({
      announce: '\x1b[?2004h', awaitMode: '\x1b[?2004h',
      text, enter: true, render: 'folded'
    })).toEqual([`${PASTE_START}${text}${PASTE_END}`])
  }, 30_000)

  it('does not submit a paste that never renders', async () => {
    expect(await writesForSendKeys({
      announce: '\x1b[?2004h', awaitMode: '\x1b[?2004h',
      text: 'unseen', enter: true, render: false
    })).toEqual([`${PASTE_START}unseen${PASTE_END}`])
  }, 30_000)

  it('leaves a pane that never asked byte-identical to the pre-fix single write', async () => {
    const writes = await writesForSendKeys({ text: 'npm test', enter: true })
    expect(writes).toEqual(['npm test\r'])
  }, 30_000)
})
