// Local admin channel for the hosted team: a unix socket at <dataDir>/relay/admin.sock, mode 0600
// in a 0700 directory, speaking one JSON line each way. Filesystem permissions ARE the gate — there
// is no token, so nothing to leak into a pane's environment. Any process running as this unix user
// can reach it, which is exactly who could already read host-key.json: SSH access as the core's user
// is the root of trust. (The 0700 directory is the real gate; the socket's own 0600 is belt and
// braces, since the socket exists at the process umask for the instant between bind and chmod.)
//
// Unix sockets are POSIX. The Server Edition targets Linux; on Windows both ends refuse by name
// rather than failing with an obscure error (the platform rule: degrade explicitly, never silently).
//
// With no hosted team on this server, the channel serves `init`, `status` and `info` only: every
// other verb would create team state (a team.json, a host key) on a server that never asked to host.
import net from 'node:net'
import path from 'node:path'
import { chmodSync, lstatSync, rmSync } from 'node:fs'
import { ensurePrivateDir } from './private-dir'
import { TeamStore, TEAM_LABEL_MAX, TEAM_PROJECT_ID_MAX } from './team-store'
import { loadHostKey } from './host-key'
import { publicKeyFromB64, publicKeyToB64 } from './e2ee'
import type {
  HostedInfo,
  HostedRotateResult,
  HostedService,
  HostedStartResult,
  HostedStatus
} from './hosted-service'

export type AdminRequest =
  | { cmd: 'init' }
  | { cmd: 'add-owner'; pubkey: string; label: string }
  | { cmd: 'remove'; pubkey: string; force?: boolean }
  | { cmd: 'info' }
  | { cmd: 'status' }
  | { cmd: 'share'; projectId: string; on: boolean }
  | { cmd: 'rotate-key' }
export type AdminReply = { ok: true; result: unknown } | { ok: false; error: string }

/** `init`'s answer. The address and join code are present only when hosting is running. */
export interface AdminInitResult {
  created: boolean
  start: HostedStartResult
  info: HostedInfo | null
  joinCode: string | null
}
/** `info`'s answer. `info` can be non-null while `enabled` is false (a key rotated while hosting
 *  was off): that address answers nobody until hosting starts. */
export interface AdminInfoResult {
  enabled: boolean
  info: HostedInfo | null
  joinCode: string | null
}
/** `rotate-key`'s answer. The new address and join code are present only when hosting restarted. */
export interface AdminRotateResult {
  result: HostedRotateResult
  info: HostedInfo | null
  joinCode: string | null
}
/** Why hosting is off, read from the relay directory at the moment `status` asked. */
export type HostingOff =
  | { reason: 'no-team' }
  | { reason: 'no-host-key' }
  | { reason: 'host-key-unreadable'; detail: string }
  | { reason: 'stopped' }
/** `status`'s answer: the service's own status, plus the reason when hosting is off. */
export interface AdminStatusResult extends HostedStatus {
  off: HostingOff | null
}

/** The longest request line the server reads. A request is a few hundred bytes. */
export const ADMIN_REQUEST_MAX = 64 * 1024
/** A connection that has not sent its request line by then is dropped. */
const REQUEST_IDLE_MS = 10_000
/** How long the CLI waits for an answer. `init` and `rotate-key` do local file work only. */
const CALL_TIMEOUT_MS = 30_000
/** How long probing an existing socket may take before it is treated as "cannot tell". */
const PROBE_TIMEOUT_MS = 2_000
/** A `remove` key is compared, never decoded: bound it only so a line cannot be all key. */
const REMOVE_KEY_MAX = 256

const NO_TEAM = 'There is no hosted team on this server yet. Run `team init` first.'

/** Something may already be serving this admin socket: another server answered on it, or it could
 *  not be told apart from one. Typed, because the caller's answer differs from every other admin
 *  failure: a second server on the same data dir must not ALSO host the team on the same host key. */
export class AdminSocketBusyError extends Error {
  readonly code = 'E_ADMIN_SOCKET_BUSY'
  constructor(message: string) {
    super(message)
    this.name = 'AdminSocketBusyError'
  }
}

export function adminSocketPath(dataDir: string): string {
  return path.join(relayDirOf(dataDir), 'admin.sock')
}
const relayDirOf = (dataDir: string): string => path.join(dataDir, 'relay')

/**
 * Why `sock` cannot be a unix socket path here, or null. `sun_path` is 108 bytes on Linux and 104 on
 * the BSDs (macOS included), one of them the terminating NUL. Measured on Linux (Node 22): a longer
 * path is TRUNCATED silently — the socket file lands under a shorter name, so the chmod that follows
 * fails with an ENOENT that says nothing about length. Hence the explicit check, on both ends.
 */
