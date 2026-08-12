// Phone-pairing service (main process) — the host side of the nodeterm iOS "scan a QR" flow.
//
// start() mints a one-time token, opens a single-shot LAN HTTP listener on a random port, and
// returns the JSON payload (for the renderer to render as a QR) plus whether SSH looks reachable.
// The phone scans the QR, generates an Ed25519 keypair on-device, and POSTs {token, publicKey}
// to http://<host>:<pairPort>/pair. On a token match we append the key to ~/.ssh/authorized_keys
// and stop the listener. The private key never leaves the phone; the only secret in the QR is the
// single-use token.
//
// Pure bits (payload build, key validation, LAN-IPv4 pick) live in `pairing-core.ts` so they're
// unit-tested without spinning up a server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { connect as netConnect } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import {
  buildPairingPayload,
  filterAuthorizedKeys,
  isValidEd25519PublicKey,
  normalizeAuthorizedKeysLine,
  normalizeDeviceName,
  pickLanIPv4,
  readDevices,
  removeDevice,
  rewriteKeyComment,
  toPublicDevices,
  upsertDevice,
  type DeviceEntry,
  type PublicDevice,
  type RelayPairingBlock
} from './pairing-core'
import type { Settings } from '../shared/types'
import { publicKeyToB64, deriveSharedKey, encrypt, decrypt, type KeyPair } from './remote/e2ee'
import { hostIdFromPublicKeyB64 } from './remote/relay-id'
import { getDeviceId } from '../core/device-id'

const execFileAsync = promisify(execFile)

/**
 * Optional relay dependencies injected into the pairing service. When present AND phone access is
 * enabled, a successful LAN pair ALSO provisions the phone for the relay (a device token +
 * the host's relay identity), so it can reach this Mac from anywhere. Injected (not imported) so
 * `pairing-core` stays pure and this stays testable. Absent / any failure ⇒ LAN-only (the phone
 * still pairs; it just won't get relay access).
 */
export interface PairingRelayDeps {
  getSettings(): Settings
  getEntitlement(): string | null
  loadHostKeyPair(): Promise<KeyPair>
  /** The relay WebSocket endpoint advertised to the phone. */
  relayEndpoint: string
  /** The API base for the /v1/relay/device mint. */
  apiBase: string
  /** Dev gate: never hit the prod relay/API from an unpackaged build (mirrors host-service). */
  relayAllowed(): boolean
}

interface RelayDeviceResponse {
  deviceToken: string
  hostId: string
  exp: number
}

/** Mint a relay device token so a freshly-paired phone can reach this host over the relay. */
async function mintRelayDevice(
  apiBase: string,
  body: {
    entitlement: string | null
    deviceId: string
    hostPublicKeyB64: string
    label?: string
    /** The phone's previous device token, relayed from the pair request: the backend's C2
     *  proof-of-possession demands it for FREE-tier re-registration — without it every free
     *  re-pair 403'd into a silent LAN-only pairing (the desktop can never hold this token
     *  itself; only the phone can supply it). */
    priorDeviceToken?: string
  }
): Promise<RelayDeviceResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${apiBase}/v1/relay/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        body.entitlement
          ? // hostDeviceId rides the ENTITLED mint too: without it the row lands with
            // hostDev=null and the backend's same-desktop C2 allowance can never match a
            // later free re-pair from this same machine (decoded live from a reauth log).
            { ...body, hostDeviceId: getDeviceId() }
          : {
              deviceId: body.deviceId,
              hostDeviceId: getDeviceId(),
              hostPublicKeyB64: body.hostPublicKeyB64,
              label: body.label,
              priorDeviceToken: body.priorDeviceToken
            }
      ),
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => ({}))) as Partial<RelayDeviceResponse>
    if (!json.deviceToken) return null
    return { deviceToken: json.deviceToken, hostId: json.hostId ?? '', exp: json.exp ?? 0 }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compute this host's relay reachability block WITHOUT any network call (just the host key →
 * hostId), so the QR renders instantly. Returns null (LAN-only) when phone access is off or
 * blocked in dev.
 */
