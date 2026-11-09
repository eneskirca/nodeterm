import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconClose, IconSwitch, IconTrash } from '../icons'
import { cardCount } from './cardMenu'

interface CardSelectionBarProps {
  count: number
  /** Where the selection can go (cardMenu `bulkMoveTargets`). Empty = no Move button. */
  moveTargets: MenuItem[]
  /** Delete every selected card (the caller confirms once). Absent = no Delete button. */
  onDelete?: () => void
  onClear: () => void
}

/**
 * The floating bar a board shows while session cards are selected: how many, and what can be done
 * to all of them at once. It is the visible half of multi-select — the count is also what tells
 * the user a plain click now picks cards instead of opening them.
 */
export function CardSelectionBar({ count, moveTargets, onDelete, onClear }: CardSelectionBarProps) {
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)
  // A body portal: `position: fixed` resolves against the nearest ancestor with a transform or a
  // backdrop-filter, and a swimlane (or a themed board) is free to have one.
  return createPortal(
    <div className="kanban-select-bar" role="toolbar" aria-label="Selected cards">
      <span className="kanban-select-bar__count" aria-live="polite">{cardCount(count)} selected</span>
      {moveTargets.length > 0 && (
        <button
          className="kanban-select-bar__btn"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMoveMenu({ x: r.left, y: r.top - 4 })
          }}
        >
          <IconSwitch />
          Move to…
        </button>
      )}
      {onDelete && (
        <button className="kanban-select-bar__btn kanban-select-bar__btn--danger" onClick={onDelete}>
          <IconTrash />
          Delete
        </button>
      )}
      <button
        className="kanban-select-bar__btn kanban-select-bar__clear"
        title="Clear selection (Esc)"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <IconClose />
      </button>
      {moveMenu && (
        <ContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          zIndex={60}
          items={moveTargets}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>,
    document.body
  )
}
