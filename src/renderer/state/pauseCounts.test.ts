import { describe, it, expect } from 'vitest'
import { pauseCountsFor } from './pauseCounts'

const P = [
  { id: 'A', nodes: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] },
  { id: 'B', nodes: [{ id: 'b1' }] }
]

describe('pauseCountsFor', () => {
  it('counts paused and pending per project, omitting projects with neither', () =>
    expect(pauseCountsFor(P, new Set(['a1', 'a2']), new Set(['a3']))).toEqual({ A: { paused: 2, pending: 1 } }))
  it('nothing paused or pending → empty', () => expect(pauseCountsFor(P, new Set(), new Set())).toEqual({}))
})
