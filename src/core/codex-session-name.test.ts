// The app-server protocol client, against a real WebSocket server on a real unix socket.
//
// Two of its answers are load-bearing in ways a mocked test would not show: `codexThreadExistsAt`
// is what stands between a stale session id and a node that dies AFTER exec (where no fallback is
// left), and both readers must answer the conservative thing when the server is simply not there —
// which, for a CLI whose app-server starts on demand, is a completely ordinary state.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  codexThreadExistsAt,
  codexUnixWebSocketUrl,
  readCodexSessionNameAt,
  waitForCodexAppServer
} from './codex-session-name'

let dir = ''
let sock = ''
let server: http.Server
let wss: WebSocketServer
/** Threads the fake app-server knows about, id → name. */
const threads = new Map<string, string | null>([
  ['thread-known', 'Named by codex'],
  ['thread-nameless', null]
])
let initializeFails = false

function handle(ws: WebSocket): void {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, any>
    if (msg.method === 'initialize') {
      ws.send(
        JSON.stringify(
          initializeFails
            ? { id: msg.id, error: { message: 'not authenticated' } }
            : { id: msg.id, result: {} }
        )
      )
      return
    }
    if (msg.method === 'thread/read') {
      const id = msg.params?.threadId as string
      if (!threads.has(id)) {
        ws.send(JSON.stringify({ id: msg.id, error: { message: 'no rollout found' } }))
        return
      }
      ws.send(JSON.stringify({ id: msg.id, result: { thread: { id, name: threads.get(id) } } }))
    }
  })
}

beforeAll(async () => {
  // Short prefix and short socket name ON PURPOSE. Unix socket paths are capped at `sun_path`
  // (104 bytes on macOS), and macOS's `os.tmpdir()` is already ~49 of them
  // (`/var/folders/ab/…/T/`); a descriptive prefix plus `app-server-control.sock` lands exactly on
  // the limit and fails to bind on a developer's machine while passing in CI. Everything still
  // lives inside the mkdtemp directory, so the path stays unpredictable.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cx-'))
  sock = path.join(dir, 'as.sock')
  server = http.createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', handle)
  await new Promise<void>((resolve) => server.listen(sock, resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('codexThreadExistsAt', () => {
  it('confirms a thread the app-server knows', async () => {
    expect(await codexThreadExistsAt(sock, 'thread-known')).toBe(true)
    expect(await codexThreadExistsAt(sock, 'thread-nameless')).toBe(true)
  })

  it('refuses an id the app-server never heard of (the stale-session-id case)', async () => {
    // This is the whole point: the launcher's bind falls back to plain codex instead of exec'ing
    // a resume that dies with "no rollout found" where nothing can catch it.
    expect(await codexThreadExistsAt(sock, 'thread-from-a-past-life')).toBe(false)
  })

  it('refuses when the app-server is not running at all', async () => {
    expect(await codexThreadExistsAt(path.join(dir, 'nope.sock'), 'thread-known', 500, 1)).toBe(
      false
    )
  })

  it('waits out a daemon whose socket is still binding, instead of refusing a good resume', async () => {
    // `codex app-server daemon start` exiting 0 does not mean the socket is listening yet, and
    // this check runs immediately after it on the cold/reboot path. Without the retry, a daemon
    // that binds a beat late turns a legitimate resume into `thread-bind-refused` → plain codex:
    // a NEW way to lose shared identity on exactly the path the feature exists for.
    const latePath = path.join(dir, 'lt.sock')
    const late = http.createServer()
    const lateWss = new WebSocketServer({ server: late })
    lateWss.on('connection', handle)
    const listening = new Promise<void>((resolve) =>
      setTimeout(() => late.listen(latePath, resolve), 250)
    )
    try {
      expect(await codexThreadExistsAt(latePath, 'thread-known', 500)).toBe(true)
    } finally {
      await listening
      await new Promise<void>((resolve) => lateWss.close(() => resolve()))
      await new Promise<void>((resolve) => late.close(() => resolve()))
    }
  })

  it('does NOT retry a server that answered — "I do not have it" is an answer', async () => {
    // Retrying a definite no just delays it. Measured by the clock: three attempts with the
    // default 200ms gap could not come back this fast.
    const started = Date.now()
    expect(await codexThreadExistsAt(sock, 'thread-from-a-past-life')).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('refuses an id that is not shaped like one, without opening a socket', async () => {
    expect(await codexThreadExistsAt(sock, '../../etc/passwd')).toBe(false)
  })

  it('refuses when the server will not initialize (a logged-out CLI)', async () => {
    initializeFails = true
    try {
      expect(await codexThreadExistsAt(sock, 'thread-known')).toBe(false)
    } finally {
      initializeFails = false
    }
  })
})

describe('waitForCodexAppServer', () => {
  it('answers true for a live socket and false for a dead one, without throwing', async () => {
    expect(await waitForCodexAppServer(sock, 1)).toBe(true)
    expect(await waitForCodexAppServer(path.join(dir, 'nope.sock'), 2, 10)).toBe(false)
  })
})

describe('readCodexSessionNameAt', () => {
  it("reads the thread's own name", async () => {
    expect(await readCodexSessionNameAt(sock, 'thread-known')).toBe('Named by codex')
  })

  it('answers null for a nameless or unknown thread, and for a dead server', async () => {
    // Null means "the node keeps its own title" — never a wrong one.
    expect(await readCodexSessionNameAt(sock, 'thread-nameless')).toBeNull()
    expect(await readCodexSessionNameAt(sock, 'thread-from-a-past-life')).toBeNull()
    expect(await readCodexSessionNameAt(path.join(dir, 'nope.sock'), 'thread-known', 500)).toBeNull()
  })
})

describe('codexUnixWebSocketUrl', () => {
  it('refuses a socket path that could not survive being put in a URL', () => {
    expect(() => codexUnixWebSocketUrl('relative/app-server.sock')).toThrow()
    expect(() => codexUnixWebSocketUrl('/tmp/with space/app.sock')).toThrow()
    expect(() => codexUnixWebSocketUrl('/tmp/a?b/app.sock')).toThrow()
  })
})
