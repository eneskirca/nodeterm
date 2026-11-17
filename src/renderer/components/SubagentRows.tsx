import { useMemo } from 'react'
import { useAgentNodes } from '../state/agentNodes'
import { requestOpenSubagent, subagentRowsFor, subagentRowsSig, type SubagentRow } from '../lib/subagentRows'
import { Spinner } from './Spinner'
import { IconCircleCheck } from './icons'

export interface SubagentRowsProps {
  /** The agent node whose subagents these are. */
  parentNodeId: string
  /**
   * `sidebar`: indented rows under the node's session row (type · task, a spinner or a done mark).
   * `list`: the kanban card modal's compact list, under a heading, with the state in words.
   */
  variant?: 'sidebar' | 'list'
  /** Runs before the canvas is asked to open the card (the card modal closes and leaves the board). */
  onBeforeOpen?: () => void
}

function rowTitle(r: SubagentRow): string {
  return `${r.type}${r.label ? ` — ${r.label}` : ''} (${r.state}). Open its card on the canvas.`
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
        <Spinner />
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
      <section className="card-subagents" aria-label="Subagents">
        <span className="card-subagents__title">Subagents</span>
        {items}
      </section>
    )
  }
  return (
    <div className="ss-subagents" role="group" aria-label="Subagents">
      {items}
    </div>
  )
}
