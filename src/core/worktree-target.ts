import fs from 'fs'
import os from 'os'
import path from 'path'
import { worktreeRedirectRefusal } from '../shared/worktree-location'

/**
 * `p` with every symlink on the way resolved. The worktree folder does not exist yet, so the
 * deepest EXISTING ancestor is resolved and the rest re-appended — which is exactly where
 * `git worktree add` (a `mkdir -p` that follows links) will create it.
 */
export function realPathOf(p: string): string {
  let cur = path.resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      rest.unshift(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * The backstop every `git worktree add` passes (`GitService.worktreeAdd`): refuse a target inside
 * the repository's `.git`, or one a symlink REDIRECTS into a hidden folder of the home directory.
 * The rule itself is `worktreeRedirectRefusal` (@shared/worktree-location); this only supplies the
 * real paths. A relative target is resolved the way git resolves it: against the repository.
 */
export function worktreeTargetRefusal(
  wtPath: string,
  repoPath: string,
  home: string = os.homedir()
): string | null {
  const requested = path.resolve(repoPath, wtPath)
  return worktreeRedirectRefusal({
    requested,
    real: realPathOf(requested),
    realRepo: realPathOf(repoPath),
    home,
    realHome: realPathOf(home)
  })
}
