import { describe, it, expect } from 'vitest'
import {
  routeControlSource,
  needsLiveCanvas,
  sourceIsControlCapable,
  storedNodeListing,
  type ControlProject
} from './controlRouting'

const P = (
  id: string,
  nodes: { id: string; kind?: string; title?: string; agentId?: string }[],
  extra: Partial<ControlProject> = {}
): ControlProject => ({ id, nodes, ...extra })

describe('routeControlSource', () => {
  const projects = [
    P('p-active', [{ id: 'term-a-1' }]),
    P('p-open', [{ id: 'term-b-1' }, { id: 'term-b-2' }]),
    P('p-closed', [{ id: 'term-c-1' }], { closed: true }),
    P('p-gone', [{ id: 'term-d-1' }], { closed: true, unavailable: true })
  ]

  it('routes a node on the active canvas to the live canvas', () => {
    expect(routeControlSource(projects, 'p-active', 'term-a-1')).toEqual({ kind: 'active' })
  })

  // THE BUG: after an app restart the app comes up on ONE project, but every other project's
  // tmux sessions are re-adopted and keep running. Their agents' control calls used to be
  // answered by the ACTIVE canvas, which has never heard of the source node — so they were
  // rejected as "not a control-capable agent". The owning project must be resolved instead.
  it('routes a node in another OPEN project to its own project (not a rejection)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-b-2')).toEqual({
      kind: 'switch',
      projectId: 'p-open'
    })
  })

  it('routes a node in a CLOSED project to a reopen (its sessions still run)', () => {
    expect(routeControlSource(projects, 'p-active', 'term-c-1')).toEqual({
      kind: 'reopen',
      projectId: 'p-closed'
    })
  })

  it('blocks a project whose files are unreadable', () => {
    expect(routeControlSource(projects, 'p-active', 'term-d-1')).toEqual({
      kind: 'blocked',
      projectId: 'p-gone'
    })
  })

  it('reports an unknown node as unknown, not as a capability failure', () => {
    expect(routeControlSource(projects, 'p-active', 'term-nope-9')).toEqual({ kind: 'unknown' })
  })

  it('treats the active project as live even when the store lags the live canvas', () => {
    // A node just created on the live canvas is not committed to the store yet: the caller only
    // consults the router when the live canvas MISSED it, so an active-project id must not be
    // reported as travel-worthy.
    expect(routeControlSource(projects, 'p-open', 'term-b-1')).toEqual({ kind: 'active' })
  })
})

describe('needsLiveCanvas', () => {
  it('is false for the read-only listing verb', () => {
    expect(needsLiveCanvas('list')).toBe(false)
  })

  it('is true for every verb that mutates the canvas', () => {
    for (const verb of ['open-terminal', 'spawn-team', 'write', 'close', 'board', 'assign']) {
      expect(needsLiveCanvas(verb)).toBe(true)
    }
  })
})

describe('sourceIsControlCapable', () => {
  it('defaults a plain terminal node (no agentId) to claude, mirroring the spawn-time env', () => {
    expect(sourceIsControlCapable(undefined)).toBe(true)
    expect(sourceIsControlCapable('')).toBe(true)
  })

  it('accepts every canvas-control-capable agent', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'grok']) {
      expect(sourceIsControlCapable(id)).toBe(true)
    }
  })

  it('rejects an agent that never gets NODETERM_CANVAS_CONTROL', () => {
    expect(sourceIsControlCapable('cursor')).toBe(false)
  })
})

describe('storedNodeListing', () => {
  it('renders serialized nodes in the same shape the live canvas answers `list` with', () => {
    expect(
      storedNodeListing([
        { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
        { id: 'sticky-b-2', kind: 'sticky' },
        { id: 'term-b-3' }
      ])
    ).toEqual([
      { id: 'term-b-1', kind: 'terminal', title: 'Claude Code' },
      { id: 'sticky-b-2', kind: 'sticky', title: '' },
      { id: 'term-b-3', kind: 'terminal', title: '' }
    ])
  })
})
