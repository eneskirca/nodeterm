// Phone-pairing service (main process) — the host side of the nodeterm iOS "scan a QR" flow.
//
// start() mints a one-time token, opens a single-shot LAN HTTP listener on a random port, and
// returns the JSON payload (for the renderer to render as a QR) plus whether SSH looks reachable.
// The phone scans the QR, generates an Ed25519 keypair on-device, and POSTs {token, publicKey}
// to http://<host>:<pairPort>/pair. On a token match we append the key to ~/.ssh/authorized_keys
// and stop the listener. The private key never leaves the phone; the only secret in the QR is the
// single-use token.
//
// Windows is relay-only: no key is installed (see `directSsh` in createPairingService), the QR
// says `"ssh":false`, and a pairing whose relay mint fails pairs nothing.
//
// A sealed answer also carries this computer's SSH host key fingerprints (`ssh-host-keys.ts`), so the
// phone checks its first SSH connect against them instead of trusting whichever key answers there.
//
// Pure bits (payload build, key validation, LAN-IPv4 pick) live in `pairing-core.ts` so they're
// unit-tested without spinning up a server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { connect as netConnect } from 'net'
import { createSocket as createUdpSocket } from 'dgram'
import { randomBytes, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { pairingNetworkChoices, pairingNetworkIPv4, type PairingInterfaces, type PairingNetworkChoice } from '../shared/pairing-network'
import {
  buildPairingPayload,
  filterAuthorizedKeys,
  holdsPairedRelayKey,
  isValidBoxPublicKeyB64,
  isValidEd25519PublicKey,
  normalizeAuthorizedKeysLine,
  normalizeDeviceName,
  readDevices,
  removeDevice,
  rewriteKeyComment,
  toPublicDevices,
  upsertDevice,
  type DeviceEntry,
  type PublicDevice,
  type RelayPairingBlock
} from './pairing-core'
import type { DeviceRevokeResult, DeviceRevokeServerOutcome, Settings } from '../shared/types'
import { renameAtomic, renameAtomicSync, tempNameFor } from '../core/fs-atomic'
import { legacyPairingEntryVersion, readLegacyPairingKey, readOwnedRegularFile } from './pairing-legacy-key'
import type { LegacyRelayPairings, LegacyRelayPairingTarget, LegacyRelayPairingInspection } from './remote/relay-pairing-proof'
import { RELAY_PAIRING_KEY, RELAY_PAIRING_UUID, type RelayPairingProofResult } from '../shared/relay-pairing-proof'
import { publicKeyToB64, deriveSharedKey, encrypt, decrypt, type KeyPair } from './remote/e2ee'
import { hostIdFromPublicKeyB64 } from './remote/relay-id'
import type { RevokeResult } from './remote/revocation'
import { getDeviceId } from '../core/device-id'
import { administratorsKeysPath, detectWindowsKeyFile, type WindowsKeyFile } from './windows-ssh-keys'
import { readSshHostKeyFingerprints, SSH_HOST_KEY_DIRS } from './ssh-host-keys'

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
  /**
   * Pin a phone's relay (box) public key on the standing host, as its SAS approval would (audit
   * A07). Optional: absent ⇒ the phone approves on its first relay connect, as before.
   */
  pinRelayKey?(boxPublicKeyB64: string): Promise<void>
  /**
   * Undo [pinRelayKey] when the device is revoked AND cut every relay session that key has open at
   * that moment: an unpin alone refuses only the NEXT handshake, so a phone connected while it is
   * forgotten would keep its terminals (audit A07-revoke). index.ts wires the revoker
   * `remote:revoke-peer` uses (peer-revoker.ts), which reports both steps rather than throwing.
   */
  revokeRelayKey?(boxPublicKeyB64: string): Promise<RevokeResult>
  /**
   * Pin `boxPublicKeyB64` on the standing host IF `stillPaired()` answers true at the moment the pin
   * is written, and say whether it is pinned (A07-late). index.ts runs `stillPaired` INSIDE the
   * approved-devices queue (`pinApprovedDeviceIf`), which is what keeps a revoke's unpin from being
   * overtaken: a revoke removes the agent.json entry before it queues its unpin, so a check that runs
   * after the unpin can no longer find the entry (a revoke lists it again only when that unpin could
   * not be written, while the key is still pinned). Optional: absent ⇒ a phone whose key was recorded
   * without being pinned approves on its first relay connect, as before, and the `/pair` answer does
   * not promise otherwise.
   */
  pinRelayKeyIfPaired?(boxPublicKeyB64: string, stillPaired: () => Promise<boolean>): Promise<boolean>
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

/** How long a revoke waits for the backend before calling it unreachable. */
const REVOKE_TIMEOUT_MS = 8000

/**
 * Take a paired phone's Pro entitlement back. Until this existed, Remove was purely local — the
 * peer key was unpinned and the socket cut, while the server kept minting Pro for that phone
 * forever.
 *
 * Three outcomes, because two cannot tell the truth here:
 *  - 'ok'      the route answered 204. It is deliberately idempotent and reveals nothing about
 *              WHICH of its four cases applied (revoked it / unknown device / the row carries a
 *              'free:'/'apple:' id so there was nothing of ours on it / already revoked) — all
 *              four mean the phone holds no entitlement of ours, which is what we asked for.
 *  - 'failed'  we asked and were refused (403 = someone else's row, 401 = the token did not
 *              verify) or could not reach the server. The caller must NOT report a clean removal.
 *  - 'skipped' we did not ask, and that is a normal state: a free-tier desktop holds no
 *              entitlement to sign the request with (and has no Pro of ours on that phone to
 *              reclaim), or there is no device (and so no row) to name at all.
 *
 * `relayDeviceId` is phone-supplied, unvalidated text, so it rides the JSON body — never a URL.
 */
export async function revokeRelayDevice(
  apiBase: string,
  relayDeviceId: string,
  entitlement: string | null
): Promise<DeviceRevokeServerOutcome> {
  // Authorization for anything that moves a license is the signed entitlement, never a deviceId.
  if (!entitlement || !relayDeviceId || !apiBase) return 'skipped'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REVOKE_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase}/v1/relay/device/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: relayDeviceId, entitlement }),
      signal: ctrl.signal
    })
    return res.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
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
  /** Will a scan install an SSH key? `false` on Windows: the phone reaches this host through the
   *  relay only, so sshd is irrelevant and the QR is gated on the relay instead (see
   *  `pairingGate`). */
  sshKey: boolean
  /** Windows only: which authorized_keys file sshd would read for this account — shown to explain
   *  why no key is installed (issue #758). Never used to decide anything. */
  windowsKeyFile?: WindowsKeyFile
  /** What the QR on screen will mint: 'ok' = carries a relay block, 'dev' = unpackaged build
   *  (relayAllowed() off — the QR is LAN-only regardless of the toggle), 'off' = toggle off.
   *  Known at start, so the UI can warn BESIDE the QR instead of after the pairing. */
  relayPlan: 'ok' | 'dev' | 'off'
}

