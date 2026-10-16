// Link one shared, NON-secret runtime asset (config.toml, skills/, …) from a system agent home into
// a managed account home. Electron-free, deps injected so the Windows leg is testable on Linux.
//
// POSIX: a plain `symlink(source, target)` — byte-identical to the inline loop this replaced,
// including that an unexpected error still throws.
//
// Windows: an untyped / file `symlink` needs SeCreateSymbolicLinkPrivilege, which a stock account
// lacks (EPERM) — that used to reject the whole account add. So:
//  - a directory is a JUNCTION (no privilege; same precedent as claude-skill-share.ts);
//  - a file tries a symlink, then an NTFS hardlink (no privilege; EXDEV across volumes), then a
//    copy — which is a SNAPSHOT that will not follow later edits of the original, so it warns. A
//    hardlink can drift too: an editor's atomic-rename save of config.toml replaces the original
//    inode and leaves the managed home holding the old one;
//  - any other failure for one entry is logged and SKIPPED, never thrown — these are convenience
//    assets, and a missing one must not block creating the account.
// In every dialect a missing source (ENOENT) and an existing target (EEXIST) are a silent skip.
import { constants, promises as fsp } from 'fs'

export type SharedEntryLinkDeps = {
  platform: NodeJS.Platform
  lstat: (p: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>
  stat: (p: string) => Promise<{ isDirectory(): boolean }>
  symlink: (source: string, target: string, type?: 'dir' | 'file' | 'junction') => Promise<void>
  link: (source: string, target: string) => Promise<void>
  copyFile: (source: string, target: string, mode: number) => Promise<void>
  warn: (message: string) => void
}

export const defaultSharedEntryLinkDeps = (): SharedEntryLinkDeps => ({
  platform: process.platform,
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  symlink: (source, target, type) => fsp.symlink(source, target, type),
  link: (source, target) => fsp.link(source, target),
  copyFile: (source, target, mode) => fsp.copyFile(source, target, mode),
  warn: (message) => console.warn(message)
})

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

/** How the entry ended up in the managed home (`skipped` = absent source, existing target, or a
 *  logged Windows failure). Returned for tests and logs; callers need not inspect it. */
export type SharedEntryLinkResult = 'symlink' | 'junction' | 'hardlink' | 'copy' | 'skipped'

export async function linkSharedEntry(
  source: string,
  target: string,
  deps: SharedEntryLinkDeps = defaultSharedEntryLinkDeps()
): Promise<SharedEntryLinkResult> {
  if (deps.platform !== 'win32') {
    try {
      await deps.lstat(source)
      await deps.symlink(source, target)
      return 'symlink'
    } catch (error) {
      const code = codeOf(error)
      if (code !== 'ENOENT' && code !== 'EEXIST') throw error
      return 'skipped'
    }
  }
  try {
    await deps.lstat(source)
    // Follow a source that is itself a link: a junction to a symlinked directory is still a dir.
    const isDir = (await deps.stat(source)).isDirectory()
    if (isDir) {
      await deps.symlink(source, target, 'junction')
      return 'junction'
    }
    try {
      await deps.symlink(source, target, 'file')
      return 'symlink'
    } catch (error) {
      const code = codeOf(error)
      if (code !== 'EPERM' && code !== 'EACCES') throw error
    }
    try {
      await deps.link(source, target)
      return 'hardlink'
    } catch (error) {
      if (codeOf(error) === 'EEXIST') throw error
    }
    await deps.copyFile(source, target, constants.COPYFILE_EXCL)
    deps.warn(
      `[accounts] ${target} is a COPY of ${source} (no symlink privilege, hardlink impossible): ` +
        'later edits of the original will not reach this account'
    )
    return 'copy'
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'EEXIST') return 'skipped'
    deps.warn(`[accounts] could not share ${source} into ${target}: ${String(error)}`)
    return 'skipped'
  }
}
