import { useEffect, useMemo, useState } from 'react'
import { IconClose } from './icons'
import type { ProjectIcon } from '@shared/project-icon'
import { filterClosedProjects } from '../lib/closedHistory'
import { ProjectGlyph } from './ProjectGlyph'

/**
 * Rows before the "Recently closed" filter box appears (issue #506). `.welcome__recent-list` is
 * capped at 220px ≈ six rows, so this is the point where the list starts scrolling — below it a
 * filter would only be clutter for someone with three projects.
 */
const RECENT_FILTER_THRESHOLD = 6

interface WelcomeScreenProps {
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepo: () => void
  /** Open the "Connect over SSH…" flow to create a project hosted on a remote server. */
  onConnectSsh: () => void
  /** Closed projects that can be reopened (id + display name + folder + icon/color). */
  closedProjects?: { id: string; name: string; cwd?: string; color?: string; icon?: ProjectIcon }[]
  /**
   * LIVE local `nt-*` session count per closed project id (one on-demand sweep — see Canvas).
   * A closed project parks its sessions invisibly (issue #442); this badge is what says they
   * exist. Absent map or missing id = NOT MEASURED, so no badge — never a claimed "0".
   */
  sessionCounts?: Record<string, number>
  /** Reopen a closed project (restores its nodes + sessions). */
  onReopen?: (id: string) => void
  /** Permanently delete a closed project (ends its tmux sessions). */
  onDeleteClosed?: (id: string) => void
  /**
   * When provided, the screen is dismissable (opened on demand via "+", over existing projects)
   * — adds a close button, Escape, and click-outside. Omitted for the permanent no-projects screen.
   */
  onClose?: () => void
  /**
   * Raise the screen above the kanban board overlay (z 25). Without this, opening "+" while a
   * project is in kanban view left the (z 5) welcome screen painted BEHIND the opaque board, so
   * nothing appeared. No effect on the canvas, where the welcome screen already sits on top.
   */
  overBoard?: boolean
}

/** Start screen with quick actions — shown when there are no projects, or on demand via "+". */
export function WelcomeScreen({
  onNewProject,
  onOpenFolder,
  onCloneRepo,
  onConnectSsh,
  closedProjects = [],
  sessionCounts,
  onReopen,
  onDeleteClosed,
  onClose,
  overBoard
}: WelcomeScreenProps) {
  const [query, setQuery] = useState('')
  const visibleClosed = useMemo(
    () => filterClosedProjects(closedProjects, query),
    [closedProjects, query]
  )

  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className={overBoard ? 'welcome welcome--over-board' : 'welcome'}
      onClick={onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}
    >
      {onClose && (
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 16,
            right: 20,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: 'rgba(235,235,245,0.6)',
            lineHeight: 1,
            cursor: 'pointer'
          }}
        >
          <IconClose />
        </button>
      )}
      <div className="welcome__brand">
        <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
          <defs>
            <linearGradient id="wtg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a38dff" />
              <stop offset="1" stopColor="#622994" />
            </linearGradient>
          </defs>
          <path
            d="M13 12 L31 24 L13 36"
            fill="none"
            stroke="url(#wtg)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
          <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
          <circle cx="31" cy="24" r="3.6" fill="#fff" />
          <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
        </svg>
        <span className="welcome__name">nodeterm</span>
      </div>
      <p className="welcome__tagline">A canvas of terminals. Start a project to begin.</p>

      <div className="welcome__cards">
        <button className="welcome__card" onClick={onNewProject}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          <span>New project</span>
        </button>

        <button className="welcome__card" onClick={onOpenFolder}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span>Open folder…</span>
        </button>

        <button className="welcome__card" onClick={onCloneRepo}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v10M8 9l4 4 4-4" />
            <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
          </svg>
          <span>Clone repo…</span>
        </button>

        <button className="welcome__card" onClick={onConnectSsh}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 10l3 2-3 2M13 14h4" />
          </svg>
          <span>Connect over SSH…</span>
        </button>
      </div>

      {closedProjects.length > 0 && (
        <div className="welcome__recent">
          <div className="welcome__recent-title">Recently closed</div>
          {/* Shown only past the visible-row cap: with three closed projects a filter box is
              in the way, and past six the list is already scrolling. */}
          {closedProjects.length > RECENT_FILTER_THRESHOLD && (
            <input
              className="welcome__recent-filter"
              placeholder="Filter by name or folder…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Esc clears the box before it reaches the screen's own close handler; on an
                // empty box it falls through and still closes the screen.
                if (e.key !== 'Escape' || query === '') return
                e.preventDefault()
                e.stopPropagation()
                setQuery('')
              }}
            />
          )}
          <div className="welcome__recent-list">
            {visibleClosed.length === 0 && (
              <div className="welcome__recent-empty">No closed projects match “{query.trim()}”.</div>
            )}
            {visibleClosed.map((p) => (
              <div
                key={p.id}
                className="welcome__recent-item"
                role="button"
                tabIndex={0}
                title={p.cwd || p.name}
                onClick={() => onReopen?.(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onReopen?.(p.id)
                }}
              >
                <ProjectGlyph
                  icon={p.icon}
                  color={p.color}
                  name={p.name}
                  variant="monogram"
                  size={15}
                  className="welcome__recent-mark"
                />
                <span className="welcome__recent-name">{p.name}</span>
                {p.cwd && <span className="welcome__recent-path">{p.cwd}</span>}
                {(sessionCounts?.[p.id] ?? 0) > 0 && (
                  <span
                    className="welcome__recent-sessions"
                    title={`${sessionCounts![p.id]} tmux session${
                      sessionCounts![p.id] === 1 ? ' from this project is' : 's from this project are'
                    } still running on this machine. Reopen the project to pick them up, or × to delete it and end them.`}
                  >
                    {sessionCounts![p.id]} running
                  </span>
                )}
                {onDeleteClosed && (
                  <button
                    className="welcome__recent-del"
                    title="Delete permanently (ends its sessions)"
                    aria-label="Delete permanently"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteClosed(p.id)
                    }}
                  >
                    <IconClose />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
