import { computeWorktreePath, type WorktreeEntry } from './worktree'
import { normWorktreePath } from './worktree-reconcile'
import { sharedWorktreeLocationRefusal } from './worktree-location'

// "Start with agent in a new worktree" on a GitHub issue card: the branch it creates, and what it
// does when that branch (or its folder) is already taken.
//
// The branch is named from the issue NUMBER and a slug of its TITLE, and the title is attacker-
// controlled: anyone can open an issue on a public repository and put whatever they like in it. So
// the slug is an ALLOWLIST (`[a-z0-9-]`, nothing else survives), it is capped, and the result never
// travels through a shell — it reaches git as one argv element (`worktree-ops.worktreeAdd`, which
// also refuses a leading `-`). A branch built here always passes `git check-ref-format --branch`:
// the alphabet has no `.`, `@`, `/`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, space or control byte, and
// every name starts with the literal `issue-` (`issue-worktree.test.ts` runs the real git over the
// hostile cases).
//
// What is already on disk is never overwritten. An existing worktree for the same issue is offered
// for REUSE; a name or folder that is merely taken moves to the next free `-2`, `-3`, … suffix.

/** The longest slug a branch carries. Long enough to read, short enough for a path segment and a
 *  group chip. */
export const ISSUE_BRANCH_SLUG_MAX = 40

/** How many `-k` suffixes the planner tries before it gives up (a folder of 20 attempts for one
 *  issue is a mess a person should look at, not one the app should keep extending). */
export const ISSUE_BRANCH_SUFFIX_MAX = 20

/** Bounds the work a hostile 1 MB title can cause before the cap applies. */
const TITLE_SCAN_MAX = 1000

const MAX_ISSUE_NUMBER = 2 ** 31 - 1

function validNumber(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER
  )
}

/**
 * The title as a branch slug: lower-case ASCII letters and digits, runs of anything else collapsed
 * to one `-`, trimmed, capped at {@link ISSUE_BRANCH_SLUG_MAX} (cut back to a word boundary when the
 * cap lands mid-word). Accented Latin keeps its base letter (`café` → `cafe`); every other script,
 * emoji, lookalike, bidi or zero-width character is dropped. `''` when nothing survives — the
 * caller then names the branch `issue-<N>` alone.
 */
export function issueBranchSlug(title: unknown): string {
  if (typeof title !== 'string') return ''
  // Lower-case BEFORE decomposing: `İ`.toLowerCase() is `i` + a combining dot, which the mark strip
  // below must see.
  const folded = title
    .slice(0, TITLE_SCAN_MAX)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
  let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > ISSUE_BRANCH_SLUG_MAX) {
    const cut = slug.slice(0, ISSUE_BRANCH_SLUG_MAX)
    // Mid-word? Back up to the last separator, as long as that keeps at least half the budget.
    const midWord = slug[ISSUE_BRANCH_SLUG_MAX] !== '-'
    const lastDash = cut.lastIndexOf('-')
    slug = midWord && lastDash >= ISSUE_BRANCH_SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut
    slug = slug.replace(/-+$/g, '')
  }
  return slug
}

/**
 * `issue-<N>-<slug>` (or `issue-<N>` when the title leaves no slug), with `-<suffix>` appended for
 * a suffix of 2 or more. `''` for a number that is not a real issue number.
 */
export function issueWorktreeBranch(number: unknown, title?: unknown, suffix = 1): string {
  if (!validNumber(number)) return ''
  const slug = issueBranchSlug(title)
  const base = slug ? `issue-${number}-${slug}` : `issue-${number}`
  return Number.isSafeInteger(suffix) && suffix >= 2 ? `${base}-${suffix}` : base
}

/** Is this branch one of the issue's own (`issue-<N>` or `issue-<N>-…`)? `issue-12` is not
 *  `issue-123`'s. Case-insensitive: a hand-made `Issue-12-x` is still that issue's. */
export function isIssueBranch(branch: unknown, number: number): boolean {
  if (typeof branch !== 'string' || !validNumber(number)) return false
  const b = branch.toLowerCase()
  return b === `issue-${number}` || b.startsWith(`issue-${number}-`)
}

/** Where a new worktree would go. */
export interface IssueWorktreeTarget {
  branch: string
  path: string
}

/** A worktree group frame on the canvas, and the branch it is bound to (stale frames excluded by
 *  the caller: a directory that is gone is nothing to reuse). */
