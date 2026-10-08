import { pairingNetworkIPv4, type PairingNetworkAddress, type PairingInterfaces } from '../shared/pairing-network'

// Pure helpers for the phone-pairing service (no I/O), so they can be unit-tested with fakes.
//
// The QR payload + the authorized_keys line validation are the two bits of the pairing flow
// with a fixed on-the-wire contract shared with the nodeterm iOS app — keep them here, pure.

import { CONTROL_RE } from '../core/relay/team-admin'

/**
 * The relay block optionally embedded in the QR payload (and the /pair HTTP response). Present
 * only when this host has phone-access (standing relay host) enabled + Pro, so the phone can
 * reach it over the relay from anywhere. Absent → the phone is LAN-only (pre-P3 behavior).
 * Matches the iOS contract exactly.
 */
export interface RelayPairingBlock {
  /** The relay broker room id: base64url(sha256(hostPublicKey)).slice(0,22). */
  hostId: string
  /** The host's NaCl box public key (standard base64), for the phone's E2EE handshake. */
  hostPublicKeyB64: string
  /** The relay WebSocket endpoint the phone connects to. */
  relayEndpoint: string
}

/** Inputs for the QR payload the iOS app scans. `port` defaults to 22 (SSH). */
export interface PairingPayloadInput {
  host: string
  port?: number
  user: string
  token: string
  pairPort: number
  name: string
  /**
   * The host's NaCl box public key (standard base64), authenticated by being shown on the host's
   * own screen. When present, the phone encrypts the whole /pair exchange to it (E2EE). Omitted →
   * the phone POSTs plaintext, exactly as before.
   */
  hostKey?: string
  /** Optional relay reachability block (standing host). Omitted from the payload when absent. */
  relay?: RelayPairingBlock
  /**
   * `false` = this host installs NO SSH key and cannot be driven over SSH, so the phone must reach
   * it through the relay alone. Set on Windows, where every command the phone sends over SSH
   * assumes a POSIX login shell and tmux (Windows OpenSSH hands out cmd.exe, and sessions live in
   * the session host, which the phone cannot attach to over SSH). Omitted otherwise, which keeps
   * every other platform's payload byte-identical.
   */
  ssh?: false
}

/**
 * Build the single-line JSON the QR encodes. The key order + compact separators match the
 * contract the phone parses:
 *   {"v":1,"host":"…","port":22,"user":"…","token":"…","pairPort":N,"nodeterm":true,"name":"…"}
 * When a host key is supplied it is appended as `"hostKey":"…"` after `name`; when a relay block is
 * supplied it is appended as `"relay":{…}` after that. With neither, the payload is byte-for-byte
 * the legacy LAN-only shape.
 */
export function buildPairingPayload(input: PairingPayloadInput): string {
  const base = {
    v: 1,
    host: input.host,
    port: input.port ?? 22,
    user: input.user,
    token: input.token,
    pairPort: input.pairPort,
    nodeterm: true,
    name: input.name
  }
  const withKey = input.hostKey ? { ...base, hostKey: input.hostKey } : base
  const withRelay = input.relay ? { ...withKey, relay: input.relay } : withKey
  return JSON.stringify(input.ssh === false ? { ...withRelay, ssh: false } : withRelay)
}

/**
 * Validate that a phone-supplied public key is a well-formed `ssh-ed25519` line
 * (`ssh-ed25519 AAAA… comment`). Anything else → the listener answers 400.
 * Beyond the textual prefix we decode the base64 blob and check its embedded algorithm
 * name, so a spoofed `ssh-ed25519 <garbage>` line can't slip through.
 */
export function isValidEd25519PublicKey(line: string): boolean {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 2) return false
  if (parts[0] !== 'ssh-ed25519') return false
  const b64 = parts[1]
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return false
  }
  // OpenSSH wire format: uint32 length-prefixed algorithm name comes first.
  if (buf.length < 4) return false
  const nameLen = buf.readUInt32BE(0)
  const NAME = 'ssh-ed25519'
  if (nameLen !== NAME.length || buf.length < 4 + nameLen) return false
  return buf.subarray(4, 4 + nameLen).toString('ascii') === NAME
}

/** Collapse a public-key line to the single trimmed line we append to authorized_keys. */
export function normalizeAuthorizedKeysLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/**
 * The attributable comment stamped onto every key paired from now on. One deterministic token
 * (`nodeterm-mobile-<deviceId>`) is what lets revocation find & delete the exact line later.
 * Platform-neutral: iOS and Android phones get the same stamp.
 */
