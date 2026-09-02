import { useContext, useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { NODE_COLORS, ungroupNodes, type CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useWorktrees, WORKTREE_STATUS_POLL_MS } from '../state/worktrees'
import { useProjectSetup } from '../state/projectSetup'
import { GitHubLinkChip } from '../components/github/GitHubLinkChip'
import { useGitHubLinks, suggestionKey } from '../state/githubLinks'
import { linkRepository, suggestionFor } from '../lib/githubLinks'
import { attachGitHubLink, openGitHubLinkPicker } from '../canvas/githubLinkActions'
import { SessionContext } from '../session/session'

export type WorktreeAction = 'merge' | 'remove' | 'unbind' | 'rerun-setup'

/**
 * Worktree-action handler bridge. React Flow instantiates custom nodes itself, so we can't
 * pass Canvas callbacks through props; Canvas registers its handler here (the same indirection
 * the file already relies on — GroupNode reaches React Flow state via `useReactFlow`). Set by
 * Canvas on mount; called by the header chip's action buttons.
 */
let worktreeActionHandler: ((groupId: string, action: WorktreeAction) => void) | null = null
export function setWorktreeActionHandler(
  fn: ((groupId: string, action: WorktreeAction) => void) | null
): void {
  worktreeActionHandler = fn
}

/**
 * A group frame: a dashed, rounded, translucent box that contains child nodes. A floating
 * label pill (color dot + name) sits on the top border; ungroup/× appear top-right on hover.
 * Children are real React Flow nodes parented to this one, so dragging the frame moves them
 * together. The frame renders behind its children (it appears first in the array).
 */
export function GroupNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)
  // The frame element, observed for viewport visibility by the worktree-status tick below.
  const frameRef = useRef<HTMLDivElement | null>(null)

  const wt = data.worktree
  // The store is the ONLY caller of the worktree/status git IPC; it throttles
  // (WORKTREE_STATUS_THROTTLE_MS) and is epoch-guarded, so asking often is free.
  const status = useWorktrees((s) => (wt ? s.statusByPath[wt.path] : undefined))
  const stale = useWorktrees((s) => (wt ? s.staleGroupIds.includes(id) : false))
  // The project setup/archive script Canvas launched for THIS checkout, resolved through the
  // attachment its ack made (an event carries no lane — see the store's header). Selected as the
  // entry itself, so a render happens only when this group's run changes, not on every chunk of
  // every other project's script.
  const setupRun = useProjectSetup((s) => {
    const runKey = s.groupRunKey[id]
    return runKey === undefined ? undefined : s.byRunKey[runKey]
  })
  // A launch for this group is already on its way (requested, not yet acked — which includes the
  // whole time a consent dialog is up). The re-run chip must not fire a second one: the service
  // would answer `busy`, and the store's counter exists precisely because that ack must not be
  // mistaken for "nothing is happening".
  const setupPending = useProjectSetup((s) => (s.pendingByGroup[id] ?? 0) > 0)
  const setupBusy = setupPending || setupRun?.state === 'running'

  // On an SSH project the poll is OFF, not merely useless: `git status <path>` would be answered by
  // the LOCAL filesystem for a project whose checkout lives on the host (remote git routing is
  // exact-cwd, and a worktree path is never the project's remoteCwd), so the chip would report a
  // local directory's branch — or, far worse, strike the group out and unlock the stale-Unbind path,
  // which rewrites the children's cwds. Worktrees are unsupported in SSH projects (v1): the honest
  // behaviour is no facts at all, not local facts about a remote checkout.
  const sshProject = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const wtPath = sshProject ? undefined : wt?.path
  // Asking once per render is NOT enough to make the chip live: nothing re-renders a group frame
  // while the user works inside its terminals, so the dirty count would freeze at whatever it was
  // when the node last happened to render (verified — it sat at "0 changed" until the canvas was
  // clicked). Hence a tick. It owns no cache and no `git status` of its own: it just pokes the
  // store, whose throttle still decides whether a real read happens (so N frames don't mean N
  // reads, and a mid-window render still coalesces).
  //
  // A STALE worktree is polled too (that is how a group un-stales when the directory comes back —
  // e.g. the user restored it, or a git read failed transiently), and the poke carries the group id
  // so the store can flip staleness live instead of only at project load.
  //
  // `git status` is the full Source-Control read (ELEVEN git subprocesses — see git-service's
  // `status`), and it is per BOUND GROUP: nothing coalesces two worktrees, because they are
  // different paths. So the tick is gated twice and runs slowly:
  //  - **page visibility** — a hidden tab / minimized window polls nothing, and a
  //    `visibilitychange` back to visible pokes immediately so the chip is correct the moment it
  //    is seen again;
  //  - **viewport** — React Flow keeps every node MOUNTED regardless of the camera (we do not set
  //    `onlyRenderVisibleElements`), so without this a frame parked off-screen kept spawning git
  //    for a chip nobody could see. An IntersectionObserver against the document viewport is the
  //    same shape the WebGL budget uses; entering the viewport pokes at once.
  // The cadence is WORKTREE_STATUS_POLL_MS, deliberately far slower than the store's throttle
  // floor: the throttle exists so several pokes in one window cost one read, NOT as a target rate.
  // A dirty-file counter on a frame is ambient information (Source Control's own auto-fetch is
  // 180 s); an explicit poke — visibility, viewport entry, mount — still refreshes within the 4 s
  // floor, so the chip stays responsive to the things the user actually does.
  //
  // (Gating here rather than hoisting a single store-owned timer keeps the poll tied to the node's
  // own mount/unmount lifecycle — no registry to leak.)
  useEffect(() => {
    if (!wtPath) return
    const el = frameRef.current
    // Assume visible when there is no element to observe (jsdom, or a pre-paint mount): the old
    // behaviour, i.e. never quieter than it needs to be at the cost of a poll.
    let onScreen = true
    const poke = (): void => {
      if (document.visibilityState === 'hidden' || !onScreen) return
      void useWorktrees.getState().refreshStatus(wtPath, id)
    }
    poke()
    const t = setInterval(poke, WORKTREE_STATUS_POLL_MS)
    document.addEventListener('visibilitychange', poke)
    const io =
      el && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              const next = entries[entries.length - 1]?.isIntersecting ?? true
              const entered = next && !onScreen
              onScreen = next
              onScreenRef.current = next
              if (entered) poke()
            },
            { rootMargin: '200px' }
          )
        : null
    if (el && io) io.observe(el)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', poke)
      io?.disconnect()
    }
  }, [wtPath, id])

  // The frame's own "PR #n open — attach?" suggestion (issue #462 phase 3b). SUGGEST, NEVER
  // ADOPT: nothing is written until the user clicks Attach, because a branch matching a pull
  // request is a guess, and a wrong chip costs more than a dismissed prompt.
  //
  // `wtPath` is already undefined on an SSH project (see above), so an SSH frame fetches nothing.
  // There is NO timer: one read on mount-visible and one per branch change, and the host's own
  // 5-minute TTL absorbs the rest — a canvas of frames must not become a poll of its own.
  // Read the context rather than `useSession()`: a frame is mountable without a provider (the
  // node tests do exactly that), and no session simply means no suggestion to fetch.
  const api = useContext(SessionContext)?.api
  const projectId = useProjects((s) => s.activeProjectId)
  const githubRepository = useProjects((s) =>
    linkRepository(s.projects.find((p) => p.id === s.activeProjectId)?.kanban))
  const suggestions = useGitHubLinks((s) => s.pullSuggestions[`${projectId}:${id}`])
  const dismissed = useGitHubLinks((s) => s.dismissed)
  const branch = status?.branch || wt?.branch
  const onScreenRef = useRef(true)
  useEffect(() => {
    if (!api || !wtPath || !branch || !githubRepository || !projectId) return
    if (!onScreenRef.current || document.visibilityState === 'hidden') return
    void useGitHubLinks.getState().fetchPullsForBranch(api.githubIssues, projectId, id, branch)
  }, [api, projectId, id, wtPath, branch, githubRepository])

  const candidates = suggestions && branch && suggestions.branch === branch
    ? suggestionFor(
        data.github,
        suggestions.pulls,
        new Set(suggestions.pulls
          .filter((pull) => dismissed.has(suggestionKey(projectId, id, pull.number)))
          .map((pull) => pull.number))
      )
    : []

  // Dissolving the frame destroys the worktree binding (the frame IS the binding) while the
  // worktree itself stays on disk. Route that through Canvas's `unbind` first, so the store
  // re-reconciles (the worktree is offered as an orphan again, and a stale registration is
  // pruned) instead of the binding silently vanishing until the next project switch.
  const ungroup = (): void => {
    if (wt) worktreeActionHandler?.(id, 'unbind')
    setNodes((ns) => ungroupNodes(ns as CanvasNode[], id))
  }

  // A bound frame must read as a checkout at a glance: solid border + a stronger tint of the
  // group's OWN color (no new palette). Stale drops the hue entirely and goes muted/warning.
  const bound = !!wt
  const frameClass = [
    'group-node',
    selected ? 'selected' : '',
    bound ? 'group-node--worktree' : '',
    bound && stale ? 'group-node--worktree-stale' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={frameRef}
      className={frameClass}
      style={{
        borderColor: bound && stale ? undefined : data.color,
        background: bound && stale ? undefined : `${data.color}${bound ? '1c' : '0f'}`,
        // Rounded selection ring (box-shadow follows border-radius, unlike the resizer line).
        boxShadow: selected ? `0 0 0 1.5px ${data.color}` : undefined
      }}
    >
      <NodeResizer
        minWidth={NODE_MIN_SIZES.group.width}
        minHeight={NODE_MIN_SIZES.group.height}
        isVisible={selected}
        color={data.color}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <div className="group-node__label">
        <button
          className="group-node__dot nodrag"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        <input
          className="group-node__name nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <GitHubLinkChip nodeId={id} links={data.github ?? []} variant="group" />
        {wt && (
          <div className="group-node__wt nodrag">
            {stale ? (
              // The directory is gone from disk (deleted outside the app). Merge and Remove would
              // act on a path that no longer exists, so only Unbind is offered.
              <span
                className="group-node__branch group-node__branch--stale"
                title={`Worktree directory is gone: ${wt.path}\nUnbind to detach this group from it.`}
              >
                ⎇ {wt.branch} · missing
              </span>
            ) : (
              <span className="group-node__branch" title={wt.path}>
                {/* The branch git reports NOW wins: the user may have switched branches inside
                    the worktree from a terminal, and the persisted name would then be a lie. */}
                ⎇ {status?.branch || wt.branch}
                {!!status && status.dirty > 0 && (
                  <em className="group-node__wt-dirty" title={`${status.dirty} changed file(s)`}>
                    {' '}
                    · {status.dirty} changed
                  </em>
                )}
                {!!status && status.ahead > 0 && (
                  <em className="group-node__wt-ahead" title={`${status.ahead} commit(s) ahead`}>
                    {' '}
                    · {status.ahead}↑
                  </em>
                )}
                {!!status && status.behind > 0 && (
                  <em className="group-node__wt-behind" title={`${status.behind} commit(s) behind`}>
                    {' '}
                    · {status.behind}↓
                  </em>
                )}
              </span>
            )}
            {setupRun &&
              // What the project's script is doing to this checkout. Status only — the OUTPUT lives
              // in the settings panel's run box (this is a frame header, not a log viewer), and the
              // failed state is the one that has to be visible here: a node armed behind a failed
              // setup is still holding its launch, and nothing else on the canvas says why.
              //
              // A FAILED SETUP IS THEREFORE A BUTTON, not a label. It is the only re-run that can
              // clear this: the settings panel's Run executes at the project ROOT and claims the
              // PROJECT lane, so it can never re-attach a worktree group's run — clicking it would
              // leave this chip failed and its nodes armed forever. Re-running here re-attaches the
              // group's lane, and a `done` from the new run releases them.
              (setupRun.kind === 'setup' && setupRun.state === 'failed' ? (
                <button
                  className={`group-node__setup group-node__setup--${setupBusy ? 'running' : 'failed'} nodrag`}
                  disabled={setupBusy}
                  title={
                    setupBusy
                      ? 'Setup script is starting…'
                      : `Setup script failed${setupRun.exitCode === undefined ? '' : ` (exit ${setupRun.exitCode})`}.` +
                        '\nNodes opened into this worktree may still be holding their launch.' +
                        '\nClick to run it again — a successful run releases them.' +
                        '\n(Its output is in Project settings → Setup.)'
                  }
                  onClick={() => worktreeActionHandler?.(id, 'rerun-setup')}
                >
                  {setupBusy ? 'setup …' : 'setup ✕ ↻'}
                </button>
              ) : (
                <span
                  className={`group-node__setup group-node__setup--${setupRun.state}`}
                  title={
                    `${setupRun.kind === 'archive' ? 'Archive' : 'Setup'} script: ${setupRun.state}` +
                    (setupRun.exitCode === undefined ? '' : ` (exit ${setupRun.exitCode})`)
                  }
                >
                  {setupRun.kind === 'archive' ? 'archive' : 'setup'}
                  {setupRun.state === 'running' ? ' …' : setupRun.state === 'done' ? ' ✓' : ' ✕'}
                </span>
              ))}
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Merge to main"
                onClick={() => worktreeActionHandler?.(id, 'merge')}
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
              onClick={() => worktreeActionHandler?.(id, 'unbind')}
            >
              Unbind
            </button>
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Remove worktree"
                onClick={() => worktreeActionHandler?.(id, 'remove')}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {candidates.length > 0 && (
        <div className="group-node__pr-suggest nodrag">
          <span title={candidates.map((pull) => `#${pull.number} ${pull.title}`).join('\n')}>
            {candidates.length > 1
              ? `${candidates.length} open PRs`
              : `PR #${candidates[0].number} ${candidates[0].draft ? 'draft' : 'open'}`}
          </span>
          <button
            className="group-node__wt-btn"
            title={
              candidates.length > 1
                ? 'Pick which pull request to attach'
                : `Attach #${candidates[0].number} to this frame`
            }
            onClick={(event) => {
              if (candidates.length > 1) {
                openGitHubLinkPicker(id, { x: event.clientX, y: event.clientY })
                return
              }
              attachGitHubLink(id, {
                kind: 'pull',
                number: candidates[0].number,
                title: candidates[0].title
              })
            }}
          >
            Attach
          </button>
          <button
            className="group-node__wt-btn"
            title="Dismiss this suggestion on this machine"
            onClick={() => {
              for (const pull of candidates) {
                useGitHubLinks.getState().dismissSuggestion(projectId, id, pull.number)
              }
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="group-node__actions nodrag">
        <button className="group-node__ungroup" title="Ungroup" onClick={ungroup}>
          ungroup
        </button>
        <button
          className="group-node__close"
          title="Remove group (keeps nodes)"
          onClick={ungroup}
        >
          ×
        </button>
      </div>
    </div>
  )
}
