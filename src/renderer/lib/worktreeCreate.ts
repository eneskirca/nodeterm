import { worktreeFromCreate, type GroupWorktree, type WorktreeCreateValue } from '@shared/worktree'

/**
 * "Create a git worktree, then bind a group frame to it" — the ONE sequence behind every way the
 * app makes a worktree: the New worktree dialog, the `open-worktree` control verb, and "Start with
 * agent in a new worktree" on a GitHub issue card. Each used to carry its own copy of the create +
 * catch + bind steps, and the issue action would have been the third.
 *
 * What each caller still owns, because it differs between them on purpose: how the branch, base and
 * path were chosen, where the frame goes, and how a failure is worded (the dialog shows it inline,
 * the verb replies `open-worktree: …`, the board raises a notice).
 */

/** Where the frame goes: an existing group to bind (`groupId`), or a new frame at `at`. */
export interface WorktreeAttachTarget {
  groupId: string | null
  at?: { x: number; y: number }
  /** A new frame's size (default: the worktree frame size). */
  size?: { width: number; height: number }
  /** A new frame's title (default: the branch). */
  title?: string
}

export interface CreateBoundWorktreeDeps {
  worktreeAdd(
    repoPath: string,
    wtPath: string,
    branch: string,
    baseRef: string,
    isNew: boolean
  ): Promise<{ ok: boolean; message: string }>
  /** The project on screen NOW — asked after the git await, never before. */
  activeProjectId(): string | null | undefined
  /** Bind (or create and bind) the frame; returns the frame's id. */
  attach(target: WorktreeAttachTarget, wt: GroupWorktree): string
}

export type CreateBoundWorktreeOutcome =
  | { ok: true; groupId: string; worktree: GroupWorktree }
  /** `git worktree add` failed (`rejected: false`, git's own message) or the call itself was
   *  rejected — a Server Edition socket that dropped mid-create (`rejected: true`, the raw error). */
  | { ok: false; reason: 'git'; message: string; rejected: boolean }
  /** The worktree was created, but the canvas moved to another project during the await: binding
   *  it to what is on screen would attach one repository's worktree to another project. It is left
   *  on disk as an orphan, and the New worktree dialog offers it again on its own project. */
  | { ok: false; reason: 'project-changed'; worktree: GroupWorktree }

/**
 * Create the worktree, then bind it. `target` is asked only AFTER git succeeded, so a caller that
 * places the frame relative to the live canvas places it against the canvas as it is then.
 * `projectId` opts in to the "the canvas moved on" refusal (the dialog and the issue action pass
 * it; the control verb does not, and keeps its historical behaviour).
 */
export async function createBoundWorktree(
  deps: CreateBoundWorktreeDeps,
  value: WorktreeCreateValue,
  opts: { target: () => WorktreeAttachTarget; projectId?: string }
): Promise<CreateBoundWorktreeOutcome> {
  // A REJECTED ipc is not the same as a failed op, and both have to land here: without the catch
  // the await throws straight out of the caller, and the dialog sat on "Creating…" with its own
  // Cancel disabled — no error, no way out but Escape.
  const res = await deps
    .worktreeAdd(value.repoPath, value.path, value.branch, value.baseRef, value.mode === 'new')
    .then(
      (r) => ({ ...r, rejected: false }),
      (e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e), rejected: true })
    )
  if (!res.ok) return { ok: false, reason: 'git', message: res.message, rejected: res.rejected }
  // We created this directory, so `createdByApp` is true — Remove may delete it.
  const worktree = worktreeFromCreate(value)
  if (opts.projectId !== undefined && deps.activeProjectId() !== opts.projectId) {
    return { ok: false, reason: 'project-changed', worktree }
  }
  const groupId = deps.attach(opts.target(), worktree)
  return { ok: true, groupId, worktree }
}
