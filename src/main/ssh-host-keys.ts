// This computer's own SSH host keys, as the fingerprints a paired phone checks its first SSH connect
// against (audit A49-anchor).
//
// Without them the phone's first connect is trust on first use: it pins whichever key answers at the
// paired address, once that server has accepted the phone's key. The pairing already crosses a channel
// that proves which computer is on the other end (the `/pair` body is sealed to the host key the QR on
// this screen carries), so the desktop hands the phone its host key fingerprints inside that sealed
// answer, and the first connect must present one of them.
//
// Read-only and never fatal: an unreadable directory, file or config yields nothing for it, and a
// pairing whose answer carries no fingerprints leaves the phone on its trust-on-first-use pin, exactly
// as before. The fingerprint is OpenSSH's (`ssh-keygen -l -E sha256`), which is also what sshj reports
// on the phone: `SHA256:` + the unpadded standard base64 of the SHA-256 of the key blob.

import { createHash } from 'crypto'
import { constants, promises as fs } from 'fs'
import path from 'path'

/**
 * Where sshd keeps its host keys and its config. `/etc/ssh` on Linux and on macOS 10.11 and later;
 * macOS 10.10 and older kept `ssh_host_*_key` and `sshd_config` directly in `/etc` (`/private/etc`).
 */
export const SSH_HOST_KEY_DIRS: readonly string[] = ['/etc/ssh', '/etc']

/** The most fingerprints a pairing answer carries. sshd serves three or four; the phone keeps as many. */
export const MAX_SSH_HOST_KEYS = 16

/** A `.pub` larger than this is not a host public key (an RSA-16384 line is under 3 KiB). */
const MAX_PUB_BYTES = 16 * 1024
/** sshd_config files larger than this are not read. */
const MAX_CONFIG_BYTES = 256 * 1024

/** Discovery is a best-effort read of administrator config, never an unbounded directory walk. */
export const SSH_HOST_KEY_DISCOVERY_LIMITS = {
  depth: 16,
  configFiles: 128,
  totalConfigBytes: 1024 * 1024,
  directoryEntries: 4096,
  includeMatches: 256,
  includePatternBytes: 4096,
  publicFiles: 256
} as const

/** The default host key names sshd generates: `ssh_host_ed25519_key.pub` and the like. */
const HOST_KEY_PUB = /^ssh_host_[A-Za-z0-9_]+_key\.pub$/
/** An SSH public key algorithm name (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `sk-ssh-ed25519@openssh.com`). */
const KEY_TYPE = /^[a-z0-9][a-z0-9.@-]*$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * OpenSSH's `SHA256:<unpadded base64>` fingerprint of the first key line in [text] (a `.pub` file), or
 * null when that line is not a plain public key: a certificate, a blob that does not name its own
 * type, or anything that is not base64. Comment and blank lines before it are skipped.
 */
export function sshFingerprintOfPublicKeyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [type, b64] = line.split(/\s+/)
    if (!type || !b64 || !KEY_TYPE.test(type) || type.includes('-cert-') || !BASE64.test(b64)) return null
    const blob = Buffer.from(b64, 'base64')
    // The blob opens with its own key type as an SSH string (RFC 4253 §6.6). One that does not is not
    // the key its line names, and its fingerprint would match nothing a server presents.
    if (blob.length < 4) return null
    const n = blob.readUInt32BE(0)
    if (n !== Buffer.byteLength(type) || blob.length <= 4 + n) return null
    if (blob.subarray(4, 4 + n).toString('latin1') !== type) return null
    return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  }
  return null
}

/** The fingerprint of one `.pub` file, or null when it cannot be read or is not a key. */
async function fingerprintOfFile(file: string): Promise<string | null> {
  try {
    // A public-name symlink must not turn this reader into a private-key reader.
    const real = await fs.realpath(file)
    if (!real.endsWith('.pub')) return null
    const read = await readBoundedText(real, MAX_PUB_BYTES)
    return read ? sshFingerprintOfPublicKeyLine(read.text) : null
  } catch {
    return null
  }
}

