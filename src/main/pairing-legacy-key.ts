import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import { deviceCommentFor, type DeviceEntry } from './pairing-core'

export const LEGACY_AUTHORIZED_KEYS_LIMIT = 1024 * 1024

/** Fixed host paths only. Descriptor-bound, capped, owner-controlled regular-file snapshot. */
export function readOwnedRegularFile(file: string, limit: number): Buffer | null {
  let fd: number | undefined
  try {
    const directory = lstatSync(path.dirname(file))
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o022 ||
        (process.getuid && directory.uid !== process.getuid())) return null
    const before = lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit ||
        before.mode & 0o022 || (process.getuid && before.uid !== process.getuid())) return null
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null
    const bytes = Buffer.alloc(opened.size + 1)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null)
      if (!n) break
      count += n
    }
    const after = fstatSync(fd)
    const named = lstatSync(file)
    const namedDirectory = lstatSync(path.dirname(file))
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino || !named.isFile() ||
        namedDirectory.dev !== directory.dev || namedDirectory.ino !== directory.ino || !namedDirectory.isDirectory()) return null
    return bytes.subarray(0, count)
  } catch { return null } finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* refusal already returned */ } } }
}

/** Public attribution only, never a private-key reader. */
export function readLegacyPairingKey(file: string, pairingId: string): string | null {
  try {
    const bytes = readOwnedRegularFile(file, LEGACY_AUTHORIZED_KEYS_LIMIT)
    if (!bytes) return null
    const matches = bytes.toString('utf8').split('\n').filter(line =>
      line.trim().split(/\s+/).at(-1) === deviceCommentFor(pairingId))
    // Even identical duplicate attributions are ambiguous; no choice by ordering/signature.
    if (matches.length !== 1) return null
    const parts = matches[0].trim().split(/\s+/)
    if (parts.length !== 3 || parts[0] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return null
    const blob = Buffer.from(parts[1], 'base64')
    if (blob.toString('base64') !== parts[1] || blob.length !== 51 || blob.readUInt32BE(0) !== 11 ||
        blob.subarray(4, 15).toString('ascii') !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) return null
    return blob.subarray(19).toString('base64')
  } catch { return null }
}

/** Private capability version, never sent to the phone or renderer. */
export function legacyPairingEntryVersion(entry: DeviceEntry): string {
  return createHash('sha256').update(JSON.stringify([entry.id, entry.name, entry.token, entry.pairedAt,
    entry.lastSeenAt, entry.relayDeviceId ?? null, entry.ssh ?? null, entry.relayBoxKey ?? null])).digest('hex')
}
