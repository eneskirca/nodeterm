import { describe, expect, it } from 'vitest'
import type { GitHubLink } from '@shared/github-issues'
import type { CanvasNodeState, NodeKind } from '@shared/types'
import { flowToNodeStates, nodeStatesToFlow } from './workspace'

const links: GitHubLink[] = [
  { kind: 'issue', number: 462, title: 'Board' },
  { kind: 'pull', number: 584 }
]

const state = (kind: NodeKind): CanvasNodeState => ({
  id: `${kind}-a-1`,
  kind,
  position: { x: 5, y: 6 },
  size: { width: 300, height: 170 },
  title: 'Work',
  color: '#888',
  group: null,
  github: links
})

describe('github link serialization', () => {
  for (const kind of ['terminal', 'sticky', 'browser', 'group'] as NodeKind[]) {
    it(`round-trips links on a ${kind} node`, () => {
      const [flow] = nodeStatesToFlow([state(kind)])
      expect(flow.data.github).toEqual(links)
      const [back] = flowToNodeStates([flow])
      expect(back.kind).toBe(kind)
      expect(back.github).toEqual(links)
    })
  }

  it('leaves a node without links undefined in both directions', () => {
    const plain = state('terminal')
    delete plain.github
    const [flow] = nodeStatesToFlow([plain])
    expect(flow.data.github).toBeUndefined()
    expect(flowToNodeStates([flow])[0].github).toBeUndefined()
  })
})
