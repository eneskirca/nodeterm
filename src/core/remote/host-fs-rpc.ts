// The path jail behind the relay host's filesystem verbs (`fs.*`, `git.*`, `fs.browse`), and the
// folder browser the phone's "new project" sheet walks when the host has no direct SSH (every
// Windows pairing is relay-only).
//
// Pure over an injected platform + fs so the Windows rules are provable on any CI host:
//   - containment uses the FILESYSTEM-OWNING host's path dialect (`path.win32` on a Windows host,
//     `path.posix` elsewhere), never the dialect of whatever machine runs the test;
//   - on win32 the comparison is case-insensitive (NTFS is) and accepts both separators — a
//     case-sensitive `startsWith` would refuse `c:\Users\me\repo` against root `C:\Users\me`, and a
//     looser rule would not be a jail;
//   - a UNC / device path (`\\server\share`, `\\?\C:\…`) is refused whole on win32: it can name
//     another machine, and resolving it against a drive-letter root is not containment;
//   - `..` is normalized away by `resolve`, so `root/../../etc` is outside, as it always was.

import path from 'path'

export interface HostPathDialect {
  platform: NodeJS.Platform
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** A Windows UNC or device-namespace path (`\\server\share`, `//server/share`, `\\?\…`, `\\.\…`). */
export function isWindowsUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/**
 * Lexically resolve `target` and confirm it sits inside one of `roots` (or equals a root), in the
 * host's own path dialect. Symlinks inside a shared root are not chased (the roots are the user's
 * own project directories). On win32 only drive-absolute paths qualify.
 */
export function isWithinRootsFor(target: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  if (!target) return false
  const p = pathFor(platform)
  if (platform === 'win32') {
    if (isWindowsUncOrDevicePath(target)) return false
    // Only a drive-absolute path: `\\foo` and `C:foo` resolve against the PROCESS's current drive
    // / directory, which is not something a remote client may pick.
    if (!/^[A-Za-z]:[\\/]/.test(target)) return false
  }
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  // POSIX keeps the historical rule byte for byte (`path.resolve`, root + separator prefix).
  const resolved = fold(p.resolve(target))
  for (const root of roots) {
    if (!root) continue
    if (platform === 'win32' && (isWindowsUncOrDevicePath(root) || !/^[A-Za-z]:[\\/]/.test(root))) continue
    const r = fold(p.resolve(root))
    if (resolved === r || resolved.startsWith(r + p.sep)) return true
  }
  return false
}

export interface BrowseEntry {
  name: string
  /** Always true — the browser lists directories only. Carried so the phone can share its row model. */
  dir: true
  /** The directory holds a `.git` (a likely project root). */
  git: boolean
}

export interface BrowseFs {
  /** Directory entries with their types (`fs.promises.readdir(p, {withFileTypes:true})`). */
  readdir(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>>
  /** Does this path exist? (For the `.git` marker.) */
  exists(p: string): Promise<boolean>
}

/** At most this many directories per listing: a home directory can hold thousands. */
export const BROWSE_MAX_ENTRIES = 500

/**
 * `fs.browse { path? }`: list the DIRECTORIES of `target` (default: the host's home), jailed to
 * that home. `null` = refused (outside home, UNC/other drive on win32, relative) or unreadable — the
 * phone shows "can't open this folder", never another machine's tree. Hidden (`.`-prefixed)
 * directories are skipped; the listing is sorted and capped at `BROWSE_MAX_ENTRIES` (`truncated`).
 */
export async function browseHostDirectory(
  target: string | undefined,
  opts: { platform: NodeJS.Platform; home: string; fs: BrowseFs; maxEntries?: number }
): Promise<{ path: string; parent: string | null; entries: BrowseEntry[]; truncated: boolean } | null> {
  const p = pathFor(opts.platform)
  const home = opts.home
  if (!home || !p.isAbsolute(home)) return null
  const want = target && target.length > 0 ? target : home
  if (!p.isAbsolute(want)) return null
  if (!isWithinRootsFor(want, [home], opts.platform)) return null
  const dir = p.resolve(want)
  let raw: Array<{ name: string; isDirectory(): boolean }>
  try {
    raw = await opts.fs.readdir(dir)
  } catch {
    return null
  }
  const max = opts.maxEntries ?? BROWSE_MAX_ENTRIES
  const dirs = raw
    .filter((e) => {
      try {
        return e.isDirectory() && !e.name.startsWith('.')
      } catch {
        return false
      }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  const truncated = dirs.length > max
  const kept = dirs.slice(0, max)
  const entries = await Promise.all(
    kept.map(async (name) => ({
      name,
      dir: true as const,
      git: await opts.fs.exists(p.join(dir, name, '.git')).catch(() => false)
    }))
  )
  const parentDir = p.dirname(dir)
  const parent = parentDir !== dir && isWithinRootsFor(parentDir, [home], opts.platform) ? parentDir : null
  return { path: dir, parent, entries, truncated }
}