async function buildRelayContext(
  deps: PairingRelayDeps | undefined
): Promise<{ block: RelayPairingBlock; entitlement: string | null } | null> {
  if (!deps || !deps.relayAllowed()) return null
  if (!deps.getSettings().phoneAccessEnabled) return null
  const entitlement = deps.getEntitlement() // null on free tier → mint by deviceId
  try {
    const keys = await deps.loadHostKeyPair()
    const hostPublicKeyB64 = publicKeyToB64(keys.publicKey)
    return {
      block: {
        hostId: hostIdFromPublicKeyB64(hostPublicKeyB64),
        hostPublicKeyB64,
        relayEndpoint: deps.relayEndpoint
      },
      entitlement
    }
  } catch {
    return null
  }
}

/** How long the listener waits for the phone before giving up. 10 minutes, not 2: the QR can
 *  now be gated behind enabling Remote Login first, and a field report showed a user scanning a
 *  long-expired QR — a wider window plus the UI's explicit timeout state beats a tight one. */
const PAIR_TIMEOUT_MS = 10 * 60 * 1000
/** Probe timeout for the "is sshd listening on :22?" check. */
const SSH_PROBE_MS = 500
/** Reject oversized POST bodies (a public key line is well under this). */
const MAX_BODY_BYTES = 64 * 1024

export interface PairingStartResult {
  /** The single-line JSON to encode into the QR. */
  payload: string
  /** True when 127.0.0.1:22 accepted a connection — sshd is (probably) running. */
  sshOpen: boolean
  /** What the QR on screen will mint: 'ok' = carries a relay block, 'dev' = unpackaged build
   *  (relayAllowed() off — the QR is LAN-only regardless of the toggle), 'off' = toggle off.
   *  Known at start, so the UI can warn BESIDE the QR instead of after the pairing. */
  relayPlan: 'ok' | 'dev' | 'off'
}

/** Fired once when pairing finishes: ok=true → a key was installed, ok=false → timeout/cancel. */
export type PairingDone = {
  ok: boolean
  /** Only on ok=true: did the pairing come with a relay leg? 'off' = toggle disabled,
   *  'failed' = enabled but the mint failed (the SILENT LAN-only degrade that cost a
   *  field debugging session — surface it, never swallow it), 'dev' = unpackaged build,
   *  where relayAllowed() disables the relay regardless of the toggle — a self-builder
   *  running `npm run dev` would otherwise read 'off' while staring at an ON toggle. */
  relay?: 'ok' | 'off' | 'failed' | 'dev'
}

export interface PairingService {
  /** Begin pairing; resolves once the listener is up. `onDone` fires exactly once later. */
  start(onDone: (result: PairingDone) => void): Promise<PairingStartResult>
  /** Cancel an in-flight pairing (idempotent). Does NOT fire onDone. */
  stop(): void
  /** All paired devices (token stripped) from ~/.nodeterm/agent.json. */
  listDevices(): Promise<PublicDevice[]>
  /** Revoke a device: drop its agent.json entry AND delete its authorized_keys line. */
  revokeDevice(id: string): Promise<void>
  /** Live re-probe of sshd (127.0.0.1:22), for the Remote Login warning's auto-clear. */
  probeSsh(): Promise<boolean>
}

/** ~/.nodeterm holds the host-agent config (agent.json). Created 0700 if missing. */
const AGENT_DIR = path.join(os.homedir(), '.nodeterm')
const AGENT_JSON_PATH = path.join(AGENT_DIR, 'agent.json')
const AUTH_KEYS_PATH = path.join(os.homedir(), '.ssh', 'authorized_keys')