export interface IssueWorktreeBoundGroup {
  groupId: string
  branch: string
  path: string
}

/** Something already on disk (or on the canvas) the user may want to reuse for this issue. */
export type IssueWorktreeExisting =
  /** A worktree for this issue that a group frame on this canvas is already bound to: reuse = open
   *  the agent in that frame. */
  | { kind: 'bound'; groupId: string; branch: string; path: string }
  /** A worktree for this issue on disk that no frame is bound to: reuse = adopt it (never deleted by
   *  Remove, because the app did not create it). */
  | { kind: 'orphan'; branch: string; path: string; entry: WorktreeEntry }
  /** The branch the app would create exists, but is checked out nowhere: reuse = check THAT branch
   *  out in a new worktree at `path`. */
  | { kind: 'branch'; branch: string; path: string }

export type IssueWorktreePlan =
  | { kind: 'refused'; reason: string }
  /** Nothing in the way (or only a name/folder that is merely taken — `renamedFrom` then names the
   *  branch that was wanted, so the caller can say why the new one ends in `-2`). */
  | { kind: 'create'; target: IssueWorktreeTarget; renamedFrom?: string }
  /** An existing worktree/branch for this issue: the person picks reuse or `alternative` (null when
   *  no free name was found within {@link ISSUE_BRANCH_SUFFIX_MAX} attempts). */
  | { kind: 'choose'; existing: IssueWorktreeExisting; alternative: IssueWorktreeTarget | null }

export interface IssueWorktreeInput {
  number: number
  /** The issue title — hostile input, only ever slugged. */
  title: unknown
  repoRoot: string
  /** The effective path template (`effectiveWorktreeTemplate`). */
  template: string
  /** `git worktree list` in git's order: the MAIN checkout is first. */
  entries: readonly WorktreeEntry[]
  /** Local branch names; null or empty when they could not be read (git then has the last word). */
  branches: readonly string[] | null
  /**
   * Remote-tracking branches as git lists them (`origin/issue-12-fix`). A name that exists on a
   * remote is TAKEN: creating a same-named local branch from the base would diverge from it, the
   * later push would be rejected, and a pull request from that remote branch — someone else's — would
   * share this session's branch name. The planner moves to `-k` rather than basing on it: starting
   * an agent on another person's branch is not what "start in a NEW worktree" asks for. Only as
   * fresh as the last fetch.
   */
  remoteBranches?: readonly string[]
  /** `worktree.basePath` — ONLY when it came from the git-shared settings file (see
   *  @shared/worktree-location): the location it produces must pass `sharedWorktreeLocationRefusal`. */
  sharedBasePath?: string
  /** Non-stale worktree-bound group frames on this canvas. */
  bound: readonly IssueWorktreeBoundGroup[]
}

/** Does anything live at this path? A probe that REJECTS reads as "yes": a failed read is never
 *  evidence of absence, and the cost of the wrong answer is only a `-2`. (A probe that folds a stat
 *  error into `false` — the app's `fs.exists` does — is backstopped by git, which refuses to add a
 *  worktree into a folder that is not empty.) */
export type PathProbe = (path: string) => Promise<boolean>

/**
 * Decide what "Start with agent in a new worktree" does for this issue. Reads the filesystem only
 * through `pathExists`, so the whole matrix is testable without a repository.
 */
