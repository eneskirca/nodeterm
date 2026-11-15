// Live links were retired in 2026-11. An install that used them kept `watch-links.json` in its data
// dir: sealed link secrets and the scrypt hashes of Control passwords, which nothing reads any more.
// Both shells call this once per boot (desktop: userData, Server Edition: its data dir, where the
// file almost certainly never existed) and it removes exactly three name shapes from the dir's TOP
// level: the store, its `.corrupt-<ts>` sidelines, and the atomic-write temps a crash may have left
// (they can hold the same secrets). Nothing wider, never recursive, never through a symlink (a link
// is removed as a link), never a directory. It never throws: ENOENT is the normal case and says
// nothing; any other failure is one warning naming a count and an error code, never a file's body.
import fs from 'fs'
import path from 'path'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// The temp shapes are fs-atomic's `tempNameFor` (`<target>.<pid>.<seq>.<uuid>.tmp`), the older
// pid+sequence form, and the legacy fixed `<target>.tmp`.
const RETIRED_NAME = new RegExp(`^watch-links\\.json(?:\\.corrupt-\\d+|(?:\\.\\d+\\.\\d+(?:\\.${UUID})?)?\\.tmp)?$`)

/** Is this top-level data-dir entry name one of the retired live-link store's files? */
export function isRetiredLiveLinkFile(name: string): boolean {
  return RETIRED_NAME.test(name)
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'
}

/** Remove the retired live-link files from `dir`'s top level. Answers how many were removed. */
export async function removeRetiredLiveLinkData(
  dir: string,
  warn: (message: string) => void = (m) => console.warn(m)
): Promise<number> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') warn(`[retired-data] could not list the data dir for old live-link files (${codeOf(err)})`)
    return 0
  }
  let removed = 0
  let failed = 0
  let firstCode = ''
  for (const name of names) {
    if (!isRetiredLiveLinkFile(name)) continue
    const file = path.join(dir, name)
    try {
      const st = await fs.promises.lstat(file)
      if (!st.isFile() && !st.isSymbolicLink()) continue
      await fs.promises.unlink(file)
      removed++
    } catch (err) {
      if (codeOf(err) === 'ENOENT') continue
      failed++
      if (!firstCode) firstCode = codeOf(err)
    }
  }
  if (failed > 0) warn(`[retired-data] could not remove ${failed} old live-link file(s) (${firstCode})`)
  return removed
}
