import { create } from 'zustand'
import { activeSessionApi } from '../session/session'
import {
  normWorktreePath,
  reconcileWorktrees,
  type BoundGroup
} from '@shared/worktree-reconcile'
import type { WorktreeEntry } from '@shared/worktree'

/** What the group chip shows. `dirty` = staged + unstaged files. */
export interface WorktreeStatus {
  branch: string
  dirty: number
  ahead: number
  behind: number
  /** A remote named `origin` exists — i.e. a merge CAN publish the base branch to origin. The merge
   *  confirm reads this to offer the push (and to not threaten one that could never happen). It is
   *  deliberately NOT `hasRemote` ("any remote"): the push is hardcoded to `origin`, so a fork whose
   *  only remote is `upstream` would be shown a push it cannot perform. */
  hasOrigin: boolean
}

/**
 * Coalescing FLOOR, not a target rate: the chip re-renders constantly and several groups can poke
 * within one window, so this is what stops every render (and every poke) from spawning a
 * `git status`. An explicit poke — a group frame mounting, the tab becoming visible again, a frame
 * scrolling into view — still gets a fresh read as soon as the floor allows.
 */
export const WORKTREE_STATUS_THROTTLE_MS = 4000

/**
 * How often a mounted, VISIBLE, on-screen group frame re-reads its worktree status in the
 * background. `git.status()` is eleven git subprocesses and runs per bound group, so a tick at the
 * throttle floor meant a canvas with three worktrees spawned ~8 processes a second forever, for a
 * dirty-file counter nobody was reading. Ambient information gets an ambient cadence (Source
 * Control's own auto-fetch is 180 s); everything the user actually does still pokes immediately.
 */
export const WORKTREE_STATUS_POLL_MS = 20_000

/**
 * How many CONSECUTIVE "this is not a repo" reads it takes to declare a bound worktree missing.
 *
 * `git.status()` answers `hasRepo:false` whenever `git rev-parse --is-inside-work-tree` merely
 * FAILS — a spawn EAGAIN under load, an NFS/FUSE hiccup — not only when the directory is gone. One
 * such read used to flip a perfectly healthy group to "missing"; it self-heals on the next poll,
 * but in that window `cwdForNewNodeIn` refuses the worktree path and hands out the project cwd, and
 * a terminal created then persists the WRONG cwd forever. Two reads in a row is the stronger signal.
 */
export const WORKTREE_STALE_STRIKES = 2

interface WorktreesState {
  repoRoot: string | null
  entries: WorktreeEntry[]
  orphans: WorktreeEntry[]
  staleGroupIds: string[]
  statusByPath: Record<string, WorktreeStatus>
  /** Per-project resolved git repo root, for the sessions sidebar's repo grouping. Populated for the
   *  active project in `refresh` (which knows its cwd) and for every open project by the sidebar's
   *  one-shot resolver; NOT cleared by `reset` (it is cross-project, unlike the active-only fields
   *  below). `null` = a project that is not a git repo. */
  repoRootByProject: Record<string, string | null>
  refresh(projectCwd: string, bound: BoundGroup[], projectId?: string): Promise<void>
  /**
   * Poll one bound worktree's status. Pass the bound group's id to also keep its staleness LIVE:
   * `refresh()` only runs on project load / mutation, so without this a worktree deleted while the
   * user watches would keep a healthy-looking chip (and a restored one would keep saying "missing")
   * until a reload. `hasRepo === false` = the directory is gone → mark the group stale; a repo
   * answering again un-marks it.
   */
  refreshStatus(path: string, groupId?: string): Promise<void>
  /**
   * Drop the previous project's worktree facts. `projectKey` (the project id) scopes the strike
   * streaks that survive the switch — see `missStreak`. Call it on every project load, including the
   * ones that never `refresh()` (SSH, or a project with no cwd), so no project can inherit another's
   * scope.
   */
  reset(projectKey?: string): void
}

const lastStatusAt = new Map<string, number>()
/**
 * Consecutive `hasRepo:false` reads per worktree path (see WORKTREE_STALE_STRIKES). Reset by any
 * success. Keyed by the NORMALIZED path (so `refresh` can look a binding up in it) PREFIXED BY THE
 * PROJECT the streak was observed in.
 *
 * The scope is what lets a streak outlive a project switch. It is a fact about a live binding, and
 * bindings do not stop being dead while the user looks at another tab: without the prefix the map
 * had to be wiped on every switch (and `refresh` purged every key its own project did not own), so
 * switching to B and back to A forgot A's strikes and A's dead group rendered healthy for a poll
 * window — the very window in which `cwdForNewNodeIn` hands out a path that is gone.
 */
const missStreak = new Map<string, number>()

/**
 * The project the strikes below belong to. Set by `reset`, which the active-project effect fires on
 * EVERY project load (a project that never refreshes — SSH, no cwd — must still get its own scope,
 * or it would file its strikes under the last project that did). Only the ACTIVE project's groups
 * ever poll, so one scope at a time is all this needs.
 */
