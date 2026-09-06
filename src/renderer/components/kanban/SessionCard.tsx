import { memo, useState } from 'react'
import type { KanbanCardMeta, KanbanLabel, KanbanPriority } from '@shared/types'
import { useAgentStatus } from '../../state/agentStatus'
import { ContextMeter } from '../ContextMeter'
import { LabelChips } from './LabelChips'
import type { KanbanSession } from './KanbanView'

const PRIO_COLOR: Record<KanbanPriority, string> = {
  low: '#8e8e93',
  medium: '#ffd60a',
  high: '#ff9f0a',
  urgent: '#ff453a'
}

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
}

export const SessionCard = memo(function SessionCard({
  session, meta, labels = [], onOpen, onDragStart, onDragEnd, onDropAt, onContext
}: SessionCardProps) {
  // THIS card's agent status, subscribed per card rather than threaded down from the board.
  // KanbanView used to hold `useAgentStatus((s) => s.byId)` and pass the map through the column:
  // that map's identity changes on every hook event of every node, so one agent's working→idle
  // flip re-rendered the whole board — every column, every card. The same rule Canvas follows
  // (see its loopSig comment) and StatusAwareMiniMap demonstrates: subscribe where the value is
  // read, so the re-render is confined to the one thing that changed.
  const status = useAgentStatus((s) => s.byId[session.id])
  // Local drag state only styles THIS card (ghost look) — the drag payload lives in KanbanView.
  const [dragging, setDragging] = useState(false)
  // Which edge a drag is hovering over → shows the drop line (top = before, bottom = after).
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sideFor = (e: React.DragEvent): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
  }
  // The board is the canvas's other view of the same sessions, and it reads the same store — so
  // SLEEPING (Eco: the agent CLI was exited to reclaim its RAM) is one more branch here, not a
  // follow-up. Ranked last: a hibernated node is idle by definition, so `working`/`waiting` can
  // only mean the wake already landed and the hooks are ahead of the flag.
  const badge =
    session.kind !== 'sticky' && status?.state === 'working'
      ? 'running'
      : session.kind !== 'sticky' && (status?.state === 'waiting' || status?.state === 'blocked')
        ? 'needs'
        : session.kind !== 'sticky' && status?.paused
          ? 'paused'
          : session.kind !== 'sticky' && status?.hibernated
            ? 'sleeping'
            : null
  const stickyPreview = session.kind === 'sticky' ? (session.text ?? '').trim() : ''
  const assignees = meta?.assignees ?? []
  const due = meta?.dueAt
  const overdue = due !== undefined && due < Date.now()
  const priority = meta?.priority
  const hasDetail = !!status?.sessionId || !!status?.session || stickyPreview.includes('\n')
  return (
    <div
      className={`kanban-card kanban-card--session${dragging ? ' kanban-card--dragging' : ''}${
        dropSide ? ` kanban-card--drop-${dropSide}` : ''
      }`}
      draggable
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
        <span className="kanban-card__title">{session.title}</span>
        {session.kind === 'sticky' && <span className="kanban-card__kind">note</span>}
        {session.kind === 'browser' && <span className="kanban-card__kind">web</span>}
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
      {(labels.length > 0 || assignees.length > 0 || due !== undefined || priority !== undefined) && (
        <div className="kanban-card__metarow">
          {/* Labels share the priority/due/avatars row (left); the meta chips hug the right. */}
          <LabelChips labels={labels} size="sm" className="kanban-card__metalabels" />
          <div className="kanban-card__metaright">
            {priority !== undefined && PRIO_COLOR[priority] && (
              <span
                className="kanban-due kanban-prio-chip"
                style={{ background: `${PRIO_COLOR[priority]}26`, color: PRIO_COLOR[priority] }}
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
              <ContextMeter sessionId={status?.sessionId ?? null} />
              {status?.session && (
                <span className="kanban-card__session" title={status.session}>
                  {status.session}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})
