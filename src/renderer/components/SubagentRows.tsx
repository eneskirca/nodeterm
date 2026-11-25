import { useMemo, useState } from 'react'
import { useAgentNodes } from '../state/agentNodes'
import { requestOpenSubagent, subagentRowsFor, subagentRowsSig, type SubagentRow } from '../lib/subagentRows'
import { IconChevronDown, IconChevronRight, IconCircleCheck } from './icons'

export interface SubagentRowsProps {
  /** The agent node whose subagents these are. */
  parentNodeId: string
  /**
   * `sidebar`: indented rows under the node's session row (type · task, a working dot or a done mark).
   * `list`: the kanban card modal's compact list, under a heading, with the state in words.
   */
  variant?: 'sidebar' | 'list'
  /** Runs before the canvas is asked to open the card (the card modal closes and leaves the board). */
  onBeforeOpen?: () => void
}

function rowTitle(r: SubagentRow): string {
  return `${r.type}${r.label ? ` — ${r.label}` : ''} (${r.state}). Open its card on the canvas.`
}

function countLabel(rows: SubagentRow[]): string {
  const working = rows.filter((r) => r.state === 'working').length
  const done = rows.length - working
  return [working && `${working} working`, done && `${done} done`].filter(Boolean).join(' · ')
}

/**
 * The subagents of one agent node, one row per card the canvas draws for it (`useAgentNodes`, the
 * DEFAULT store: a relay tab's nodes have no cards there, so they get no rows). A click asks the
 * canvas to go to the parent node and open the card (`nodeterm:open-subagent`). Renders nothing for
 * a node with no cards, so a session row's height is untouched.
 *
 * Subscribes through `subagentRowsSig`, a primitive, never the store's whole `byId`: a chunk of
 * another subagent's output, or another node's card finishing, re-renders nothing here.
 */
export function SubagentRows({ parentNodeId, variant = 'sidebar', onBeforeOpen }: SubagentRowsProps): JSX.Element | null {
  const sig = useAgentNodes((s) => subagentRowsSig(s.byId, parentNodeId))
  const [collapsed, setCollapsed] = useState(false)
  // The signature carries everything a row draws, so reading the store again here is exact.
  const rows = useMemo(
    () => (sig ? subagentRowsFor(useAgentNodes.getState().byId, parentNodeId) : []),
    [sig, parentNodeId]
  )
  if (rows.length === 0) return null

  const items = rows.map((r) => (
    <button
      key={r.id}
      type="button"
      className={`subagent-row subagent-row--${r.state}`}
      title={rowTitle(r)}
      aria-label={`${r.type}${r.label ? `: ${r.label}` : ''}, ${r.state}`}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        onBeforeOpen?.()
        requestOpenSubagent(parentNodeId, r.id)
      }}
    >
      {r.state === 'working' ? (
        // A STATIC mark, never a spinner: a subagent can run for many minutes, and one looping
        // animation keeps a focused window producing frames at display rate (issue #1454).
        <span className="subagent-row__working" aria-hidden="true" />
      ) : (
        <span className="subagent-row__done" aria-hidden="true">
          <IconCircleCheck />
        </span>
      )}
      <span className="subagent-row__type">{r.type}</span>
      {r.label && (
        <>
          <span className="subagent-row__sep" aria-hidden="true">
            ·
          </span>
          <span className="subagent-row__label">{r.label}</span>
        </>
      )}
      {variant === 'list' && <span className="subagent-row__state">{r.state}</span>}
    </button>
  ))

  if (variant === 'list') {
    return (
      // A long run fans out dozens of subagents: the list scrolls inside a capped height (CSS) so it
      // never pushes the card's own body off the modal, and the heading folds it away entirely.
      <section className="card-subagents" aria-label="Subagents">
        <button
          type="button"
          className="card-subagents__header"
          aria-expanded={!collapsed}
          onClick={(e) => {
            e.stopPropagation()
            setCollapsed((c) => !c)
          }}
        >
          <span className="card-subagents__chevron" aria-hidden="true">
            {collapsed ? <IconChevronRight /> : <IconChevronDown />}
          </span>
          <span className="card-subagents__title">Subagents</span>
          <span className="card-subagents__count">{countLabel(rows)}</span>
        </button>
        {!collapsed && <div className="card-subagents__list">{items}</div>}
      </section>
    )
  }
  return (
    <div className="ss-subagents" role="group" aria-label="Subagents">
      {items}
    </div>
  )
}