export const DEVICE_KEY_COMMENT_PREFIX = 'nodeterm-mobile-'

/**
 * The stamp used while the companion was iOS-only. Every iPhone paired before the rename still
 * carries it in authorized_keys, and revoke MUST keep matching it — a revoke that only knew the
 * new prefix would report the phone removed while its SSH key stayed live. Never stamped again.
 */
export const LEGACY_DEVICE_KEY_COMMENT_PREFIX = 'nodeterm-ios-'

export function deviceCommentFor(deviceId: string): string {
  return `${DEVICE_KEY_COMMENT_PREFIX}${deviceId}`
}

/** Every comment a key for `deviceId` may carry: the current stamp first, then the legacy one. */
export function deviceCommentsFor(deviceId: string): string[] {
  return [deviceCommentFor(deviceId), `${LEGACY_DEVICE_KEY_COMMENT_PREFIX}${deviceId}`]
}

/**
 * Rewrite an incoming public-key line so its comment is exactly `nodeterm-mobile-<deviceId>`,
 * replacing whatever comment the phone sent (the iOS app sends `nodeterm-ios`) while keeping the
 * key type + base64 blob intact. The result is already normalized (single-space separated),
 * ready for authorized_keys.
 */
export function rewriteKeyComment(publicKey: string, deviceId: string): string {
  const parts = normalizeAuthorizedKeysLine(publicKey).split(' ')
  const type = parts[0] ?? ''
  const blob = parts[1] ?? ''
  return `${type} ${blob} ${deviceCommentFor(deviceId)}`
}

/**
 * Remove every authorized_keys line whose comment is EXACTLY one of `deviceCommentsFor(deviceId)`
 * (current or legacy stamp), preserving all other lines (including blanks, other keys' comments,
 * and the trailing newline) byte-for-byte. The caller writes the result back atomically.
 */
export function filterAuthorizedKeys(content: string, deviceId: string): string {
  const targets = new Set(deviceCommentsFor(deviceId))
  return content
    .split('\n')
    .filter((line) => {
      const parts = line.trim().split(/\s+/)
      // comment = everything after the key type + base64 blob
      return !targets.has(parts.slice(2).join(' '))
    })
    .join('\n')
}

/** A device identity minted at pairing time and persisted into ~/.nodeterm/agent.json. */
export interface DeviceEntry {
  id: string
  name: string
  /** Bearer token the phone uses on the host-agent WebSocket. NEVER sent to the renderer. */
  token: string
  pairedAt: number
  lastSeenAt: number
  /**
   * The PHONE's own device id, as sent to `/v1/relay/device` — the key `relay_devices` is stored
   * under. `id` above is ours (it stamps the authorized_keys comment) and means nothing to the
   * backend, so without this a removal could not tell the server WHICH row to revoke.
   * Absent for devices paired before this field existed; equal to `id` when the phone sent no id
   * of its own. Recorded for a LAN-only pairing too — the phone identifies itself either way — so
   * its presence names a row the server MAY hold, not one it certainly does.
   */
  relayDeviceId?: string
  /**
   * The phone's relay (NaCl box) public key, base64, when it sent one inside the SEALED `/pair`
   * body. Pairing pins it on the standing host when the pairing minted a relay leg (audit A07);
   * otherwise the standing host pins it on the phone's first relay handshake while this entry is
   * listed (A07-late: remote access turned on after the scan, the phone adopting the relay over
   * SSH). Revoking the device unpins it again and closes the relay sessions it has open
   * (A07-revoke). Recorded whether or not a relay leg was minted.
   * Absent for pairings made before this field existed and for phones that do not send it.
   */
  relayBoxKey?: string
  /**
   * `false` = no SSH key was installed for this device (a Windows pairing: the phone reaches this
   * host through the relay only). Absent on every pairing that did install one, including all
   * pairings made before this field existed. Revoke still sweeps the key files either way.
   */
  ssh?: false
}

/** The device shape safe to expose to the renderer (no `token`). */
export type PublicDevice = Omit<DeviceEntry, 'token'>

/** The comment the shipped iOS app puts on the key it generates (nodeterm-ios PairingService). */
export const IOS_APP_KEY_COMMENT = 'nodeterm-ios'

/** A phone-sent name is shown in Settings and sent as the relay label; keep it one short line (graphemes). */
export const DEVICE_NAME_MAX = 64

