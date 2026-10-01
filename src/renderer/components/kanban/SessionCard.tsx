import { memo, useState } from 'react'
import type { KanbanCardMeta, KanbanColumnCategory, KanbanLabel, KanbanPriority } from '@shared/types'
import { useAgentStatus } from '../../state/agentStatus'
import { AccountChip, useAccountChip } from '../AccountChip'
import { LiveLinkChip, showsLiveLinks } from '../LiveLinkChip'
import type { SessionSource } from '../../session/session'
import { useWatchLinks } from '../../state/watchLinks'
import { ContextMeter } from '../ContextMeter'
import { isRemoteSessionNode } from '@shared/worktree'
import { NodeIconView } from '../NodeIcon'
import { LabelChips } from './LabelChips'
import { PRIORITIES } from './CardMetaBar'
import type { KanbanSession } from './KanbanView'
import type { GitHubPullStatus, PullStatusFreshness } from '@shared/github-pull-status'
import { PullRefChip } from './PullStatusBadges'
import type { IssueRef } from '@shared/github-issue-ref'
import { IssueRefChip } from '../IssueRefChip'
import { cardBadge } from '../../lib/kanbanStatusChips'
import { cardAssignees } from '@shared/kanban-labels'
import { TeamProgressChip } from '../TeamProgressChip'
import type { TeamStation } from '../../lib/teamProgress'
import { cardShowsOverdue, sessionNameRepeatsTitle } from '../../lib/cardRedundancy'

const PRIO_COLOR = Object.fromEntries(PRIORITIES.map((p) => [p.id, p.color])) as Record<KanbanPriority, string>

interface SessionCardProps {
  session: KanbanSession
  meta?: KanbanCardMeta
  /** Resolved board labels on this card (LabelChips) — resolved by the board, passed in. */
  labels?: KanbanLabel[]
  // Every callback carries the node id so the column can pass ONE stable function to all its
  // cards — per-card arrow closures would give each card fresh props and defeat the memo.
  /** Single click opens the card modal directly (the expand/collapse step was dropped). */
  onOpen: (nodeId: string) => void
  onDragStart: (nodeId: string) => void
  onDragEnd: () => void
  /** A dragged card was dropped on this card — before it (top half) or after it (bottom half). */
  onDropAt: (nodeId: string, side: 'before' | 'after') => void
  /** Right-click on the card — opens the actions menu at the cursor. */
  onContext: (nodeId: string, x: number, y: number) => void
  /** Pull requests linked to this card through its worktree branch (stable array per card). */
  pulls?: GitHubPullStatus[]
  pullFreshness?: PullStatusFreshness
  /** The session's `#N` chip (it was started on a GitHub issue): open that issue. */
  onOpenIssue?: (ref: IssueRef) => void
  /** The stations this session opened (lib/teamProgress) — a stable array per card. */
  team?: readonly TeamStation[]
  /** A station row in the team list was picked: go to that node on the canvas. */
  onTravel?: (nodeId: string) => void
  /** The lifecycle category of the column the card sits in (lib/cardRedundancy reads it). */
  columnCategory?: KanbanColumnCategory
  /** The session the board's PROJECT belongs to (`projectSessionSource`). Only a local one shows
   *  this machine's LIVE chip, or counts a link as card detail — a relay tab's node with the same
   *  id is another machine's terminal (R57). */
  liveLinkSource: SessionSource | null
}

