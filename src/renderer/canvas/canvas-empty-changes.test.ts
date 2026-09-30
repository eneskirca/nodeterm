import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyNodeChanges } from '@xyflow/react'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

// An all-filtered change batch (ephemeral subagent/loop cards, keep-alive ghosts) must not reach
// onNodesChange: see the comment at the early return in handleNodesChange.
describe('handleNodesChange with nothing left to apply', () => {
  it('React Flow returns a new array for an empty change list (the premise)', () => {
    const nodes = [{ id: 'a', position: { x: 0, y: 0 }, data: {} }]
    expect(applyNodeChanges([], nodes)).not.toBe(nodes)
  })

  it('returns before onNodesChange when every change was filtered', () => {
    const body = src.slice(src.indexOf('const handleNodesChange'), src.indexOf('const agentIdOf'))
    const early = body.indexOf('if (managed.length === 0) return')
    expect(early).toBeGreaterThan(-1)
    expect(early).toBeLessThan(body.indexOf('onNodesChange(snapped)'))
  })
})