/** Fired once when pairing finishes: ok=true → a key was installed, ok=false → timeout/cancel. */
export type PairingDone = {
  ok: boolean
  /** Only on ok=false: 'timeout' (nobody finished in time) or 'relay-failed' (a relay-only
   *  pairing whose device mint failed — nothing was paired, and the phone was told so). */
  reason?: 'timeout' | 'relay-failed'
  /** Only on ok=false: did ANY request reach the listener? A Windows timeout with nothing reached
   *  is the signature of the firewall (or a wrong adapter address) blocking the phone. */
  reached?: boolean
  /** Only on ok=true: did the pairing come with a relay leg? 'off' = toggle disabled,
   *  'failed' = enabled but the mint failed (the SILENT LAN-only degrade that cost a
   *  field debugging session — surface it, never swallow it), 'dev' = unpackaged build,
   *  where relayAllowed() disables the relay regardless of the toggle — a self-builder
   *  running `npm run dev` would otherwise read 'off' while staring at an ON toggle. */
  relay?: 'ok' | 'off' | 'failed' | 'dev'
}

export interface PairingService {
  /** Exact retained SSH proof repairs a legacy association; never grants approval or changes pins. */
  readonly legacyRelayPairings: LegacyRelayPairings
  /** Read this computer's current IPv4 adapters, without guessing phone reachability. */
  listNetworks(): PairingNetworkChoice[]
  /** Begin pairing; resolves once the listener is up. `onDone` fires exactly once later. */
  start(onDone: (result: PairingDone) => void): Promise<PairingStartResult>
  /** Cancel an in-flight pairing (idempotent). Does NOT fire onDone. */
  stop(): void
  /** All paired devices (token stripped) from ~/.nodeterm/agent.json. */
  listDevices(): Promise<PublicDevice[]>
  /**
   * Revoke a device: drop its agent.json entry, delete its authorized_keys line, unpin its relay key
   * and close the relay sessions it has open (A07-revoke), AND take its Pro entitlement back on the
   * relay backend. The legs are reported separately — see `DeviceRevokeResult`; this never throws,
   * because a failure the caller cannot see is exactly how the server leg went missing in the first
   * place. A legacy pairing with no relay-key association reports that remote revocation remains
   * unconfirmed; another pairing that still authorizes the key reports retained access.
   */
  revokeDevice(id: string): Promise<DeviceRevokeResult>
  /** Live re-probe of sshd (127.0.0.1:22), for the Remote Login warning's auto-clear. */
  probeSsh(): Promise<boolean>
  /**
   * The standing host met a relay key it has not pinned (A07-late). Pin it when a pairing still
   * listed in agent.json recorded that key from its sealed `/pair` body, and answer whether it did:
   * `true` ⇒ approve the handshake silently, `false` ⇒ raise the SAS dialog as before. Never throws.
   *
   * Why the record is enough: the key arrived sealed to this desktop's host key, behind the one-time
   * token shown on its screen — the same authority that installed the phone's SSH key with full shell
   * access. Pairing pins it at once only when it minted a relay leg; a phone paired while remote
   * access was off adopts the relay later over SSH (relay-advertise.ts), and its first relay connect
   * used to raise the dialog, typically with nobody at the desk. Pinning here rather than at the scan
   * keeps "pinned" meaning "a phone that uses the relay", which host-mode push keys on.
   *
   * So the pairing is what authorizes the key: forgetting a phone means revoking its device
   * (`revokeDevice` drops the entry, then unpins). Unpinning the key alone (the `remote:revoke-peer`
   * channel, which no screen calls today) lasts only until its next handshake while that pairing is
   * still listed.
   */
  approvePairedRelayKey(boxPublicKeyB64: string): Promise<boolean>
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

/**
 * Remove agent.json temps no writer in THIS process owns: the legacy fixed `agent.json.tmp`
 * (written by builds from before per-call names) and any `agent.json.<pid>.<seq>[.<uuid>].tmp`
 * whose pid is not ours. Best effort — a failure here must never break (or skip) the write that
 * follows.
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
      const middle = entry.slice(base.length, -'.tmp'.length) // '' or '.<pid>.<seq>[.<uuid>]'
      const owner =
        /^\.(\d+)\.\d+(?:\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/
          .exec(middle)?.[1]
      if (middle === '' || (owner && owner !== String(process.pid))) {
        await fs.rm(path.join(AGENT_DIR, entry), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // A dir we cannot read is not a reason to fail (or skip) the write below.
  }
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

/**
 * The source address the OS would use for a route to the internet — the default-route adapter.
 * A UDP `connect` only consults the routing table; no packet is sent. Null when there is no route
 * or anything fails.
 */
function defaultRouteIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const sock = createUdpSocket('udp4')
    const done = (addr: string | null): void => {
      if (settled) return
      settled = true
      try {
        sock.close()
      } catch {
        // already closed
      }
      resolve(addr)
    }
    sock.once('error', () => done(null))
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          done(sock.address().address)
        } catch {
          done(null)
        }
      })
    } catch {
      done(null)
    }
    setTimeout(() => done(null), 500).unref?.()
  })
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
 * permissions. The caller stamps the attributable `nodeterm-mobile-<deviceId>` comment via
 * `rewriteKeyComment` before this point (revoke also matches the legacy `nodeterm-ios-<id>`).
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