export function socketPathProblem(sock: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    return 'The team admin channel is a unix socket, which is not available on Windows. Run the Server Edition on Linux.'
  }
  const max = platform === 'linux' || platform === 'android' ? 107 : 103
  const bytes = Buffer.byteLength(sock)
  if (bytes <= max) return null
  return (
    `The team admin socket path is ${bytes} bytes long; a unix socket path may be at most ${max}. ` +
    `Use a shorter data directory (--data-dir / NODETERM_DATA_DIR): ${sock}`
  )
}

// ---- validation (one definition: the CLI refuses a typo before the socket, the server refuses it again)

/** Why `key` is not a device key a peer could ever present, or null. A key is compared as a STRING
 *  against the canonical base64 the relay handshake reports, so a key that merely decodes to 32 bytes
 *  (missing padding, stray whitespace — Node's base64 decoder skips both) would be written to the
 *  team and never match anyone. */
export function ownerKeyProblem(key: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = publicKeyFromB64(key)
  } catch {
    const got = Buffer.from(key, 'base64').length
    return (
      `That is not a device key: a device key is 32 bytes of base64 (44 characters ending in "="), ` +
      `and this decodes to ${got} bytes. Check that the whole key was copied.`
    )
  }
  if (publicKeyToB64(bytes) !== key) {
    return (
      'That is not a device key in canonical base64 form — check for a typo, a missing "=", ' +
      'spaces, or "-"/"_" in place of "+"/"/".'
    )
  }
  return null
}

// C0/C1 controls and DEL (\p{Cc}), plus the text-direction controls that let a label reorder the
// text around it when printed in a terminal. Written as \u escapes, never as the characters
// themselves: a raw bidi control in source is invisible in review (Trojan Source).
export const CONTROL_RE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u

/** Why `label` cannot be a member label, or null. The same limit `team.json`'s reader enforces. */
export function ownerLabelProblem(label: string): string | null {
  if (label.length > TEAM_LABEL_MAX) {
    return `The label is ${label.length} characters long; the limit is ${TEAM_LABEL_MAX}.`
  }
  if (CONTROL_RE.test(label)) {
    return 'The label contains a control character (a newline, tab, escape or text-direction control); use plain text.'
  }
  return null
}

/** Why `id` cannot be a shared project id, or null. The same limit `team.json`'s reader enforces. */
export function projectIdProblem(id: string): string | null {
  if (id.length === 0) return 'The project id is empty.'
  if (id.length > TEAM_PROJECT_ID_MAX) {
    return `The project id is ${id.length} characters long; the limit is ${TEAM_PROJECT_ID_MAX}.`
  }
  if (CONTROL_RE.test(id)) return 'The project id contains a control character.'
  return null
}

/** A well-formed request, or the reason it is not. The server's own check: the CLI is one client,
 *  but anything running as this user can write to the socket. */
export function parseAdminRequest(raw: unknown): AdminRequest | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'bad request: expected a JSON object'
  const o = raw as Record<string, unknown>
  switch (o.cmd) {
    case 'init':
    case 'info':
    case 'status':
    case 'rotate-key':
      return { cmd: o.cmd }
    case 'add-owner': {
      if (typeof o.pubkey !== 'string') return 'bad request: add-owner needs a pubkey string'
      if (typeof o.label !== 'string') return 'bad request: add-owner needs a label string'
      const problem = ownerKeyProblem(o.pubkey) ?? ownerLabelProblem(o.label)
      return problem ?? { cmd: 'add-owner', pubkey: o.pubkey, label: o.label }
    }
    case 'remove': {
      if (typeof o.pubkey !== 'string' || o.pubkey.length === 0 || o.pubkey.length > REMOVE_KEY_MAX) {
        return 'bad request: remove needs a pubkey string'
      }
      if (o.force !== undefined && typeof o.force !== 'boolean') return 'bad request: remove force must be a boolean'
      return o.force === undefined ? { cmd: 'remove', pubkey: o.pubkey } : { cmd: 'remove', pubkey: o.pubkey, force: o.force }
    }
    case 'share': {
      if (typeof o.projectId !== 'string') return 'bad request: share needs a projectId string'
      if (typeof o.on !== 'boolean') return 'bad request: share needs on (a boolean)'
      return projectIdProblem(o.projectId) ?? { cmd: 'share', projectId: o.projectId, on: o.on }
    }
    default:
      return `bad request: unknown command ${JSON.stringify(typeof o.cmd === 'string' ? o.cmd.slice(0, 40) : o.cmd)}`
  }
}

// ---- handling

type KeyState = 'absent' | 'present' | { unreadable: string }

async function hostKeyState(relayDir: string): Promise<KeyState> {
  try {
    return (await loadHostKey(relayDir)) === null ? 'absent' : 'present'
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) }
  }
}

