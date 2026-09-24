// User-owned JSON is never repaired by an installer. Only ENOENT means a new config.
import { lstatSync, readFileSync, mkdirSync, rmdirSync, statSync, writeFileSync, rmSync, chmodSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'fs'
import path from 'path'
import { renameAtomicSync, tempNameFor } from '../../fs-atomic'

export function parseSettings(raw: string): Record<string, unknown> {
  const value: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object')
  return value as Record<string, unknown>
}

function snapshot(file: string): string | null {
  let fd: number | undefined
  try {
    // Inspect and read the SAME open file, never lstat(path) then reopen a possibly swapped path.
    // POSIX O_NOFOLLOW rejects a symlink introduced after target resolution. On platforms without
    // that flag, the target-resolution check before publication remains the backstop. NONBLOCK
    // lets fstat reject a FIFO without waiting for a writer.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    if (!fstatSync(fd).isFile()) throw new Error('Settings must be a regular file')
    return readFileSync(fd, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function settingsTarget(file: string): string {
  try {
    return realpathSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    // A missing file is creatable; a dangling symlink is not ours to repair.
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('Dangling settings link') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return path.join(realpathSync(path.dirname(file)), path.basename(file))
  }
}

/** Serialize our writers, stage before publishing, and refuse stale snapshots. Other programs
 * do not honor our lock: the final comparison narrows, but cannot eliminate, their rename race. */
export function updateSettingsFile(requested: string, update: (config: Record<string, unknown>) => Record<string, unknown>): boolean {
  let lock = ''
  let locked = false
  let tmp: string | undefined
  try {
    mkdirSync(path.dirname(requested), { recursive: true })
    const file = settingsTarget(requested)
    lock = `${file}.nodeterm-lock`
    try { mkdirSync(lock) } catch (error) {
      console.warn(`[agent-hooks] Settings lock unavailable: ${lock}. Installation skipped; if it persists, stop nodeterm writers and inspect/remove the stale lock before retrying.`)
      throw error
    }
    locked = true
    const before = snapshot(file)
    const config = before === null ? {} : parseSettings(before)
    const original = JSON.stringify(config)
    const updated = update(config)
    if (before !== null && JSON.stringify(updated) === original) return false
    const next = JSON.stringify(updated, null, 2)
    tmp = tempNameFor(file)
    const mode = before === null ? 0o600 : statSync(file).mode & 0o777
    writeFileSync(tmp, next, { flag: 'wx', mode })
    chmodSync(tmp, mode)
    if (settingsTarget(requested) !== file || snapshot(file) !== before) return false
    renameAtomicSync(tmp, file)
    return true
  } catch {
    return false // fail open for the session, fail closed for the user's settings
  } finally {
    try { if (tmp) rmSync(tmp, { force: true }) } catch { /* best-effort cleanup */ }
    try { if (locked) rmdirSync(lock) } catch { /* never break session startup */ }
  }
}
