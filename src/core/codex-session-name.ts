/**
 * The desktop's client for the ONE shared `codex app-server`.
 *
 * Two jobs, both of which the sh launcher cannot do itself:
 *  - `startCodexThreadAt` — mint the thread a fresh Codex node will own.
 *  - `readCodexSessionName` — the READ leg of codex's session name (`TITLE_READ_CAPABLE`).
 *
 * The name lives in the app-server's `Thread.name`, not in a file on disk, so this is the only
 * place it can be read from. There is no WRITE leg: codex has no rename command NodeTerm can
 * drive, which is exactly the gemini situation `TITLE_READ_CAPABLE` was split out for.
 *
 * Everything here fails to `null`/reject rather than throwing into a caller's poll loop: a name we
 * cannot read means the node keeps its own title, and a thread we cannot start means the launcher
 * falls back to plain codex.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { WebSocket } from 'ws'
// Minting a thread is a multi-step conversation with a typically COLD server, so it needs a real
// budget — and the hook route serving it must raise its socket guard to match (handleCodexThread).
// Shared with the launcher's client budget so the two cannot drift apart.
// `isSafeThreadId` comes from the same module, and deliberately: this file used to keep its own
// copy of the bare charset, which accepted `.` and `..` — harmless over the RPC wire here, but the
// ids it validates (a thread the app-server just minted, one a node persisted) are handed straight
// to the record store, where they ARE path segments. One rule, so the two cannot drift apart.
import { CODEX_THREAD_START_TIMEOUT_MS, isSafeThreadId } from './codex-identity-proxy'

/**
 * `codex app-server daemon start` exiting 0 does NOT mean its control socket is accepting
 * connections yet — the daemon binds a beat later. Everything here runs immediately after that
 * command, on the cold/reboot path this feature exists for, so a single failed connect must not be
 * read as an answer. Three tries over ~600 ms: long enough for a daemon that is coming up, short
 * enough that a daemon that is not there costs nothing worth noticing.
 */
const SOCKET_WAIT_ATTEMPTS = 3
const SOCKET_WAIT_MS = 200

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/** Resolve once the app-server's socket accepts a connection, or after the attempts run out. */
export function waitForCodexAppServer(
  socketPath: string,
  attempts = SOCKET_WAIT_ATTEMPTS,
  gapMs = SOCKET_WAIT_MS
): Promise<boolean> {
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      let ws: WebSocket
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* the connection may never have opened */
        }
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS)
      timer.unref?.()
      try {
        ws = connectCodexAppServer(socketPath)
      } catch {
        clearTimeout(timer)
        resolve(false)
        return
      }
      ws.once('open', () => finish(true))
      ws.once('error', () => finish(false))
      ws.once('close', () => finish(false))
    })
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      if (await tryOnce()) return true
      if (i < attempts - 1) await delay(gapMs)
    }
    return false
  })()
}
const CACHE_MS = 3_000
const REQUEST_TIMEOUT_MS = 2_000

const names = new Map<string, { name: string | null; at: number }>()
const inflight = new Map<string, Promise<string | null>>()

/** The app-server's control socket, under the CLI's own `CODEX_HOME` (default `~/.codex`). */
export function defaultCodexAppServerSocket(): string {
  const configured = process.env.CODEX_HOME
  const codexHome =
    configured && path.isAbsolute(configured) ? configured : path.join(homedir(), '.codex')
  return path.join(codexHome, 'app-server-control', 'app-server-control.sock')
}

export function codexUnixWebSocketUrl(socketPath: string): string {
  if (!path.isAbsolute(socketPath) || /[\s:%?#]/.test(socketPath)) {
    throw new Error('Unsupported Codex app-server socket path')
  }
  return `ws+unix://${socketPath}:/rpc`
}

function connectCodexAppServer(socketPath: string): WebSocket {
  return new WebSocket(codexUnixWebSocketUrl(socketPath), { perMessageDeflate: false })
}

export interface CodexThreadSnapshot {
  id: string
  name?: string | null
  status?: { type?: unknown; activeFlags?: unknown }
  updatedAt?: number
}

/** One read-only `thread/read` request, shared by title and status consumers. */
export function readCodexThreadAt(
  socketPath: string,
  threadId: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<CodexThreadSnapshot | null> {
  if (!isSafeThreadId(threadId)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket
    const finish = (thread: CodexThreadSnapshot | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      resolve(thread)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm', version: '1' } }
        })
      )
    })
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish(null)
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(
          JSON.stringify({
            id: 2,
            method: 'thread/read',
            params: { threadId, includeTurns: false }
          })
        )
      } else if (message.id === 2) {
        const thread = message.result?.thread
        finish(
          !message.error && thread && thread.id === threadId
            ? (thread as CodexThreadSnapshot)
            : null
        )
      }
    })
    ws.once('error', () => finish(null))
    ws.once('close', () => finish(null))
  })
}

