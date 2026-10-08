// What this computer tells a paired phone about its own direct-SSH leg, next to every relay
// `projects.list` answer (audit A74-refresh).
//
// The phone's LAN leg dials the address the pairing QR carried (`pairingNetworkIPv4`, pairing-service.ts) and
// checks the SSH host key against what the sealed `/pair` answer named (`sshHostKeyFingerprints`,
// audit A49-anchor). Both are facts about the moment of pairing: a DHCP lease moves, and a reinstall
// regenerates sshd's keys. The relay leg authenticates this computer on its own (the phone pinned this
// computer's box key at pairing, and the session is E2EE to it and approved), so an answer that comes
// back over it can tell the phone the CURRENT address and keys, and the phone may update its record from
// it. Nothing taken over SSH ever does: the SSH leg is the thing being checked.
//
// Additive on the wire: `{ output, lan: { host?, sshHostKeyFingerprints? } }`. A phone that does not
// read `lan` (the iOS app today, an older Android build) sees the reply it always saw.

import os from 'os'
import { pairingNetworkIPv4, type PairingInterfaces } from '../../shared/pairing-network'
import { readSshHostKeyFingerprints, SSH_HOST_KEY_DIRS } from '../ssh-host-keys'

/** The `lan` field of a `projects.list` answer. Each part is left out when it is unknown. */
export interface HostLanReport {
  /** This computer's LAN IPv4, picked exactly as the pairing QR picks its `host`. */
  host?: string
  /** `SHA256:…` of this computer's SSH host keys, exactly as the sealed `/pair` answer carries them. */
  sshHostKeyFingerprints?: string[]
}

export interface HostLanReporterOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Defaults to `os.networkInterfaces`. */
  interfaces?: () => PairingInterfaces
  /** Same saved adapter NAME used by pairing; read on each report. Empty means automatic. */
  getPairingInterface?: () => string
  /** Where sshd's host keys and config are read from. Defaults to `SSH_HOST_KEY_DIRS`. */
  sshHostKeyDirs?: readonly string[]
  /** How long one read of the host keys is reused. Defaults to `HOST_KEYS_TTL_MS`. */
  keysTtlMs?: number
  /** Defaults to `Date.now`. */
  now?: () => number
}

/**
 * The phone lists every 8 s while a screen shows the computer. Host keys change on a reinstall, not
 * between two polls, so one read of `/etc/ssh` serves a minute of them. The address is read every time
 * (`os.networkInterfaces()` asks the kernel, no disk).
 */
export const HOST_KEYS_TTL_MS = 60_000

/**
 * A reader of this computer's current `HostLanReport`. Never rejects. Answers null when there is
 * nothing to report, and always on Windows: a Windows desktop pairs relay-only (pairing-service.ts,
 * `directSsh`), so the phone has no SSH leg to refresh.
 */
export function createHostLanReporter(options: HostLanReporterOptions = {}): () => Promise<HostLanReport | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return async () => null
  const interfaces = options.interfaces ?? os.networkInterfaces
  const dirs = options.sshHostKeyDirs ?? SSH_HOST_KEY_DIRS
  const ttl = options.keysTtlMs ?? HOST_KEYS_TTL_MS
  const now = options.now ?? Date.now
  let keys: { at: number; read: Promise<string[]> } | null = null

  const hostKeys = (): Promise<string[]> => {
    const t = now()
    if (!keys || t - keys.at >= ttl) {
      keys = { at: t, read: readSshHostKeyFingerprints(dirs).catch(() => []) }
    }
    return keys.read
  }

  return async () => {
    let host: string | null = null
    try {
      host = pairingNetworkIPv4(interfaces(), options.getPairingInterface?.() ?? '')
    } catch {
      host = null
    }
    const fingerprints = await hostKeys()
    if (!host && !fingerprints.length) return null
    return {
      ...(host ? { host } : {}),
      ...(fingerprints.length ? { sshHostKeyFingerprints: fingerprints } : {})
    }
  }
}