/** Has a hosted team been set up on this server? A running service, a team.json, or a host key in
 *  any state (an unreadable key must still be rotatable — its own error message says to). A
 *  team.json set aside as corrupt while hosting runs is still a team: the recovery is `add-owner`. */
async function teamIsSetUp(relayDir: string, svc: HostedService): Promise<boolean> {
  if (svc.status().enabled) return true
  if (new TeamStore(relayDir).exists()) return true
  return (await hostKeyState(relayDir)) !== 'absent'
}

async function offReason(relayDir: string): Promise<HostingOff> {
  const key = await hostKeyState(relayDir)
  if (typeof key === 'object') return { reason: 'host-key-unreadable', detail: key.unreadable }
  if (!new TeamStore(relayDir).exists()) return { reason: 'no-team' }
  if (key === 'absent') return { reason: 'no-host-key' }
  return { reason: 'stopped' }
}

const ok = (result: unknown): AdminReply => ({ ok: true, result })
const fail = (error: string): AdminReply => ({ ok: false, error })

/** The address teammates need — only while hosting actually runs. */
const address = (svc: HostedService, running: boolean): { info: HostedInfo | null; joinCode: string | null } =>
  running ? { info: svc.info(), joinCode: svc.joinCode() } : { info: null, joinCode: null }

const SHUTTING_DOWN = 'The nodeterm server is shutting down.'

async function handle(
  relayDir: string,
  svc: HostedService,
  req: AdminRequest,
  closing: () => boolean
): Promise<AdminReply> {
  if (req.cmd !== 'init' && req.cmd !== 'status' && req.cmd !== 'info' && !(await teamIsSetUp(relayDir, svc))) {
    return fail(NO_TEAM)
  }
  switch (req.cmd) {
    case 'init': {
      const { created } = await svc.init()
      // The admin closes BEFORE the server stops hosting. A `start()` issued after that stop would
      // bring a scheduler up on a server that is going away, so an init still inside `svc.init()`
      // when close() began does not start hosting.
      if (closing()) {
        return fail(`${SHUTTING_DOWN} ${created ? 'The team was created but hosting was not started.' : 'Hosting was not started.'}`)
      }
      const start = await svc.start()
      const result: AdminInitResult = { created, start, ...address(svc, start === 'started') }
      return ok(result)
    }
    case 'add-owner':
      await svc.addOwner(req.pubkey, req.label)
      return ok(null)
    case 'remove': {
      const r = await svc.remove(req.pubkey, !!req.force)
      if (r === 'last-owner') return fail('That is the last owner. Add another owner first, or pass --force.')
      if (r === 'unknown') return fail('No team member has that key.')
      return ok(null)
    }
    case 'info': {
      const result: AdminInfoResult = { enabled: svc.status().enabled, info: svc.info(), joinCode: svc.joinCode() }
      return ok(result)
    }
    case 'status': {
      const s = svc.status()
      const result: AdminStatusResult = { ...s, off: s.enabled ? null : await offReason(relayDir) }
      return ok(result)
    }
    case 'share':
      await svc.share(req.projectId, req.on)
      return ok(null)
    case 'rotate-key': {
      const r = await svc.rotateKey()
      const result: AdminRotateResult = { result: r, ...address(svc, r === 'started') }
      return ok(result)
    }
  }
}

async function answer(relayDir: string, svc: HostedService, line: string, closing: () => boolean): Promise<AdminReply> {
  if (closing()) return fail(SHUTTING_DOWN)
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return fail('bad request: not JSON')
  }
  const req = parseAdminRequest(raw)
  if (typeof req === 'string') return fail(req)
  try {
    return await handle(relayDir, svc, req, closing)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

// ---- the server

/**
 * Clear the way for a fresh bind: nothing there is fine, a socket nobody answers on (a crashed run)
 * is removed. A socket that ANSWERS belongs to a live server sharing this data dir, and anything that
 * is not a socket is not ours — both are refused, never removed. Only a refused connection proves a
 * socket dead; a timeout or any other error is "cannot tell", which also refuses.
 */
async function clearStaleSocket(sock: string): Promise<void> {
  let isSocket: boolean
  try {
    isSocket = lstatSync(sock).isSocket()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (!isSocket) throw new Error(`${sock} exists and is not a socket; refusing to remove it.`)
  const verdict = await new Promise<'live' | 'dead' | string>((resolve) => {
    const c = net.connect(sock)
    const timer = setTimeout(() => {
      c.destroy()
      resolve('no answer in time')
    }, PROBE_TIMEOUT_MS)
    c.once('connect', () => {
      clearTimeout(timer)
      c.destroy()
      resolve('live')
    })
    c.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(err.code === 'ECONNREFUSED' ? 'dead' : (err.code ?? err.message))
    })
  })
  if (verdict === 'dead') {
    rmSync(sock, { force: true })
    return
  }
  if (verdict === 'live') {
    throw new AdminSocketBusyError(
      `Another nodeterm server is already answering on ${sock} (two servers sharing one data directory?). Not replacing it.`
    )
  }
  throw new AdminSocketBusyError(`Could not tell whether ${sock} is still in use (${verdict}); not replacing it.`)
}

