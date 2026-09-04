import { Fragment, memo, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../icons'
import type { KanbanColumn as KanbanColumnT } from '@shared/types'
import { NODE_COLORS } from '../../state/workspace'
import type { KanbanCreateChoice, KanbanCreateOption } from './KanbanView'
import { byLane, type KanbanSourceId } from '../../lib/kanbanSources'

/** One source's contribution to one column. The board builds the cards (each source renders its
 *  own leaf); the column only places the lanes, so it knows nothing about where a card came from
 *  beyond the registry's stacking order. */
export interface KanbanLane {
  sourceId: KanbanSourceId
  /** This lane's cards, already keyed by the board. */
  cards: React.ReactNode
  /** Trailing affordance under the lane's cards (e.g. GitHub's "Show more issues"). */
  footer?: React.ReactNode
  /** What this lane adds to the column's header count. Not `cards.length`: a provider-placed
   *  source reports a server-side total that can exceed the page it has fetched. */
  count: number
}

interface KanbanColumnProps {
  /** null = the virtual Ungrouped column: fixed label, no rename/recolor/delete, header not draggable. */
  column: KanbanColumnT | null
  /** The column's card lanes, one per visible source; placed in registry lane order. */
  lanes: KanbanLane[]
  // Column-scoped callbacks carry the column id so KanbanView can hand every column the SAME
  // function references — that identity stability is what lets memo() skip untouched columns.
  onRename?: (columnId: string, title: string) => void
  onRecolor?: (columnId: string, color: string) => void
  onDelete?: (columnId: string) => void
  /** "+ New" menu entries (agents, terminal, sticky) and what to do when one is picked
   *  (columnId null = Ungrouped: no assignment). */
  createOptions: KanbanCreateOption[]
  onCreate: (choice: KanbanCreateChoice, columnId: string | null) => void
  // Drag plumbing — the single drag source of truth lives in KanbanView.
  onColumnDragStart?: (columnId: string) => void
  onDragEnd: () => void
  /** Drop on the column body: a card lands at the END of this column; a column lands BEFORE it. */
  onDropOnColumn: (columnId: string | null) => void
}

export const KanbanColumn = memo(function KanbanColumn({
  column, lanes, onRename, onRecolor, onDelete,
  createOptions, onCreate, onColumnDragStart, onDragEnd, onDropOnColumn
}: KanbanColumnProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(column?.title ?? '')
  const [swatchesOpen, setSwatchesOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newTriggerRef = useRef<HTMLButtonElement>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)
  // Trello-style drop highlight: counted enter/leave (dragleave fires when crossing children).
  const [dragOverCount, setDragOverCount] = useState(0)

  useLayoutEffect(() => {
    if (!newMenuOpen) return

    const positionMenu = () => {
      const trigger = newTriggerRef.current
      const menu = newMenuRef.current
      if (!trigger || !menu) return

      const triggerRect = trigger.getBoundingClientRect()
      const width = Math.min(triggerRect.width, Math.max(0, window.innerWidth - 16))
      const left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - width - 8))
      const below = triggerRect.bottom + 4

      // The menu is initially hidden but measurable. Position it below first, then flip above
      // the trigger when the viewport has more room there. Fixed positioning plus the portal
      // keeps it out of the lane's horizontal overflow clip and above following swimlanes.
      menu.style.width = `${width}px`
      menu.style.left = `${left}px`
      menu.style.top = `${below}px`
      const menuHeight = menu.getBoundingClientRect().height
      const fitsBelow = below + menuHeight <= window.innerHeight - 8
      const above = triggerRect.top - menuHeight - 4
      const top = fitsBelow
        ? below
        : above >= 8
          ? above
          : Math.max(8, window.innerHeight - menuHeight - 8)
      menu.style.top = `${top}px`
      menu.style.visibility = 'visible'
    }

    positionMenu()
    window.addEventListener('resize', positionMenu)
    // Capture scroll events from the global board and each horizontally scrollable column.
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [newMenuOpen])

  const colId = column?.id ?? null
  const orderedLanes = byLane(lanes)
  const count = lanes.reduce((total, lane) => total + lane.count, 0)

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
        <span className="kanban-col__count">{count}</span>
        {column && (
          <button
            className="kanban-col__close"
            title="Delete column (cards return to Ungrouped)"
            onClick={() => onDelete?.(column.id)}
          >
            <IconClose />
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
        {orderedLanes.map((lane) => (
          <Fragment key={lane.sourceId}>
            {lane.cards}
            {lane.footer}
          </Fragment>
        ))}
      </div>
      <div className="kanban-col__footer">
        {newMenuOpen && typeof document !== 'undefined' && createPortal(
          <div ref={newMenuRef} className="kanban-col__newmenu kanban-col__newmenu--portal">
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
          </div>,
          document.body
        )}
        <button ref={newTriggerRef} className="kanban-col__new" onClick={() => setNewMenuOpen((v) => !v)}>
          + New session
        </button>
      </div>
    </div>
  )
})