export async function readCodexSessionNameAt(
  socketPath: string,
  threadId: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  const thread = await readCodexThreadAt(socketPath, threadId, timeoutMs)
  const name = thread?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * Does the shared app-server actually know this thread?
 *
 * The bind route writes a record claiming a node owns a conversation. Without this check ANY
 * id the caller hands us binds happily — a stale session id, or one persisted from a
 * plain-codex-era session that the app-server has never heard of — and the launcher then execs
 * `codex --remote unix:// resume <id>`, which dies with "no rollout found" AFTER exec, where
 * there is no fallback left. Asking first turns that dead node into an ordinary fallback.
 *
 * A server we cannot reach answers `false`, which is the safe direction here: refusing costs a
 * plain codex session, accepting costs the node.
 */
function probeCodexThread(
  socketPath: string,
  threadId: string,
  timeoutMs: number
): Promise<'yes' | 'no' | 'unreachable'> {
  return new Promise((resolve) => {
    let settled = false
    let answered = false
    let ws: WebSocket
    const finish = (result: 'yes' | 'no' | 'unreachable'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish(answered ? 'no' : 'unreachable'), timeoutMs)
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      resolve('unreachable')
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm', version: '1' } }
        })
      )
    })
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        answered = true
        // A server that will not initialize is a definite NO, not a transient one: retrying a
        // logged-out CLI just delays the same answer.
        if (message.error) return finish('no')
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(
          JSON.stringify({ id: 2, method: 'thread/read', params: { threadId, includeTurns: false } })
        )
      } else if (message.id === 2) {
        // The id must come back UNCHANGED: a server that answers with some other thread has not
        // confirmed the one we asked about.
        finish(!message.error && message.result?.thread?.id === threadId ? 'yes' : 'no')
      }
    })
    ws.once('error', () => finish(answered ? 'no' : 'unreachable'))
    ws.once('close', () => finish(answered ? 'no' : 'unreachable'))
  })
}

/**
 * Does the shared app-server actually know this thread?
 *
 * The bind route writes a record claiming a node owns a conversation. Without this check ANY
 * id the caller hands us binds happily — a stale session id, or one persisted from a
 * plain-codex-era session that the app-server has never heard of — and the launcher then execs
 * `codex --remote unix:// resume <id>`, which dies with "no rollout found" AFTER exec, where
 * there is no fallback left. Asking first turns that dead node into an ordinary fallback.
 *
 * A server we could not REACH is retried (the daemon may still be binding its socket — see
 * SOCKET_WAIT_ATTEMPTS), because this check runs on the cold path and a not-yet-listening daemon
 * would otherwise turn a perfectly good resume into a fallback. A server that ANSWERED is never
 * retried: "I do not have that thread" is an answer, and asking again just delays it.
 *
 * Out of retries, the answer is `false` — the safe direction: refusing costs a plain codex
 * session, accepting costs the node.
 */
export async function codexThreadExistsAt(
  socketPath: string,
  threadId: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  attempts = SOCKET_WAIT_ATTEMPTS,
  gapMs = SOCKET_WAIT_MS
): Promise<boolean> {
  if (!isSafeThreadId(threadId)) return false
  for (let i = 0; i < attempts; i++) {
    const result = await probeCodexThread(socketPath, threadId, timeoutMs)
    if (result !== 'unreachable') return result === 'yes'
    if (i < attempts - 1) await delay(gapMs)
  }
  return false
}

export function codexThreadExists(threadId: string): Promise<boolean> {
  return codexThreadExistsAt(defaultCodexAppServerSocket(), threadId)
}

/**
 * Create one new, immediately RESUMABLE thread on the shared app-server and return its id.
 *
 * `thread/start` alone only creates app-server metadata: it deliberately does not materialize the
 * rollout file, and a second client's `thread/resume` then fails with "no rollout found" — which
 * is precisely what the launcher does one line later. So the rollout is materialized by running
 * one empty turn, interrupting it the moment the server announces it, forking immediately BEFORE
 * that turn, and deleting the seed. The result is a thread with zero user turns and a valid
 * rollout, without the deprecated rollback API.
 */
export async function startCodexThreadAt(
  socketPath: string,
  cwd: string,
  timeoutMs = CODEX_THREAD_START_TIMEOUT_MS
): Promise<string> {
  // Same cold-socket window as the bind check: `daemon start` has exited, the socket may still be
  // binding. Bounded (~600 ms) and charged against the 20 s budget below, which has room for it.
  await waitForCodexAppServer(socketPath)
  return startCodexThreadOnce(socketPath, cwd, timeoutMs)
}