/** Seams for the platform decisions, so the Windows behaviour is testable on any runner. */
export interface PairingServiceOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Defaults to the OS interface list, re-read for every start/list. */
  interfaces?: () => PairingInterfaces
  /** The saved adapter NAME, read at use. Empty or absent means automatic. */
  getPairingInterface?: () => string
  /** Windows key-file detection (explanation only). Defaults to the real probe. */
  detectKeyFile?: () => Promise<WindowsKeyFile>
  /** Windows' machine-wide administrators key file, swept on revoke. */
  administratorsKeysPath?: string
  /** Default-route source address, for the Windows LAN-IP pick. */
  defaultRouteAddress?: () => Promise<string | null>
  /** Defaults to PAIR_TIMEOUT_MS. */
  timeoutMs?: number
  /** Where sshd's host keys (and `sshd_config`) are read from for the sealed answer's
   *  `sshHostKeyFingerprints` (audit A49-anchor). Defaults to `SSH_HOST_KEY_DIRS`. */
  sshHostKeyDirs?: readonly string[]
  /**
   * Revoke the phone's RELAY trust on Remove: unpin its box key from the phone store and close its
   * live relay sessions (peer-revoke.ts `revokeAllPhones`). Without it a removed phone keeps its
   * relay shell until the socket drops and is silently re-admitted on reconnect. Absent ⇒ no relay
   * leg (tests, and any shell without a standing host).
   */
  revokePhoneRelayTrust?: () => Promise<{ persisted: boolean; killed: boolean }>
}

