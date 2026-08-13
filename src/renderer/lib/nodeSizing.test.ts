import { describe, it, expect } from 'vitest'
import { NODE_MIN_SIZES, snapNodeToGrid } from './nodeSizing'
import type { NodeKind } from '@shared/types'

const G = 24

describe('snapNodeToGrid', () => {
  it('snaps each edge to its nearest grid line', () => {
    // x=10 -> 0, y=10 -> 0, right=210 -> 216, bottom=210 -> 216
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    expect(r).toEqual({ x: 0, y: 0, width: 216, height: 216 })
  })

  it('lands every corner on a grid intersection', () => {
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    expect(r.x % G).toBe(0)
    expect(r.y % G).toBe(0)
    expect((r.x + r.width) % G).toBe(0)
    expect((r.y + r.height) % G).toBe(0)
  })

  it('leaves an already-aligned, above-minimum node untouched', () => {
    // terminal grid-aligned minimum is 264x168
    const r = snapNodeToGrid(G, 'terminal', { x: 0, y: 0, width: 264, height: 168 })
    expect(r).toEqual({ x: 0, y: 0, width: 264, height: 168 })
  })

  it('rounds edges independently — right edge goes to its own nearest line, not left + rounded width', () => {
    // right=210 -> 216 (nearest), so width is 216. A "round size" scheme would give
    // round(200/24)*24 = 192 and a right edge at 192 — farther from 210.
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 0, width: 200, height: 140 })
    expect(r).toEqual({ x: 0, y: 0, width: 216, height: 144 })
  })

  it('clamps a tiny node up to the kind grid-aligned minimum', () => {
    // terminal min 260x160 -> grid-aligned ceil(260/24)*24 = 264, ceil(160/24)*24 = 168
    const r = snapNodeToGrid(G, 'terminal', { x: 5, y: 5, width: 20, height: 20 })
    expect(r).toEqual({ x: 0, y: 0, width: 264, height: 168 })
  })

  it('clamps at a large grid size without inverting (a sub-grid box grows to the minimum)', () => {
    // grid 96, sticky 160x120 -> grid-aligned ceil(160/96)*96 = 192, ceil(120/96)*96 = 192
    const r = snapNodeToGrid(96, 'sticky', { x: 10, y: 10, width: 20, height: 20 })
    expect(r).toEqual({ x: 0, y: 0, width: 192, height: 192 })
  })

  it('keeps a size that already clears the minimum at its snapped value', () => {
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    // snapped 216x216 is above sticky's grid-aligned min (168x120), so no clamp
    expect(r.width).toBe(216)
    expect(r.height).toBe(216)
  })

  it('every kind has a positive min-size entry', () => {
    const kinds: NodeKind[] = [
      'terminal', 'sticky', 'group', 'editor', 'diff',
      'video', 'web', 'browser', 'subagent', 'loop', 'dino'
    ]
    for (const k of kinds) {
      expect(NODE_MIN_SIZES[k]).toBeDefined()
      expect(NODE_MIN_SIZES[k].width).toBeGreaterThan(0)
      expect(NODE_MIN_SIZES[k].height).toBeGreaterThan(0)
    }
  })
})