function startCodexThreadOnce(
  socketPath: string,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  if (!path.isAbsolute(cwd) || cwd.includes('\0')) {
    return Promise.reject(new Error('Unsupported Codex thread cwd'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let ws: WebSocket
    const finish = (error: Error | null, threadId?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      if (error) reject(error)
      else resolve(threadId as string)
    }
    const timer = setTimeout(
      () => finish(new Error('Codex app-server thread start timed out')),
      timeoutMs
    )
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      reject(new Error('Codex app-server is unavailable'))
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'nodeterm', version: '1' },
            capabilities: { experimentalApi: true }
          }
        })
      )
    })
    let threadId = ''
    let bootstrapTurnId = ''
    let announcedBootstrapTurnId = ''
    let announcedCompletedTurnId = ''
    let bootstrapStarted = false
    let interruptSent = false
    let interruptAcknowledged = false
    let bootstrapCompleted = false
    let cleanupForkSent = false
    const maybeInterrupt = (): void => {
      if (!bootstrapTurnId || !bootstrapStarted || bootstrapCompleted || interruptSent) return
      interruptSent = true
      ws.send(
        JSON.stringify({
          id: 4,
          method: 'turn/interrupt',
          params: { threadId, turnId: bootstrapTurnId }
        })
      )
    }
    const maybeCreateCleanThread = (): void => {
      if (!bootstrapCompleted || cleanupForkSent) return
      if (interruptSent && !interruptAcknowledged) return
      cleanupForkSent = true
      ws.send(
        JSON.stringify({
          id: 5,
          method: 'thread/fork',
          params: { threadId, beforeTurnId: bootstrapTurnId, cwd, ephemeral: false }
        })
      )
    }
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error('Codex app-server initialization failed'))
          return
        }
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(JSON.stringify({ id: 2, method: 'thread/start', params: { cwd } }))
      } else if (message.id === 2) {
        const startedThreadId = message.result?.thread?.id
        if (
          message.error ||
          typeof startedThreadId !== 'string' ||
          !isSafeThreadId(startedThreadId)
        ) {
          finish(new Error('Codex app-server returned no valid thread identity'))
          return
        }
        threadId = startedThreadId
        ws.send(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId, input: [] } }))
      } else if (message.id === 3) {
        const turnId = message.result?.turn?.id
        if (message.error || typeof turnId !== 'string' || !isSafeThreadId(turnId)) {
          finish(new Error('Codex app-server could not materialize the new thread'))
          return
        }
        bootstrapTurnId = turnId
        if (announcedBootstrapTurnId === turnId) bootstrapStarted = true
        if (announcedCompletedTurnId === turnId) bootstrapCompleted = true
        maybeInterrupt()
        maybeCreateCleanThread()
      } else if (message.method === 'turn/started') {
        const turnId = message.params?.turn?.id
        if (typeof turnId === 'string') {
          announcedBootstrapTurnId = turnId
          if (turnId === bootstrapTurnId) {
            bootstrapStarted = true
            maybeInterrupt()
          }
        }
      } else if (message.id === 4) {
        if (message.error) {
          finish(new Error('Codex app-server could not interrupt thread materialization'))
          return
        }
        interruptAcknowledged = true
        maybeCreateCleanThread()
      } else if (message.method === 'turn/completed') {
        const turnId = message.params?.turn?.id
        if (typeof turnId === 'string') {
          announcedCompletedTurnId = turnId
          if (turnId === bootstrapTurnId) {
            bootstrapCompleted = true
            maybeCreateCleanThread()
          }
        }
      } else if (message.id === 5) {
        const readyThreadId = message.result?.thread?.id
        if (
          message.error ||
          typeof readyThreadId !== 'string' ||
          !isSafeThreadId(readyThreadId)
        ) {
          finish(new Error('Codex app-server could not clean up thread materialization'))
          return
        }
        const seedThreadId = threadId
        threadId = readyThreadId
        ws.send(JSON.stringify({ id: 6, method: 'thread/delete', params: { threadId: seedThreadId } }))
      } else if (message.id === 6) {
        if (message.error) {
          finish(new Error('Codex app-server could not remove thread materialization seed'))
          return
        }
        finish(null, threadId)
      }
    })
    ws.once('error', () => finish(new Error('Codex app-server is unavailable')))
    ws.once('close', () => finish(new Error('Codex app-server closed before thread start')))
  })
}

export function startCodexThread(cwd: string): Promise<string> {
  return startCodexThreadAt(defaultCodexAppServerSocket(), cwd)
}

/**
 * The relay's on-disk fallback for a session name the shared app-server no longer reports.
 *
 * A native in-TUI `/resume` can fork a cloud conversation into a local app-server thread whose
 * `Thread.name` is `null`; the persistent relay observed the source id at bind time and copied its
 * `session_index` title to `~/.nodeterm/codex-thread-names/<sha256(socket)[..16]>/<threadId>` (the
 * exact path the relay daemon's `nameFile` writes — one definition, kept in step). Read as DATA and
 * capped; a later real `Thread.name` from the server always wins. Fails to `null`.
 */
