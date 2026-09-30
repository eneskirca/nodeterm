import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import {
  BOARD_COMMENT_MENTION_MAX,
  boardCommentOutcomeText,
  commentIdOfSource,
  commentSegments,
  parseMentions
} from '@shared/board-comment'
import { formatTimeAgo } from '../../lib/usageFormat'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useBoardLog } from '../../state/boardLog'
import { useBoardCommentDelivery } from '../../state/boardCommentDelivery'
import { collapseFeed } from '../../lib/boardLogCollapse'
import {
  boardCommentTraces,
  isBoardCommentTrace,
  mentionStatuses,
  type MentionStatus
} from '../../lib/boardCommentStatus'
import { canDeliverBoardComments, deliverCommentMentions } from '../../lib/boardCommentDelivery'
import {
  insertMention,
  mentionOptions,
  mentionQueryAt,
  type MentionCandidate
} from '../../lib/boardMentions'
import { isBrowserRuntime } from '../../bridge/runtime'
import { stationTrigger } from '@shared/station-notice'
import type { KanbanSession } from './KanbanView'

interface BoardLogPanelProps {
  /** The card/node whose activity this panel shows — feed + composer are scoped to `card.id`.
   *  Only the id is needed, so the canvas node flyout can use this panel without building a
   *  full KanbanSession. A GitHub issue card passes its synthetic board-log id (`issueLogId`). */
  card: Pick<KanbanSession, 'id'>
  /** Panel heading. Defaults to the session card's "Comments & activity". */
  title?: string
  /** Hide the comment composer — the issue card's run history is read-only, because a comment box
   *  under a GitHub issue reads as "post to GitHub", and this log never leaves the project. */
  readOnly?: boolean
  /** Shown when the feed is empty (defaults to nothing). */
  emptyText?: string
  /** The agent sessions on this board a comment may @mention (`mentionCandidatesFrom`). Also what a
   *  mention renders as — the node's CURRENT title. Absent ⇒ no @ picker. */
  mentionables?: readonly MentionCandidate[]
}

/** The activity sentence WITHOUT the leading author name — the name is rendered separately in
 *  the author's color, so the feed reads like Trello (colored actor + muted action). column-*
 *  events carry no nodeId and so never reach a card-scoped feed; kept for completeness. */
export function eventBody(e: BoardLogEvent): string {
  switch (e.type) {
    case 'card-created':
      return `created this card in ${e.to ?? 'Ungrouped'}`
    case 'card-moved':
      // `title` is the reason when the board moved the card itself ("PR #12 merged").
      return `moved this card ${e.from ?? 'Ungrouped'} → ${e.to ?? 'Ungrouped'}${e.title ? ` (${e.title})` : ''}`
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
      // A board comment's delivery line: normally shown ON its comment's row (and hidden as a row of
      // its own); it stands alone only where the comment itself is not — a comment written on
      // another card that mentioned this session.
      if (commentIdOfSource(e.from))
        return `routed a board comment here: ${boardCommentOutcomeText(String(e.title ?? ''), e.reason).text}`
      return `sent a message to ${e.to ?? 'another node'} (${e.title ?? 'unknown outcome'})`
    case 'agent-read-cookies':
      // A loud, human-visible line for a cookie read (the whole point of the trace). `from` names the
      // agent, `to` the domain it read; `title` names the browser node it drove.
      return `read cookies for ${e.to ?? 'a site'}${e.title ? ` via ${e.title}` : ''}`
    case 'run-started':
      // The run's fields come from a git-shared file like everything else here: rendered as text
      // only (React escapes it), and never turned into an action.
      return `started ${runName(e)} on this issue`
    case 'run-ended':
      return `closed ${runName(e)}${e.run?.end ? ` (last state: ${e.run.end})` : ''}`
    case 'station-failed':
      // Rendered from the closed reason table, never from anything the station wrote: `to` is a
      // reason CODE, and an unknown one (a newer peer, a hand edit) reads as a plain "stopped".
      return `told this agent that station ${stationName(e)} stopped: ${stationTrigger(e.to)?.label ?? 'it stopped'}`
    case 'station-reported':
      // `to` is the outcome CODE and `title` the station's note — from a shared file, so text only
      // (React escapes it); an outcome this build does not know reads as a plain report.
      return `recorded this session's report: ${
        e.to === 'succeeded' ? 'its task succeeded' : e.to === 'failed' ? 'its task failed' : 'an outcome'
      }${typeof e.title === 'string' && e.title ? ` — "${e.title}"` : ''}`
    default:
      // A newer peer may write event types this build doesn't know — show them neutrally.
      return `updated this card`
  }
}

