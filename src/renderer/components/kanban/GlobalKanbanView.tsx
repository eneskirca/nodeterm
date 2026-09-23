import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectKanban } from '@shared/types'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import {
  addColumn, assignNode, assignedTo, boardLabels, cardMatchesLabelFilter, cardMeta, columnForNode,
  deleteColumn, labelsForCard, moveColumn,
  nextColumnColor, pruneAssignments, recolorColumn, renameColumn, unassigned, defaultKanban
} from '../../lib/kanban'
import { KanbanColumn, type KanbanLane } from './KanbanColumn'
import { SessionCard } from './SessionCard'
import { toKanbanSessionState } from '../../canvas/toKanbanSessionState'
import { createAgentNode, createBrowserNode, createStickyNode, createTerminalNode, flowToNodeStates, resolveNewNodeAccount } from '../../state/workspace'
import { markCanvasCovered } from '../../lib/canvasCovered'
import { useViewMode } from '../../state/viewMode'
import { useSession } from '../../session/session'
import { activePermissionMode } from '../../state/permissionMode'
import { CardModal } from './CardModal'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconAgent, IconNote, IconTerminal, IconTrash, IconExternal, IconSwitch, IconWeb } from '../icons'
import { useBoardLog } from '../../state/boardLog'
import { boardLogEvents } from '../../lib/boardLogDiff'
import { markWorkspaceDirty } from '../../state/workspaceDirty'
import { useWindows } from '../../state/windows'
import type { KanbanCreateChoice, KanbanSession } from './KanbanView'
import type { NodeIcon } from '@shared/node-icon'

/**
 * Global (Omni) Kanban overview — one swimlane per open project.
 *
 * Three surfaces:
 * - Desktop: full (pure renderer + workspace.save; same stack as per-project KanbanView).
 * - Server Edition: works as-is (same renderer bundle via bridge, no Electron-specific code).
 * - Mobile (nodeterm-ios, private repo): N/A — no canvas/kanban there (separate transport protocol).
 *
 * Closed projects (`p.closed`) are filtered out — an open board that showed closed lanes would
 * surface parked sessions the user deliberately hid. Board writes (column/boardLog) go to the
 * owning project's `.nodeterm/project.json` (`useProjects.setProjectKanban` → `markWorkspaceDirty` →
 * debounced `workspace.save`), so a cross-project drag is a write in that project's repo — intentional
 * (the board file travels with the repo, like per-project kanban already does). A card modal for a
 * non-active SSH project co-attaches via `ModalTerminal`'s transport — if its ControlMaster is down,
 * core refuses with `PtyCreateResult.unavailable` (`requireRemote` rule) and the modal shows no
 * session rather than a local shell fallback; verified by the `create`/`join` contract in
 * `src/core/pty-manager.ts` (`requireRemote` refuses, never falls through to local tmux).
 */

// One swimlane = one project's board
interface SwimlaneProps {
  projectId: string
  projectName: string
  projectColor?: string
  board: ProjectKanban
  sessions: KanbanSession[]
  onChangeBoard: (next: ProjectKanban) => void
  onOpenNode: (nodeId: string, projectId: string) => void
  onCreateNode: (projectId: string, choice: KanbanCreateChoice, columnId: string | null) => void
  onDeleteNode: (projectId: string, nodeId: string) => void
  onRenameNode: (nodeId: string, title: string) => void
  onEditSticky: (projectId: string, nodeId: string, text: string) => void
  onBrowserNav: (projectId: string, nodeId: string, patch: { url?: string; title?: string }) => void
  onSetIcon: (projectId: string, nodeId: string, icon: NodeIcon | undefined) => void
  onModalChange: (nodeId: string | null) => void
  highlight?: boolean
}

