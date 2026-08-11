import { useEffect, useMemo, useState } from 'react'
import {
  buildSessionList,
  isGroupCollapsed,
  projectSignalCounts,
  type SessionNodeInput
} from '../lib/sessionList'
import { SessionRow } from './SessionRow'
import { IconBellFilled, IconCircleCheck, IconPin } from './icons'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useAgentStatus } from '../state/agentStatus'
import { useSessionNaming } from '../state/sessionNaming'
import { useSession } from '../session/session'

export interface SessionsSidebarProps {
  open: boolean
  pinned: boolean
  liveActiveNodes: SessionNodeInput[] | null
  onTogglePin(): void
  onClose(): void
  onFocusNode(id: string): void
  onCloseSession(projectId: string, id: string): void
  onRenameSession(projectId: string, id: string, title: string): void
  onAiNameSession(projectId: string, id: string, cwd?: string): void | Promise<void>
  onRowContextMenu(e: React.MouseEvent, projectId: string, id: string): void
  /** Right-click on a project header: the project actions menu (switch/rename/folder/close). */
  onProjectContextMenu(e: React.MouseEvent, projectId: string): void
  onAddToProject(projectId: string): void
  /** Move a node into a canvas group (groupId) or out to the top level (null). */
  onMoveToGroup(projectId: string, nodeId: string, groupId: string | null): void
  /** Name a canvas group with AI from its member terminals' output. */
  onAiNameGroup(projectId: string, groupId: string, memberIds: string[], cwd?: string): void | Promise<void>
  /** Reorder a session to sit immediately before another (within/across containers). */
  onReorder(projectId: string, draggedId: string, beforeId: string): void
  /** Reorder a project to sit before another (null = to the end). Shared order with the
   *  tab bar: both render the projects array, so one drag updates both surfaces. */
  onReorderProject(draggedId: string, beforeId: string | null): void
  onMouseEnter?(): void
  onMouseLeave?(): void
}