/** Bound the read itself as well as stat: a growing file cannot evade the byte limit. */
async function readBoundedText(file: string, limit: number): Promise<{ text: string; bytes: number } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const before = await fs.stat(file)
    if (!before.isFile() || before.size > limit) return null
    // The second stat checks the opened inode. Nonblocking/no-follow also protects against a
    // concurrent regular-file replacement by a FIFO or symlink between the first stat and open.
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const st = await handle.stat()
    if (!st.isFile() || st.size > limit) return null
    const buffer = Buffer.alloc(limit + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    return bytes <= limit ? { text: buffer.subarray(0, bytes).toString('utf8'), bytes } : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The absolute `HostKey` paths an sshd config text names. sshd takes `Keyword value` or
 * `Keyword=value`, keywords case-insensitively, and a value in double quotes. A relative or
 * token-bearing path is skipped: there is no telling here what sshd would resolve it to.
 */
export function hostKeyPathsInSshdConfig(text: string): string[] {
  return hostKeyValuesInSshdConfig(text).filter((value) => path.posix.isAbsolute(value))
}

/** Relative declarations are useful only for excluding private reads, never for guessing anchors. */
function hostKeyValuesInSshdConfig(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*hostkey(?:\s*=\s*|\s+)(.*)$/i.exec(raw)
    if (!m) continue
    let value = m[1].trim()
    const quoted = /^"([^"]*)"/.exec(value)
    value = quoted ? quoted[1] : value.split(/\s+/)[0]
    if (value && !value.includes('%') && !value.includes('\0')) out.push(value)
  }
  return out
}

/** Include values, with quoted whitespace, multiple paths and comments outside quotes. */
export function includePathsInSshdConfig(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const directive = /^\s*include(?:\s*=\s*|\s+)(.*)$/i.exec(raw)
    if (!directive) continue
    const words: string[] = []
    let word = ''
    let quoted = false
    for (const char of directive[1]) {
      if (char === '"') quoted = !quoted
      else if (!quoted && char === '#') break
      else if (!quoted && /\s/.test(char)) {
        if (word) words.push(word)
        word = ''
      } else word += char
    }
    if (quoted) continue // An invalid directive must not produce guessed paths.
    if (word) words.push(word)
    out.push(...words.filter((value) => !value.includes('%') && !value.includes('\0')))
  }
  return out
}

type Discovery = {
  files: number
  bytes: number
  entries: number
  matches: number
  visited: Set<string>
  privateKeys: Set<string>
  relativePrivateNames: Set<string>
  keyPaths: Set<string>
  keysExhausted: boolean
}

/** POSIX glob components, without shell expansion, globstar recursion or command execution. */
function globComponent(pattern: string): (name: string) => boolean {
  const tokens: Array<'*' | '?' | RegExp | { literal: string }> = []
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' || char === '?') tokens.push(char)
    else if (char === '[') {
      const end = pattern.indexOf(']', i + (pattern[i + 1] === '!' ? 2 : 1))
      if (end < 0) tokens.push({ literal: '[' })
      else {
        const members = pattern.slice(i + 1, end)
        tokens.push(new RegExp('^[' + (members.startsWith('!') ? '^' + members.slice(1) : members).replace(/\\/g, '\\\\') + ']$'))
        i = end
      }
    } else tokens.push({ literal: char })
  }
  // Greedy wildcard matching with a single retry point avoids a backtracking regex over the
  // administrator-supplied pattern. Character-class regexes consume exactly one character.
  return (name) => {
    let at = 0, token = 0, star = -1, retry = 0
    while (at < name.length) {
      const next = tokens[token]
      if (next === '?' || (next instanceof RegExp ? next.test(name[at]) : typeof next === 'object' && next.literal === name[at])) {
        at++; token++
      } else if (next === '*') {
        star = token++; retry = at
      } else if (star >= 0) {
        token = star + 1; at = ++retry
      } else return false
    }
    while (tokens[token] === '*') token++
    return token === tokens.length
  }
}

