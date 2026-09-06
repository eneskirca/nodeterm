import type { Project } from '@shared/types'
import { mergeClosedHistory } from '../lib/closedHistory'
import { sessionStateAgeLabel } from '../lib/sessionList'
import { ProjectGlyph } from './ProjectGlyph'

export interface ClosedHistorySectionProps {
  projects: readonly Project[]
  nowMs: number
  collapsed: boolean
  onToggleCollapse(): void
  onReopenProject(id: string): void
  onDeleteProject(id: string): void
  onReopenSession(projectId: string, entryId: string): void
  onDiscardSession(projectId: string, entryId: string): void
}

/** Sidebar section listing recently closed projects (tabs) and recently closed sessions
 *  (terminal/agent/… nodes deleted from a still-open project), merged by recency. Renders
 *  nothing when there's no history at all — an empty "Recently closed" header would be dead
 *  chrome on every fresh install. */
export function ClosedHistorySection(props: ClosedHistorySectionProps): JSX.Element | null {
  const rows = mergeClosedHistory(props.projects)
  if (!rows.length) return null

  return (
    <div className="sessions-sidebar__history">
      <div
        className="sessions-sidebar__history-head"
        role="button"
        tabIndex={0}
        onClick={props.onToggleCollapse}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') props.onToggleCollapse()
        }}
      >
        <span className="sessions-sidebar__chevron" aria-hidden="true">
          {props.collapsed ? '▶' : '▼'}
        </span>
        <span className="sessions-sidebar__history-title">Recently closed</span>
        <span className="sessions-sidebar__count">{rows.length}</span>
      </div>
      {!props.collapsed && (
        <div className="sessions-sidebar__history-list">
          {rows.map((row) =>
            row.kind === 'project' ? (
              <div
                key={`project:${row.projectId}`}
                className="sessions-sidebar__history-item"
                role="button"
                tabIndex={0}
                title={row.project.cwd || row.project.name}
                onClick={() => props.onReopenProject(row.projectId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') props.onReopenProject(row.projectId)
                }}
              >
                {/* Same className the sidebar's own project rows pass (SessionsSidebar's
                    ss-group__head). ProjectGlyph deliberately carries no box CSS of its own —
                    "every wired call site passes its own className" — so omitting it renders the
                    monogram fallback as a bare colored span instead of the 18px circular badge
                    every other project row shows. `size` is not the substitute: it only sets the
                    EMOJI font-size and is inert for the monogram variant. */}
                <ProjectGlyph
                  icon={row.project.icon}
                  color={row.project.color}
                  name={row.project.name}
                  variant="monogram"
                  className="ss-group__monogram"
                />
                <span className="sessions-sidebar__history-name">{row.project.name}</span>
                <span className="sessions-sidebar__history-age">
                  {sessionStateAgeLabel(row.closedAt >= 0 ? row.closedAt : undefined, props.nowMs)}
                </span>
                <button
                  className="sessions-sidebar__history-del"
                  aria-label="Discard"
                  title="Delete permanently (ends its sessions)"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onDeleteProject(row.projectId)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  ×
                </button>
              </div>
            ) : (
              <div
                key={`session:${row.entry.id}`}
                className="sessions-sidebar__history-item"
                role="button"
                tabIndex={0}
                title={row.entry.node.cwd || row.entry.node.title}
                onClick={() => props.onReopenSession(row.projectId, row.entry.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') props.onReopenSession(row.projectId, row.entry.id)
                }}
              >
                <span className="sessions-sidebar__history-name">
                  {row.entry.node.title || row.entry.node.kind}
                </span>
                <span className="sessions-sidebar__history-age">
                  {sessionStateAgeLabel(row.closedAt, props.nowMs)}
                </span>
                <button
                  className="sessions-sidebar__history-del"
                  aria-label="Discard"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onDiscardSession(row.projectId, row.entry.id)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  ×
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
