import { describe, expect, it } from 'vitest'
import { adjacentProjectId } from './projectCycle'

const P = [{ id: 'a' }, { id: 'b', closed: true }, { id: 'c' }, { id: 'd' }]

describe('adjacentProjectId', () => {
  it('steps forward and backward in tab order, skipping closed projects', () => {
    expect(adjacentProjectId(P, 'a', 1)).toBe('c')
    expect(adjacentProjectId(P, 'c', -1)).toBe('a')
    expect(adjacentProjectId(P, 'c', 1)).toBe('d')
  })

  it('wraps at both ends', () => {
    expect(adjacentProjectId(P, 'd', 1)).toBe('a')
    expect(adjacentProjectId(P, 'a', -1)).toBe('d')
  })

  it('has nowhere to go with a single open project, or none', () => {
    expect(adjacentProjectId([{ id: 'a' }, { id: 'b', closed: true }], 'a', 1)).toBeNull()
    expect(adjacentProjectId([{ id: 'a' }], 'a', -1)).toBeNull()
    expect(adjacentProjectId([], null, 1)).toBeNull()
    expect(adjacentProjectId([{ id: 'b', closed: true }], 'b', 1)).toBeNull()
  })

  it('enters the strip from the matching end when the active id is not an open tab', () => {
    expect(adjacentProjectId(P, null, 1)).toBe('a')
    expect(adjacentProjectId(P, 'b', -1)).toBe('d')
    expect(adjacentProjectId(P, 'gone', 1)).toBe('a')
  })
})