const CONTROL_RE_GLOBAL = new RegExp(CONTROL_RE.source, 'gu')
/** Zero-width characters with no visible glyph (NOT U+200D, which joins emoji). */
const INVISIBLE_RE = /[\u200B\u200C\u2060\uFEFF]/g
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The comment part of a public-key line (everything after type + blob), whitespace-collapsed. */
export function keyCommentOf(publicKey: string): string {
  return normalizeAuthorizedKeysLine(publicKey).split(' ').slice(2).join(' ')
}

/**
 * The name a paired phone is listed (and relay-labelled) under.
 *
 * The name the phone sends wins — Android sends one. Control characters and newlines collapse to
 * single spaces; bidi / direction marks (the repo's Trojan-Source set, `CONTROL_RE`) become spaces
 * too, and the zero-width characters U+200B, U+200C, U+2060 and U+FEFF are removed outright (U+200D
 * is kept: it joins legitimate emoji). The result is capped at DEVICE_NAME_MAX GRAPHEMES, so a
 * ZWJ emoji is kept whole or cut whole, never left with a dangling joiner. A name with no visible
 * content after that (empty, or only U+200D) counts as no name.
 * With no usable name the fallback is the neutral 'Phone' — EXCEPT for the iOS app, which has
 * never sent a name: it is recognised by its fixed key comment and keeps the 'iPhone' every iPhone
 * paired so far was given. Without that branch every newly paired iPhone would silently become
 * "Phone".
 */
export function normalizeDeviceName(name: unknown, publicKey = ''): string {
  if (typeof name === 'string') {
    const flat = name
      .replace(CONTROL_RE_GLOBAL, ' ')
      .replace(INVISIBLE_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
    const capped = Array.from(GRAPHEME_SEGMENTER.segment(flat), (g) => g.segment)
      .slice(0, DEVICE_NAME_MAX)
      .join('')
      .trim()
    if (capped.replace(/\u200D/g, '').trim()) return capped
  }
  return keyCommentOf(publicKey) === IOS_APP_KEY_COMMENT ? 'iPhone' : 'Phone'
}

/**
 * Extract the `devices` array from a parsed agent.json object. A missing / malformed
 * `devices` is treated as empty (back-compat: the host agent writes only {v, port, token}).
 */
export function readDevices(agentJson: unknown): DeviceEntry[] {
  if (!agentJson || typeof agentJson !== 'object') return []
  const devices = (agentJson as { devices?: unknown }).devices
  return Array.isArray(devices) ? (devices as DeviceEntry[]) : []
}

/** Append `entry`, or replace an existing device with the same id (idempotent by id). */
export function upsertDevice(devices: DeviceEntry[], entry: DeviceEntry): DeviceEntry[] {
  return [...devices.filter((d) => d.id !== entry.id), entry]
}

/** A NaCl box public key as base64: exactly 32 bytes. */
export function isValidBoxPublicKeyB64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  return Buffer.from(value, 'base64').length === 32
}

/**
 * Does a listed pairing hold `boxKeyB64` as the relay key its phone sent in the sealed `/pair` body
 * (A07-late)? What the standing host asks before pinning a phone it has not pinned yet: the scan that
 * recorded the key is the approval, as at pairing. Exact string match against what pairing recorded,
 * so a hand-edited entry carrying junk matches nothing. An empty key never matches.
 */
export function holdsPairedRelayKey(devices: DeviceEntry[], boxKeyB64: string): boolean {
  return boxKeyB64.length > 0 && devices.some((d) => d.relayBoxKey === boxKeyB64)
}

/** Drop the device with the given id (no-op if absent). */
export function removeDevice(devices: DeviceEntry[], id: string): DeviceEntry[] {
  return devices.filter((d) => d.id !== id)
}

/**
 * Strip the secret `token` from each device before handing the list to the renderer. Built field
 * by field on purpose: spreading the entry would carry the token out with every future field.
 */
export function toPublicDevices(devices: DeviceEntry[]): PublicDevice[] {
  return devices.map(({ id, name, pairedAt, lastSeenAt, relayDeviceId }) => ({
    id,
    name,
    pairedAt,
    lastSeenAt,
    relayDeviceId
  }))
}

/** Compatibility export for callers using the pairing core's structural OS address type. */
export type NetInterfaceAddr = PairingNetworkAddress

/** Automatic pairing uses the same current-adapter policy as QR and LAN refresh. */
export function pickLanIPv4(interfaces: PairingInterfaces): string | null {
  return pairingNetworkIPv4(interfaces)
}

/** Windows' current OS route hint has precedence within the shared automatic policy. */
export function pickPairingIPv4(
  interfaces: PairingInterfaces,
  routeAddress: string | null
): string | null {
  return pairingNetworkIPv4(interfaces, '', routeAddress)
}
