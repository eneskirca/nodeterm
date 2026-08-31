import { useState } from 'react'
import { IconBellFilled, IconCircleCheck } from './icons'
import { ProjectGlyph } from './ProjectGlyph'
import type { SessionRowVM } from '../lib/sessionList'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'
import { useSettings } from '../state/settings'
import { contextFillColor, contextPillText, percentText } from '../lib/usageFormat'

export interface SessionRowProps {
  row: SessionRowVM
  onClick(): void
  onClose(): void
  onRename(title: string): void
  onAiName(): void | Promise<void>
  onContextMenu(e: React.MouseEvent): void
  onDragStart(): void
  onDragEnd(): void
  /** Status-group mode only: elapsed time since the current state began. */
  stateAgeLabel?: string
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
  onDragEnd,
  stateAgeLabel
}: SessionRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  // Naming progress lives in a store keyed by node id, so the spinner persists across the row
  // unmounting (sidebar close / hover-peek collapse) while the name is still generating.
  const naming = useSessionNaming((s) => !!s.byId[row.id])
  const usage = useContextWindow((s) => (row.sessionId ? s.bySessionId[row.sessionId] : undefined))
  const percentMode = useSettings((s) => s.settings.usagePercentMode)

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
      onMouseDown={(e) => {
        // Middle-click closes the session, same as the × button — but goes through
        // onClose's confirm dialog rather than skipping it (killing a real tmux
        // session isn't the same low-stakes action as closing a browser tab).
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
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
        // Finished before its live state became unknown while the user wasn't looking: the check,
        // but accent-blue and pulsing until they visit the node. Working/attention win —
        // a new turn or a permission prompt is more urgent than an old unread mark.
        <span className="ss-check ss-check--unread" title="Finished — new for you">
          <IconCircleCheck />
        </span>
      ) : (
        <span className={`ss-dot ss-dot--${row.statusKind}`} title={row.stateLabel} />
      )}
      <div className="ss-row__body">
        <div className="ss-row__titleline">
          {row.projectColor ? (
            // Status mode: rows are flattened across projects, so each row shows its project's
            // icon (or, absent one, the monogram — colored circle with the project initial)
            // instead of the plain color mark.
            <ProjectGlyph
              icon={row.projectIcon}
              color={row.projectColor}
              name={row.projectName ?? ''}
              variant="monogram"
              className="ss-mark ss-mark--project"
              title={row.projectName}
            />
          ) : (
            <ProjectGlyph color={row.color} name="" variant="dot" className="ss-mark" />
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
            <span
              className="ss-ctx"
              title={`Context window — ${percentText(usage.usedPercent, percentMode)}`}
              style={{ background: contextFillColor(usage.usedPercent) }}
            >
              {contextPillText(usage.usedTokens, usage.windowTokens, usage.usedPercent, percentMode)}
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
            title="End session"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            ×
          </button>
        </div>
        {(row.projectName || row.cwd || row.sshHost || stateAgeLabel) && (
          <div className="ss-meta">
            {row.projectName && <span className="ss-meta__project">{row.projectName}</span>}
            {row.sshHost && <span className="ss-meta__ssh">⇅ {row.sshHost}</span>}
            {row.cwd && <span className="ss-meta__cwd">{dirName(row.cwd)}</span>}
            {stateAgeLabel && (
              <span
                className="ss-meta__state-age"
                title={
                  row.statusRestored
                    ? `Last known state entered ${stateAgeLabel}`
                    : `Entered this state ${stateAgeLabel}`
                }
              >
                {row.statusRestored ? `last known · ${stateAgeLabel}` : stateAgeLabel}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