export function createPairingService(
  relayDeps?: PairingRelayDeps,
  options: PairingServiceOptions = {}
): PairingService {
  const platform = options.platform ?? process.platform
  const interfaces = options.interfaces ?? os.networkInterfaces
  // Windows: no SSH key, relay only. Everything the phone sends over SSH is POSIX sh + tmux
  // (nodeterm-ios HostCommands / TmuxBinary / TerminalTransport), Windows OpenSSH hands out
  // cmd.exe, and sessions live in the session host — so a key sshd accepts only pins the phone to
  // a path that cannot work, where a rejected one lets it fall through to the relay.
  const directSsh = platform !== 'win32'
  const adminKeysPath = options.administratorsKeysPath ?? administratorsKeysPath()
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

  /**
   * Write agent.json atomically (0600), creating ~/.nodeterm (0700) if needed.
   *
   * Lives INSIDE the factory, below `serialize`, so no code path outside this closure can reach
   * it unchained — the same by-construction guarantee as GitHubControlStore's private write().
   * Overlapping entry points (the pairing POST, renderer revokes) are ordered by the chain; the
   * per-call temp name (`tempNameFor`: pid + module counter + UUID) covers the writers the chain
   * cannot see — the host agent is a separate PROCESS writing this same ~/.nodeterm, a second
   * service instance in THIS process, and a crash between tmp-write and rename.
   */
  async function writeAgentJson(obj: Record<string, unknown>): Promise<void> {
    await fs.mkdir(AGENT_DIR, { recursive: true, mode: 0o700 })
    await fs.chmod(AGENT_DIR, 0o700).catch(() => {})
    await sweepStaleAgentTmp()
    const tmp = tempNameFor(AGENT_JSON_PATH)
    try {
      await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
      await fs.chmod(tmp, 0o600).catch(() => {})
      await renameAtomic(tmp, AGENT_JSON_PATH)
    } catch (e) {
      // A unique name never self-heals the way the fixed one did (the next write just reused it),
      // and here a leaked temp IS a leaked credential: only this cleanup — or a later run's sweep,
      // once this pid is dead — will ever collect it. The error still propagates.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    await fs.chmod(AGENT_JSON_PATH, 0o600).catch(() => {})
  }

  /** Only migration uses this staged publication: the final admission and rename are synchronous.
   * The queue fences this service's pair/revoke writers, not another process or manual file edits. */
  async function writeLegacyAssociation(obj: Record<string, unknown>, admitted: () => boolean): Promise<boolean> {
    const tmp = tempNameFor(AGENT_JSON_PATH)
    try {
      await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
      await fs.chmod(tmp, 0o600)
      if (!admitted()) return false
      // No await between the current approved-session fence and publication.
      renameAtomicSync(tmp, AGENT_JSON_PATH)
      return true
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
  }

  const inspectLegacy = (obj: Record<string, unknown>, pairingId: string, peerKey: string): LegacyRelayPairingInspection => {
    if (!RELAY_PAIRING_UUID.test(pairingId) || !RELAY_PAIRING_KEY.test(peerKey)) return { status: 'unprovable' }
    const matches = readDevices(obj).filter(entry => entry?.id === pairingId)
    if (!matches.length) return { status: 'gone' }
    if (matches.length !== 1) return { status: 'unprovable' }
    const entry = matches[0]
    if (entry.relayBoxKey) return { status: entry.relayBoxKey === peerKey ? 'associated' : 'conflict' }
    if (entry.ssh === false || typeof entry.token !== 'string' || !entry.token || !Number.isFinite(entry.pairedAt)) return { status: 'unprovable' }
    const sshPublicKeyB64 = readLegacyPairingKey(AUTH_KEYS_PATH, pairingId)
    return sshPublicKeyB64 ? { status: 'eligible', target: { pairingId, sshPublicKeyB64,
      entryVersion: legacyPairingEntryVersion(entry) } } : { status: 'unprovable' }
  }
  const legacyRelayPairings: LegacyRelayPairings = {
    inspect: (pairingId, peerKey) => serialize(async () => inspectLegacy(await readAgentJson(), pairingId, peerKey)),
    associate: (target: LegacyRelayPairingTarget, peerKey, current) => serialize(async (): Promise<RelayPairingProofResult> => {
      if (!current()) return { status: 'expired' }
      const obj = await readAgentJson()
      if (!current()) return { status: 'expired' }
      const found = inspectLegacy(obj, target.pairingId, peerKey)
      if (found.status !== 'eligible') return found
      if (found.target.entryVersion !== target.entryVersion || found.target.sshPublicKeyB64 !== target.sshPublicKeyB64) return { status: 'unprovable' }
      let refused: RelayPairingProofResult = { status: 'expired' }
      const published = await writeLegacyAssociation({ ...obj, devices: readDevices(obj).map(entry =>
        entry.id === target.pairingId ? { ...entry, relayBoxKey: peerKey } : entry) }, () => {
        // Re-attest captured entry/key after staging. Refuse replacement/manual edits instead of
        // publishing a stale whole-file snapshot. This final bounded read never escapes the host.
        const snapshot = readOwnedRegularFile(AGENT_JSON_PATH, 4 * 1024 * 1024)
        if (!snapshot) { refused = { status: 'unprovable' }; return false }
        const fresh = JSON.parse(snapshot.toString('utf8')) as Record<string, unknown>
        const next = inspectLegacy(fresh, target.pairingId, peerKey)
        if (next.status !== 'eligible') { refused = next; return false }
        if (next.target.entryVersion !== target.entryVersion || next.target.sshPublicKeyB64 !== target.sshPublicKeyB64 ||
            JSON.stringify(fresh) !== JSON.stringify(obj)) { refused = { status: 'unprovable' }; return false }
        return current()
      })
      return published ? { status: 'associated' } : refused
    })
  }

  /** Persist a device into agent.json, preserving all other fields the host agent wrote. */
  async function persistDevice(entry: DeviceEntry): Promise<void> {
    const obj = await readAgentJson()
    const devices = upsertDevice(readDevices(obj), entry)
    await writeAgentJson({ ...obj, devices })
  }

  /**
   * Delete every authorized_keys line stamped for `deviceId`, rewriting the file atomically
   * (0600). In the closure below `serialize` for the same by-construction reason as
   * writeAgentJson; the per-call temp name covers the chain-invisible writers and the crash
   * window — a spliced line is a key sshd rejects, i.e. the keys that were supposed to SURVIVE
   * the revoke stop working. No orphan sweep here (unlike agent.json): these are PUBLIC keys, so
   * a stray temp is litter rather than a credential.
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
    const tmp = tempNameFor(AUTH_KEYS_PATH)
    try {
      await fs.writeFile(tmp, next, { mode: 0o600 })
      await fs.chmod(tmp, 0o600).catch(() => {})
      await renameAtomic(tmp, AUTH_KEYS_PATH)
    } catch (e) {
      // A unique name never self-heals the way the fixed one did (the next write just reused it),
      // so a failed write has to remove its own temp — otherwise every failed revoke leaves
      // another orphan copy of the user's key file in ~/.ssh forever. The error still propagates.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    await fs.chmod(AUTH_KEYS_PATH, 0o600).catch(() => {})
  }

  /**
   * Windows: also remove the device's line from `%ProgramData%\ssh\administrators_authorized_keys`.
   * nodeterm never writes that file, but #758's manual workaround copies a paired key into it, and
   * a revoke that only rewrote the profile file would report the device removed while the copy
   * sshd actually reads stays authorized — for every administrator account on the machine.
   *
   * Rewritten IN PLACE, deliberately not temp + rename: the file's ACL must stay Administrators +
   * SYSTEM only, and a temp file inherits the directory's ACL instead, which sshd then refuses —
   * breaking every other administrator key in it. A line that IS there but cannot be removed
   * throws, so the revoke reports `local: false` rather than a removal that did not happen.
   *
   * KNOWN RESIDUAL: an unreadable file is skipped, and unreadable is the NORMAL case — that ACL
   * denies an unelevated process even a read. So an unelevated revoke cannot see a manually copied
   * line and cannot say one exists; only an elevated nodeterm reaches it. Failing every unelevated
   * revoke instead would make "Remove device" permanently impossible on any admin account with
   * sshd installed, for a copy nodeterm never made.
   */
  async function removeAdministratorsKeysForDevice(deviceId: string): Promise<void> {
    if (platform !== 'win32') return
    let content: string
    try {
      content = await fs.readFile(adminKeysPath, 'utf8')
    } catch {
      return
    }
    const next = filterAuthorizedKeys(content, deviceId)
    if (next === content) return
    await fs.writeFile(adminKeysPath, next)
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

    // Only Windows uses its existing OS route hint. An explicit adapter always wins, and is
    // re-read after the asynchronous hint so a settings/DHCP change is not cached into the QR.
    const routeAddress = !directSsh && !options.getPairingInterface?.()
      ? await (options.defaultRouteAddress ?? defaultRouteIPv4)().catch(() => null)
      : null
    const preferred = options.getPairingInterface?.() ?? ''
    const host = pairingNetworkIPv4(interfaces(), preferred, routeAddress)
    if (!host) {
      onDoneCb = null
      throw new Error(preferred
        ? `The selected pairing network “${preferred}” has no usable IPv4 address. Reconnect it or choose another network in Settings → Phone.`
        : "Couldn't detect a LAN IPv4 address — connect to a network and try again.")
    }
    const token = randomBytes(24).toString('base64url')
    const user = os.userInfo().username
    // Set by the first request of any kind — see PairingDone.reached.
    let reached = false

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
    const [name, sshOpen, windowsKeyFile] = await Promise.all([
      computerName(),
      probeSsh(),
      directSsh
        ? Promise.resolve(undefined)
        : (options.detectKeyFile ?? detectWindowsKeyFile)().catch((): WindowsKeyFile => 'unknown')
    ])
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
      relay: relayCtx?.block,
      ...(directSsh ? {} : { ssh: false as const })
    })

    // Give up after PAIR_TIMEOUT_MS with a timeout result.
    timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', reached }),
      options.timeoutMs ?? PAIR_TIMEOUT_MS
    )
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
      reached = true
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
          boxPublicKey?: unknown
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
            boxPublicKey?: unknown
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
        const name = normalizeDeviceName(body.deviceName, publicKey)
        // The phone's OWN id — the key the relay backend stores its device row under, and the
        // only one it would recognize in a later revoke. Resolved here rather than at the mint
        // below so the registry entry can carry it; the fallback (phone sent none ⇒ our id) is
        // unchanged, and the mint still reads this same value.
        const phoneDeviceId =
          typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim() : deviceId
        // The phone's relay identity (audit A07). Taken ONLY from the sealed body: that body is
        // sealed to the QR's host key and authorized by the one-time token on this screen — the same
        // authority that installs an SSH key with full shell access — so pinning it here is the
        // human's approval, given by scanning. A plaintext body could be rewritten on the LAN.
        const relayBoxKey = sealed && isValidBoxPublicKeyB64(body.boxPublicKey) ? body.boxPublicKey : undefined
        let relayPinned = false
        const pinRelay = async (): Promise<void> => {
          if (!relayBoxKey || !relayFields.relayDeviceToken || !relayDeps?.pinRelayKey) return
          try {
            await relayDeps.pinRelayKey(relayBoxKey)
            relayPinned = true
          } catch (err) {
            // Not fatal: the key is recorded on the device entry, so the standing host pins it on the
            // phone's first relay handshake instead (`approvePairedRelayKey`, A07-late).
            console.warn('[pairing] could not pin the phone relay key:', err)
          }
        }
        let relayFields: { relay?: RelayPairingBlock; relayDeviceToken?: string } = {}
        const mint = async (): Promise<void> => {
          if (!relayCtx) return
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
        if (directSsh) {
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
              lastSeenAt: 0,
              relayDeviceId: phoneDeviceId,
              ...(relayBoxKey ? { relayBoxKey } : {})
            })
          })
          // Provision relay access for the phone when enabled. Any failure ⇒ LAN-only: we never
          // fail the pairing over a relay hiccup (the phone still got its SSH key installed).
          await mint()
          await pinRelay()
        } else {
          // Relay-only (Windows). The relay IS the connection, so there is nothing to fall back
          // to: no relay leg ⇒ nothing is paired, and both ends are told so. Minted BEFORE the
          // device is recorded, so a failed mint leaves no half-paired entry behind. The body is
          // plain text because the phone shows a non-2xx body verbatim ("The computer rejected
          // pairing: …").
          if (!relayCtx) {
            send(
              res,
              409,
              'remote access is off on the computer. On Windows the phone connects only through remote access — turn it on in nodeterm and scan the new code.'
            )
            return
          }
          await mint()
          if (!relayFields.relayDeviceToken) {
            send(
              res,
              502,
              "the computer couldn't set up remote access, and on Windows that is how the phone connects. Check its internet connection and scan a new code."
            )
            finish({ ok: false, reason: 'relay-failed', reached: true })
            return
          }
          await serialize(() =>
            persistDevice({
              id: deviceId,
              name,
              token: agentToken,
              pairedAt: Date.now(),
              lastSeenAt: 0,
              relayDeviceId: phoneDeviceId,
              ...(relayBoxKey ? { relayBoxKey } : {}),
              ssh: false
            })
          )
          await pinRelay()
        }
        // Build the response exactly as before; wrap it in the box only when the request was
        // encrypted (same shared key), so the relay device token never crosses the LAN in cleartext.
        // `relayPinned` (additive, A07): the key was pinned just now.
        // `relayApproved` (additive, A07-late): this desktop serves the phone's relay key without the
        // SAS dialog, so the phone may treat the relay as approved. True when the key was pinned just
        // now, and also when it was only recorded (no relay leg yet, or the pin failed): the standing
        // host pins a recorded key on the phone's first relay handshake (`approvePairedRelayKey`), as
        // after a late adoption. Not pinned at the scan without a relay leg, so a LAN-only pairing
        // does not count as a relay phone (host-mode push keys on the pin store).
        const relayApproved = relayPinned || (!!relayBoxKey && !!relayDeps?.pinRelayKeyIfPaired)
        // `sshHostKeyFingerprints` (additive, A49-anchor): this computer's SSH host key fingerprints,
        // so the phone's first SSH connect must present one of them instead of pinning whichever key
        // answers at the paired address. In the SEALED answer only, which is bound to the host key on
        // this screen; a plaintext answer could be rewritten on the LAN, and the QR stays as it is.
        // Not on Windows, where the phone has no SSH leg. Unreadable keys ⇒ the field is left out and
        // the phone keeps its pin-after-authentication, as with an older desktop.
        const sshHostKeyFingerprints =
          sealed && directSsh
            ? await readSshHostKeyFingerprints(options.sshHostKeyDirs ?? SSH_HOST_KEY_DIRS).catch(() => [])
            : []
        const responseObj = {
          ok: true,
          deviceId,
          agentToken,
          ...relayFields,
          ...(relayPinned ? { relayPinned: true } : {}),
          ...(relayApproved ? { relayApproved: true } : {}),
          ...(sshHostKeyFingerprints.length ? { sshHostKeyFingerprints } : {})
        }
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
      sshKey: directSsh,
      ...(windowsKeyFile ? { windowsKeyFile } : {}),
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
  // Legacy unassociated relay trust goes first; a recorded key is revoked after removing its
  // pairing below, so a late paired pin cannot resurrect it. authorized_keys is full
  // shell access; agent.json holds the host-agent bearer token and the device the UI lists. If the
  // second step fails, revoking the SSH key first leaves the BIGGER capability already gone and the
  // device still listed — visible to its owner, with the Revoke button still there to finish the
  // job. The reverse order fails the other way: the device disappears from the list while its key
  // is still live, so the owner believes it revoked and has no way left to retry.
  //
  // The relay device id is read BEFORE either write and kept even when the local leg fails: the
  // entitlement is what authorizes the server leg, not the local write's success, and a phone the
  // user asked to remove should stop being minted Pro either way.
  //
  // The relay leg runs LAST, inside the same unit, and only after agent.json no longer lists the
  // device: the standing host's late pin (`approvePairedRelayKey`, A07-late) pins a key a listed
  // pairing recorded, so an unpin queued while the entry is still there could be undone by it. If
  // the unpin cannot be written, the pin may survive, and the phone's next relay connect would be
  // approved with no dialog (revocation.ts: the caller MUST retry and MUST NOT show "Removed"). So
  // the entry is put back where it was and `local` is false: the device stays listed, which is the
  // same partial state as an agent.json write that failed, and Revoke retries the whole thing. The
  // key is still pinned in that case, so listing the device again gives the late pin nothing new.
  const revokeDevice = async (id: string): Promise<DeviceRevokeResult> => {
    const { local, relayId, found, relay } = await serialize(async () => {
      const before = readDevices(await readAgentJson())
      const entry = before.find((d) => d.id === id)
      const relayId = entry?.relayDeviceId
      const boxKey = entry?.relayBoxKey
      const found = !!entry
      let devices: DeviceEntry[]
      let legacyRelayRevoked = false
      try {
        // A legacy entry has no recorded relay key to revoke precisely: use the phone-only
        // fallback before removing it. A recorded key follows the exact-key path below, leaving
        // other paired phones and another pairing of this same key authorized. A stale id does
        // not invoke either revoker.
        if (found && !boxKey && options.revokePhoneRelayTrust) {
          const relay = await options.revokePhoneRelayTrust()
          if (!relay.persisted || !relay.killed) {
            throw new Error(`relay trust revoke incomplete (persisted=${relay.persisted}, killed=${relay.killed})`)
          }
          legacyRelayRevoked = true
        }
        await removeAuthorizedKeysForDevice(id)
        await removeAdministratorsKeysForDevice(id)
        const obj = await readAgentJson()
        devices = removeDevice(readDevices(obj), id)
        await writeAgentJson({ ...obj, devices })
      } catch (err) {
        // Reported, not thrown: `local:false` is what the UI turns into "try again", and the
        // server leg below is still worth running. The detail belongs in the log.
        console.warn('[pairing] local revoke failed:', err)
        return { local: false, relayId, found, relay: undefined }
      }
      // The relay pin made at pairing goes with the device, and so do the relay sessions that key
      // has open — unless another pairing of the same phone (a re-pair keeps its box key) is still
      // listed: that pairing still authorizes the phone, its pin and its session.
      if (!entry) {
        return { local: true, relayId, found, relay: undefined }
      }
      // Older pairings did not record a relay identity. Without the phone-only fallback, do not
      // guess from the approved-key store
      // or call a different peer's revoker: local removal cannot confirm remote access is gone.
      if (!boxKey) return { local: true, relayId, found, relay: legacyRelayRevoked ? 'ok' as const : 'unconfirmed' as const }
      if (devices.some((d) => d.relayBoxKey === boxKey)) {
        return { local: true, relayId, found, relay: 'retained' as const }
      }
      if (!relayDeps?.revokeRelayKey) {
        return { local: true, relayId, found, relay: 'unconfirmed' as const }
      }
      // Unpins the key, then closes the relay sessions it has open right now (peer-revoker.ts).
      // A revoker that throws said nothing about the pin, so it counts as an unpin that failed.
      const outcome = await relayDeps.revokeRelayKey(boxKey).catch((err) => {
        console.warn('[pairing] could not revoke the phone relay key:', err)
        return null
      })
      if (outcome?.persisted) {
        if (outcome.killed) return { local: true, relayId, found, relay: 'ok' as const }
        // The pin is gone, so the phone cannot come back; a session whose close threw may still be
        // half open, and the UI says so rather than "Removed".
        console.warn('[pairing] could not close the phone relay session')
        return { local: true, relayId, found, relay: 'cut-unconfirmed' as const }
      }
      console.warn('[pairing] could not unpin the phone relay key; keeping the device listed so Revoke can be retried')
      try {
        const obj = await readAgentJson()
        const now = readDevices(obj).filter((d) => d.id !== id)
        const at = Math.min(Math.max(before.findIndex((d) => d.id === id), 0), now.length)
        await writeAgentJson({ ...obj, devices: [...now.slice(0, at), entry, ...now.slice(at)] })
      } catch (err) {
        // Both writes failed: the device is gone and its pin may not be. Still `local:false`, so
        // the UI does not report a clean removal.
        console.warn('[pairing] could not keep the device listed after the failed unpin:', err)
      }
      return { local: false, relayId, found, relay: 'unpin-failed' as const }
    })
    // A device paired before `relayDeviceId` was recorded still falls back to OUR id — which is
    // not a guess. `id` is the per-pairing `randomUUID()` above, and when the phone sent no id of
    // its own the mint sent exactly this value as the row's `deviceId` (see `phoneDeviceId`), so
    // the row really is keyed on it. It is NOT this desktop's machine id (`getDeviceId()`), which
    // is never a key in `relay_devices` — it lives only in the non-key `host_device_id` column,
    // and /v1/relay/host-token writes no row at all — so this cannot reach the desktop's own
    // registration. Nor can it reach a stranger's: the route authorizes by the row's licenseId /
    // hostDeviceId and answers 403 otherwise, and 204 (no write) for a row carrying a
    // 'free:'/'apple:' id — which is what keeps an Apple purchase bridged to this desktop safe.
    //
    // RESIDUAL LEAK, deliberately not closed here: a pre-Task-12 pairing where the phone DID send
    // its own id (every iOS build since 2026-07-10 does) has a row keyed by a value we never
    // recorded, and the backend's 204 reveals nothing — so this reports 'ok' having asked about a
    // row that is not that phone's, and the phone keeps Pro. The desktop cannot name that row at
    // all; re-pairing the phone records its id (the phone's id is stable and the mint upserts on
    // it), after which a removal revokes for real. Closing it properly needs a
    // server-side "devices for this host" read, which does not exist yet.
    //
    // Deliberately OUTSIDE the mutation chain: this is a network round trip, and holding the
    // agent.json/authorized_keys queue open for it would stall a concurrent pairing POST behind
    // an unreachable backend. No local state depends on the answer.
    const server = found
      ? await revokeRelayDevice(
          relayDeps?.apiBase ?? '',
          relayId ?? id,
          relayDeps?.getEntitlement() ?? null
        )
      : 'skipped'
    return relay ? { local, server, relay } : { local, server }
  }

  const approvePairedRelayKey = async (boxPublicKeyB64: string): Promise<boolean> => {
    if (!isValidBoxPublicKeyB64(boxPublicKeyB64) || !relayDeps?.pinRelayKeyIfPaired) return false
    // Read fresh each time, not through `serialize`: agent.json is published by atomic rename, so
    // this sees the file either before or after a revoke's write, and the ordering argument on
    // `pinRelayKeyIfPaired` covers both. A missing or malformed file lists no device ⇒ no pin.
    const stillPaired = async (): Promise<boolean> =>
      holdsPairedRelayKey(readDevices(await readAgentJson()), boxPublicKeyB64)
    // Asked once BEFORE the pin store's queue, so the commonest unpinned handshake (a key no
    // pairing recorded: an iOS phone, a pairing older than A07, a stranger) is answered with one
    // file read and never waits behind, or writes, the pin store (review of A07-late). A "no"
    // pins nothing, so it cannot undo a revoke; only a "yes" has to be asked again in the queue.
    try {
      if (!(await stillPaired())) return false
      return await relayDeps.pinRelayKeyIfPaired(boxPublicKeyB64, stillPaired)
    } catch (err) {
      // The SAS dialog is the fallback, exactly as before this existed.
      console.warn('[pairing] could not pin a paired phone relay key:', err)
      return false
    }
  }

  return { start, stop, listNetworks: () => pairingNetworkChoices(interfaces()), listDevices, revokeDevice, probeSsh, approvePairedRelayKey, legacyRelayPairings }
}