export const SessionCard = memo(function SessionCard({
  session, meta, labels = [], onOpen, onDragStart, onDragEnd, onDropAt, onContext, pulls,
  pullFreshness = 'fresh', onOpenIssue, team, onTravel, columnCategory, liveLinkSource
}: SessionCardProps) {
  // THIS card's agent status, subscribed per card rather than threaded down from the board.
  // KanbanView used to hold `useAgentStatus((s) => s.byId)` and pass the map through the column:
  // that map's identity changes on every hook event of every node, so one agent's working→idle
  // flip re-rendered the whole board — every column, every card. The same rule Canvas follows
  // (see its loopSig comment) and StatusAwareMiniMap demonstrates: subscribe where the value is
  // read, so the re-render is confined to the one thing that changed.
  const status = useAgentStatus((s) => s.byId[session.id])
  // The board is the canvas's other view of the same node (CONTRIBUTING), so the card carries the
  // node header's account chip from the same helper — created-with account, else what the session
  // was observed running as.
  const accountChip = useAccountChip(session.spawn.accountId, status?.account)
  // Local drag state only styles THIS card (ghost look) — the drag payload lives in KanbanView.
  const [dragging, setDragging] = useState(false)
  // Which edge a drag is hovering over → shows the drop line (top = before, bottom = after).
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sideFor = (e: React.DragEvent): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }
  // The board is the canvas's other view of the same sessions and reads the same store, so the
  // node's pause/liveness chips (DROPPED, PAUSED, SLEEPING) are badges here too.
  // The ONE badge rule, shared with the board's status chips (lib/kanbanStatusChips), so a chip
  // can never select cards whose badge says something else. The ranking and its reasons live there.
  const badge = cardBadge(session.kind, status)
  const stickyPreview = session.kind === 'sticky' ? (session.text ?? '').trim() : ''
  const assignees = cardAssignees(meta)
  const due = meta?.dueAt
  // Not in a done/closed column: the column already settled it (lib/cardRedundancy). The card
  // modal's Due strip still says "Overdue".
  const overdue = cardShowsOverdue(due, Date.now(), columnCategory)
  // The session name is usually the title (agent titles auto-track it) — then the chip repeats it.
  const sessionName = status?.session && !sessionNameRepeatsTitle(status.session, session.title)
    ? status.session
    : undefined
  const priority = meta?.priority
  // A live link counts as detail: "this terminal is being broadcast" must show on the card whatever
  // else it has to say (a primitive selector — see LiveLinkChip).
  const showLive = showsLiveLinks(liveLinkSource)
  const hasLiveLink = useWatchLinks(
    (s) => showLive && session.kind === 'terminal' && (s.byNode[session.id]?.length ?? 0) > 0
  )
  // The account chip counts as detail in its own right: a card whose only thing to say is "this
  // one is on the other Claude login" is exactly the card that must say it.
  const hasDetail =
    !!status?.sessionId || !!sessionName || !!accountChip || hasLiveLink || stickyPreview.includes('\n')
  return (
    <div
      className={`kanban-card kanban-card--session${dragging ? ' kanban-card--dragging' : ''}${
        dropSide ? ` kanban-card--drop-${dropSide}` : ''
      }`}
      draggable
      // Focusable, and named for the board's keyboard (J/K/arrows walk these, Space opens one —
      // KanbanView's board-key handler finds the current card through this attribute).
      tabIndex={0}
      data-kanban-card={session.id}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStart(session.id)
      }}
      onDragEnd={() => {
        setDragging(false)
        setDropSide(null)
        onDragEnd()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        const side = sideFor(e)
        if (side !== dropSide) setDropSide(side)
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // don't let the column's end-drop swallow a drop aimed at this card
        const side = sideFor(e)
        setDropSide(null)
        onDropAt(session.id, side)
      }}
      onClick={() => onOpen(session.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContext(session.id, e.clientX, e.clientY)
      }}
      title="Open card"
    >
      <div className="kanban-card__row">
        <span className="kanban-card__nodedot" style={{ background: session.color }} />
        <NodeIconView icon={session.icon} size={14} className="kanban-card__icon" />
        <span className="kanban-card__title">{session.title}</span>
        {session.kind === 'terminal' && onOpenIssue && (
          <IssueRefChip issueRef={session.issueRef} onOpen={onOpenIssue} />
        )}
        {session.kind === 'terminal' && team && team.length > 0 && onTravel && (
          <TeamProgressChip stations={team} onTravel={onTravel} />
        )}
        {session.kind === 'sticky' && <span className="kanban-card__kind">note</span>}
        {session.kind === 'browser' && <span className="kanban-card__kind">web</span>}
        {badge === 'dropped' && (
          <span
            className="kanban-badge kanban-badge--dropped"
            title="This session's agent process is gone (it did not exit cleanly) — open the card to resume it"
          >
            DROPPED
          </span>
        )}
        {badge === 'running' && <span className="kanban-badge kanban-badge--running">RUNNING</span>}
        {badge === 'needs' && <span className="kanban-badge kanban-badge--needs">NEEDS YOU</span>}
        {badge === 'paused' && (
          <span
            className="kanban-badge kanban-badge--sleeping"
            title="Session paused — use Resume session from the node menu to bring it back"
          >
            PAUSED
          </span>
        )}
        {badge === 'sleeping' && (
          <span
            className="kanban-badge kanban-badge--sleeping"
            title="Agent hibernated to save memory — resumes when you open the session"
          >
            SLEEPING
          </span>
        )}
        {status?.unread && <span className="kanban-card__unread" />}
      </div>
      {pulls && pulls.length > 0 && (
        <div className="pull-refs pull-refs--session">
          {pulls.slice(0, 3).map((pull) => (
            <PullRefChip key={pull.number} status={pull} freshness={pullFreshness} />
          ))}
        </div>
      )}
      {(labels.length > 0 || assignees.length > 0 || due !== undefined || priority !== undefined) && (
        <div className="kanban-card__metarow">
          {/* Labels share the priority/due/avatars row (left); the meta chips hug the right. */}
          <LabelChips labels={labels} size="sm" className="kanban-card__metalabels" />
          <div className="kanban-card__metaright">
            {priority !== undefined && PRIO_COLOR[priority] && (
              <span
                className="kanban-due kanban-prio-chip"
                style={{ background: `color-mix(in srgb, ${PRIO_COLOR[priority]} 15%, transparent)`, color: PRIO_COLOR[priority] }}
              >
                {priority.toUpperCase()}
              </span>
            )}
            {due !== undefined && (
              <span className={`kanban-due${overdue ? ' kanban-due--overdue' : ''}`}>
                {new Date(due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
              </span>
            )}
            {assignees.length > 0 && (
              <span className="kanban-card__avatars">
                {assignees.slice(0, 3).map((a) => (
                  <span key={a.name} className="kanban-avatar kanban-avatar--sm" style={{ background: a.color }} title={a.name}>
                    {(a.name.trim()[0] ?? '?').toUpperCase()}
                  </span>
                ))}
                {assignees.length > 3 && <span className="kanban-avatar kanban-avatar--sm kanban-avatar--more">+{assignees.length - 3}</span>}
              </span>
            )}
          </div>
        </div>
      )}
      {/* Detail line is ALWAYS visible when the card has something to say (no expand step):
          agents show the context meter + session chip; multi-line notes show a preview. */}
      {hasDetail && (
        <div className="kanban-card__detail" onClick={(e) => e.stopPropagation()}>
          {session.kind === 'sticky' ? (
            <span className="kanban-card__stickytext">{stickyPreview}</span>
          ) : (
            <>
              <ContextMeter sessionId={status?.sessionId ?? null} nodeId={session.id} remote={isRemoteSessionNode(session.spawn)} agentId={session.agentId ?? session.spawn.agentId ?? status?.agentId} />
              <AccountChip chip={accountChip} />
              <LiveLinkChip nodeId={session.id} source={liveLinkSource} className="kanban-card__live" />
              {sessionName && (
                <span className="kanban-card__session" title={sessionName}>
                  {sessionName}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})