export function relayedCodexSessionName(
  socketPath: string,
  threadId: string,
  home = homedir()
): string | null {
  if (!isSafeThreadId(threadId)) return null
  try {
    const scope = createHash('sha256').update(socketPath).digest('hex').slice(0, 16)
    const value = readFileSync(
      path.join(home, '.nodeterm', 'codex-thread-names', scope, threadId),
      'utf8'
    ).trim()
    return value ? value.slice(0, 500) : null
  } catch {
    return null
  }
}

/** Seed the in-process name cache from a name observed elsewhere (e.g. a relay bind), so the next
 * sweep serves it without a socket round-trip. A blank name caches an explicit `null`. */
export function rememberCodexSessionName(
  threadId: string,
  name: unknown,
  socketPath = defaultCodexAppServerSocket()
): void {
  if (!isSafeThreadId(threadId)) return
  const value = typeof name === 'string' && name.trim() ? name.trim() : null
  names.set(`${socketPath}\0${threadId}`, { name: value, at: Date.now() })
}

/** Read a thread's full identity from an app-server socket: its id (must come back UNCHANGED), name,
 * and absolute rollout path. Used by the cross-account switch to locate a foreign rollout. Distinct
 * from `readCodexThreadAt` (which exposes runtime `status` for agent-status recovery): this one
 * resolves the on-disk rollout `path` the account switch follows. Fails to `null` rather than
 * throwing into a poll loop. */
export function readCodexThreadRollout(
  socketPath: string,
  threadId: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ id: string; name: string | null; path: string | null } | null> {
  if (!isSafeThreadId(threadId)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket
    const finish = (value: { id: string; name: string | null; path: string | null } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm', version: '1' } }
        })
      )
    })
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish(null)
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(
          JSON.stringify({ id: 2, method: 'thread/read', params: { threadId, includeTurns: false } })
        )
      } else if (message.id === 2) {
        const thread = message.result?.thread
        if (message.error || typeof thread?.id !== 'string' || thread.id !== threadId) {
          finish(null)
          return
        }
        finish({
          id: thread.id,
          name: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : null,
          path: typeof thread.path === 'string' && path.isAbsolute(thread.path) ? thread.path : null
        })
      }
    })
    ws.once('error', () => finish(null))
    ws.once('close', () => finish(null))
  })
}

/** Read the logged-in account's email from an app-server socket (`account/read`). Fails to `null`. */
export function readCodexAccountAt(
  socketPath: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ email: string | null } | null> {
  return new Promise((resolve) => {
    let settled = false
    let ws: WebSocket
    const finish = (value: { email: string | null } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* the connection may never have opened */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    try {
      ws = connectCodexAppServer(socketPath)
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm', version: '1' } }
        })
      )
    })
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish(null)
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(JSON.stringify({ id: 2, method: 'account/read', params: {} }))
      } else if (message.id === 2) {
        const account = message.result?.account
        const email =
          typeof account?.email === 'string' && account.email.trim()
            ? account.email.trim()
            : typeof message.result?.email === 'string' && message.result.email.trim()
              ? message.result.email.trim()
              : null
        finish(message.error ? null : { email })
      }
    })
    ws.once('error', () => finish(null))
    ws.once('close', () => finish(null))
  })
}

/** Drop the memoized/coalesced name state — for tests and for a relay/account-set change. */
export function forgetCodexSessionNames(): void {
  names.clear()
  inflight.clear()
}

/**
 * The READ leg for `TITLE_READ_CAPABLE`. Memoized for `CACHE_MS` and coalesced, because the
 * session-name sweep asks once a minute PER NODE and every ask is a socket connect.
 *
 * When the shared app-server reports no name, fall back to the relay's on-disk copy
 * (`relayedCodexSessionName`) so a conversation forked in the TUI still shows its title.
 */
export function readCodexSessionName(
  threadId: string,
  socketPath = defaultCodexAppServerSocket()
): Promise<string | null> {
  if (!isSafeThreadId(threadId)) return Promise.resolve(null)
  const key = `${socketPath}\0${threadId}`
  const cached = names.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.name)
  const running = inflight.get(key)
  if (running) return running
  const request = readCodexSessionNameAt(socketPath, threadId).then(
    (serverName) => {
      const name = serverName ?? relayedCodexSessionName(socketPath, threadId)
      names.set(key, { name, at: Date.now() })
      inflight.delete(key)
      return name
    },
    () => {
      inflight.delete(key)
      return null
    }
  )
  inflight.set(key, request)
  return request
}
