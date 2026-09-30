// The relay's data directory (`<dataDir>/relay`) holds the team's membership and the host's secret
// key, so it is private to this unix user: 0700.
import { mkdirSync, chmodSync } from 'node:fs'

/** Create `dir` (and parents) at 0700, and tighten it to 0700 if it already existed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode applies only when it CREATES the directory; tighten one that already existed.
  // Best-effort, and POSIX only: the bits mean nothing on Windows.
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700) } catch { /* not ours to fix: the 0600 files inside are the guard */ }
  }
}
