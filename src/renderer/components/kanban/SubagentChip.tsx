import { useMemo } from 'react'
import { useAgentNodes } from '../../state/agentNodes'
import { subagentRowsFor, subagentRowsSig } from '../../lib/subagentRows'

/**
 * "N subagents" on a session card, while the node has subagent cards on the canvas (the same store
 * the canvas draws them from); the running ones are counted apart and emphasized. Not a control:
 * the card's own click opens the card modal, whose list opens a subagent on the canvas. No spinner,
 * on purpose — a looping animation per card holds a focused board's frame loop open (issue #1454),
 * and the count already says it.
 *
 * Subscribes through `subagentRowsSig` (a primitive), never the store's whole `byId`.
 */
export function SubagentChip({ nodeId }: { nodeId: string }): JSX.Element | null {
  const sig = useAgentNodes((s) => subagentRowsSig(s.byId, nodeId))
  const { total, working } = useMemo(() => {
    const rows = sig ? subagentRowsFor(useAgentNodes.getState().byId, nodeId) : []
    return { total: rows.length, working: rows.filter((r) => r.state === 'working').length }
  }, [sig, nodeId])
  if (total === 0) return null
  const noun = `subagent${total === 1 ? '' : 's'}`
  const title =
    working > 0
      ? `${total} ${noun}, ${working} still working — open the card to see them`
      : `${total} ${noun}, all finished — open the card to see them`
  return (
    <span className="kanban-subagent-chip" title={title}>
      {total} {noun}
      {working > 0 && (
        <>
          {' · '}
          <strong className="kanban-subagent-chip__working">{working} working</strong>
        </>
      )}
    </span>
  )
}
