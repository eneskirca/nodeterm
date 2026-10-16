import { describe, it, expect } from 'vitest'
import { reconcileWorktrees, type BoundGroup } from './worktree-reconcile'
import type { WorktreeEntry } from './worktree'

const wt = (path: string, branch: string | null): WorktreeEntry => ({
  path,
  branch,
  head: 'abc123',
  isBare: false
})

const bound = (groupId: string, path: string, branch: string): BoundGroup => ({
  groupId,
  worktree: { repoPath: '/repo', branch, baseRef: 'main', path, createdByApp: true }
})

describe('reconcileWorktrees', () => {
  it('does not report a binding whose worktree still exists as stale', () => {
    const r = reconcileWorktrees([bound('g1', '/wt/feat', 'feat')], [wt('/repo', 'main'), wt('/wt/feat', 'feat')])
    expect(r.stale).toEqual([])
  })

  it('reports a binding whose worktree is gone from disk as stale', () => {
    const r = reconcileWorktrees([bound('g1', '/wt/feat', 'feat')], [wt('/repo', 'main')])
    expect(r.stale).toEqual(['g1'])
  })

  it('ignores a trailing slash when matching paths', () => {
    // The persisted path has a trailing slash, git's does not: if that difference were not
    // normalised away, the binding would be reported stale even though its worktree is right there.
    const r = reconcileWorktrees([bound('g1', '/wt/feat/', 'feat')], [wt('/repo', 'main'), wt('/wt/feat', 'feat')])
    expect(r.stale).toEqual([])
  })

  it('matches a Windows binding to git\'s path across separators and drive-letter case', () => {
    const entries = [wt('C:/r', 'main'), wt('C:/r/wt', 'feat')]
    for (const p of ['C:\\r\\wt', 'c:/r/wt', 'C:\\R\\WT\\']) {
      const r = reconcileWorktrees([bound('g1', p, 'feat')], entries)
      expect(r.stale).toEqual([])
      expect(r.orphans).toEqual([])
    }
  })

  it('keeps POSIX paths case-sensitive', () => {
    const r = reconcileWorktrees([bound('g1', '/A/wt', 'feat')], [wt('/repo', 'main'), wt('/a/wt', 'feat')])
    expect(r.stale).toEqual(['g1'])
    expect(r.orphans.map((o) => o.path)).toEqual(['/a/wt'])
  })

  it('reports a worktree on disk that no group is bound to as an orphan', () => {
    const r = reconcileWorktrees([], [wt('/repo', 'main'), wt('/wt/loose', 'loose')])
    expect(r.orphans.map((o) => o.path)).toEqual(['/wt/loose'])
  })

  // The main checkout is itself an entry in `git worktree list`. Offering it as a
  // recoverable "orphan" would invite the user to delete their own repo.
  it('never reports the main checkout as an orphan', () => {
    const r = reconcileWorktrees([], [wt('/repo', 'main')])
    expect(r.orphans).toEqual([])
  })

  it('skips bare entries', () => {
    const entries: WorktreeEntry[] = [{ path: '/repo.git', branch: null, head: null, isBare: true }]
    const r = reconcileWorktrees([], entries)
    expect(r.orphans).toEqual([])
  })

  // The realistic "deleted outside the app" case: `rm -rf` the directory and git STILL lists the
  // worktree, tagged `prunable`. Before this, the entry counted as on-disk, the group was reported
  // live, and a dead binding rendered as a healthy one (and was offered for adoption as an orphan).
  it('treats a prunable entry (directory deleted behind git´s back) as gone, not live', () => {
    const gone: WorktreeEntry = { ...wt('/wt/feat', 'feat'), prunable: true }
    const r = reconcileWorktrees([bound('g1', '/wt/feat', 'feat')], [wt('/repo', 'main'), gone])
    expect(r.stale).toEqual(['g1'])
  })

  it('never offers a prunable worktree as an adoptable orphan', () => {
    const gone: WorktreeEntry = { ...wt('/wt/loose', 'loose'), prunable: true }
    const r = reconcileWorktrees([], [wt('/repo', 'main'), gone, wt('/wt/real', 'real')])
    expect(r.orphans.map((o) => o.path)).toEqual(['/wt/real'])
  })

  it('classifies a mixed workspace in one pass', () => {
    const r = reconcileWorktrees(
      [bound('g1', '/wt/a', 'a'), bound('g2', '/wt/gone', 'gone')],
      [wt('/repo', 'main'), wt('/wt/a', 'a'), wt('/wt/loose', 'loose')]
    )
    expect(r.stale).toEqual(['g2'])
    expect(r.orphans.map((o) => o.path)).toEqual(['/wt/loose'])
  })
})
