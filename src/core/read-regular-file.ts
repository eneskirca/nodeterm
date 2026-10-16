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
