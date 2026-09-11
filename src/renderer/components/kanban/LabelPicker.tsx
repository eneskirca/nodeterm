import { useMemo, useRef, useState } from 'react'
import { IconClose, IconMore } from '../icons'
import type { KanbanLabelColor, ProjectKanban } from '@shared/types'
import {
  autoLabelColor,
  boardLabels,
  createLabel,
  deleteLabel,
  labelsForCard,
  recolorLabel,
  renameLabel,
  toggleCardLabel
} from '../../lib/kanban'
import { LABEL_COLOR_OPTIONS, labelSwatch } from '../../lib/kanbanLabelColors'

/**
 * Notion-style label picker: type to filter existing labels or CREATE a new one inline, click a row
 * to assign/unassign, and edit a label (rename / recolor / delete) from its ⋯ menu. All edits go
 * through the pure `kanban.ts` transforms and out via `onChange` (which the modal persists).
 */
export function LabelPicker({
  board,
  nodeId,
  onChange
}: {
  board: ProjectKanban
  nodeId: string
  onChange: (next: ProjectKanban) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  // Color chosen for the NEXT label created inline. Seeded to the rotating auto-color; the user can
  // override it before hitting Create, and it re-seeds to the next auto-color after each create.
  const [createColor, setCreateColor] = useState<KanbanLabelColor>(() => autoLabelColor(board))
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const all = boardLabels(board)
  const assigned = labelsForCard(board, nodeId)
  const assignedIds = useMemo(() => new Set(assigned.map((l) => l.id)), [assigned])
  const q = query.trim().toLowerCase()
  const filtered = q ? all.filter((l) => l.name.toLowerCase().includes(q)) : all
  const exact = all.some((l) => l.name.trim().toLowerCase() === q)
  const canCreate = q.length > 0 && !exact

  const toggle = (id: string) => onChange(toggleCardLabel(board, nodeId, id))
  const create = () => {
    if (!canCreate) return
    const { k, id } = createLabel(board, query.trim(), createColor)
    onChange(toggleCardLabel(k, nodeId, id))
    setQuery('')
    setColorMenuOpen(false)
    setCreateColor(autoLabelColor(k)) // advance to the next auto-color for the following create
    inputRef.current?.focus()
  }

  const editLabel = editing ? all.find((l) => l.id === editing) : undefined

  if (editLabel) {
    // ── Edit panel for one label (rename / color / delete) — Notion's ⋯ popover. ──
    const sw = labelSwatch(editLabel.color)
    return (
      <div className="label-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="label-picker__edithead">
          <button className="label-picker__back" title="Back" onClick={() => setEditing(null)}>
            ‹
          </button>
          <input
            className="label-picker__renameinput"
            autoFocus
            value={editLabel.name}
            style={{ background: sw.bg, color: sw.fg }}
            onChange={(e) => onChange(renameLabel(board, editLabel.id, e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setEditing(null)
            }}
          />
        </div>
        <button
          className="label-picker__delete"
          onClick={() => {
            onChange(deleteLabel(board, editLabel.id))
            setEditing(null)
          }}
        >
          🗑 Delete
        </button>
        <div className="label-picker__colhead">Colors</div>
        <div className="label-picker__colors">
          {LABEL_COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.color}
              className="label-picker__colorrow"
              onClick={() => onChange(recolorLabel(board, editLabel.id, opt.color))}
            >
              <span className="label-picker__swatch" style={{ background: opt.bg }} />
              <span className="label-picker__colorname">{opt.title}</span>
              {editLabel.color === opt.color && <span className="label-picker__check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="label-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div className="label-picker__input" onClick={() => inputRef.current?.focus()}>
        {assigned.map((l) => {
          const s = labelSwatch(l.color)
          return (
            <span key={l.id} className="kanban-label-chip" style={{ background: s.bg, color: s.fg }}>
              {l.name || 'Label'}
              <button className="kanban-label-chip__x" title="Remove" onClick={() => toggle(l.id)}>
                <IconClose />
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          className="label-picker__search"
          autoFocus
          value={query}
          spellCheck={false}
          placeholder={assigned.length ? '' : 'Select an option or create one'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) create()
            if (e.key === 'Backspace' && !query && assigned.length) toggle(assigned[assigned.length - 1].id)
          }}
        />
      </div>
      <div className="label-picker__hint">Select an option or create one</div>
      <div className="label-picker__list">
        {filtered.map((l) => {
          const s = labelSwatch(l.color)
          return (
            <div key={l.id} className="label-picker__row">
              <button className="label-picker__pick" onClick={() => toggle(l.id)}>
                <span className="kanban-label-chip" style={{ background: s.bg, color: s.fg }}>
                  {l.name || 'Label'}
                </span>
                {assignedIds.has(l.id) && <span className="label-picker__rowcheck">✓</span>}
              </button>
              <button
                className="label-picker__more"
                title="Edit label"
                onClick={() => setEditing(l.id)}
              >
                <IconMore />
              </button>
            </div>
          )
        })}
      </div>
      {canCreate && (
        <div className="label-picker__createrow">
            <button
              className="label-picker__createcolor"
              title="Pick color"
              onClick={() => setColorMenuOpen((v) => !v)}
            >
              <span className="label-picker__swatch" style={{ background: labelSwatch(createColor).bg }} />
              <span className="label-picker__caret">▾</span>
            </button>
            <button className="label-picker__create" onClick={create}>
              Create{' '}
              <span
                className="kanban-label-chip"
                style={{ background: labelSwatch(createColor).bg, color: labelSwatch(createColor).fg }}
              >
                {query.trim()}
              </span>
            </button>
            {colorMenuOpen && (
              <div className="label-picker__createcolors">
                {LABEL_COLOR_OPTIONS.map((opt) => (
                  <button
                    key={opt.color}
                    className="label-picker__colorrow"
                    onClick={() => {
                      setCreateColor(opt.color)
                      setColorMenuOpen(false)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="label-picker__swatch" style={{ background: opt.bg }} />
                    <span className="label-picker__colorname">{opt.title}</span>
                    {createColor === opt.color && <span className="label-picker__check">✓</span>}
                  </button>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  )
}