export function SessionsSidebar(props: SessionsSidebarProps): JSX.Element | null {
  const { open, pinned, liveActiveNodes } = props
  const allProjects = useProjects((s) => s.projects)
  // Closed projects are hidden from the tab bar; hide them from the sidebar too.
  const projects = useMemo(() => allProjects.filter((p) => !p.closed), [allProjects])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const setActiveProject = useProjects((s) => s.setActive)
  const statusById = useAgentStatus((s) => s.byId)
  const namingById = useSessionNaming((s) => s.byId)
  // This sidebar's core api (a stable context read — the branch lookups run on the session's git).
  const { api } = useSession()

  const [filter, setFilter] = useState('')
  // Explicit per-project collapse choices (true = collapsed, false = expanded). Absent =
  // follow the default (active project expanded, others collapsed — see isGroupCollapsed).
  // Deliberately transient: reset on every project switch, so the toggles are "for now",
  // not forever — switching projects always re-focuses the list on the active one.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [branches, setBranches] = useState<Record<string, string>>({})
  // Drag-to-group: the session being dragged, and the current drop target for highlighting.
  const [drag, setDrag] = useState<{ projectId: string; nodeId: string } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  // Project reorder: the project being dragged (by its header) + the project it would land
  // before ('' = end of the list). Distinct from the session drag above — one at a time.
  const [dragProj, setDragProj] = useState<string | null>(null)
  const [dropProj, setDropProj] = useState<string | null>(null)
  // Inline group rename: the group node id being edited + its draft title.
  const [editGroup, setEditGroup] = useState<{ id: string; draft: string } | null>(null)

  // Switching the active project resets the manual collapse choices, so the default takes
  // over again: the newly active project expands, everything else collapses. Without this,
  // one manual toggle stuck forever and project switches stopped re-focusing the list.
  // Gated on settings.sidebarAutoCollapse — with it OFF, a project switch changes nothing:
  // every project defaults to expanded (see isGroupCollapsed) and the user's toggles stick.
  const autoCollapse = useSettings((s) => s.settings.sidebarAutoCollapse)
  useEffect(() => {
    if (!autoCollapse) return
    setOverrides((prev) => (Object.keys(prev).length === 0 ? prev : {}))
  }, [activeProjectId, autoCollapse])

  // Look up the current git branch for each project cwd (best-effort, cached). Gated on `open`
  // and caches a NEGATIVE result too — without the '' fallback a non-git cwd re-fired a git
  // subprocess on every projects-store change, forever.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    projects.forEach((p) => {
      if (!p.cwd || branches[p.id] !== undefined) return
      api.git
        .status(p.cwd)
        .then((st) => {
          if (cancelled) return
          const branch = st && typeof st.branch === 'string' ? st.branch : ''
          setBranches((b) => ({ ...b, [p.id]: branch }))
        })
        .catch(() => {
          if (!cancelled) setBranches((b) => ({ ...b, [p.id]: '' }))
        })
    })
    return () => {
      cancelled = true
    }
    // `api` is a safe dep: this effect only fetches (cancellation flag, no resource), and the
    // local session's api is referentially stable, so adding it changes nothing today.
  }, [open, projects, branches, api])

  // Gated on `open`: this component stays mounted while the sidebar is closed (the common
  // case), and the O(projects × nodes) rebuild re-ran on every agent hook event otherwise.
  const groups = useMemo(
    () =>
      open ? buildSessionList(projects, liveActiveNodes, activeProjectId, statusById, filter) : [],
    [open, projects, liveActiveNodes, activeProjectId, statusById, filter]
  )

  const projectCount = (g: (typeof groups)[number]): number =>
    g.groups.reduce((n, b) => n + b.sessions.length, 0) + g.ungrouped.length
  const total = groups.reduce((n, g) => n + projectCount(g), 0)

  const toggleCollapse = (id: string, currentlyCollapsed: boolean): void => {
    setOverrides((prev) => ({ ...prev, [id]: !currentlyCollapsed }))
  }

  // Drop-target wiring shared by the project header (ungroup) and group sub-headers (add).
  // Only reacts while dragging a session that belongs to the same project.
  const dropTargetKey = (projectId: string, groupId: string | null): string =>
    `${projectId}:${groupId ?? 'ungrouped'}`
  const dropProps = (projectId: string, groupId: string | null): React.HTMLAttributes<HTMLDivElement> => {
    const key = dropTargetKey(projectId, groupId)
    const active = !!drag && drag.projectId === projectId
    return {
      onDragOver: (e) => {
        if (!active) return
        e.preventDefault()
        if (dropKey !== key) setDropKey(key)
      },
      onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
      onDrop: (e) => {
        if (!drag || drag.projectId !== projectId) return
        e.preventDefault()
        props.onMoveToGroup(projectId, drag.nodeId, groupId)
        setDrag(null)
        setDropKey(null)
      }
    }
  }
  const dropClass = (projectId: string, groupId: string | null): string =>
    dropKey === dropTargetKey(projectId, groupId) ? ' is-drop-target' : ''

  // Project-header drop wiring while a PROJECT drag is in flight (the session dropProps above
  // take the header otherwise — only one kind of drag happens at a time).
  const projDropProps = (projectId: string): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!dragProj) return
      e.stopPropagation()
      if (dragProj === projectId) return
      e.preventDefault()
      if (dropProj !== projectId) setDropProj(projectId)
    },
    onDragLeave: () => setDropProj((d) => (d === projectId ? null : d)),
    onDrop: (e) => {
      if (!dragProj || dragProj === projectId) return
      e.preventDefault()
      e.stopPropagation()
      props.onReorderProject(dragProj, projectId)
      setDragProj(null)
      setDropProj(null)
    }
  })

  // A row is both draggable and a drop target: dropping another row onto it reorders the
  // dragged session to sit immediately before this one. stopPropagation keeps the enclosing
  // group/ungrouped drop zone (which appends) from also firing.
  const renderRow = (projectId: string, row: (typeof groups)[number]['ungrouped'][number]): JSX.Element => {
    const rowKey = `row:${row.id}`
    const canDrop = !!drag && drag.projectId === projectId && drag.nodeId !== row.id
    return (
      <div
        key={row.id}
        className={`ss-rowdrop${dropKey === rowKey ? ' is-drop-before' : ''}`}
        onDragOver={(e) => {
          if (!canDrop) return
          e.preventDefault()
          e.stopPropagation()
          if (dropKey !== rowKey) setDropKey(rowKey)
        }}
        onDragLeave={() => setDropKey((k) => (k === rowKey ? null : k))}
        onDrop={(e) => {
          if (!canDrop) return
          e.preventDefault()
          e.stopPropagation()
          props.onReorder(projectId, drag.nodeId, row.id)
          setDrag(null)
          setDropKey(null)
        }}
      >
        <SessionRow
          row={row}
          onClick={() => props.onFocusNode(row.id)}
          onClose={() => props.onCloseSession(projectId, row.id)}
          onRename={(title) => props.onRenameSession(projectId, row.id, title)}
          onAiName={() => props.onAiNameSession(projectId, row.id, row.cwd)}
          onContextMenu={(e) => props.onRowContextMenu(e, projectId, row.id)}
          onDragStart={() => setDrag({ projectId, nodeId: row.id })}
          onDragEnd={() => {
            setDrag(null)
            setDropKey(null)
          }}
        />
      </div>
    )
  }

  if (!open) return null

  return (
    <aside
      className="sessions-sidebar"
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <div className="sessions-sidebar__head">
        <span className="sessions-sidebar__title">Sessions</span>
        <span className="sessions-sidebar__count">{total}</span>
        <div className="sessions-sidebar__head-actions">
          <button
            className={pinned ? 'is-on' : ''}
            title={pinned ? 'Unpin' : 'Pin'}
            onClick={props.onTogglePin}
          >
            <IconPin />
          </button>
          <button title="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="sessions-sidebar__search">
        <input
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div
        className="sessions-sidebar__body"
        // The body's empty space is the project drag's "drop at the end" zone (headers
        // stopPropagation their own drops).
        onDragOver={(e) => {
          if (!dragProj) return
          e.preventDefault()
          if (dropProj !== '') setDropProj('')
        }}
        onDrop={(e) => {
          if (!dragProj) return
          e.preventDefault()
          props.onReorderProject(dragProj, null)
          setDragProj(null)
          setDropProj(null)
        }}
      >
        {groups.length === 0 && <div className="sessions-sidebar__empty">No sessions yet.</div>}
        {groups.map((g) => {
          const isCollapsed = isGroupCollapsed(overrides, g.projectId, g.isActive, autoCollapse)
          const signals = projectSignalCounts(g)
          return (
            <div
              key={g.projectId}
              className={`ss-group${g.isActive ? ' is-active' : ''}${dropProj === g.projectId ? ' is-drop-before' : ''}`}
              // While a project drag is in flight the whole block is a REORDER target (the
              // session drop handlers below no-op and let the events bubble up here).
              {...(dragProj ? projDropProps(g.projectId) : {})}
            >
              <div
                className={`ss-group__head${dropClass(g.projectId, null)}`}
                onClick={() => {
                  if (!g.isActive) setActiveProject(g.projectId)
                  if (isCollapsed) toggleCollapse(g.projectId, isCollapsed)
                }}
                onContextMenu={(e) => props.onProjectContextMenu(e, g.projectId)}
                title={drag?.projectId === g.projectId ? 'Drop here to remove from group' : undefined}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDragProj(g.projectId)
                }}
                onDragEnd={() => {
                  setDragProj(null)
                  setDropProj(null)
                }}
                {...dropProps(g.projectId, null)}
              >
                <span
                  className="ss-group__chev"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleCollapse(g.projectId, isCollapsed)
                  }}
                >
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span className="ss-group__monogram" style={{ background: g.projectColor }}>
                  {(g.projectName.trim() || '?').charAt(0).toUpperCase()}
                </span>
                <span className="ss-group__name">{g.projectName}</span>
                {branches[g.projectId] && (
                  <span className="ss-group__branch">⎇ {branches[g.projectId]}</span>
                )}
                {signals.attention > 0 && (
                  <span className="ss-group__sig ss-group__sig--attention" title="Sessions that need you">
                    <IconBellFilled />
                    {signals.attention}
                  </span>
                )}
                {signals.unread > 0 && (
                  <span className="ss-group__sig ss-group__sig--unread" title="Finished — new for you">
                    <IconCircleCheck />
                    {signals.unread}
                  </span>
                )}
                <span className="ss-group__count">{projectCount(g)}</span>
                <button
                  className="ss-group__add"
                  title="New terminal in this project"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onAddToProject(g.projectId)
                  }}
                >
                  +
                </button>
              </div>
              {!isCollapsed && (
                <>
                  {g.groups.map((bucket) => (
                    <div key={bucket.id} className="ss-subgroup">
                      <div
                        className={`ss-subgroup__head${dropClass(g.projectId, bucket.id)}`}
                        title="Click to show the group on the canvas"
                        onClick={() => props.onFocusNode(bucket.id)}
                        {...dropProps(g.projectId, bucket.id)}
                      >
                        <span className="ss-subgroup__dot" style={{ background: bucket.color }} />
                        {editGroup?.id === bucket.id ? (
                          <input
                            className="ss-title-input"
                            style={{ flex: 1, minWidth: 0 }}
                            autoFocus
                            value={editGroup.draft}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditGroup({ id: bucket.id, draft: e.target.value })}
                            onBlur={() => {
                              const t = editGroup.draft.trim()
                              if (t && t !== bucket.title) props.onRenameSession(g.projectId, bucket.id, t)
                              setEditGroup(null)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur()
                              if (e.key === 'Escape') setEditGroup(null)
                            }}
                          />
                        ) : (
                          <span
                            className="ss-subgroup__name"
                            title="Double-click to rename group"
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              setEditGroup({ id: bucket.id, draft: bucket.title })
                            }}
                          >
                            {bucket.title}
                          </span>
                        )}
                        <span className="ss-group__count">{bucket.sessions.length}</span>
                        {bucket.sessions.length > 0 && (
                          <button
                            className="ss-subgroup__ai"
                            title="Name group with AI (from members' output)"
                            disabled={!!namingById[bucket.id]}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (namingById[bucket.id]) return
                              void props.onAiNameGroup(
                                g.projectId,
                                bucket.id,
                                bucket.sessions.map((s) => s.id),
                                g.cwd
                              )
                            }}
                          >
                            {namingById[bucket.id] ? '…' : '✦'}
                          </button>
                        )}
                      </div>
                      {bucket.sessions.length === 0 ? (
                        <div className="ss-group__empty">Drop a session here</div>
                      ) : (
                        bucket.sessions.map((row) => renderRow(g.projectId, row))
                      )}
                    </div>
                  ))}
                  {g.ungrouped.length === 0 && g.groups.length === 0 ? (
                    <div className="ss-group__empty">No sessions</div>
                  ) : (
                    <div
                      className={`ss-ungrouped${dropClass(g.projectId, null)}`}
                      {...dropProps(g.projectId, null)}
                    >
                      {g.groups.length > 0 && g.ungrouped.length > 0 && (
                        <div className="ss-ungrouped__label">Ungrouped</div>
                      )}
                      {g.ungrouped.map((row) => renderRow(g.projectId, row))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
