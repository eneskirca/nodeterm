import { memo, useCallback, useState } from 'react'
import type { KanbanColumn as KanbanColumnT } from '@shared/types'
import { NODE_COLORS } from '../../state/workspace'
import { SessionCard } from './SessionCard'
import type { KanbanCardMeta, KanbanLabel } from '@shared/types'
import type { KanbanCreateChoice, KanbanCreateOption, KanbanSession } from './KanbanView'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubIssueCard } from './GitHubIssueCard'

interface KanbanColumnProps {
  /** null = the virtual Ungrouped column: fixed label, no rename/recolor/delete, header not draggable. */
  column: KanbanColumnT | null
  cards: KanbanSession[]
  githubCards?: GitHubIssueCardView[]
  githubColumns?: KanbanColumnT[]
  githubMoving?: Record<number, true>
  githubReadOnly?: boolean
  githubStatus?: Record<number, string>
  displayCount?: number
  // Column-scoped callbacks carry the column id (and card-scoped ones the node id) so KanbanView
  // can hand every column the SAME function references — that identity stability is what lets
  // memo() skip columns/cards untouched by a render.
  onRename?: (columnId: string, title: string) => void
  onRecolor?: (columnId: string, color: string) => void
  onDelete?: (columnId: string) => void
  /** Open a card's modal (↗ / double-click on the card). */
  onOpenCard: (nodeId: string) => void
  /** Card metadata lookup (assignees/due) for the chips on each card. */
  metaOf: (nodeId: string) => KanbanCardMeta | undefined
  /** Resolved board labels for a card (the colored label chips). */
  labelsOf: (nodeId: string) => KanbanLabel[]
  /** "+ New" menu entries (agents, terminal, sticky) and what to do when one is picked
   *  (columnId null = Ungrouped: no assignment). */
  createOptions: KanbanCreateOption[]
  onCreate: (choice: KanbanCreateChoice, columnId: string | null) => void
  // Drag plumbing — the single drag source of truth lives in KanbanView.
  onCardDragStart: (nodeId: string) => void
  onColumnDragStart?: (columnId: string) => void
  onDragEnd: () => void
  /** Drop on the column body: a card lands at the END of this column; a column lands BEFORE it. */
  onDropOnColumn: (columnId: string | null) => void
  onDropAtCard: (columnId: string | null, nodeId: string, side: 'before' | 'after') => void
  /** Right-click on a card — bubbles the cursor position + node id up to the board menu. */
  onCardContext: (nodeId: string, x: number, y: number) => void
  onOpenGitHub?: (issue: GitHubIssueCardView) => void
  onMoveGitHub?: (issue: GitHubIssueCardView, columnId: string | null) => void
  onGitHubDragStart?: (issue: GitHubIssueCardView) => void
  onLoadMoreGitHub?: (columnId: string | null) => void
  hasMoreGitHub?: boolean
}

export const KanbanColumn = memo(function KanbanColumn({
  column, cards, githubCards = [], githubColumns = [], githubMoving = {}, displayCount, metaOf, labelsOf,
  githubReadOnly = false, githubStatus = {},
  onRename, onRecolor, onDelete, onOpenCard, onCardContext, onOpenGitHub, onMoveGitHub,
  onGitHubDragStart, onLoadMoreGitHub, hasMoreGitHub,
  createOptions, onCreate, onCardDragStart, onColumnDragStart, onDragEnd, onDropOnColumn,
  onDropAtCard
}: KanbanColumnProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(column?.title ?? '')
  const [swatchesOpen, setSwatchesOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  // Trello-style drop highlight: counted enter/leave (dragleave fires when crossing children).
  const [dragOverCount, setDragOverCount] = useState(0)

  const colId = column?.id ?? null
  // Binds this column's id onto the shared card-drop handler; stable while the parent's is.
  const dropAtCard = useCallback(
    (nodeId: string, side: 'before' | 'after') => onDropAtCard(colId, nodeId, side),
    [onDropAtCard, colId]
  )

  const commitTitle = () => {
    const t = title.trim()
    if (column && t && t !== column.title) onRename?.(column.id, t)
    setEditingTitle(false)
  }

  return (
    <div
      className={`kanban-col${column ? '' : ' kanban-col--ungrouped'}${dragOverCount > 0 ? ' kanban-col--drop' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setDragOverCount((c) => c + 1)}
      onDragLeave={() => setDragOverCount((c) => Math.max(0, c - 1))}
      onDrop={(e) => {
        e.preventDefault()
        setDragOverCount(0)
        onDropOnColumn(colId)
      }}
    >
      <div
        className="kanban-col__header"
        draggable={!!column}
        onDragStart={(e) => {
          if (!column) return
          e.dataTransfer.effectAllowed = 'move'
          onColumnDragStart?.(column.id)
        }}
        onDragEnd={onDragEnd}
      >
        {column ? (
          <button
            className="kanban-col__dot"
            style={{ background: column.color }}
            title="Column color"
            onClick={() => setSwatchesOpen((v) => !v)}
          />
        ) : (
          <span className="kanban-col__dot kanban-col__dot--ungrouped" />
        )}
        {column && editingTitle ? (
          <input
            className="kanban-col__rename"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="kanban-col__title"
            onClick={() => {
              if (!column) return
              setTitle(column.title)
              setEditingTitle(true)
            }}
          >
            {column ? column.title : 'Ungrouped'}
          </span>
        )}
        <span className="kanban-col__count">{displayCount ?? cards.length + githubCards.length}</span>
        {column && (
          <button
            className="kanban-col__close"
            title="Delete column (cards return to Ungrouped)"
            onClick={() => onDelete?.(column.id)}
          >
            ✕
          </button>
        )}
      </div>
      {column && swatchesOpen && (
        <div className="kanban-col__swatches">
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className="kanban-col__swatch"
              style={{ background: c }}
              onClick={() => {
                if (column) onRecolor?.(column.id, c)
                setSwatchesOpen(false)
              }}
            />
          ))}
        </div>
      )}
      <div className="kanban-col__cards">
        {cards.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            meta={metaOf(s.id)}
            labels={labelsOf(s.id)}
            onOpen={onOpenCard}
            onContext={onCardContext}
            onDragStart={onCardDragStart}
            onDragEnd={onDragEnd}
            onDropAt={dropAtCard}
          />
        ))}
        {githubCards.map((issue) => (
          <GitHubIssueCard
            key={`github:${issue.id}`}
            issue={issue}
            columns={githubColumns}
            moving={!!githubMoving[issue.number]}
            readOnly={githubReadOnly}
            status={githubStatus[issue.number]}
            onOpen={(item) => onOpenGitHub?.(item)}
            onMove={(item, target) => onMoveGitHub?.(item, target)}
            onDragStart={(item) => onGitHubDragStart?.(item)}
            onDragEnd={onDragEnd}
          />
        ))}
        {hasMoreGitHub && (
          <button className="kanban-github-more" onClick={() => onLoadMoreGitHub?.(colId)}>
            Show more issues
          </button>
        )}
      </div>
      <div className="kanban-col__footer">
        {newMenuOpen && (
          <div className="kanban-col__newmenu">
            {createOptions.map((o) => (
              <button
                key={o.key}
                onClick={() => {
                  setNewMenuOpen(false)
                  onCreate(o.choice, colId)
                }}
              >
                <span className="kanban-col__newicon">{o.icon}</span>
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button className="kanban-col__new" onClick={() => setNewMenuOpen((v) => !v)}>
          + New session
        </button>
      </div>
    </div>
  )
})