export async function startTeamAdmin(dataDir: string, svc: HostedService): Promise<{ close(): Promise<void> }> {
  const sock = adminSocketPath(dataDir)
  const problem = socketPathProblem(sock)
  if (problem) throw new Error(problem)
  const relayDir = relayDirOf(dataDir)
  ensurePrivateDir(relayDir)
  await clearStaleSocket(sock)

  const conns = new Set<net.Socket>()
  let closing: Promise<void> | null = null
  const isClosing = (): boolean => closing !== null
  const server = net.createServer((c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
    c.on('error', () => {}) // the peer went away; nothing to tell it
    c.setEncoding('utf8')
    c.setTimeout(REQUEST_IDLE_MS, () => c.destroy())
    let buf = ''
    let taken = false
    c.on('data', (d: string) => {
      if (taken) return
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0 ? buf.length > ADMIN_REQUEST_MAX : nl > ADMIN_REQUEST_MAX) {
        taken = true
        c.destroy()
        return
      }
      if (nl < 0) return
      taken = true
      c.setTimeout(0)
      void answer(relayDir, svc, buf.slice(0, nl), isClosing).then((reply) => {
        if (!c.destroyed) c.end(JSON.stringify(reply) + '\n')
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    const fail = (err: NodeJS.ErrnoException): void => {
      // Two servers starting on one data dir both find no socket in `clearStaleSocket`, and the
      // second bind meets the first one's socket. That is the same verdict as a live socket found
      // there: busy, so the caller does not host (two hosts on one key would both mint and both
      // write team.json). Anything else stays the error it is.
      reject(
        err.code === 'EADDRINUSE'
          ? new AdminSocketBusyError(`Another nodeterm server is already listening on ${sock} (two servers sharing one data directory?).`)
          : err
      )
    }
    server.once('error', fail)
    server.listen(sock, () => {
      server.off('error', fail)
      resolve()
    })
  })
  try {
    chmodSync(sock, 0o600)
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw err
  }

  return {
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          // Node unlinks the socket file itself on close; this covers a platform that does not.
          rmSync(sock, { force: true })
          resolve()
        })
        // An idle or slow connection would otherwise hold close() open.
        for (const c of conns) c.destroy()
      }))
  }
}

// ---- the client

function connectErrorMessage(err: NodeJS.ErrnoException, sock: string): string {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    return (
      `The nodeterm server is not running (no admin socket at ${sock}). Start the service first. ` +
      `If it runs with a different data directory, pass --data-dir <dir> (or set NODETERM_DATA_DIR); ` +
      `a server from before this version has no admin socket and needs a restart after updating.`
    )
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return `Permission denied on ${sock}. Run \`team\` as the unix user the nodeterm server runs as.`
  }
  return `Could not reach the nodeterm server at ${sock}: ${err.code ?? err.message}.`
}

function parseReply(line: string): AdminReply {
  try {
    const r = JSON.parse(line) as Record<string, unknown> | null
    if (r && r.ok === true && 'result' in r) return { ok: true, result: r.result }
    if (r && r.ok === false && typeof r.error === 'string') return { ok: false, error: r.error }
  } catch {
    // fall through
  }
  return fail('The nodeterm server sent a reply this CLI does not understand (is the server a different version?).')
}

export function callTeamAdmin(dataDir: string, req: AdminRequest): Promise<AdminReply> {
  const sock = adminSocketPath(dataDir)
  const problem = socketPathProblem(sock)
  if (problem) return Promise.resolve(fail(problem))
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    const c = net.connect(sock)
    const timer = setTimeout(
      () => finish(fail(`The nodeterm server did not answer within ${CALL_TIMEOUT_MS / 1000} s (${sock}).`)),
      CALL_TIMEOUT_MS
    )
    function finish(r: AdminReply): void {
      if (done) return
      done = true
      clearTimeout(timer)
      c.destroy()
      resolve(r)
    }
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'))
    c.on('data', (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) finish(parseReply(buf.slice(0, nl)))
      else if (buf.length > ADMIN_REQUEST_MAX) finish(parseReply(''))
    })
    c.on('end', () =>
      finish(buf.trim() ? parseReply(buf) : fail('The nodeterm server closed the connection without answering.'))
    )
    c.on('error', (err: NodeJS.ErrnoException) => finish(fail(connectErrorMessage(err, sock))))
  })
}
