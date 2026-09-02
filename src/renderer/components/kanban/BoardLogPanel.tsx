import { useEffect, useState } from 'react'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import { formatTimeAgo } from '../../lib/usageFormat'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useBoardLog } from '../../state/boardLog'
import type { KanbanSession } from './KanbanView'

interface BoardLogPanelProps {
  /** The card/node whose activity this panel shows — feed + composer are scoped to `card.id`.
   *  Only the id is needed, so the canvas node flyout can use this panel without building a
   *  full KanbanSession. */
  card: Pick<KanbanSession, 'id'>
}

/** The activity sentence WITHOUT the leading author name — the name is rendered separately in
 *  the author's color, so the feed reads like Trello (colored actor + muted action). column-*
 *  events carry no nodeId and so never reach a card-scoped feed; kept for completeness. */
export function eventBody(e: BoardLogEvent): string {
  switch (e.type) {
    case 'card-created':
      return `created this card in ${e.to ?? 'Ungrouped'}`
    case 'card-moved':
      return `moved this card ${e.from ?? 'Ungrouped'} → ${e.to ?? 'Ungrouped'}`
    case 'column-added':
      return `added column ${e.title ?? ''}`.trimEnd()
    case 'column-renamed':
      return `renamed column ${e.from ?? ''} → ${e.to ?? ''}`
    case 'column-deleted':
      return `deleted column ${e.title ?? ''}`.trimEnd()
    case 'member-assigned':
      return `assigned ${e.to ?? 'someone'}`
    case 'member-unassigned':
      return `removed ${e.to ?? 'someone'}`
    case 'due-set':
      return `set the due date → ${e.to ? formatStamp(Date.parse(e.to)) : ''}`.trimEnd()
    case 'due-cleared':
      return `removed the due date`
    case 'priority-set':
      return `set priority → ${e.to ?? ''}`.trimEnd()
    case 'priority-cleared':
      return `removed the priority`
    case 'agent-message':
      return `sent a message to ${e.to ?? 'another node'} (${e.title ?? 'unknown outcome'})`
    case 'github-attached':
      return `attached ${e.to === 'pull' ? 'PR' : 'issue'} ${e.title ?? ''}`.trimEnd()
    case 'github-detached':
      return `detached ${e.to === 'pull' ? 'PR' : 'issue'} ${e.title ?? ''}`.trimEnd()
    case 'agent-read-cookies':
      // A loud, human-visible line for a cookie read (the whole point of the trace). `from` names the
      // agent, `to` the domain it read; `title` names the browser node it drove.
      return `read cookies for ${e.to ?? 'a site'}${e.title ? ` via ${e.title}` : ''}`
    default:
      // A newer peer may write event types this build doesn't know — show them neutrally.
      return `updated this card`
  }
}

/** Absolute, Trello-style stamp ("19 Jul 2026, 22:50") — the feed shows dates, not "2h ago"
 *  (the relative form stays in the row's tooltip). */
function formatStamp(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Right panel of the card modal (all card kinds): a composer on top and the card's own
 *  comments + activity feed newest-first. Reads/writes the board log for the ACTIVE project via
 *  its session api — resolved here (not threaded from Canvas). Subscribes on mount, so a teammate's
 *  comment or a board change lands live; unsubscribes on unmount / card swap. */
export function BoardLogPanel({ card }: BoardLogPanelProps) {
  const { api } = useSession()
  const projectId = useProjects((s) => s.activeProjectId)
  const entries = useBoardLog((s) => s.entriesFor(projectId))
  const unsupported = useBoardLog((s) => !!s.unsupportedByProject[projectId])
  const error = useBoardLog((s) => !!s.errorByProject[projectId])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!projectId) return
    void useBoardLog.getState().load(api, projectId)
    const unsub = useBoardLog.getState().subscribeChanged(api, projectId)
    return unsub
  }, [api, projectId])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    useBoardLog.getState().append(api, projectId, { kind: 'comment', nodeId: card.id, text })
    setDraft('')
  }

  // Card-scoped: this card's comments + its own events. Column events (no nodeId) never match.
  const feed = (entries ?? []).filter((e) => e.nodeId === card.id)

  return (
    <div className="board-log">
      <div className="board-log__title">Comments & activity</div>
      {unsupported ? (
        <div className="board-log__hint">Board history needs a project folder</div>
      ) : (
        <textarea
          className="board-log__composer"
          value={draft}
          placeholder="Write a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
            // Never submit mid-IME-composition (e.g. selecting a kanji candidate with Enter).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
      )}
      {!unsupported && error && (
        <div className="board-log__error">Some board history couldn’t be saved.</div>
      )}
      <div className="board-log__feed">
        {feed.map((entry) => (
          <FeedRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function FeedRow({ entry }: { entry: BoardLogEntry }) {
  const when = formatStamp(entry.ts)
  const whenAgo = formatTimeAgo(entry.ts)
  if (entry.kind === 'event' && entry.event) {
    return (
      <div className="board-log__event" title={whenAgo}>
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author" style={{ color: entry.author.color }}>
          {entry.author.name}
        </span>{' '}
        <span className="board-log__event-body">{eventBody(entry.event)}</span>
        <span className="board-log__time">{when}</span>
      </div>
    )
  }
  return (
    <div className="board-log__comment">
      <div className="board-log__meta">
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author" style={{ color: entry.author.color }}>
          {entry.author.name}
        </span>
        <span className="board-log__time" title={whenAgo}>{when}</span>
      </div>
      <div className="board-log__text">{entry.text}</div>
    </div>
  )
}