/** Read + parse ~/.nodeterm/agent.json; returns {} when absent or malformed. */
async function readAgentJson(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(AGENT_JSON_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Paired with `process.pid` in the temp names below: the counter makes a name unique WITHIN this
 *  process, the pid makes it unique ACROSS processes (it restarts at 0 in every new one). Same
 *  scheme as agent-status-mirror's local write (src/core/agent-status-mirror.ts). */
let writeSeq = 0

/**
 * Remove agent.json temps no writer in THIS process owns: the legacy fixed `agent.json.tmp`
 * (written by builds from before per-call names) and any `agent.json.<pid>.<seq>.tmp` whose pid is
 * not ours. Best effort — a failure here must never break (or skip) the write that follows.
 *
 * agent.json is not config: every device entry carries the `agentToken` bearer the phone presents
 * on the host-agent WebSocket, so an orphan is a live credential at 0600 that nothing will ever
 * overwrite — a unique name is never written twice. Temps bearing our own pid are untouchable: one
 * may belong to a concurrent write sitting between its `writeFile` and its `rename`, and deleting
 * it would recreate the exact race the unique names fixed. A foreign pid can in theory be the HOST
 * AGENT mid-write; ~/.nodeterm is shared with it and has no lock to begin with, and the worst case
 * is that process's rename failing cleanly (ENOENT, rethrown to its caller) instead of a forgotten
 * token file sitting on disk forever.
 */
async function sweepStaleAgentTmp(): Promise<void> {
  try {
    const base = path.basename(AGENT_JSON_PATH)
    for (const entry of await fs.readdir(AGENT_DIR)) {
      if (!entry.startsWith(base) || !entry.endsWith('.tmp')) continue
      const middle = entry.slice(base.length, -'.tmp'.length) // '' or '.<pid>.<seq>'
      const owner = /^\.(\d+)\.\d+$/.exec(middle)?.[1]
      if (middle === '' || (owner && owner !== String(process.pid))) {
        await fs.rm(path.join(AGENT_DIR, entry), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // A dir we cannot read is not a reason to fail (or skip) the write below.
  }
}

/**
 * Write agent.json atomically (0600), creating ~/.nodeterm (0700) if needed.
 *
 * The temp name is unique per call because nothing serializes the writers: `persistDevice` runs
 * when the phone POSTs its key to the open pairing listener (an inbound HTTP request) while
 * `revokeDevice` runs from a renderer IPC — independent event sources — and two rapid revokes
 * interleave with each other. With one shared `agent.json.tmp`, a writer's rename publishes the
 * other's half-written file, or moves the file out from under it so the loser's rename fails. The
 * pid covers the other direction: the host agent is a separate PROCESS writing into this same
 * ~/.nodeterm, and every process's counter starts at 0.
 */
async function writeAgentJson(obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(AGENT_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(AGENT_DIR, 0o700).catch(() => {})
  await sweepStaleAgentTmp()
  const tmp = `${AGENT_JSON_PATH}.${process.pid}.${++writeSeq}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => {})
    await fs.rename(tmp, AGENT_JSON_PATH)
  } catch (e) {
    // A unique name never self-heals the way the fixed one did (the next write just reused it), and
    // here a leaked temp IS a leaked credential: only this cleanup — or a later run's sweep above,
    // once this pid is dead — will ever collect it. The error still propagates.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  await fs.chmod(AGENT_JSON_PATH, 0o600).catch(() => {})
}

/** Persist a device into agent.json, preserving all other fields the host agent wrote. */
async function persistDevice(entry: DeviceEntry): Promise<void> {
  const obj = await readAgentJson()
  const devices = upsertDevice(readDevices(obj), entry)
  await writeAgentJson({ ...obj, devices })
}

/** Detect the machine's display name (macOS ComputerName, else hostname). */
async function computerName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', 'ComputerName'])
      const name = stdout.trim()
      if (name) return name
    } catch {
      // fall through to hostname
    }
  }
  return os.hostname()
}

/** Quick TCP probe of 127.0.0.1:22 to guess whether Remote Login (sshd) is on. */
function probeSsh(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (open: boolean): void => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        // ignore
      }
      resolve(open)
    }
    const sock = netConnect({ host: '127.0.0.1', port: 22 })
    sock.setTimeout(SSH_PROBE_MS)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * Append an already-normalized public-key line to ~/.ssh/authorized_keys with the right
 * permissions. The caller stamps the attributable `nodeterm-ios-<deviceId>` comment via
 * `rewriteKeyComment` before this point.
 */
async function appendAuthorizedKey(keyLine: string): Promise<void> {
  const sshDir = path.join(os.homedir(), '.ssh')
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 })
  await fs.chmod(sshDir, 0o700).catch(() => {})
  // Guard against a file that doesn't end in a newline (would concatenate onto the last key).
  let prefix = ''
  try {
    const existing = await fs.readFile(AUTH_KEYS_PATH, 'utf8')
    if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n'
  } catch {
    // no file yet — appendFile creates it
  }
  await fs.appendFile(AUTH_KEYS_PATH, prefix + normalizeAuthorizedKeysLine(keyLine) + '\n')
  await fs.chmod(AUTH_KEYS_PATH, 0o600)
}

/**
 * Delete every authorized_keys line stamped for `deviceId`, rewriting the file atomically (0600).
 *
 * Unique temp name for the same reason as writeAgentJson: two `revokeDevice` calls from the
 * renderer IPC overlap with nothing serializing them, and a shared `authorized_keys.tmp` lets one
 * writer's rename publish the other's half-written key file — a spliced line is a key sshd rejects,
 * i.e. the keys that were supposed to SURVIVE the revoke stop working — or steal the tmp so the
 * loser's rename fails. No orphan sweep here (unlike agent.json above): these are PUBLIC keys, so a
 * stray temp is litter rather than a credential.
 */
async function removeAuthorizedKeysForDevice(deviceId: string): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(AUTH_KEYS_PATH, 'utf8')
  } catch {
    return // no file → nothing to revoke
  }
  const next = filterAuthorizedKeys(content, deviceId)
  if (next === content) return
  const tmp = `${AUTH_KEYS_PATH}.${process.pid}.${++writeSeq}.tmp`
  try {
    await fs.writeFile(tmp, next, { mode: 0o600 })
    await fs.chmod(tmp, 0o600).catch(() => {})
    await fs.rename(tmp, AUTH_KEYS_PATH)
  } catch (e) {
    // A unique name never self-heals the way the fixed one did (the next write just reused it), so
    // a failed write has to remove its own temp — otherwise every failed revoke leaves another
    // orphan copy of the user's key file in ~/.ssh forever. The error still propagates.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  await fs.chmod(AUTH_KEYS_PATH, 0o600).catch(() => {})
}

/** Read the whole request body (capped), rejecting oversized payloads. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createPairingService(relayDeps?: PairingRelayDeps): PairingService {
  let server: Server | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let onDoneCb: ((result: PairingDone) => void) | null = null

  /**
   * Serializes every mutation of agent.json / authorized_keys. Both are read-modify-write over a
   * whole file and both entry points are unserialized — each `pairing:revoke-device` invoke is
   * independent (src/main/index.ts) and the pairing POST arrives on its own connection — so two
   * overlapping mutations each read the ORIGINAL file and write back a copy carrying only their
   * own change. The revoke case is the dangerous one: the loser's stale read republishes the
   * device the winner just revoked, key line and agent token both, so a revoked phone silently
   * keeps SSH and host-agent access. Same idiom as SshStore's writeChain.
   */
  let mutateChain: Promise<void> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    // Both arms run `fn`: one mutation failing must not cancel the ones queued behind it…
    const run = mutateChain.then(fn, fn)
    // …nor surface on them, while the caller still sees ITS OWN failure.
    mutateChain = run.then(() => undefined, () => undefined)
    return run
  }

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (server) {
      server.close()
      server = null
    }
  }

  // Fire the completion callback exactly once, then tear everything down.
  const finish = (result: PairingDone): void => {
    const cb = onDoneCb
    onDoneCb = null
    cleanup()
    cb?.(result)
  }

  const start = async (onDone: (result: PairingDone) => void): Promise<PairingStartResult> => {
    // A prior in-flight pairing is cancelled silently (no onDone) before starting a new one.
    onDoneCb = null
    cleanup()
    onDoneCb = onDone

    const host = pickLanIPv4(os.networkInterfaces())
    if (!host) {
      onDoneCb = null
      throw new Error("Couldn't detect a LAN IP address — connect to Wi-Fi and try again.")
    }
    const token = randomBytes(24).toString('base64url')
    const user = os.userInfo().username

    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(req, res)
    })
    server = srv

    // Bind a random high port on all interfaces (0.0.0.0) so the phone on the LAN can reach it.
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '0.0.0.0', () => {
        srv.removeListener('error', reject)
        resolve()
      })
    })

    const addr = srv.address()
    const pairPort = typeof addr === 'object' && addr ? addr.port : 0
    const [name, sshOpen] = await Promise.all([computerName(), probeSsh()])
    // Relay reachability (network-free) — embedded in the QR so the phone can reach us over the
    // relay too. Also reused in handleRequest to mint the phone's device token. LAN-only when null.
    const relayCtx = await buildRelayContext(relayDeps)
    // The host's NaCl box keypair — its public key rides the QR as `hostKey` (authenticated by
    // being shown on this screen), so a new phone can E2EE the whole /pair exchange to it. Loaded
    // once here and reused to decrypt the request in handleRequest. If the key can't be loaded we
    // simply omit `hostKey` → the phone falls back to plaintext (never fail pairing over this).
    let hostKeys: KeyPair | null = null
    let hostKey: string | undefined
    if (relayDeps) {
      try {
        hostKeys = await relayDeps.loadHostKeyPair()
        hostKey = publicKeyToB64(hostKeys.publicKey)
      } catch {
        hostKeys = null
        hostKey = undefined
      }
    }
    const payload = buildPairingPayload({
      host,
      port: 22,
      user,
      token,
      pairPort,
      name,
      hostKey,
      relay: relayCtx?.block
    })

    // Give up after 2 minutes with a timeout result.
    timer = setTimeout(() => finish({ ok: false }), PAIR_TIMEOUT_MS)
    timer.unref?.()

    // The phone reads /pair responses off a raw TCP socket (ATS blocks URLSession for bare-IP
    // HTTP) and takes everything after the header block as the body, so every response must be
    // framed with an explicit Content-Length — otherwise Node chunks the HTTP/1.1 response and
    // the chunk-framing bytes corrupt the body on the phone.
    const send = (res: ServerResponse, code: number, body = '', type?: string): void => {
      const headers: Record<string, string | number> = { 'Content-Length': Buffer.byteLength(body) }
      if (type) headers['Content-Type'] = type
      res.writeHead(code, headers).end(body)
    }

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST' || req.url !== '/pair') {
        send(res, 404)
        return
      }
      try {
        const raw = await readBody(req)
        let outer: { epk?: unknown; box?: unknown } & Record<string, unknown>
        try {
          outer = JSON.parse(raw)
        } catch {
          send(res, 400, 'bad json')
          return
        }
        // E2EE branch: when the phone sealed the request to our host key, the outer body is
        // {epk, box}. Derive the shared key from the ephemeral public key + our secret and open
        // the box to recover the SAME {token, publicKey, deviceId} JSON. A present-but-undecryptable
        // envelope is a hard 400 — we never fall through to parsing ciphertext as plaintext.
        let body: {
          token?: unknown
          publicKey?: unknown
          deviceName?: unknown
          deviceId?: unknown
          priorDeviceToken?: unknown
        }
        let sealed: Uint8Array | null = null // the shared key, set only on the encrypted path
        if (typeof outer.epk === 'string') {
          if (!hostKeys) {
            send(res, 400, 'no host key')
            return
          }
          let shared: Uint8Array
          try {
            shared = deriveSharedKey(outer.epk, hostKeys.secretKey)
          } catch {
            send(res, 400, 'bad epk')
            return
          }
          const boxB64 = typeof outer.box === 'string' ? outer.box : ''
          const plain = decrypt(Uint8Array.from(Buffer.from(boxB64, 'base64')), shared)
          if (!plain) {
            send(res, 400, 'decrypt failed')
            return
          }
          try {
            body = JSON.parse(Buffer.from(plain).toString('utf8'))
          } catch {
            send(res, 400, 'bad json')
            return
          }
          sealed = shared
        } else {
          body = outer as {
            token?: unknown
            publicKey?: unknown
            deviceName?: unknown
            deviceId?: unknown
            priorDeviceToken?: unknown
          }
        }
        if (body.token !== token) {
          send(res, 403, 'bad token')
          return
        }
        const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : ''
        if (!isValidEd25519PublicKey(publicKey)) {
          send(res, 400, 'unexpected key type')
          return
        }
        // Mint a device identity: the deviceId stamps the key line (attributable + revocable);
        // the agentToken is the phone's bearer for the host-agent WebSocket (stored in its Keychain).
        const deviceId = randomUUID()
        const agentToken = randomBytes(24).toString('base64url')
        const name = normalizeDeviceName(body.deviceName)
        // One unit, and queued behind any in-flight revoke: a pairing that interleaves with one
        // would either append onto the inode the revoke is about to rename over, or lose its
        // agent.json entry to the revoke's stale read.
        await serialize(async () => {
          await appendAuthorizedKey(rewriteKeyComment(publicKey, deviceId))
          await persistDevice({
            id: deviceId,
            name,
            token: agentToken,
            pairedAt: Date.now(),
            lastSeenAt: 0
          })
        })
        // Provision relay access for the phone when enabled + Pro. Any failure ⇒ LAN-only: we
        // never fail the pairing over a relay hiccup (the phone still got its SSH key installed).
        let relayFields: { relay?: RelayPairingBlock; relayDeviceToken?: string } = {}
        if (relayCtx) {
          const phoneDeviceId =
            typeof body.deviceId === 'string' && body.deviceId.trim()
              ? body.deviceId.trim()
              : deviceId
          const minted = await mintRelayDevice(relayDeps!.apiBase, {
            entitlement: relayCtx.entitlement,
            deviceId: phoneDeviceId,
            hostPublicKeyB64: relayCtx.block.hostPublicKeyB64,
            label: name,
            priorDeviceToken:
              typeof body.priorDeviceToken === 'string' ? body.priorDeviceToken : undefined
          })
          if (minted?.deviceToken) {
            relayFields = {
              relay: { ...relayCtx.block, hostId: minted.hostId || relayCtx.block.hostId },
              relayDeviceToken: minted.deviceToken
            }
          }
        }
        // Build the response exactly as before; wrap it in the box only when the request was
        // encrypted (same shared key), so the relay device token never crosses the LAN in cleartext.
        const responseObj = { ok: true, deviceId, agentToken, ...relayFields }
        if (sealed) {
          const respBox = encrypt(
            Uint8Array.from(Buffer.from(JSON.stringify(responseObj), 'utf8')),
            sealed
          )
          send(
            res,
            200,
            JSON.stringify({ box: Buffer.from(respBox).toString('base64') }),
            'application/json'
          )
        } else {
          send(res, 200, JSON.stringify(responseObj), 'application/json')
        }
        finish({
          ok: true,
          relay: relayCtx
            ? relayFields.relayDeviceToken
              ? 'ok'
              : 'failed'
            : relayDeps && !relayDeps.relayAllowed()
              ? 'dev'
              : 'off'
        })
      } catch (err) {
        send(res, 500, 'pairing failed')
        console.warn('[pairing] request failed:', err)
      }
    }

    return {
      payload,
      sshOpen,
      relayPlan: relayCtx ? 'ok' : relayDeps && !relayDeps.relayAllowed() ? 'dev' : 'off'
    }
  }

  const stop = (): void => {
    onDoneCb = null
    cleanup()
  }

  const listDevices = async (): Promise<PublicDevice[]> => {
    return toPublicDevices(readDevices(await readAgentJson()))
  }

  // One unit: agent.json and authorized_keys must not be revoked half-way by an interleaving writer.
  //
  // authorized_keys goes FIRST, and the order is load-bearing on partial failure. That file is full
  // shell access; agent.json holds the host-agent bearer token and the device the UI lists. If the
  // second step fails, revoking the SSH key first leaves the BIGGER capability already gone and the
  // device still listed — visible to its owner, with the Revoke button still there to finish the
  // job. The reverse order fails the other way: the device disappears from the list while its key
  // is still live, so the owner believes it revoked and has no way left to retry.
  const revokeDevice = (id: string): Promise<void> =>
    serialize(async () => {
      await removeAuthorizedKeysForDevice(id)
      const obj = await readAgentJson()
      const devices = removeDevice(readDevices(obj), id)
      await writeAgentJson({ ...obj, devices })
    })

  return { start, stop, listDevices, revokeDevice, probeSsh }
}