/** `"Build UI" (term-1a2b)` — the station as the notice named it. Text only, like `runName`. */
function stationName(e: BoardLogEvent): string {
  const id = typeof e.from === 'string' && e.from ? ` (${e.from})` : ''
  return typeof e.title === 'string' && e.title ? `"${e.title}"${id}` : `${e.from ?? 'a station'}`
}

/** "Claude session term-1a2b" — the node title when the event recorded one, else the node id. */
function runName(e: BoardLogEvent): string {
  const who = typeof e.title === 'string' && e.title ? e.title : 'a session'
  const id = typeof e.run?.nodeId === 'string' ? ` (${e.run.nodeId})` : ''
  return `${who}${id}`
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
 *  comment or a board change lands live; unsubscribes on unmount / card swap.
 *
 *  A comment that @mentions a session (the composer's @ picker) is also delivered to that agent —
 *  ONLY from this composer's send, with the text just typed, and only in the desktop app's own
 *  window (`canDeliverBoardComments`). A comment that arrives in the log (git pull, another
 *  instance, a relay peer, a team-presence guest) renders its mentions and types nowhere. */
export function BoardLogPanel({ card, title, readOnly, emptyText, mentionables }: BoardLogPanelProps) {
  const { api, source } = useSession()
  const projectId = useProjects((s) => s.activeProjectId)
  const entries = useBoardLog((s) => s.entriesFor(projectId))
  const unsupported = useBoardLog((s) => !!s.unsupportedByProject[projectId])
  const error = useBoardLog((s) => !!s.errorByProject[projectId])
  const deliveries = useBoardCommentDelivery((s) => s.byComment)
  const sent = useBoardCommentDelivery((s) => s.sent)
  const [draft, setDraft] = useState('')
  const [composeError, setComposeError] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ start: number; caret: number; query: string } | null>(null)
  const [pick, setPick] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const canDeliver = canDeliverBoardComments(source, isBrowserRuntime())
  const candidates = canDeliver ? (mentionables ?? []) : []
  const options = picker ? mentionOptions(candidates, picker.query) : []

  useEffect(() => {
    if (!projectId) return
    void useBoardLog.getState().load(api, projectId)
    const unsub = useBoardLog.getState().subscribeChanged(api, projectId)
    return unsub
  }, [api, projectId])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    const mentions = canDeliver ? parseMentions(text) : []
    if (mentions.length > BOARD_COMMENT_MENTION_MAX) {
      setComposeError(`A comment can mention at most ${BOARD_COMMENT_MENTION_MAX} sessions.`)
      return
    }
    const entry = useBoardLog.getState().append(api, projectId, { kind: 'comment', nodeId: card.id, text })
    setDraft('')
    setPicker(null)
    setComposeError(null)
    // The one place a delivery starts: this send, this text. Mentions are re-parsed from the text
    // as it was stored (clamped), which is exactly what main will parse them from.
    if (mentions.length && entry.text)
      void deliverCommentMentions(
        { projectId, commentId: entry.id, author: entry.author.name, text: entry.text },
        parseMentions(entry.text)
      )
  }

  const choose = (c: MentionCandidate): void => {
    if (!picker) return
    const next = insertMention(draft, picker.start, picker.caret, c)
    setDraft(next.text)
    setPicker(null)
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  /** Re-read the @query at the caret — on every edit, and whenever the caret moves (a click, an
   *  arrow key), so the picker never inserts at a place the user has left. */
  const syncPicker = (value: string, caret: number): void => {
    const q = candidates.length ? mentionQueryAt(value, caret) : null
    setPicker((cur) => {
      if (!q) return null
      if (cur && cur.start === q.start && cur.query === q.query && cur.caret === caret) return cur
      return { ...q, caret }
    })
  }

  const onDraftChange = (value: string, caret: number): void => {
    setDraft(value)
    setComposeError(null)
    syncPicker(value, caret)
    setPick(0)
  }

  // Card-scoped: this card's comments + its own events. Column events (no nodeId) never match. A
  // board comment's delivery line is shown ON its comment's row — so it is not also a row of its own
  // when that comment is on THIS card and is one this machine sent (the only comments whose row
  // shows a status). Everywhere else — the mentioned session's own card, a teammate's comment — it
  // stays a line. `traces` reads the WHOLE log: a line is filed under the session it went to.
  const all = entries ?? []
  const ownHere = new Set(
    all.filter((e) => e.kind === 'comment' && e.nodeId === card.id && sent[e.id] !== undefined).map((e) => e.id)
  )
  const traces = useMemo(() => boardCommentTraces(all), [all])
  const feed = all.filter(
    (e) =>
      e.nodeId === card.id &&
      !(isBoardCommentTrace(e) && ownHere.has(commentIdOfSource(e.event?.from) ?? ''))
  )
  const titles = useMemo(() => new Map((mentionables ?? []).map((m) => [m.id, m.title])), [mentionables])
  const pending = canDeliver ? parseMentions(draft) : []

  return (
    <div className="board-log">
      <div className="board-log__title">{title ?? 'Comments & activity'}</div>
      {unsupported ? (
        <div className="board-log__hint">Board history needs a project folder</div>
      ) : readOnly ? null : (
        <div className="board-log__compose">
          <textarea
            ref={composerRef}
            className="board-log__composer"
            value={draft}
            placeholder={candidates.length ? 'Write a comment… (@ to mention a session)' : 'Write a comment…'}
            aria-autocomplete={candidates.length ? 'list' : undefined}
            aria-expanded={options.length > 0 ? true : undefined}
            onChange={(e) => onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyUp={(e) => {
              // A caret move (arrows, Home/End) — the keys that edit already went through onChange.
              if (!picker || e.nativeEvent.isComposing) return
              const el = e.currentTarget
              syncPicker(el.value, el.selectionStart ?? el.value.length)
            }}
            onClick={(e) => {
              const el = e.currentTarget
              syncPicker(el.value, el.selectionStart ?? el.value.length)
            }}
            onBlur={() => setPicker(null)}
            onKeyDown={(e) => {
              // Never act mid-IME-composition (e.g. selecting a kanji candidate with Enter).
              if (e.nativeEvent.isComposing) return
              if (picker && options.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const d = e.key === 'ArrowDown' ? 1 : -1
                  setPick((i) => (i + d + options.length) % options.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(options[Math.min(pick, options.length - 1)])
                  return
                }
              }
              if (picker && e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setPicker(null)
                return
              }
              // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {options.length > 0 && (
            <div className="board-log__mention-picker" role="listbox" aria-label="Mention a session">
              {options.map((c, i) => (
                <div
                  key={c.id}
                  role="option"
                  aria-selected={i === pick}
                  className={`board-log__mention-option${i === pick ? ' is-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault() // keep the caret in the composer
                    choose(c)
                  }}
                >
                  {c.title}
                </div>
              ))}
            </div>
          )}
          {pending.length > 0 && (
            <div className="board-log__deliver-note">
              Delivers to {pending.map((id) => `@${titles.get(id) ?? id}`).join(', ')} when you send —
              through agent messaging, when the session is idle.
            </div>
          )}
          {composeError && <div className="board-log__error">{composeError}</div>}
        </div>
      )}
      {!unsupported && error && (
        <div className="board-log__error">Some board history couldn’t be saved.</div>
      )}
      {!unsupported && feed.length === 0 && emptyText && (
        <div className="board-log__hint">{emptyText}</div>
      )}
      <BoardLogFeed
        feed={feed}
        titles={titles}
        statusesFor={(entry) =>
          mentionStatuses(entry, traces, deliveries[entry.id], {
            own: sent[entry.id] !== undefined,
            now: Date.now()
          })
        }
      />
    </div>
  )
}

/** The feed itself, newest first. Runs of like events render folded as one "×N" row that expands
 *  in place (lib/boardLogCollapse — a VIEW; the log is never rewritten). Comments and the audit
 *  types are always one row each. Which groups are open is component state keyed by the group's
 *  newest entry id, so a new entry landing on top does not collapse a row the user just opened.
 *  `titles` renders a mention as its session's current title; `statusesFor` puts a comment's
 *  delivery outcomes on its own row. */
export function BoardLogFeed({
  feed,
  titles,
  statusesFor
}: {
  feed: readonly BoardLogEntry[]
  titles?: ReadonlyMap<string, string>
  statusesFor?: (entry: BoardLogEntry) => MentionStatus[]
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const items = useMemo(() => collapseFeed(feed), [feed])
  const toggle = (key: string): void =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const row = (entry: BoardLogEntry, fold?: React.ReactNode, key?: string) => (
    <FeedRow
      key={key ?? entry.id}
      entry={entry}
      fold={fold}
      titles={titles}
      statuses={entry.kind === 'comment' ? statusesFor?.(entry) : undefined}
    />
  )
  return (
    <div className="board-log__feed">
      {items.map((item) => {
        if (item.kind === 'single') return row(item.entry)
        const expanded = open.has(item.key)
        const fold = (
          <button
            className="board-log__fold"
            aria-expanded={expanded}
            title={expanded ? 'Collapse' : `Show all ${item.entries.length}`}
            onClick={() => toggle(item.key)}
          >
            ×{item.entries.length}
          </button>
        )
        return expanded ? (
          <div key={item.key} className="board-log__group board-log__group--open">
            {item.entries.map((entry, i) => row(entry, i === 0 ? fold : undefined))}
          </div>
        ) : (
          row(item.entries[0], fold, item.key)
        )
      })}
    </div>
  )
}

/** A comment's text with each mention token drawn as its session's name — the CURRENT title when
 *  the session is on this board, else the name the token was written with. Text only: React escapes
 *  it, and nothing here is ever turned into an action. */
function CommentText({ text, titles }: { text: string; titles?: ReadonlyMap<string, string> }) {
  return (
    <>
      {commentSegments(text).map((s, i) =>
        s.kind === 'text' ? (
          s.text
        ) : (
          <span key={i} className="board-log__mention" title={s.nodeId}>
            @{titles?.get(s.nodeId) || s.label || s.nodeId}
          </span>
        )
      )}
    </>
  )
}

function FeedRow({
  entry,
  fold,
  titles,
  statuses
}: {
  entry: BoardLogEntry
  fold?: React.ReactNode
  titles?: ReadonlyMap<string, string>
  statuses?: MentionStatus[]
}) {
  const when = formatStamp(entry.ts)
  const whenAgo = formatTimeAgo(entry.ts)
  const nameOf = (nodeId: string): string => {
    const current = titles?.get(nodeId)
    if (current) return current
    for (const s of commentSegments(entry.text ?? ''))
      if (s.kind === 'mention' && s.nodeId === nodeId && s.label) return s.label
    return nodeId
  }
  if (entry.kind === 'event' && entry.event) {
    return (
      <div className="board-log__event" title={whenAgo}>
        <span className="board-log__dot" style={{ background: entry.author.color }} />
        <span className="board-log__author" style={{ color: entry.author.color }}>
          {entry.author.name}
        </span>{' '}
        <span className="board-log__event-body">{eventBody(entry.event)}</span>
        {fold}
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
      <div className="board-log__text">
        <CommentText text={entry.text ?? ''} titles={titles} />
      </div>
      {statuses && statuses.length > 0 && (
        <ul className="board-log__deliveries" aria-label="Delivery to mentioned sessions">
          {statuses.map((m) => (
            <li key={m.nodeId} className={`board-log__delivery board-log__delivery--${m.view.tone}`}>
              <span className="board-log__mention">@{nameOf(m.nodeId)}</span>{' '}
              {m.view.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
