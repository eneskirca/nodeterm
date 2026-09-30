import { useCallback, useMemo, useRef } from 'react'
import { useStore, type ReactFlowState } from '@xyflow/react'
import { mentionCandidatesFromNodes } from '../../lib/boardMentions'
import type { CanvasNode } from '../../state/workspace'
import { BoardLogPanel } from './BoardLogPanel'

/**
 * The canvas node's comments flyout: the same `BoardLogPanel` the card modal shows, with the same
 * @mention candidates — the agent sessions on this canvas, built through the board's own mapping.
 * Mounted only while the flyout is open. The selector recomputes only when the node ARRAY changes
 * (a pan or zoom leaves it alone), and it returns a string, so the panel re-renders only when the
 * candidate list itself changes — not on every drag frame.
 */
export function NodeCommentsPanel({ id }: { id: string }) {
  const cache = useRef<{ nodes: unknown; signature: string } | null>(null)
  const select = useCallback((s: ReactFlowState) => {
    if (cache.current?.nodes === s.nodes) return cache.current.signature
    const signature = JSON.stringify(mentionCandidatesFromNodes(s.nodes as unknown as CanvasNode[]))
    cache.current = { nodes: s.nodes, signature }
    return signature
  }, [])
  const signature = useStore(select)
  const mentionables = useMemo(
    () => JSON.parse(signature) as ReturnType<typeof mentionCandidatesFromNodes>,
    [signature]
  )
  return <BoardLogPanel card={{ id }} mentionables={mentionables} />
}
