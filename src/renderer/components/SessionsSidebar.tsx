import { useEffect, useMemo, useState } from 'react'
import {
  buildSessionList,
  buildStatusList,
  groupCollapseKey,
  groupSessionCount,
  groupSessionRows,
  isGroupCollapsed,
  liveCollapseKeys,
  projectCollapseKey,
  projectHeadClickAction,
  projectSignalCounts,
  pruneCollapsedItems,
  sessionStateAgeLabel,
  type GroupBucket,
  type SessionNodeInput,
  type SessionRowVM,
  type StatusSection
} from '../lib/sessionList'
import { SessionRow } from './SessionRow'
import { ProjectGlyph } from './ProjectGlyph'
import { ClosedHistorySection } from './ClosedHistorySection'
import { IconBellFilled, IconCircleCheck, IconPin } from './icons'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useAgentStatus } from '../state/agentStatus'
import { useSessionNaming } from '../state/sessionNaming'
import { useSession } from '../session/session'

const HISTORY_COLLAPSE_KEY = 'history'

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
  /** Make a project active. MUST be Canvas's `switchProject`, never `useProjects.setActive`:
   *  a switch has to commit the live React Flow nodes back into the store and persist first,
   *  or the outgoing project's unsaved edits are dropped by the active-project reload and the
   *  new activeProjectId never reaches disk (the app reopens on the old project). */
  onSwitchProject(projectId: string): void
  /** "+" on a project header: open the add-node menu at the cursor (switching to the project
   *  first if it isn't active). The event positions the menu. */
  onAddToProject(projectId: string, e: { clientX: number; clientY: number }): void
  /** Move a node into a canvas group (groupId) or out to the top level (null). */
  onMoveToGroup(projectId: string, nodeId: string, groupId: string | null): void
  /** Name a canvas group with AI from its member terminals' output. */
  onAiNameGroup(projectId: string, groupId: string, memberIds: string[], cwd?: string): void | Promise<void>
  /** Reorder a session to sit immediately before another (within/across containers). */
  onReorder(projectId: string, draggedId: string, beforeId: string): void
  /** Reorder a group frame among its siblings. `beforeId` null appends within that parent. */
  onReorderGroup(
    projectId: string,
    draggedId: string,
    parentGroupId: string | null,
    beforeId: string | null
  ): void
  /** Reorder a project to sit before another (null = to the end). Shared order with the
   *  tab bar: both render the projects array, so one drag updates both surfaces. */
  onReorderProject(draggedId: string, beforeId: string | null): void
  /** Reopen a closed project (Welcome screen's existing action, now also reachable here). */
  onReopenProject(id: string): void
  /** Permanently delete a closed project (Welcome screen's existing action). */
  onDeleteProject(id: string): void
  onReopenClosedSession(projectId: string, entryId: string): void
  onDiscardClosedSession(projectId: string, entryId: string): void
  onMouseEnter?(): void
  onMouseLeave?(): void
}

