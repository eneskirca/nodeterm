import { worktreePathKey, type GroupWorktree, type WorktreeEntry } from './worktree'

/** A group node that carries a worktree binding. */
export interface BoundGroup {
  groupId: string
  worktree: GroupWorktree
}

/**
 * stale   — group ids whose worktree is gone from disk (deleted outside the app).
 * orphans — worktrees on disk that no group is bound to (every Unbind makes one).
 *
 * There is deliberately no `live` list: it is the exact complement of `stale` over the bindings the
 * caller passed in, and nothing ever read it. A second, derived source of the same truth is a
 * standing invitation for the two to disagree — the UI asks "is this group stale?", so `stale` is
 * the only answer that needs to exist.
 */
export interface Reconciliation {
  stale: string[]
  orphans: WorktreeEntry[]
}

/** Compare worktree paths as git prints them vs. as we persisted them: trailing slashes differ, and
 *  on Windows so do separators and case (`worktreePathKey`). A comparison KEY — never a path to use. */
export const normWorktreePath = (p: string): string => worktreePathKey(p)

const norm = normWorktreePath

/**
 * Compare the persisted bindings against `git worktree list`. The FIRST entry git prints is the
 * main checkout — it is never an orphan (offering it as one would invite deleting the repo), and
 * bare entries are not worktrees a group can own.
 *
 * Caller contract: `entries` must be `git worktree list`'s output in git's order (the main checkout
 * is identified positionally — never sort/filter it first), and `bound` must contain only groups
 * bound to THAT one repo (groups of another repo would be falsely reported stale).
 */
export function reconcileWorktrees(bound: BoundGroup[], entries: WorktreeEntry[]): Reconciliation {
  const usable = entries.filter((e) => !e.isBare)
  const mainCheckout = usable[0]?.path
  // `prunable` = git still lists it, but its directory is gone (deleted behind git's back, and
  // nobody has run `git worktree prune` yet). Listed is NOT the same as present: counting these
  // as on-disk would report a dead binding as live, and would offer a directory that no longer
  // exists as an adoptable orphan.
  const present = usable.filter((e) => !e.prunable)
  const onDisk = new Set(present.map((e) => norm(e.path)))
  const boundPaths = new Set(bound.map((b) => norm(b.worktree.path)))

  const stale = bound.filter((b) => !onDisk.has(norm(b.worktree.path))).map((b) => b.groupId)

  const orphans = present.filter(
    (e) => norm(e.path) !== norm(mainCheckout ?? '') && !boundPaths.has(norm(e.path))
  )

  return { stale, orphans }
}
