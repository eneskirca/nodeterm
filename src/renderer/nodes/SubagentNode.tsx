import { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconChevronRight } from '../components/icons'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useAgentNodes } from '../state/agentNodes'

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * Subagent node — a first-class canvas node (select/drag/resize) visualizing a subagent the
 * Claude session spawned. Shows type + task + live timer / duration-tokens; expand to read
 * its live transcript in a terminal-styled panel (subagents have no PTY).
 */
export function SubagentNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const working = data.subagentState !== 'done'
  const startedAt = (data.subagentStartedAt as number) || 0
  const durationMs = data.subagentDurationMs as number | undefined
  const tokens = data.subagentTokens as number | undefined
  const toolUses = data.subagentToolUses as number | undefined
  const result = (data.subagentResult as string) || ''
  // Live transcript: subscribed here per-id (not passed through Canvas's ephemeral node data)
  // so streaming chunks re-render only this card, never the whole canvas.
  const activity = useAgentNodes((s) => s.activityById[id]) || ''
  const body = activity || result
  const expanded = !!data.ephExpanded
  const bodyRef = useRef<HTMLDivElement>(null)
  const toggle = () => useAgentNodes.getState().toggleExpanded(id)

  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [body, expanded])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  const elapsed = working && startedAt ? fmtDur(now - startedAt) : durationMs ? fmtDur(durationMs) : ''
  const meta = [
    elapsed,
    tokens != null ? `↓ ${fmtTokens(tokens)} tokens` : null,
    toolUses ? `${toolUses} tool${toolUses === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  // The cards are `selectable: false` in React Flow (a rubber band must not sweep a fan-out
  // into the selection), so selecting one — which is what reveals its resize frame — is ours.
  const select = () => useAgentNodes.getState().select(id)

  return (
    <div onPointerDownCapture={select} className={`subagent-node${working ? ' working' : ' done'}`}>
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_SIZES.subagent.width} minHeight={NODE_MIN_SIZES.subagent.height} color="#d97757" />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="subagent-node__head nodrag" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button
          className="subagent-node__expand"
          title={expanded ? 'Collapse' : 'Open output'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {expanded ? <IconChevronDown /> : <IconChevronRight />}
        </button>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{(data.subagentType as string) || 'subagent'}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && !expanded && <div className="subagent-node__task">{data.title as string}</div>}
      {meta && <div className="subagent-node__meta">{meta}</div>}
      {expanded && (
        <div className="subagent-node__term nodrag nowheel" ref={bodyRef}>
          {data.title ? <div className="subagent-node__result-task">{data.title as string}</div> : null}
          {body || (working ? 'Working… (live output appears here)' : 'No output.')}
        </div>
      )}
    </div>
  )
}
