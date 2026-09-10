import { useEffect, useState, type DragEvent } from 'react'
import type { SwarmMission, SwarmRoleId } from '@shared/swarm/types'
import { COORDINATOR_ROLES, SWARM_ROLE_LABEL } from '@shared/swarm/types'
import { childRolesOf, roleNeedsActivation, taskLifecycleLabel } from '@shared/swarm/schemas'
import type { CanvasNode } from '../../state/workspace'
import { callsignOf } from '../../lib/callsign'
import type { MesaColumn } from '../../lib/mesaLayout'
import { useAgentStatus } from '../../state/agentStatus'
import { BotAvatar, presenceOf, presenceLabel } from './BotAvatar'

export type MesaTalkPick = { fromId: string } | { fromId: string; toId: string }

export function MissionRoster({
  query,
  onQuery,
  mission,
  columns,
  grouped,
  byId,
  focusId,
  talk,
  match,
  missionNodeIds,
  openCoords,
  snippetOf,
  onToggleCoord,
  onSelect,
  onTalk,
  onDragStart,
  onDragOverCol,
  onDropCol,
  onRenameGroup,
  onAddInColumn,
  onActivate
}: {
  query: string
  onQuery: (q: string) => void
  mission: SwarmMission | null
  columns: MesaColumn[]
  grouped: boolean
  byId: Map<string, CanvasNode>
  focusId: string | null
  talk: MesaTalkPick | null
  match: (id: string) => boolean
  missionNodeIds: Set<string>
  openCoords: Record<string, boolean>
  snippetOf: (node: CanvasNode) => string
  onToggleCoord: (coord: SwarmRoleId) => void
  onSelect: (id: string) => void
  onTalk: (id: string) => void
  onDragStart: (e: DragEvent, id: string) => void
  onDragOverCol: (e: DragEvent) => void
  onDropCol: (e: DragEvent, groupId: string | null) => void
  onRenameGroup: (groupId: string, title: string) => void
  onAddInColumn: (groupId?: string) => void
  /** Selective 1→4→16 wake. Must not move focus — a dormant role has no pane yet. */
  onActivate?: (roleId: SwarmRoleId) => void
}) {
  return (
    <aside className="mesa-roster">
      <input
        className="mesa-roster__search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search"
        aria-label="Buscar bots"
      />
      <div className="mesa-roster__list">
        {mission && (
          <section className="mesa-roster__sec mesa-roster__mission">
            <div className="mesa-col__head">
              <span className="mesa-col__title">Misión activa</span>
            </div>
            <p className="mesa-roster__obj">{mission.goal.objective}</p>
            {(() => {
              const orch = byId.get(mission.orchestratorNodeId)
              if (!orch) return null
              return (
                <RosterRow
                  node={orch}
                  selected={focusId === orch.id}
                  picking={!!talk && !('toId' in talk) && talk.fromId !== orch.id}
                  isSource={talk?.fromId === orch.id}
                  snippet={snippetOf(orch)}
                  onSelect={() => onSelect(orch.id)}
                  onTalk={() => onTalk(orch.id)}
                  onDragStart={(e) => onDragStart(e, orch.id)}
                />
              )
            })()}
            {COORDINATOR_ROLES.map((coord) => {
              const task = mission.tasks.find((t) => t.roleId === coord)
              const workers = childRolesOf(coord)
              const open = openCoords[coord] !== false
              const canFocus = !!task?.nodeId
              const canActivate =
                !!onActivate && !mission.paused && !mission.cancelled && roleNeedsActivation(task)
              return (
                <div key={coord} className="mesa-roster__coord">
                  <div className="mesa-roster__coord-head">
                    <button
                      type="button"
                      className="mesa-roster__coord-toggle"
                      aria-expanded={open}
                      aria-label={open ? `Plegar ${coord}` : `Desplegar ${coord}`}
                      onClick={() => onToggleCoord(coord)}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <button
                      type="button"
                      className="mesa-roster__coord-btn"
                      disabled={!canFocus && !canActivate}
                      onClick={() => {
                        if (canFocus && task?.nodeId) onSelect(task.nodeId)
                        else if (canActivate) onActivate?.(coord)
                      }}
                    >
                      {coord} {SWARM_ROLE_LABEL[coord]}
                      <em>
                        {canActivate && !canFocus
                          ? task
                            ? `${taskLifecycleLabel(task)} · reintentar`
                            : 'dormido · activar'
                          : taskLifecycleLabel(task)}
                      </em>
                    </button>
                  </div>
                  {open && (
                    <>
                      {(() => {
                        const node = task?.nodeId ? byId.get(task.nodeId) : undefined
                        if (!node || !match(node.id)) return null
                        return (
                          <RosterRow
                            key={coord}
                            node={node}
                            selected={focusId === node.id}
                            picking={!!talk && !('toId' in talk) && talk.fromId !== node.id}
                            isSource={talk?.fromId === node.id}
                            snippet={snippetOf(node)}
                            onSelect={() => onSelect(node.id)}
                            onTalk={() => onTalk(node.id)}
                            onDragStart={(e) => onDragStart(e, node.id)}
                          />
                        )
                      })()}
                      {workers.map((wid) => {
                        const wt = mission.tasks.find((t) => t.roleId === wid)
                        const node = wt?.nodeId ? byId.get(wt.nodeId) : undefined
                        if (node && match(node.id)) {
                          return (
                            <RosterRow
                              key={wid}
                              node={node}
                              selected={focusId === node.id}
                              picking={!!talk && !('toId' in talk) && talk.fromId !== node.id}
                              isSource={talk?.fromId === node.id}
                              snippet={snippetOf(node)}
                              onSelect={() => onSelect(node.id)}
                              onTalk={() => onTalk(node.id)}
                              onDragStart={(e) => onDragStart(e, node.id)}
                            />
                          )
                        }
                        const canWake =
                          !!onActivate &&
                          !mission.paused &&
                          !mission.cancelled &&
                          roleNeedsActivation(wt)
                        return (
                          <button
                            key={wid}
                            type="button"
                            className={`mesa-row is-asleep${canWake ? ' is-activatable' : ''}`}
                            disabled={!canWake}
                            onClick={() => {
                              if (canWake) onActivate?.(wid)
                            }}
                          >
                            <span className="mesa-row__copy">
                              <span className="mesa-row__name">
                                {wid} {SWARM_ROLE_LABEL[wid]}
                              </span>
                              <span className="mesa-row__snip">
                                {canWake
                                  ? wt
                                    ? `${taskLifecycleLabel(wt)} · reintentar`
                                    : 'dormido · activar'
                                  : taskLifecycleLabel(wt)}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </>
                  )}
                </div>
              )
            })}
          </section>
        )}
        {mission && (
          <div className="mesa-col__head">
            <span className="mesa-col__title">Otros terminales</span>
          </div>
        )}
        {columns.map((col) => {
          const ids = col.nodeIds.filter(match)
          if (query.trim() && ids.length === 0) return null
          return (
            <section
              key={col.id ?? 'libre'}
              className="mesa-roster__sec"
              style={{ ['--mesa-col' as string]: col.color }}
              onDragOver={onDragOverCol}
              onDrop={(e) => onDropCol(e, col.id)}
            >
              {grouped && (
                <ColumnHead
                  title={col.title}
                  count={col.nodeIds.length}
                  editable={!!col.id}
                  onRename={col.id ? (t) => onRenameGroup(col.id!, t) : undefined}
                  onAdd={() => onAddInColumn(col.id ?? undefined)}
                />
              )}
              {ids.map((id) => {
                const node = byId.get(id)
                if (!node) return null
                if (mission && missionNodeIds.has(id)) return null
                return (
                  <RosterRow
                    key={id}
                    node={node}
                    selected={focusId === id}
                    picking={!!talk && !('toId' in talk) && talk.fromId !== id}
                    isSource={talk?.fromId === id}
                    snippet={snippetOf(node)}
                    onSelect={() => onSelect(id)}
                    onTalk={() => onTalk(id)}
                    onDragStart={(e) => onDragStart(e, id)}
                  />
                )
              })}
              {col.nodeIds.length === 0 && grouped && (
                <button
                  type="button"
                  className="mesa-drop mesa-drop--roster"
                  onClick={() => onAddInColumn(col.id ?? undefined)}
                >
                  Soltá un bot acá
                </button>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

function displayName(node: CanvasNode): string {
  const title = String(node.data.title ?? '').trim()
  return title || callsignOf(node)
}

function ColumnHead({
  title,
  count,
  editable,
  onRename,
  onAdd
}: {
  title: string
  count: number
  editable: boolean
  onRename?: (title: string) => void
  onAdd: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  useEffect(() => setValue(title), [title])
  const commit = () => {
    setEditing(false)
    const t = value.trim()
    if (t && t !== title) onRename?.(t)
    else setValue(title)
  }
  return (
    <div className="mesa-col__head">
      {editing && editable ? (
        <input
          className="mesa-col__rename"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setValue(title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button type="button" className="mesa-col__title" onClick={() => editable && setEditing(true)}>
          {title}
        </button>
      )}
      <span className="mesa-col__count">{count}</span>
      <button type="button" className="mesa-col__add" title="Bot en este grupo" onClick={onAdd}>
        +
      </button>
    </div>
  )
}

function RosterRow({
  node,
  selected,
  picking,
  isSource,
  snippet,
  onSelect,
  onTalk,
  onDragStart
}: {
  node: CanvasNode
  selected: boolean
  picking: boolean
  isSource: boolean
  snippet: string
  onSelect: () => void
  onTalk: () => void
  onDragStart: (e: DragEvent) => void
}) {
  const letter = callsignOf(node)
  const name = displayName(node)
  const color = String(node.data.color ?? '#bf5af2')
  const status = useAgentStatus((s) => s.byId[node.id])
  const armed = !!node.data.pendingLaunch
  const presence = presenceOf(status?.state, armed)
  const unread = !!status?.unread && !selected
  return (
    <div
      className={`mesa-row${selected ? ' is-selected' : ''}${picking ? ' is-pick' : ''}${isSource ? ' is-from' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      draggable
      onDragStart={onDragStart}
    >
      <BotAvatar
        letter={letter}
        color={color}
        presence={presence}
        title={presenceLabel(presence)}
        size={40}
      />
      <span className="mesa-row__copy">
        <span className="mesa-row__name">{name}</span>
        <span className="mesa-row__snip">{snippet}</span>
      </span>
      {unread && <span className="mesa-row__unread" aria-label="Sin leer" />}
      <span
        className="mesa-row__talk"
        title="Hablar con otro bot"
        onClick={(e) => {
          e.stopPropagation()
          onTalk()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onTalk()
          }
        }}
        role="button"
        tabIndex={0}
      >
        @
      </span>
    </div>
  )
}
