// known_hosts for the in-process transport, with the semantics the argv builders ask OpenSSH for:
// `StrictHostKeyChecking=accept-new` — a host never seen before is recorded and accepted; a host
// whose recorded key CHANGED is refused (the MITM case), and so is a key marked @revoked.
//
// The file format is OpenSSH's (sshd(8) "SSH_KNOWN_HOSTS FILE FORMAT"), read from the same files
// `ssh -G` reports (userknownhostsfile + globalknownhostsfile), so a host the user already trusts
// with their own ssh is trusted here, and one we record is trusted by their ssh too:
//   [@marker] host-patterns keytype base64-key [comment]
// Host patterns are comma-separated; `[host]:port` for a non-22 port; `*`/`?` wildcards; `!`
// negation; `|1|salt|hmac` for HashKnownHosts entries (HMAC-SHA1 of the name, keyed by the salt).
// @cert-authority lines are ignored (the native transport does not do host certificates), which
// can only make a host look UNKNOWN, never trusted.

import { createHmac } from 'crypto'
import fs from 'fs'
import path from 'path'

export type HostKeyVerdict = 'match' | 'mismatch' | 'revoked' | 'unknown'

/** The key type out of an ssh wire-format public key blob (`string keytype` comes first). */
export function keyTypeOfBlob(blob: Buffer): string | null {
  if (blob.length < 4) return null
  const n = blob.readUInt32BE(0)
  if (n <= 0 || 4 + n > blob.length || n > 64) return null
  return blob.subarray(4, 4 + n).toString('latin1')
}

/** The name a host is looked up under: bare for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function globMatch(pattern: string, name: string): boolean {
  let re = '^'
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$', 'i').test(name)
}

function hashedMatch(entry: string, name: string): boolean {
  // |1|base64(salt)|base64(hmac-sha1(salt, name))
  // HMAC-SHA1 is not our choice: it is what OpenSSH's HashKnownHosts writes, and we only READ the
  // user's existing entries — any other algorithm could never match them. The input is a host name
  // (the hash only hides it from someone reading the file), not a secret. CodeQL's weak-crypto
  // alert on this line was reviewed and dismissed as a false positive for that reason.
  const parts = entry.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2], 'base64')
    const want = Buffer.from(parts[3], 'base64')
    const got = createHmac('sha1', salt).update(name).digest()
    return got.length === want.length && got.equals(want)
  } catch {
    return false
  }
}

/** Whether a host-patterns field matches `name` (a negated match anywhere wins, as in OpenSSH). */
export function hostPatternsMatch(field: string, name: string): boolean {
  if (field.startsWith('|')) return hashedMatch(field, name)
  let hit = false
  for (const raw of field.split(',')) {
    if (!raw) continue
    const neg = raw.startsWith('!')
    const pat = neg ? raw.slice(1) : raw
    if (globMatch(pat, name)) {
      if (neg) return false
      hit = true
    }
  }
  return hit
}

interface Entry {
  marker?: string
  hosts: string
  keyType: string
  key: Buffer
}

export function parseKnownHosts(text: string): Entry[] {
  const out: Entry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const f = line.split(/\s+/)
    let i = 0
    let marker: string | undefined
    if (f[0].startsWith('@')) marker = f[i++]
    const hosts = f[i++]
    const keyType = f[i++]
    const b64 = f[i++]
    if (!hosts || !keyType || !b64) continue
    let key: Buffer
    try {
      key = Buffer.from(b64, 'base64')
    } catch {
      continue
    }
    if (key.length === 0) continue
    out.push({ marker, hosts, keyType, key })
  }
  return out
}

/**
 * The verdict for `blob` presented by `name` (already in knownHostsName form), across all files.
 * Order of precedence follows OpenSSH: a matching @revoked key refuses; a matching key accepts;
 * a recorded key of the SAME type that differs is a mismatch; otherwise the host is unknown.
 * A different key TYPE for a known host is "unknown", not a mismatch — OpenSSH offers the types it
 * has on record first, and a host that genuinely serves several types records each separately.
 */
export function verifyHostKey(texts: string[], name: string, blob: Buffer): HostKeyVerdict {
  const type = keyTypeOfBlob(blob)
  let sawSameTypeDifferent = false
  let matched = false
  for (const text of texts) {
    for (const e of parseKnownHosts(text)) {
      if (e.marker === '@cert-authority') continue
      if (!hostPatternsMatch(e.hosts, name)) continue
      if (e.marker === '@revoked') {
        if (e.key.equals(blob)) return 'revoked'
        continue
      }
      if (e.key.equals(blob)) matched = true
      else if (e.keyType === type) sawSameTypeDifferent = true
    }
  }
  if (matched) return 'match'
  return sawSameTypeDifferent ? 'mismatch' : 'unknown'
}

function readIfPresent(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** The line `accept-new` appends for a first-seen host. */
export function knownHostsLine(name: string, blob: Buffer): string | null {
  const type = keyTypeOfBlob(blob)
  if (!type) return null
  return `${name} ${type} ${blob.toString('base64')}`
}

export interface HostKeyPolicy {
  userFiles: string[]
  globalFiles: string[]
}

/**
 * The accept-new decision, with the file side effects: an unknown key is appended to the FIRST
 * user known_hosts file (created with its directory, 0600/0700 — ssh's own modes) and accepted;
 * a match accepts; mismatch / revoked refuse. Returns the verdict that decided it so the caller
 * can name the reason in the connection error.
 */
export function acceptNewHostKey(
  policy: HostKeyPolicy,
  host: string,
  port: number,
  blob: Buffer
): { accept: boolean; verdict: HostKeyVerdict } {
  const name = knownHostsName(host, port)
  const texts = [...policy.userFiles, ...policy.globalFiles].map(readIfPresent)
  const verdict = verifyHostKey(texts, name, blob)
  if (verdict === 'match') return { accept: true, verdict }
  if (verdict !== 'unknown') return { accept: false, verdict }
  const line = knownHostsLine(name, blob)
  const file = policy.userFiles[0]
  if (!line || !file) return { accept: false, verdict }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const existing = readIfPresent(file)
    const sep = existing && !existing.endsWith('\n') ? '\n' : ''
    // An append, not a rewrite: other ssh processes read and append to this file concurrently,
    // and replacing it would lose a line one of them wrote in between.
    fs.appendFileSync(file, `${sep}${line}\n`, { mode: 0o600 })
  } catch {
    // Could not record it. OpenSSH's accept-new warns ("Failed to add the host to the list of
    // known hosts") and connects anyway; the transport must mean the same thing, so it does too —
    // the next connection simply asks again.
  }
  return { accept: true, verdict }
}