export async function planIssueWorktree(
  input: IssueWorktreeInput,
  pathExists: PathProbe
): Promise<IssueWorktreePlan> {
  const canonical = issueWorktreeBranch(input.number, input.title)
  if (!canonical) return { kind: 'refused', reason: 'That is not a valid issue number.' }
  const repoRoot = input.repoRoot.trim()
  if (!repoRoot) return { kind: 'refused', reason: 'No git repository was found in this project’s folder.' }
  const pathFor = (branch: string): string => computeWorktreePath(repoRoot, branch, input.template)
  if (!pathFor(canonical)) {
    return {
      kind: 'refused',
      reason: 'No worktree location could be derived from the worktree path setting. Nothing was created.'
    }
  }
  // Every candidate (`-k` included) lives in the same folder, so one check on the wanted name
  // judges them all — before anything else is planned.
  const location = sharedWorktreeLocationRefusal({
    path: pathFor(canonical),
    repoRoot,
    branch: canonical,
    sharedBasePath: input.sharedBasePath
  })
  if (location) return { kind: 'refused', reason: location }

  const known = new Set<string>()
  for (const b of input.branches ?? []) known.add(b.toLowerCase())
  for (const e of input.entries) if (e.branch) known.add(e.branch.toLowerCase())
  // A frame's binding counts too: `entries` may be a failed (empty) read, and a bound branch or
  // folder is taken whatever git managed to list.
  for (const g of input.bound) known.add(g.branch.toLowerCase())
  for (const r of input.remoteBranches ?? []) {
    const slash = r.indexOf('/')
    if (slash > 0 && slash < r.length - 1) known.add(r.slice(slash + 1).toLowerCase())
  }
  // Every name this module builds is lower-case already; `known` is folded on the way in.
  const branchTaken = (b: string): boolean => known.has(b)
  const entryPaths = new Set(
    [...input.entries.map((e) => e.path), ...input.bound.map((g) => g.path)].map(normWorktreePath)
  )
  const pathTaken = async (p: string): Promise<boolean> => {
    if (entryPaths.has(normWorktreePath(p))) return true
    return pathExists(p).catch(() => true)
  }
  /** The first `base`, `base-2`, `base-3`, … whose branch AND folder are both free. */
  const firstFree = async (fromSuffix: number): Promise<IssueWorktreeTarget | null> => {
    for (let k = fromSuffix; k <= ISSUE_BRANCH_SUFFIX_MAX; k++) {
      const branch = issueWorktreeBranch(input.number, input.title, k)
      if (branchTaken(branch)) continue
      const path = pathFor(branch)
      if (!path || (await pathTaken(path))) continue
      return { branch, path }
    }
    return null
  }

  // 1. A worktree this issue already has. A frame bound to it beats an unbound one (that is where
  //    the issue's other sessions already are), and the exact name beats a sibling of it.
  const byName = <T extends { branch: string }>(xs: T[]): T | undefined =>
    xs.find((x) => x.branch.toLowerCase() === canonical) ?? xs[0]
  const boundHere = input.bound.filter((g) => isIssueBranch(g.branch, input.number))
  const boundPaths = new Set(input.bound.map((g) => normWorktreePath(g.path)))
  const orphans = input.entries
    .slice(1) // the main checkout is never "a worktree to reuse"
    .filter((e) => !e.isBare && !e.prunable && e.branch && isIssueBranch(e.branch, input.number))
    .filter((e) => !boundPaths.has(normWorktreePath(e.path)))
    .map((e) => ({ branch: e.branch as string, path: e.path, entry: e }))
  const bound = byName(boundHere)
  const orphan = bound ? undefined : byName(orphans)
  if (bound || orphan) {
    const existing: IssueWorktreeExisting = bound
      ? { kind: 'bound', groupId: bound.groupId, branch: bound.branch, path: bound.path }
      : { kind: 'orphan', branch: orphan!.branch, path: orphan!.path, entry: orphan!.entry }
    return { kind: 'choose', existing, alternative: await firstFree(1) }
  }

  // 2. The branch exists but is checked out NOWHERE: offer to check it out. (Checked out somewhere
  //    — the main checkout, or a registration whose folder is gone — it cannot be, so it is simply
  //    taken, and case 3 moves on to `-2`.)
  //    The branch is offered under ITS OWN spelling: `known` is case-folded, but git resolves the
  //    name it is given, and `issue-12-x` does not name a local `Issue-12-X` on a case-sensitive
  //    filesystem or in packed refs.
  const checkedOut = input.entries.some((e) => e.branch?.toLowerCase() === canonical)
  const existingBranch = (input.branches ?? []).find((b) => b.toLowerCase() === canonical)
  if (existingBranch && !checkedOut) {
    const path = pathFor(canonical)
    if (!(await pathTaken(path))) {
      return {
        kind: 'choose',
        existing: { kind: 'branch', branch: existingBranch, path },
        alternative: await firstFree(2)
      }
    }
  }

  // 3. A fresh worktree — under the wanted name when it is free, else the next free suffix.
  const target = await firstFree(1)
  if (!target) {
    return {
      kind: 'refused',
      reason: `Every name from ${canonical} to ${canonical}-${ISSUE_BRANCH_SUFFIX_MAX} is taken. Nothing was created.`
    }
  }
  return target.branch === canonical ? { kind: 'create', target } : { kind: 'create', target, renamedFrom: canonical }
}