const Swimlane = memo(function Swimlane({
  projectId, projectName, projectColor, board, sessions, onChangeBoard, onOpenNode, onCreateNode, onDeleteNode, onRenameNode, onEditSticky, onBrowserNav, onSetIcon, onModalChange, highlight
}: SwimlaneProps) {
  const dragRef = useRef<{ kind: 'column'; id: string } | { kind: 'card'; id: string } | null>(null)
  const [modalNodeId, setModalNodeId] = useState<string | null>(null)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const customAgents = useSettings((s) => s.settings.customAgents)
  const disabledAgents = useSettings((s) => s.settings.disabledAgents)

  useEffect(() => { onModalChange(modalNodeId) }, [modalNodeId, onModalChange])

  const requestedCardNodeId = useViewMode((s) => s.requestedCardNodeId)
  useEffect(() => {
    if (!requestedCardNodeId) return
    if (sessions.some(s => s.id === requestedCardNodeId)) {
      setModalNodeId(requestedCardNodeId)
      useViewMode.getState().clearCardRequest()
    }
  }, [requestedCardNodeId, sessions])

  const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions])
  const sessionIds = useMemo(() => sessions.map(s => s.id), [sessions])

  const paletteLabels = useMemo(() => boardLabels(board), [board])
  const localFilterKeys = useMemo(() => new Set(paletteLabels.map(l => `local:${l.id}`)), [paletteLabels])
  const activeLocalFilter = useMemo(() => labelFilter.filter(id => localFilterKeys.has(id)).map(k => k.slice(6)), [labelFilter, localFilterKeys])

  const labelsByCard = useMemo(() => {
    const m = new Map<string, ReturnType<typeof labelsForCard>>()
    if (Array.isArray(board.meta)) {
      for (const entry of board.meta) {
        if (!entry?.nodeId) continue
        const l = labelsForCard(board, entry.nodeId)
        if (l.length) m.set(entry.nodeId, l)
      }
    }
    return m
  }, [board])

  const commit = useCallback((next: ProjectKanban) => {
    onChangeBoard(pruneAssignments(next, sessionIds))
  }, [onChangeBoard, sessionIds])

  const createOptions = useMemo(() => [
    ...BUILTIN_AGENT_IDS.filter(id => !disabledAgents.includes(id)).map(id => ({
      key: id, label: AGENT_CONFIG[id].label, choice: { kind: 'agent', agentId: id } as KanbanCreateChoice, icon: <IconAgent />
    })),
    ...customAgents.filter(a => !disabledAgents.includes(a.id)).map(a => ({
      key: a.id, label: a.label, choice: { kind: 'agent', agentId: a.id } as KanbanCreateChoice, icon: <IconAgent />
    })),
    { key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' } as KanbanCreateChoice, icon: <IconTerminal /> },
    { key: 'browser', label: 'Browser', choice: { kind: 'browser' } as KanbanCreateChoice, icon: <IconWeb /> },
    { key: 'sticky', label: 'Sticky note', choice: { kind: 'sticky' } as KanbanCreateChoice, icon: <IconNote /> }
  ], [customAgents, disabledAgents])

  const columnCards = useMemo(() => {
    const vis = (ids: string[]) => activeLocalFilter.length ? ids.filter(id => cardMatchesLabelFilter(board, id, activeLocalFilter)) : ids
    const toCards = (ids: string[]) => {
      const cards = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      return cards
    }
    return {
      ungrouped: toCards(vis(unassigned(board, sessionIds))),
      byColumn: new Map(board.columns.map(c => [c.id, toCards(vis(assignedTo(board, c.id)))]))
    }
  }, [board, byId, sessionIds, activeLocalFilter])

  const handleCardDragStart = useCallback((id: string) => { dragRef.current = { kind: 'card', id } }, [])
  const handleColumnDragStart = useCallback((id: string) => { dragRef.current = { kind: 'column', id } }, [])
  const handleDragEnd = useCallback(() => { dragRef.current = null }, [])

  const dropOnColumn = useCallback((columnId: string | null) => {
    const drag = dragRef.current; dragRef.current = null; if (!drag) return
    if (drag.kind === 'column') {
      if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
    } else {
      commit(assignNode(board, drag.id, columnId, null))
    }
  }, [board, commit])

  const dropAtCard = useCallback((columnId: string | null, targetNodeId: string, side: 'before' | 'after') => {
    const drag = dragRef.current; dragRef.current = null; if (!drag) return
    if (drag.kind === 'column') {
      if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
      return
    }
    const ids = columnId === null ? unassigned(board, sessionIds) : assignedTo(board, columnId)
    let beforeId: string | null = targetNodeId
    if (side === 'after') {
      const i = ids.indexOf(targetNodeId)
      beforeId = i >= 0 && i + 1 < ids.length ? ids[i+1] : null
    }
    commit(assignNode(board, drag.id, columnId, beforeId))
  }, [board, commit, sessionIds])

  const dropAtCardFor = useMemo(() => {
    const cache = new Map<string, (nodeId: string, side: 'before' | 'after') => void>()
    return (columnId: string | null) => {
      const key = columnId ?? '\u0000ungrouped'
      let bound = cache.get(key)
      if (!bound) { bound = (nodeId, side) => dropAtCard(columnId, nodeId, side); cache.set(key, bound) }
      return bound
    }
  }, [dropAtCard])

  const lanesFor = (columnId: string | null): KanbanLane[] => {
    const cards = columnId === null ? columnCards.ungrouped : columnCards.byColumn.get(columnId) ?? []
    const onDropAt = dropAtCardFor(columnId)
    return [{
      sourceId: 'sessions' as const,
      count: cards.length,
      cards: cards.map(s => (
        <SessionCard
          key={s.id}
          session={s}
          meta={cardMeta(board, s.id)}
          labels={labelsByCard.get(s.id) ?? []}
          onOpen={setModalNodeId}
          onContext={(id, x, y) => setCardMenu({ nodeId: id, x, y })}
          onDragStart={handleCardDragStart}
          onDragEnd={handleDragEnd}
          onDropAt={onDropAt}
        />
      ))
    }]
  }

  const cardMenuItems = (nodeId: string): MenuItem[] => {
    const curColId = columnForNode(board, nodeId)?.id ?? null
    const moveTargets: MenuItem[] = [
      ...(curColId !== null ? [{ label: 'Ungrouped', onClick: () => commit(assignNode(board, nodeId, null, null)) }] : []),
      ...board.columns.filter(c => c.id !== curColId).map(c => ({ label: c.title, onClick: () => commit(assignNode(board, nodeId, c.id, null)) }))
    ]
    return [
      { label: 'Open card', icon: <IconExternal />, onClick: () => setModalNodeId(nodeId) },
      { label: 'Open on canvas', icon: <IconExternal />, onClick: () => onOpenNode(nodeId, projectId) },
      ...(moveTargets.length ? [{ type: 'submenu', label: 'Move to', icon: <IconSwitch />, children: moveTargets } as MenuItem] : []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => onDeleteNode(projectId, nodeId) }
    ]
  }

  const toggleCollapsed = () => {
    document.getElementById(`swimlane-${projectId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    useViewMode.getState().setHighlightedSwimlaneId(projectId)
    setCollapsed((value) => !value)
  }
  return (
    <div
      id={`swimlane-${projectId}`}
      className={`kanban-swimlane${highlight ? ' kanban-swimlane--highlight' : ''}${collapsed ? ' kanban-swimlane--collapsed' : ''}`}
      style={{ ['--swimlane-color' as string]: projectColor || 'rgba(128,128,128,0.3)' }}
    >
      <div
        className="kanban-swimlane__header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggleCollapsed()
        }}
        title={collapsed ? 'Expand swimlane' : 'Collapse swimlane'}
      >
        <span className="kanban-swimlane__toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="kanban-header__dot" style={{ background: projectColor || '#444' }} />
        <span className="kanban-header__name">{projectName}</span>
        <span className="kanban-swimlane__count">{sessions.length} sessions</span>
      </div>
      {!collapsed && (
        <div className="kanban-board kanban-swimlane__board">
          <div className="kanban-board__columns">
            <KanbanColumn
              column={null}
              lanes={lanesFor(null)}
              createOptions={createOptions}
              onCreate={(choice, colId) => onCreateNode(projectId, choice, colId)}
              onDragEnd={handleDragEnd}
              onDropOnColumn={dropOnColumn}
            />
            {board.columns.map(col => (
              <KanbanColumn
                key={col.id}
                column={col}
                lanes={lanesFor(col.id)}
                onRename={(id, t) => commit(renameColumn(board, id, t))}
                onRecolor={(id, c) => commit(recolorColumn(board, id, c))}
                onDelete={(id) => commit(deleteColumn(board, id))}
                createOptions={createOptions}
                onCreate={(choice, colId) => onCreateNode(projectId, choice, colId)}
                onColumnDragStart={handleColumnDragStart}
                onDragEnd={handleDragEnd}
                onDropOnColumn={dropOnColumn}
              />
            ))}
            <button className="kanban-add-col" onClick={() => commit(addColumn(board, 'New column', nextColumnColor(board)))}>+ Add column</button>
          </div>
        </div>
      )}
      {cardMenu && byId.has(cardMenu.nodeId) && (
        <ContextMenu x={cardMenu.x} y={cardMenu.y} zIndex={60} items={cardMenuItems(cardMenu.nodeId)} onClose={() => setCardMenu(null)} />
      )}
      {modalNodeId && byId.has(modalNodeId) && (
        <CardModal
          session={byId.get(modalNodeId)!}
          columnTitle={columnForNode(board, modalNodeId)?.title ?? null}
          board={board}
          onChangeBoard={commit}
          onClose={() => setModalNodeId(null)}
          onOpenCanvas={() => { setModalNodeId(null); onOpenNode(modalNodeId, projectId) }}
          onRename={(t) => onRenameNode(modalNodeId, t)}
          onEditSticky={(t) => onEditSticky(projectId, modalNodeId, t)}
          onBrowserNav={(patch) => onBrowserNav(projectId, modalNodeId, patch)}
          onSetIcon={(icon) => onSetIcon(projectId, modalNodeId, icon)}
        />
      )}
    </div>
  )
})

export const GlobalKanbanView = memo(function GlobalKanbanView() {
  // Same rule as the per-project board: the canvas is covered but mounted underneath.
  useEffect(() => markCanvasCovered(document.documentElement), [])
  const projects = useProjects(s => s.projects.filter(p => !p.closed))
  const detached = useWindows(s => s.detached)
  const { api } = useSession()
  const modalRef = useRef<string | null>(null)
  const highlightId = useViewMode(s => s.highlightedSwimlaneId)
  const setHighlightId = useViewMode(s => s.setHighlightedSwimlaneId)
  const containerRef = useRef<HTMLDivElement>(null)
  const mod = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl'

  const jumpTo = useCallback((projectId: string) => {
    document.getElementById(`swimlane-${projectId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setHighlightId(projectId)
  }, [setHighlightId])

  // Expose scroll-to-swimlane for Cmd+1..9
  useEffect(() => {
    const handler = (e: CustomEvent<{ projectId: string }>) => jumpTo(e.detail.projectId)
    window.addEventListener('nodeterm:swimlane-jump' as never, handler as never)
    return () => window.removeEventListener('nodeterm:swimlane-jump' as never, handler as never)
  }, [jumpTo])

  const onChangeBoard = useCallback((projectId: string, next: ProjectKanban) => {
    const prev = useProjects.getState().getProject(projectId)?.kanban ?? defaultKanban()
    useProjects.getState().setProjectKanban(projectId, next)
    markWorkspaceDirty()
    const cardTitle = (nodeId: string) => {
      const proj = useProjects.getState().getProject(projectId)
      const n = proj?.nodes.find(x => x.id === nodeId)
      if (!n) return ''
      const s = toKanbanSessionState(n as never)
      return s ? s.title || 'Untitled' : ''
    }
    for (const { nodeId, event } of boardLogEvents(prev, next, cardTitle)) {
      useBoardLog.getState().append(api, projectId, { kind: 'event', nodeId, event })
    }
  }, [api])

  const onCreateNode = useCallback((projectId: string, choice: KanbanCreateChoice, columnId: string | null) => {
    // Delegate to Canvas's createNodeInColumn which correctly mounts the TerminalNode
    // and starts the tmux session (via transport.create). Direct store manipulation
    // would leave the tmux session unstarted for non-active projects, causing the
    // card's modal to open a fresh empty session that immediately closes.
    window.dispatchEvent(new CustomEvent('nodeterm:create-node', { detail: { projectId, choice, columnId } }))
  }, [])

  const onDeleteNode = useCallback((projectId: string, nodeId: string) => {
    // Delegate to Canvas — it shows ConfirmDialog, handles agent-status teardown, and routes
    // SSH kills via lib/sessionKill (local pty.destroy only touches local sockets).
    window.dispatchEvent(new CustomEvent('nodeterm:global-delete', { detail: { projectId, nodeId } }))
  }, [])

  const onRenameNode = useCallback((nodeId: string, title: string) => {
    const proj = useProjects.getState().projects.find(p => p.nodes.some(n => n.id === nodeId))
    if (!proj) return
    window.dispatchEvent(new CustomEvent('nodeterm:global-rename', { detail: { projectId: proj.id, nodeId, title } }))
  }, [])

  const onEditSticky = useCallback((projectId: string, nodeId: string, text: string) => {
    window.dispatchEvent(new CustomEvent('nodeterm:global-edit-sticky', { detail: { projectId, nodeId, text } }))
  }, [])

  const onBrowserNav = useCallback((projectId: string, nodeId: string, patch: { url?: string; title?: string }) => {
    window.dispatchEvent(new CustomEvent('nodeterm:global-browser-nav', { detail: { projectId, nodeId, patch } }))
  }, [])

  const onSetIcon = useCallback((projectId: string, nodeId: string, icon: NodeIcon | undefined) => {
    window.dispatchEvent(new CustomEvent('nodeterm:global-set-icon', { detail: { projectId, nodeId, icon } }))
  }, [])

  const onOpenNode = useCallback((nodeId: string, _projectId: string) => {
    const vm = useViewMode.getState()
    if (vm.globalKanban) vm.toggleGlobalKanban()
    // Let Canvas's focusNodeById handle project switching and canvas framing
    setTimeout(() => window.dispatchEvent(new CustomEvent('nodeterm:focus-node', { detail: { nodeId } })), 50)
  }, [])

  if (projects.length === 0) {
    return (
      <div className="kanban-overlay global-kanban">
        <div className="kanban-header"><span className="kanban-header__name">All Projects — Kanban</span></div>
        <div className="kanban-empty">No projects yet. Create a project to see its swimlane.</div>
      </div>
    )
  }

  return (
    <div className="kanban-overlay global-kanban" ref={containerRef}>
      <div className="kanban-header">
        <span className="kanban-header__name">All Projects</span>
        <span className="kanban-swimlane__hint">{projects.length} projects — {mod}+1..{Math.min(9, projects.length)} to jump</span>
        <button
          className="kanban-header__close"
          title={`Back to canvas (${mod}+Shift+B)`}
          onClick={() => useViewMode.getState().toggleGlobalKanban()}
        >
          ✕
        </button>
      </div>
      <div className="global-kanban__scroll">
        {projects.map((p, idx) => {
          // A project popped out into its own window is edited there (docs/popout-windows.md): its
          // lane names the window instead of offering cards whose edits this window may not make.
          if (detached.has(p.id)) {
            return (
              <div key={p.id} id={`swimlane-${p.id}`} className="kanban-swimlane kanban-swimlane--collapsed" style={{ ['--swimlane-color' as string]: p.color || 'rgba(128,128,128,0.3)' }}>
                <div className="kanban-swimlane__header">
                  <span className="kanban-header__dot" style={{ background: p.color || '#444' }} />
                  <span className="kanban-header__name">{`${idx+1}. ${p.name}`}</span>
                  <span className="kanban-swimlane__count">Open in its own window</span>
                  <button className="kanban-swimlane__window" onClick={() => void api.windows.focusProject(p.id)}>Show window</button>
                </div>
              </div>
            )
          }
          const board = p.kanban ?? defaultKanban()
          const sessions = p.nodes.map(n => toKanbanSessionState(n as never)).filter((s): s is KanbanSession => s !== null)
          return (
            <Swimlane
              key={p.id}
              projectId={p.id}
              projectName={`${idx+1}. ${p.name}`}
              projectColor={p.color}
              board={board}
              sessions={sessions}
              onChangeBoard={next => onChangeBoard(p.id, next)}
              onOpenNode={onOpenNode}
              onCreateNode={onCreateNode}
              onDeleteNode={onDeleteNode}
              onRenameNode={onRenameNode}
              onEditSticky={onEditSticky}
              onBrowserNav={onBrowserNav}
              onSetIcon={onSetIcon}
              onModalChange={id => { modalRef.current = id }}
              highlight={highlightId === p.id}
            />
          )
        })}
      </div>
    </div>
  )
})
