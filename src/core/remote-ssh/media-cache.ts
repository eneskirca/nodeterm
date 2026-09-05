// Pure helpers for the remote-media cache: a VideoNode in an SSH project plays a HOST file, so
// main pulls it into <userData>/remote-media-cache/ over the ControlMaster and serves the cached
// copy via nt-media://. These stay pure (no fs) so they are unit-testable; the manager does the IO.
import { createHash } from 'crypto'

/**
 * Deterministic cache file name for (host, remote path): re-opening the same remote file lands on
 * the same cache entry (so an unchanged file is not re-downloaded), while two hosts — or two paths
 * with the same basename — can never collide. The basename is kept for debuggability and so the
 * served file keeps its extension (container sniffing).
 */
export function remoteMediaCacheName(hostKey: string, remotePath: string, basename: string): string {
  const h = createHash('sha256').update(`${hostKey}\n${remotePath}`).digest('hex').slice(0, 16)
  return `${h}-${basename}`
}

/** Cache entries beyond this many are pruned oldest-first (videos are large; the cache is a
 *  convenience, not a store). */
export const MEDIA_CACHE_KEEP = 20

/**
 * Given the cache dir's entries, return the file names to DELETE, keeping the newest `keep`.
 * Pure: the caller stats and deletes. `except` (the entry being (re)written) is never returned.
 */
export function mediaCachePruneList(
  entries: readonly { name: string; mtimeMs: number }[],
  except: string,
  keep: number = MEDIA_CACHE_KEEP,
  protectedNames: ReadonlySet<string> = new Set()
): string[] {
  return entries
    .filter((e) => e.name !== except)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, keep - 1))
    .filter((e) => !protectedNames.has(e.name))
    .map((e) => e.name)
}
