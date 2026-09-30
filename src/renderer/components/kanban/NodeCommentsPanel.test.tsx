// @vitest-environment jsdom
/**
 * The canvas node's comments flyout offers the same @mention candidates the card modal does — the
 * agent sessions on the canvas — and follows the canvas when one is added or renamed.
 */
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, useStoreApi, type Node } from '@xyflow/react'
import { NodeCommentsPanel } from './NodeCommentsPanel'

const seen = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('./BoardLogPanel', () => ({
  BoardLogPanel: (p: { mentionables?: unknown }) => {
    seen.calls.push(p.mentionables)
    return null
  }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node = (id: string, type: string, data: Record<string, unknown>): Node => ({ id, type, position: { x: 0, y: 0 }, data })

function Seed({ nodes }: { nodes: Node[] }) {
  const store = useStoreApi()
  useEffect(() => store.setState({ nodes }), [store, nodes])
  return null
}

describe('NodeCommentsPanel', () => {
  it('hands the panel the canvas\'s agent sessions, and follows a rename', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const first = [
      node('a', 'terminal', { title: 'Alpha', agentId: 'claude' }),
      node('s', 'sticky', { text: 'note' }),
      node('t', 'terminal', { title: 'Shell' })
    ]
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <Seed nodes={first} />
          <NodeCommentsPanel id="a" />
        </ReactFlowProvider>
      )
    })
    expect(seen.calls.at(-1)).toEqual([{ id: 'a', title: 'Alpha' }])
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <Seed nodes={[node('a', 'terminal', { title: 'Renamed', agentId: 'claude' }), ...first.slice(1)]} />
          <NodeCommentsPanel id="a" />
        </ReactFlowProvider>
      )
    })
    expect(seen.calls.at(-1)).toEqual([{ id: 'a', title: 'Renamed' }])
    act(() => root.unmount())
  })
})