let streakScope = ''

/** Separates the scope from the path in a streak key. A project id and a path can both contain
 *  most characters; a NUL cannot appear in either, so the key can never be ambiguous. */
const STREAK_SEP = '\u0000'

/** Streak key: the project that observed it + the normalized worktree path. */
const streakKey = (p: string): string => `${streakScope}${STREAK_SEP}${normWorktreePath(p)}`

/** Has this path been read as "not a repo" often enough in a row to count as gone? */
const struckOut = (p: string): boolean => (missStreak.get(streakKey(p)) ?? 0) >= WORKTREE_STALE_STRIKES

/**
 * Cancellation token for the in-flight async reads. `refresh`/`refreshStatus` are fired from React
 * effects and have no abort; a project switch calls `reset()` and starts the NEW project's refresh,
 * so the OLD project's call can still resolve afterwards and win the last write — leaving project B
 * holding project A's `repoRoot` and orphan list. Since worktrees are CREATED under `repoRoot` and
 * orphans are offered for DELETION, that stale write is not cosmetic. Every `set` is therefore
 * gated on the epoch the call started in.
 */
let epoch = 0

/** "No worktree facts" — what a non-repo project, a failed read and a reset all collapse to. */
const empty = (): Pick<WorktreesState, 'repoRoot' | 'entries' | 'orphans' | 'staleGroupIds'> => ({
  repoRoot: null,
  entries: [],
  orphans: [],
  staleGroupIds: []
})