/** A huge directory exhausts the scan budget instead of returning an arbitrary unsorted prefix. */
async function boundedNames(dir: string, state: Discovery): Promise<string[]> {
  if (state.entries >= SSH_HOST_KEY_DISCOVERY_LIMITS.directoryEntries) return []
  const names: string[] = []
  try {
    const handle = await fs.opendir(dir)
    for await (const entry of handle) {
      if (++state.entries > SSH_HOST_KEY_DISCOVERY_LIMITS.directoryEntries) return []
      names.push(entry.name)
    }
  } catch {
    return []
  }
  return names.sort()
}

async function includeMatches(pattern: string, base: string, state: Discovery): Promise<string[]> {
  if (state.matches >= SSH_HOST_KEY_DISCOVERY_LIMITS.includeMatches ||
      Buffer.byteLength(pattern) > SSH_HOST_KEY_DISCOVERY_LIMITS.includePatternBytes) return []
  // OpenSSH resolves every relative Include under its configuration root (/etc/ssh), including
  // directives inside another included file. The first injected dir models that root in tests.
  const absolute = path.posix.isAbsolute(pattern) ? path.posix.normalize(pattern) : path.posix.resolve(base, pattern)
  let candidates = ['/']
  try {
    for (const component of absolute.split('/').filter(Boolean)) {
      const next: string[] = []
      const glob = /[*?\[]/.test(component) ? globComponent(component) : null
      for (const candidate of candidates) {
        const names = glob ? await boundedNames(candidate, state) : [component]
        for (const name of names) {
          if (glob && ((!component.startsWith('.') && name.startsWith('.')) || !glob(name))) continue
          next.push(path.posix.join(candidate, name))
          if (next.length >= SSH_HOST_KEY_DISCOVERY_LIMITS.includeMatches - state.matches) break
        }
        if (next.length >= SSH_HOST_KEY_DISCOVERY_LIMITS.includeMatches - state.matches) break
      }
      candidates = next
      if (!candidates.length) break
    }
  } catch {
    return [] // e.g. a malformed character range, an unreadable glob directory.
  }
  state.matches += candidates.length
  return candidates
}

const PRIVATE_KEY_NAME = /^(?:ssh_host_[A-Za-z0-9_]+_key|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:key|pem|p12|pfx|pk8|jks|keystore)$/i

/**
 * The host key paths `<dir>/sshd_config`, its bounded Includes and every `sshd_config.d/` file configure. Every file,
 * not only `*.conf`: which drop-ins sshd reads is its `Include` glob's call (`*.conf` on Debian and
 * Fedora; a config may as well include the whole directory), and a key read from a drop-in sshd skips costs
 * nothing (the list is a superset), while a key sshd serves from one this skipped makes the phone
 * refuse SSH to its own computer, and pairing again would only read the same files (review of
 * A49-anchor).
 */
async function configuredHostKeys(dir: string, includeBase: string, state: Discovery): Promise<string[]> {
  const files = [path.join(dir, 'sshd_config')]
  const dropIns = path.join(dir, 'sshd_config.d')
  for (const name of await boundedNames(dropIns, state)) files.push(path.join(dropIns, name))
  const out: string[] = []
  const visit = async (file: string, depth: number): Promise<void> => {
    if (depth > SSH_HOST_KEY_DISCOVERY_LIMITS.depth || state.files >= SSH_HOST_KEY_DISCOVERY_LIMITS.configFiles ||
        state.bytes >= SSH_HOST_KEY_DISCOVERY_LIMITS.totalConfigBytes || state.keysExhausted) return
    if (PRIVATE_KEY_NAME.test(path.basename(file)) || state.privateKeys.has(path.resolve(file)) ||
        state.relativePrivateNames.has(path.basename(file))) return
    state.files++ // failed/unreadable attempts count too.
    const real = await fs.realpath(file).catch(() => null)
    if (!real || state.visited.has(real) || PRIVATE_KEY_NAME.test(path.basename(real)) || state.privateKeys.has(real) ||
        state.relativePrivateNames.has(path.basename(real))) return
    state.visited.add(real)
    const read = await readBoundedText(real, Math.min(MAX_CONFIG_BYTES, SSH_HOST_KEY_DISCOVERY_LIMITS.totalConfigBytes - state.bytes))
    if (!read) return
    state.bytes += read.bytes
    const keys = [...new Set(hostKeyValuesInSshdConfig(read.text))]
    // A glob must not read the private paths this config names, even if they have custom names.
    for (const key of keys.filter((key) => path.posix.isAbsolute(key) && !key.endsWith('.pub'))) {
      state.privateKeys.add(path.resolve(key))
    }
    for (const key of keys) {
      if (state.keyPaths.has(key)) continue
      if (state.keyPaths.size >= SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles) {
        // Stop Include traversal too: an overflow key alias has not been canonicalized, so it
        // cannot safely be ruled out as a private-key target of a later Include.
        state.keysExhausted = true
        break
      }
      state.keyPaths.add(key)
      if (!path.posix.isAbsolute(key)) {
        // The daemon's working directory is unknown. A same-named Include could be its private
        // key, including through a symlink, so exclude lexical and canonical basenames instead
        // of resolving the declaration under our config root. Explicit .pub names stay public.
        const normalized = path.posix.normalize(key)
        if (!normalized.endsWith('.pub')) state.relativePrivateNames.add(path.posix.basename(normalized))
        continue
      }
      out.push(key)
      if (key.endsWith('.pub')) continue
      const realKey = await fs.realpath(key).catch(() => null)
      if (realKey) state.privateKeys.add(realKey)
    }
    if (state.keysExhausted) return
    for (const pattern of includePathsInSshdConfig(read.text)) {
      for (const included of await includeMatches(pattern, includeBase, state)) await visit(included, depth + 1)
    }
  }
  for (const file of files) await visit(file, 0)
  return out
}

/**
 * The fingerprints of this computer's SSH host keys: every `ssh_host_*_key.pub` in [dirs], then the
 * `.pub` beside every key a `HostKey` line in `<dir>/sshd_config`, an included config or `sshd_config.d/`
 * names (or that file itself when it is already a `.pub`, which sshd accepts when the private
 * key lives in an agent), in that order, without duplicates and at most [MAX_SSH_HOST_KEYS]. sshd serves one
 * of its keys per connection, so the list is a superset rather than a guess: a key here that sshd
 * does not serve costs nothing, a key sshd serves that is missing here makes the phone refuse SSH.
 * The first directory models OpenSSH's `/etc/ssh` root for relative Includes. Discovery budgets
 * apply across all directories. Never throws; unreadable/over-budget inputs are left out.
 */
export async function readSshHostKeyFingerprints(dirs: readonly string[] = SSH_HOST_KEY_DIRS): Promise<string[]> {
  const files: string[] = []
  const state: Discovery = {
    files: 0, bytes: 0, entries: 0, matches: 0, visited: new Set(), privateKeys: new Set(), relativePrivateNames: new Set(),
    keyPaths: new Set(), keysExhausted: false
  }
  const includeBase = dirs[0] ?? SSH_HOST_KEY_DIRS[0]
  for (const dir of dirs) {
    const names = await boundedNames(dir, state)
    for (const name of names.filter((n) => HOST_KEY_PUB.test(n)).sort()) files.push(path.join(dir, name))
    for (const key of await configuredHostKeys(dir, includeBase, state)) files.push(key.endsWith('.pub') ? key : `${key}.pub`)
  }
  const out: string[] = []
  for (const file of [...new Set(files)].slice(0, SSH_HOST_KEY_DISCOVERY_LIMITS.publicFiles)) {
    if (out.length >= MAX_SSH_HOST_KEYS) break
    const fp = await fingerprintOfFile(file)
    if (fp && !out.includes(fp)) out.push(fp)
  }
  return out
}