export function SessionsSidebar(props: SessionsSidebarProps): JSX.Element | null {
  const { open, pinned, liveActiveNodes } = props
  const allProjects = useProjects((s) => s.projects)
  // Closed projects are hidden from the tab bar; hide them from the sidebar too.
  const projects = useMemo(() => allProjects.filter((p) => !p.closed), [allProjects])
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const statusById = useAgentStatus((s) => s.byId)
  const namingById = useSessionNaming((s) => s.byId)
  // This sidebar's core api (a stable context read — the branch lookups run on the session's git).
  const { api } = useSession()

  const [filter, setFilter] = useState('')
  const [statusNow, setStatusNow] = useState(() => Date.now())
  const [branches, setBranches] = useState<Record<string, string>>({})
  // Drag-to-group: the object being dragged, and the current drop target for highlighting.
  // A group drag also remembers its parent frame, so a sibling-reorder drop zone can refuse a
  // drag that came from another container (that move is a REPARENT, which the head handles).
  const [drag, setDrag] = useState<{
    projectId: string
    nodeId: string
    kind: 'session' | 'group'
    parentGroupId?: string | null
  } | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  // Project reorder: the project being dragged (by its header) + the project it would land
  // before ('' = end of the list). Distinct from the session drag above — one at a time.
  const [dragProj, setDragProj] = useState<string | null>(null)
  const [dropProj, setDropProj] = useState<string | null>(null)
  // Inline group rename: the group node id being edited + its draft title.
  const [editGroup, setEditGroup] = useState<{ id: string; draft: string } | null>(null)

  // Disclosure choices are PERSISTED (settings.sidebarCollapsedItems), for group frames as well
  // as projects: a tree the user shaped should still be that shape after a restart. This
  // deliberately replaces the old "a project switch resets every manual toggle" effect —
  // sidebarAutoCollapse now only supplies the DEFAULT for a row nobody ever toggled.
  const autoCollapse = useSettings((s) => s.settings.sidebarAutoCollapse)
  const collapsedItems = useSettings((s) => s.settings.sidebarCollapsedItems)
  const grouping = useSettings((s) => s.settings.sidebarGrouping)
  const updateSettings = useSettings((s) => s.update)

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
  // Status-grouped sections (only computed in status mode — flattens all projects' sessions by
  // live agent status so attention floats to the top). Same inputs as `groups`.
  const statusSections = useMemo(
    () =>
      open && grouping === 'status'
        ? buildStatusList(projects, liveActiveNodes, activeProjectId, statusById, filter)
        : [],
    [open, grouping, projects, liveActiveNodes, activeProjectId, statusById, filter]
  )

  // Relative state ages need to advance even when no hook event arrives. Keep the clock dormant
  // unless the status view is visible; 30s catches minute boundaries without per-row timers.
  useEffect(() => {
    if (!open || grouping !== 'status') return
    setStatusNow(Date.now())
    const timer = window.setInterval(() => setStatusNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open, grouping])

  const projectCount = (g: (typeof groups)[number]): number =>
    g.groups.reduce((n, b) => n + groupSessionCount(b), 0) + g.ungrouped.length
  const total = groups.reduce((n, g) => n + projectCount(g), 0)

  // Every write prunes keys that no longer address a live project/frame — settings.json is
  // forever, and a canvas churns through group ids.
  const toggleCollapse = (key: string, currentlyCollapsed: boolean): void => {
    const current = useSettings.getState().settings.sidebarCollapsedItems
    const pruned = pruneCollapsedItems(
      current,
      new Set([...liveCollapseKeys(groups), HISTORY_COLLAPSE_KEY]),
      key
    )
    useSettings.getState().update({
      sidebarCollapsedItems: { ...pruned, [key]: !currentlyCollapsed }
    })
  }
  const historyCollapsed = collapsedItems[HISTORY_COLLAPSE_KEY] ?? false

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
          onDragStart={() => setDrag({ projectId, nodeId: row.id, kind: 'session' })}
          onDragEnd={() => {
            setDrag(null)
            setDropKey(null)
          }}
        />
      </div>
    )
  }

  /**
   * One group frame's row and everything under it, recursively — this is what makes the sidebar
   * a TREE rather than one flat level. `parentGroupId` is the frame's container: a sibling
   * reorder only accepts a drag that started in the same container, so a cross-container drop
   * stays a reparent (the head's dropProps), not a silent reorder that also moved the node.
   */
  const renderBucket = (
    projectId: string,
    projectCwd: string | undefined,
    bucket: GroupBucket,
    parentGroupId: string | null
  ): JSX.Element => {
    const collapseKey = groupCollapseKey(projectId, bucket.id)
    // A frame the user never toggled is expanded; while FILTERING nothing is collapsed, or a
    // collapsed frame would hide the very match the user is searching for.
    const collapsed = filter ? false : (collapsedItems[collapseKey] ?? false)
    const members = groupSessionRows(bucket)
    const canReorderHere = (): boolean =>
      !!drag && drag.kind === 'group' && drag.projectId === projectId &&
      (drag.parentGroupId ?? null) === parentGroupId
    return (
      <div key={bucket.id} className="ss-subgroup">
        <div
          className={`ss-subgroup__reorder-zone${dropKey === `group-before:${bucket.id}` ? ' is-drop-before' : ''}`}
          onDragOver={(e) => {
            if (!canReorderHere() || drag!.nodeId === bucket.id) return
            e.preventDefault()
            e.stopPropagation()
            setDropKey(`group-before:${bucket.id}`)
          }}
          onDragLeave={() => setDropKey((k) => (k === `group-before:${bucket.id}` ? null : k))}
          onDrop={(e) => {
            if (!canReorderHere() || drag!.nodeId === bucket.id) return
            e.preventDefault()
            e.stopPropagation()
            props.onReorderGroup(projectId, drag!.nodeId, parentGroupId, bucket.id)
            setDrag(null)
            setDropKey(null)
          }}
        />
        <div
          className={`ss-subgroup__head${dropClass(projectId, bucket.id)}`}
          title="Click to show the group on the canvas"
          onClick={() => props.onFocusNode(bucket.id)}
          onContextMenu={(e) => props.onRowContextMenu(e, projectId, bucket.id)}
          draggable
          onDragStart={(e) => {
            e.stopPropagation()
            e.dataTransfer.effectAllowed = 'move'
            setDrag({ projectId, nodeId: bucket.id, kind: 'group', parentGroupId })
          }}
          onDragEnd={() => {
            setDrag(null)
            setDropKey(null)
          }}
          {...dropProps(projectId, bucket.id)}
        >
          <button
            type="button"
            className="ss-group__chev"
            aria-label={collapsed ? `Expand ${bucket.title}` : `Collapse ${bucket.title}`}
            aria-expanded={!collapsed}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation()
              toggleCollapse(collapseKey, collapsed)
            }}
          >
            {collapsed ? '▶' : '▼'}
          </button>
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
                if (t && t !== bucket.title) props.onRenameSession(projectId, bucket.id, t)
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
          <span className="ss-group__count">{groupSessionCount(bucket)}</span>
          {members.length > 0 && (
            <button
              className="ss-subgroup__ai"
              title="Name group with AI (from every session below it)"
              disabled={!!namingById[bucket.id]}
              onClick={(e) => {
                e.stopPropagation()
                if (namingById[bucket.id]) return
                void props.onAiNameGroup(
                  projectId,
                  bucket.id,
                  members.map((session) => session.id),
                  projectCwd
                )
              }}
            >
              {namingById[bucket.id] ? '…' : '✦'}
            </button>
          )}
        </div>
        {!collapsed && (
          <>
            {bucket.children.map((child) => renderBucket(projectId, projectCwd, child, bucket.id))}
            {bucket.children.length > 0 && (
              <div
                className={`ss-subgroup__reorder-end${dropKey === `group-end:${bucket.id}` ? ' is-drop-before' : ''}`}
                onDragOver={(e) => {
                  if (
                    !drag ||
                    drag.kind !== 'group' ||
                    drag.projectId !== projectId ||
                    (drag.parentGroupId ?? null) !== bucket.id
                  ) return
                  e.preventDefault()
                  e.stopPropagation()
                  setDropKey(`group-end:${bucket.id}`)
                }}
                onDragLeave={() => setDropKey((k) => (k === `group-end:${bucket.id}` ? null : k))}
                onDrop={(e) => {
                  if (
                    !drag ||
                    drag.kind !== 'group' ||
                    drag.projectId !== projectId ||
                    (drag.parentGroupId ?? null) !== bucket.id
                  ) return
                  e.preventDefault()
                  e.stopPropagation()
                  props.onReorderGroup(projectId, drag.nodeId, bucket.id, null)
                  setDrag(null)
                  setDropKey(null)
                }}
              />
            )}
            {bucket.sessions.length === 0 && bucket.children.length === 0 ? (
              <div className="ss-group__empty">Drop a session or group here</div>
            ) : (
              bucket.sessions.map((row) => renderRow(projectId, row))
            )}
          </>
        )}
      </div>
    )
  }

  // A status-mode row. Unlike project mode, the row carries its own project id (rows are flattened
  // across projects), so the project-scoped callbacks read it off the row. Drag/drop reorder and
  // move-to-group are project-mode concepts — their drop targets (project headers, sub-groups)
  // aren't rendered in status mode, so the row is not draggable here. It stays clickable,
  // closable, renameable, and right-clickable.
  const renderStatusRow = (row: SessionRowVM): JSX.Element => (
    <div key={row.id} className="ss-rowdrop">
      <SessionRow
        row={row}
        onClick={() => props.onFocusNode(row.id)}
        onClose={() => props.onCloseSession(row.projectId!, row.id)}
        onRename={(title) => props.onRenameSession(row.projectId!, row.id, title)}
        onAiName={() => props.onAiNameSession(row.projectId!, row.id, row.cwd)}
        onContextMenu={(e) => props.onRowContextMenu(e, row.projectId!, row.id)}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        stateAgeLabel={sessionStateAgeLabel(row.statusUpdatedAt, statusNow)}
      />
    </div>
  )

  if (!open) return null

  return (
    <aside
      className={props.pinned ? 'sessions-sidebar sessions-sidebar--pinned' : 'sessions-sidebar'}
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

      {/* Grouping tabs: plain text with a 2px accent underline on the active one, sitting on the
          hairline that separates the header from the list — quieter than a pill toggle. */}
      <div className="ss-tabs" role="tablist" aria-label="Group sessions by">
        <button
          role="tab"
          aria-selected={grouping === 'project'}
          className={`ss-tab${grouping === 'project' ? ' is-active' : ''}`}
          onClick={() => updateSettings({ sidebarGrouping: 'project' })}
        >
          Project
        </button>
        <button
          role="tab"
          aria-selected={grouping === 'status'}
          className={`ss-tab${grouping === 'status' ? ' is-active' : ''}`}
          onClick={() => updateSettings({ sidebarGrouping: 'status' })}
        >
          Status
        </button>
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
        {groups.length === 0 && grouping !== 'status' && (
          <div className="sessions-sidebar__empty">No sessions yet.</div>
        )}
        {grouping === 'status' ? (
          statusSections.map((section: StatusSection) => (
            <div key={section.kind} className="ss-status">
              <div className="ss-status__head">
                {section.kind === 'attention' ? (
                  <span className="ss-status__icon ss-status__icon--attention">
                    <IconBellFilled />
                  </span>
                ) : (
                  <span className={`ss-status__icon ss-status__icon--${section.kind}`} />
                )}
                <span className="ss-status__label">{section.label}</span>
                <span className="ss-status__count">{section.rows.length}</span>
              </div>
              <div className="ss-status__rows">
                {section.rows.map((row) => renderStatusRow(row))}
              </div>
            </div>
          ))
        ) : (
          groups.map((g) => {
          const collapseKey = projectCollapseKey(g.projectId)
          // While filtering, never collapse — a collapsed project would hide its own matches.
          const isCollapsed = filter
            ? false
            : isGroupCollapsed(collapsedItems, collapseKey, g.isActive, autoCollapse)
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
                // One click, one action (projectHeadClickAction documents why it is never both):
                // an inactive project switches — through Canvas, so the outgoing project's live
                // nodes are committed and the new active id is persisted — and the active one
                // toggles its own collapse, so the row keeps no dead zone.
                onClick={() => {
                  if (projectHeadClickAction(g.isActive) === 'switch') props.onSwitchProject(g.projectId)
                  else toggleCollapse(collapseKey, isCollapsed)
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
                {/* Collapse is now the chevron's job alone on an inactive row, so it has to be a
                    real target: a button with its own hit area and keyboard focus, not the bare
                    9px glyph. It stops propagation so peeking into a project never switches. */}
                <button
                  type="button"
                  className="ss-group__chev"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  aria-label={isCollapsed ? `Expand ${g.projectName}` : `Collapse ${g.projectName}`}
                  aria-expanded={!isCollapsed}
                  draggable={false}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleCollapse(collapseKey, isCollapsed)
                  }}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
                <ProjectGlyph
                  icon={g.projectIcon}
                  color={g.projectColor}
                  name={g.projectName}
                  variant="monogram"
                  className="ss-group__monogram"
                />
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
                {signals.working > 0 && (
                  <span className="ss-group__sig ss-group__sig--working" title="Sessions running right now">
                    <span className="ss-group__sig-spin" />
                    {signals.working}
                  </span>
                )}
                <span className="ss-group__count">{projectCount(g)}</span>
                <button
                  className="ss-group__add"
                  title="Add a node to this project"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onAddToProject(g.projectId, { clientX: e.clientX, clientY: e.clientY })
                  }}
                >
                  +
                </button>
              </div>
              {!isCollapsed && (
                <>
                  {g.groups.map((bucket) => renderBucket(g.projectId, g.cwd, bucket, null))}
                  {g.groups.length > 0 && (
                    <div
                      className={`ss-subgroup__reorder-end ss-subgroup__reorder-end--root${dropKey === `group-end:${g.projectId}` ? ' is-drop-before' : ''}`}
                      onDragOver={(e) => {
                        if (
                          !drag ||
                          drag.kind !== 'group' ||
                          drag.projectId !== g.projectId ||
                          (drag.parentGroupId ?? null) !== null
                        ) return
                        e.preventDefault()
                        e.stopPropagation()
                        setDropKey(`group-end:${g.projectId}`)
                      }}
                      onDragLeave={() => setDropKey((k) => (k === `group-end:${g.projectId}` ? null : k))}
                      onDrop={(e) => {
                        if (
                          !drag ||
                          drag.kind !== 'group' ||
                          drag.projectId !== g.projectId ||
                          (drag.parentGroupId ?? null) !== null
                        ) return
                        e.preventDefault()
                        e.stopPropagation()
                        props.onReorderGroup(g.projectId, drag.nodeId, null, null)
                        setDrag(null)
                        setDropKey(null)
                      }}
                    />
                  )}
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
        })
        )}
      </div>

      <ClosedHistorySection
        projects={allProjects}
        nowMs={statusNow}
        collapsed={historyCollapsed}
        onToggleCollapse={() => toggleCollapse(HISTORY_COLLAPSE_KEY, historyCollapsed)}
        onReopenProject={props.onReopenProject}
        onDeleteProject={props.onDeleteProject}
        onReopenSession={props.onReopenClosedSession}
        onDiscardSession={props.onDiscardClosedSession}
      />
    </aside>
  )
}
