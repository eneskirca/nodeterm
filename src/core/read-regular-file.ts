/**
 * Read a file only if the name holds a plain regular file — never a symlink, directory or FIFO —
 * with the check and the read served by ONE file descriptor (open → fstat → read via the handle).
 * A stat/lstat on the path followed by a second open by name is a check-then-use race (CodeQL
 * js/file-system-race): the name can be swapped between the two.
 *
 * O_NOFOLLOW refuses a symlink at the name and O_NONBLOCK keeps a FIFO from hanging the open; the
 * fstat then judges what we actually hold. Where the platform has no O_NOFOLLOW (Windows) the open
 * follows a link, so the name is lstat'ed AFTER the open and must be a plain file that is the very
 * file we hold (same dev + ino, when the filesystem reports a file id — a zero ino proves nothing
 * and is accepted, like `readIfRegular` in integration-files.ts). It runs on every platform, so
 * POSIX tests cover it too. Same shape as `readAlertSound` in alert-sounds.ts.
 *
 * Resolves `null` for anything that is not a readable regular file within `maxBytes` (absent,
 * a link, a directory, a FIFO, too large). Never throws.
 */
import { createHash } from 'crypto'
import { promises as fs, constants as fsConstants } from 'fs'

export const READ_REGULAR_FILE_DEFAULT_MAX = 1024 * 1024

export async function readRegularFileNoFollow(
  file: string,
  maxBytes: number = READ_REGULAR_FILE_DEFAULT_MAX
): Promise<string | null> {
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    const st = await fh.stat({ bigint: true })
    if (!st.isFile() || st.size > BigInt(maxBytes)) return null
    const named = await fs.lstat(file, { bigint: true })
    if (!named.isFile() || (st.ino !== 0n && (named.dev !== st.dev || named.ino !== st.ino))) return null
    // At most one byte past the cap from the SAME handle: a file that grew after the fstat is
    // refused rather than slurped.
    const buf = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) return null
    return buf.subarray(0, total).toString('utf8')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * `readRegularFileNoFollow`'s rules for binary or large files: the same single-descriptor open →
 * fstat → lstat-identity check, but the buffer is sized from the fstat (not `maxBytes`, which for a
 * whiteboard scene is 64 MB), the bytes come back raw, and `read: false` answers only the file's
 * mtime and stamp — so a caller can learn a file's revision without holding the file in memory.
 * Resolves `null` for anything that is not a readable regular file within `maxBytes`. Never throws.
 *
 * `stamp` is `dev:ino:size:mtimeNs:sha256` of the descriptor actually read. The stat part alone is
 * not enough: a publish by rename frees the old inode, ext4 hands it straight to the next file, and
 * mtime moves in coarse ticks — so two same-size rewrites in one tick had the same stamp, and a stale
 * compare-and-set from another process passed. The content hash closes that; what is left (same
 * inode, size, tick AND bytes) is the very file the caller saw. So `read: false` still reads the
 * file, a chunk at a time, to hash it.
 */
export async function readRegularFileBytesNoFollow(
  file: string,
  maxBytes: number,
  opts: { read?: boolean } = {}
): Promise<{ bytes?: Buffer; mtimeMs: number; stamp: string } | null> {
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    const st = await fh.stat({ bigint: true })
    if (!st.isFile() || st.size > BigInt(maxBytes)) return null
    const named = await fs.lstat(file, { bigint: true })
    if (!named.isFile() || (st.ino !== 0n && (named.dev !== st.dev || named.ino !== st.ino))) return null
    // Up to one byte past what fstat reported, from the SAME handle: a file that grew since is
    // refused. `read: false` reuses one chunk-sized buffer and keeps only the hash.
    const size = Number(st.size)
    const keep = opts.read !== false
    const buf = Buffer.alloc(keep ? size + 1 : Math.min(size + 1, 1024 * 1024))
    const hash = createHash('sha256')
    let total = 0
    for (;;) {
      const at = keep ? total : 0
      const { bytesRead } = await fh.read(buf, at, buf.length - at, total)
      if (bytesRead === 0) break
      hash.update(buf.subarray(at, at + bytesRead))
      total += bytesRead
      if (total > size) return null
    }
    const mtimeMs = Number(st.mtimeMs)
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${hash.digest('hex')}`
    return keep ? { bytes: buf.subarray(0, total), mtimeMs, stamp } : { mtimeMs, stamp }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}