export const useWorktrees = create<WorktreesState>((set) => ({
  repoRoot: null,
  entries: [],
  orphans: [],
  staleGroupIds: [],
  statusByPath: {},
  repoRootByProject: {},

  async refresh(projectCwd, bound, projectId) {
    // Bump the epoch at the START, before any await. This ensures a newer refresh always
    // supersedes an older one: if two refreshes are called in quick succession without an
    // intervening reset(), the second one bumps the epoch, making the first's epoch stale.
    // After bumping, capture the new epoch so this refresh knows if it was superseded.
    epoch++
    const mineEpoch = epoch
    // Non-component consumer: git comes from the ACTIVE session's core (resolved per call, not at
    // module load — the local session's api is `window.nodeTerminal` by identity, so this is the
    // same function reference as before Stage 4).
    const git = activeSessionApi().git
    try {
      const root = await git.repoRoot(projectCwd)
      if (mineEpoch !== epoch) return
      if (!root) {
        set(empty())
        if (projectId) set((s) => ({ repoRootByProject: { ...s.repoRootByProject, [projectId]: null } }))
        return
      }
      // Record this project's repo root for the sessions sidebar's repo grouping. The map is
      // cross-project (not reset on switch), so the sidebar can group every open project by repo.
      if (projectId) set((s) => ({ repoRootByProject: { ...s.repoRootByProject, [projectId]: root } }))
      // `entries` stays in git's order — reconcileWorktrees identifies the main checkout positionally.
      // A REJECTION here (a dead WS bridge in the Server Edition) is the same fact as `ok:false` —
      // the list could not be read — so it must not fall through to the catch below, which empties
      // the store and would take every group's staleness (and every orphan) with it.
      const listed = await git
        .worktreeList(root)
        .catch(() => ({ ok: false, entries: [] as WorktreeEntry[] }))
      if (mineEpoch !== epoch) return
      if (!listed.ok) {
        // git could not be READ (spawn EAGAIN under load, a corrupt index, an unmounted repo). That
        // is not "this repo has no worktrees": reconciling against the empty list would mark EVERY
        // bound group stale on one bad read — no strike streak, no second opinion — which is exactly
        // the escalation WORKTREE_STALE_STRIKES exists to forbid, and it costs the user real things
        // (`cwdForNewNodeIn` stops handing out a healthy worktree path, and the only action a stale
        // group offers — Unbind — rewrites its children's persisted cwds off a live worktree).
        // So: change nothing. The previous facts stand until a read actually succeeds.
        set({ repoRoot: root })
        return
      }
      const entries = listed.entries
      // A miss-streak is a fact about a BINDING, not about a path forever. It is keyed by path and
      // `computeWorktreePath` is deterministic, so a streak that outlives its binding comes back to
      // haunt the next one: delete a worktree dir → the group strikes out → Unbind (which prunes)
      // → create a worktree for the same branch → the SAME path → the union below drags the dead
      // streak onto a brand-new, healthy group, which renders "· missing" (Merge/Remove/↪ hidden)
      // until the next successful poll. So the moment a path is no longer bound to any group
      // (unbind / remove / ungroup / delete — all of which re-refresh), forget its streak.
      // Only BOUND paths are ever consulted below, so nothing else can depend on it.
      //
      // Scoped to THIS project's keys: another project's streaks are none of this refresh's
      // business (its `bound` list does not describe them), and deleting them was what made a
      // dead group read healthy again after a there-and-back project switch.
      const boundKeys = new Set(bound.map((b) => streakKey(b.worktree.path)))
      const mineKey = (k: string): boolean => k.startsWith(`${streakScope}${STREAK_SEP}`)
      for (const key of [...missStreak.keys()])
        if (mineKey(key) && !boundKeys.has(key)) missStreak.delete(key)
      // Reconcile only the groups bound to THIS repo. A group bound to another repo's worktree
      // (legacy binding, or hand-typed) would otherwise be compared against the wrong entry list
      // and falsely reported stale.
      const mine = bound.filter(
        (b) => normWorktreePath(b.worktree.repoPath) === normWorktreePath(root)
      )
      const { stale, orphans } = reconcileWorktrees(mine, entries)
      // UNION, never replace. Staleness has two sources: git's own facts (`reconcileWorktrees`, via
      // `prunable`) and the status poll's miss-streak. `refresh()` runs on a project switch, on
      // binding another worktree, on deleting a node, on ungrouping — and setting `staleGroupIds`
      // to reconcile's answer alone would ERASE, on any of those, a group the poll had already
      // proven dead: the chip goes healthy again and "↪ Move into worktree" reopens the very window
      // in which it kills a live session into a directory that no longer exists.
      // Struck-out over ALL bindings, not just `mine`: a group bound to ANOTHER repo (a legacy or
      // hand-edited binding) is excluded from reconciliation by design, but its miss-streak is
      // still a fact about its own path. Filtering it out here dropped it from `staleGroupIds` on
      // every refresh, so a dead cross-repo worktree looked healthy again until the next poll tick.
      const struck = bound.filter((b) => struckOut(b.worktree.path)).map((b) => b.groupId)
      const staleIds = [...new Set([...stale, ...struck])]
      set({ repoRoot: root, entries, orphans, staleGroupIds: staleIds })
    } catch {
      // Fail open: the IPC rejects on a transport error (WS-RPC, Server Edition) and callers are
      // fire-and-forget effects, so throwing here would only become an unhandled rejection. An
      // empty store means "no worktree facts" — every consumer already degrades to that.
      if (mineEpoch !== epoch) return
      set(empty())
    }
  },

  async refreshStatus(path, groupId) {
    const mineEpoch = epoch
    const now = Date.now()
    const prev = lastStatusAt.get(path) ?? 0
    if (now - prev < WORKTREE_STATUS_THROTTLE_MS) return
    lastStatusAt.set(path, now)
    const git = activeSessionApi().git
    let status: Awaited<ReturnType<typeof git.status>>
    try {
      status = await git.status(path)
    } catch {
      // Un-stamp, or a transient failure would lock the chip out of retrying for the whole window.
      if (lastStatusAt.get(path) === now) lastStatusAt.delete(path)
      return
    }
    if (mineEpoch !== epoch) return
    // A deleted worktree does NOT reject: git-service answers with an empty status. Writing it
    // would render a dead worktree as a healthy one on a blank branch — `staleGroupIds` is what
    // tells that story, so mark the group stale instead of keeping a lie on screen. But only once
    // the reading REPEATS: a single failed read is as likely to be a transient git failure as a
    // deleted directory, and calling a live worktree missing has consequences of its own.
    if (!status.hasRepo) {
      const key = streakKey(path)
      const strikes = (missStreak.get(key) ?? 0) + 1
      missStreak.set(key, strikes)
      if (groupId && strikes >= WORKTREE_STALE_STRIKES) {
        set((s) =>
          s.staleGroupIds.includes(groupId)
            ? s
            : { staleGroupIds: [...s.staleGroupIds, groupId] }
        )
      }
      return
    }
    missStreak.delete(streakKey(path))
    set((s) => ({
      // The directory answers again (restored, or a transient read failure passed) → not stale.
      staleGroupIds:
        groupId && s.staleGroupIds.includes(groupId)
          ? s.staleGroupIds.filter((g) => g !== groupId)
          : s.staleGroupIds,
      statusByPath: {
        ...s.statusByPath,
        [path]: {
          branch: status.branch,
          dirty: status.staged.length + status.changes.length,
          ahead: status.ahead,
          behind: status.behind,
          hasOrigin: !!status.hasOrigin
        }
      }
    }))
  },

  reset(projectKey = '') {
    epoch++
    streakScope = projectKey
    lastStatusAt.clear()
    // `missStreak` is deliberately NOT cleared: it is scoped per project (see missStreak), and a
    // switch away from a project does not resurrect its dead worktrees. Clearing it here handed a
    // struck-out group a clean slate on every switch-back — one poll window in which it looked
    // healthy. Its keys are pruned by `refresh` (per project), not by the switch.
    set({ ...empty(), statusByPath: {} })
  }
}))
