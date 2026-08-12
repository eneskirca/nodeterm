import { useState } from 'react'
import { IconBellFilled, IconCircleCheck } from './icons'
import type { SessionRowVM } from '../lib/sessionList'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'

export interface SessionRowProps {
  row: SessionRowVM
  onClick(): void
  onClose(): void
  onRename(title: string): void
  onAiName(): void | Promise<void>
  onContextMenu(e: React.MouseEvent): void
  onDragStart(): void
  onDragEnd(): void
}

function ctxColor(pct: number): string {
  if (pct > 85) return '#ff453a'
  if (pct >= 60) return '#ffd60a'
  return '#30d158'
}

function dirName(p?: string): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function SessionRow({
  row,
  onClick,
  onClose,
  onRename,
  onAiName,
  onContextMenu,
  onDragStart,
  onDragEnd
}: SessionRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  // Naming progress lives in a store keyed by node id, so the spinner persists across the row
  // unmounting (sidebar close / hover-peek collapse) while the name is still generating.
  const naming = useSessionNaming((s) => !!s.byId[row.id])
  const usage = useContextWindow((s) => (row.sessionId ? s.bySessionId[row.sessionId] : undefined))

  const commit = (): void => {
    const t = draft.trim()
    if (t && t !== row.title) onRename(t)
    setEditing(false)
  }

  const aiName = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (naming) return
    void onAiName()
  }

  return (
    <div
      className="ss-row"
      draggable={!editing}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        // Some browsers require data to be set for a drag to start.
        e.dataTransfer.setData('text/plain', row.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      {row.statusKind === 'attention' ? (
        // Needs-you rings a bell — louder than one more colored dot.
        <span className="ss-bell" title={row.stateLabel}>
          <IconBellFilled />
        </span>
      ) : row.statusKind !== 'working' && row.unread ? (
        // Finished (or reset to idle) while the user wasn't looking: the SAME check glyph,
        // but accent-blue and pulsing until they visit the node. Working/attention win —
        // a new turn or a permission prompt is more urgent than an old unread mark.
        <span className="ss-check ss-check--unread" title="Finished — new for you">
          <IconCircleCheck />
        </span>
      ) : row.statusKind === 'done' ? (
        // Completion glyph: a check icon scans better than one more dot.
        <span className="ss-check" title={row.stateLabel}>
          <IconCircleCheck />
        </span>
      ) : (
        <span className={`ss-dot ss-dot--${row.statusKind}`} title={row.stateLabel} />
      )}
      <div className="ss-row__body">
        <div className="ss-row__titleline">
          {row.projectColor ? (
            // Status mode: rows are flattened across projects, so each row shows its project's
            // monogram (colored circle with the project initial) instead of the plain color mark.
            <span
              className="ss-mark ss-mark--project"
              style={{ background: row.projectColor }}
              title={row.projectName}
            >
              {(row.projectName?.trim() || '?').charAt(0).toUpperCase()}
            </span>
          ) : (
            <span className="ss-mark" style={{ background: row.color }} />
          )}
          {editing ? (
            <input
              className="ss-title-input"
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <span
              className={`ss-title${row.unread ? ' is-unread' : ''}`}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setDraft(row.title)
                setEditing(true)
              }}
            >
              {row.title}
            </span>
          )}
          {row.session && <span className="ss-chip">{row.session}</span>}
          {row.loop && (
            <span className="ss-loop">
              {row.loop.kind} · {row.loop.count}
            </span>
          )}
          {row.usesContext && usage && (
            <span className="ss-ctx" style={{ background: ctxColor(usage.usedPercent) }}>
              {Math.round(usage.usedPercent)}%
            </span>
          )}
          <button
            className="ss-row__ai"
            title="Name with AI (from terminal output)"
            disabled={naming}
            onClick={aiName}
          >
            {naming ? '…' : '✦'}
          </button>
          <button
            className="ss-row__close"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            ×
          </button>
        </div>
        {(row.projectName || row.cwd || row.sshHost) && (
          <div className="ss-meta">
            {row.projectName && <span className="ss-meta__project">{row.projectName}</span>}
            {row.sshHost && <span className="ss-meta__ssh">⇅ {row.sshHost}</span>}
            {row.cwd && <span className="ss-meta__cwd">{dirName(row.cwd)}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
