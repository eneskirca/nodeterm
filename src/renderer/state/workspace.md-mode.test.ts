import { describe, it, expect } from 'vitest'
import { flowToNodeStates, nodeStatesToFlow } from './workspace'
import type { CanvasNodeState } from '@shared/types'

// The ⌘M view used to live only in React Flow's node data: a project switch reloads the canvas
// from the saved nodes, so every open chat view came back as the raw terminal.
const base: CanvasNodeState = {
  id: 'term-a-1',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  title: 'W1',
  color: '#888',
  group: null
}

describe('the ⌘M view survives a save/load round trip (a project switch, a reload)', () => {
  it('an open view stays open', () => {
    const saved = flowToNodeStates(nodeStatesToFlow([{ ...base, mdMode: true }]))
    expect(saved[0].mdMode).toBe(true)
    expect(nodeStatesToFlow(saved)[0].data.mdMode).toBe(true)
  })

  it('a closed view is not written at all, so other nodes save exactly as before', () => {
    expect(flowToNodeStates(nodeStatesToFlow([base]))[0].mdMode).toBeUndefined()
  })
})
