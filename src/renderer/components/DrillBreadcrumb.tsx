import { useEffect } from 'react'
import { useProjects } from '../state/projects'
import { useWorktrees, WORKTREE_STATUS_POLL_MS } from '../state/worktrees'
import type { DrillContext } from '../state/workspace'
import type { WorktreeAction } from '../nodes/GroupNode'

/**
 * The drill breadcrumb (ticket 07/10), promoted into a component so it can SUBSCRIBE to the worktrees
 * store (an inline IIFE in Canvas's JSX can't call hooks). For a plain group drill or a single-node
 * focus it shows a one-line "Drilled into / Focused on {title} — Esc to return" + ← back. For a
 * worktree-bound group drill (ticket 08) it ALSO carries the worktree's branch chip + dirty/ahead/
 * behind + Merge/Unbind/Remove — the chrome that normally lives on the GroupNode frame, which leaves
 * the node-set when drilled (only the group's children are shown), so the worktree's git context has
 * to move to a canvas-level strip.
 *
 * The status poll reuses the SINGLE store poller invariant (no second poller, no second `git status`):
 * a page-visibility-gated tick pokes `useWorktrees.refreshStatus(wtPath, groupId)`, exactly like
 * GroupNode's per-frame tick minus the IntersectionObserver (the drilled canvas IS the viewport, so
 * the observer is trivially always-intersecting — dropped). The store's throttle floor coalesces.
 * On an SSH project the poll is OFF (worktrees unsupported in v1); the branch chip shows with no
 * live status, matching GroupNode's contract.
 */
export function DrillBreadcrumb({
  drill,
  onExit,
  onWorktreeAction,
  isSshProject
}: {
  drill: DrillContext
  onExit: () => void
  onWorktreeAction: (groupId: string, action: WorktreeAction) => void
  isSshProject: boolean
}) {
  // For a group/node drill, `proj` is the project the drilled node lives in and `title` is the
  // node's own title. For a cross-project drill (09), `proj` is the REFERENCED (target) project —
  // `drill.projectId` is the SOURCE meta-canvas (only `exitDrill` needs it) — and the title is the
  // target project's name. There is no node and no worktree context for a project-ref drill.
  const targetProjId = drill.kind === 'project-ref' ? drill.targetId : drill.projectId
  const proj = useProjects((s) => s.projects.find((p) => p.id === targetProjId))
  const node =
    drill.kind === 'group' || drill.kind === 'node'
      ? proj?.nodes.find((n) => n.id === (drill.kind === 'group' ? drill.groupId : drill.nodeId))
      : undefined
  const title =
    drill.kind === 'project-ref'
      ? proj?.name ?? 'project'
      : node?.title ?? (drill.kind === 'group' ? 'group' : 'node')

  // Worktree context only exists for a GROUP drill whose group is worktree-bound.
  const wt = drill.kind === 'group' ? node?.worktree : undefined
  const groupId = drill.kind === 'group' ? drill.groupId : undefined
  // The SSH gate matches GroupNode: a remote checkout's status can't be read by local git, so the
  // poll is off (and `wtPath` is undefined, which short-circuits the effect below).
  const wtPath = wt && !isSshProject ? wt.path : undefined
  const status = useWorktrees((s) => (wt ? s.statusByPath[wt.path] : undefined))
  const stale = useWorktrees((s) => (groupId ? s.staleGroupIds.includes(groupId) : false))

  // Page-visibility-gated status tick (no IntersectionObserver — the drilled canvas fills the
  // viewport). Same cadence + store as GroupNode; the store's throttle decides whether a read fires.
  useEffect(() => {
    if (!wtPath || !groupId) return
    const poke = (): void => {
      if (document.visibilityState === 'hidden') return
      void useWorktrees.getState().refreshStatus(wtPath, groupId)
    }
    poke()
    const t = setInterval(poke, WORKTREE_STATUS_POLL_MS)
    document.addEventListener('visibilitychange', poke)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', poke)
    }
  }, [wtPath, groupId])

  return (
    <div className="announce-banner announce-banner--info drill-breadcrumb">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__body">
          {drill.kind === 'project-ref' ? (
            'Drilled into project '
          ) : drill.kind === 'group' ? (
            'Drilled into '
          ) : (
            'Focused on '
          )}
          <strong>{title}</strong>{' — '}
          {drill.kind === 'group' ? 'press Esc to return' : 'Esc to return'}
        </span>
        {wt && groupId && (
          <span className="drill-breadcrumb__wt">
            {stale ? (
              <span
                className="group-node__branch group-node__branch--stale"
                title={`Worktree directory is gone: ${wt.path}\nUnbind to detach this group from it.`}
              >
                ⎇ {wt.branch} · missing
              </span>
            ) : (
              <span className="group-node__branch" title={wt.path}>
                ⎇ {status?.branch || wt.branch}
                {status && status.dirty > 0 && (
                  <em className="group-node__wt-dirty" title={`${status.dirty} changed file(s)`}>
                    {' '}
                    · {status.dirty} changed
                  </em>
                )}
                {status && status.ahead > 0 && (
                  <em className="group-node__wt-ahead" title={`${status.ahead} commit(s) ahead`}>
                    {' '}
                    · {status.ahead}↑
                  </em>
                )}
                {status && status.behind > 0 && (
                  <em className="group-node__wt-behind" title={`${status.behind} commit(s) behind`}>
                    {' '}
                    · {status.behind}↓
                  </em>
                )}
              </span>
            )}
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Merge to main"
                onClick={() => onWorktreeAction(groupId, 'merge')}
              >
                ⤴
              </button>
            )}
            <button
              className="group-node__wt-btn"
              title={
                stale
                  ? 'Unbind (the directory is gone — also prunes the stale git registration)'
                  : 'Unbind worktree (keeps the worktree on disk)'
              }
              onClick={() => onWorktreeAction(groupId, 'unbind')}
            >
              Unbind
            </button>
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Remove worktree"
                onClick={() => onWorktreeAction(groupId, 'remove')}
              >
                ✕
              </button>
            )}
          </span>
        )}
      </div>
      <button className="announce-banner__close" title="Return to canvas (Esc)" onClick={onExit}>
        ← back
      </button>
    </div>
  )
}
