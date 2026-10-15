// Naming rules for a file pulled down from a remote host. Pure and shell-free so the SSH manager
// (and any later transport) share one answer, and so the awkward cases are testable.
//
// The remote name is the only attacker-influenced part of a download's LOCAL path: it comes off
// another machine's filesystem, and it ends up as a write target here. So it is basenamed and
// sanitized before it is joined to anything — never trusted as a path component on its own.
import path from 'node:path'

/**
 * The local filename for a remote path, or null when the remote path names nothing writable
 * (`/`, `.`, `..`, empty). Separators and control characters are replaced rather than rejected:
 * a name like `a\b.txt` is perfectly legal on the remote POSIX host but is a PATH on Windows,
 * and silently refusing the download would be worse than renaming it.
 */
export function safeDownloadBasename(remotePath: string): string | null {
  const base = path.posix.basename(remotePath.replace(/\/+$/, ''))
  if (!base || base === '.' || base === '..' || base === '~') return null
  // eslint-disable-next-line no-control-regex
  const safe = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return safe && safe !== '.' && safe !== '..' ? safe : null
}

/**
 * The n-th candidate name for a collision: `notes.md`, `notes (2).md`, `notes (3).md`. The counter
 * goes before the extension (Finder/Explorer convention) so the file still opens in the right app;
 * a dotfile (`.bashrc`) has no extension to speak of and takes the suffix at the end.
 */
export function candidateName(name: string, attempt: number): string {
  if (attempt <= 1) return name
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a leading-dot name like `.bashrc`.
  if (dot <= 0) return `${name} (${attempt})`
  return `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`
}

/** Windows device names, which name the DEVICE in every directory and with any extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * The local name for one entry INSIDE a downloaded directory tree, or null for one that names
 * nothing (`.`, `..`, empty). The remote host is POSIX, so a child may legally be called `a:b`,
 * `x?.txt` or `CON` — all of which Windows cannot create, and one such child used to fail the whole
 * download. On win32: the characters Windows refuses become `_`, trailing dots/spaces (which Windows
 * silently strips, so two names would alias one file) are dropped, and a device stem is prefixed
 * with `_`. Elsewhere only a separator is neutralized — a name off another machine is never a path.
 */
export function localChildName(name: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!name || name === '.' || name === '..') return null
  if (platform !== 'win32') return name.replace(/[/\x00]/g, '_')
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (!safe) safe = 'download'
  return WINDOWS_RESERVED.test(safe) ? `_${safe}` : safe
}

/**
 * `name`, or the first `candidateName` not already in `taken` (one directory's names so far), and
 * records it. Compared case-insensitively on win32, where `Foo` and `foo` — or `a:b` and `a_b` once
 * sanitized — are the same file and the second would silently overwrite the first.
 */
export function uniqueChildName(name: string, taken: Set<string>, platform: NodeJS.Platform = process.platform): string {
  const key = (n: string): string => (platform === 'win32' ? n.toLowerCase() : n)
  let attempt = 1
  let candidate = name
  while (taken.has(key(candidate))) candidate = candidateName(name, ++attempt)
  taken.add(key(candidate))
  return candidate
}
