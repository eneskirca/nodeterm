import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { CanvasNodeState, Link } from '@shared/types'

const mkNode = (id: string): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 240 },
  title: id,
  color: '#888',
  group: null
})

beforeEach(() => {
  useProjects.setState({
    projects: [
      { id: 'p1', name: 'P1', color: '#111', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [mkNode('n1')] }
    ],
    activeProjectId: 'p1'
  })
})

describe('projects store node mutations', () => {
  it('renames a node in a project', () => {
    useProjects.getState().renameNode('p1', 'n1', 'hello')
    expect(useProjects.getState().getProject('p1')!.nodes[0].title).toBe('hello')
  })

  it('recolors a node', () => {
    useProjects.getState().recolorNode('p1', 'n1', '#abc')
    expect(useProjects.getState().getProject('p1')!.nodes[0].color).toBe('#abc')
  })

  it('removes a node', () => {
    useProjects.getState().removeNode('p1', 'n1')
    expect(useProjects.getState().getProject('p1')!.nodes).toHaveLength(0)
  })

  it('duplicates a node with a new id and offset position', () => {
    useProjects.getState().duplicateNode('p1', 'n1')
    const nodes = useProjects.getState().getProject('p1')!.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes[1].id).not.toBe('n1')
    expect(nodes[1].position).not.toEqual(nodes[0].position)
  })
})

describe('moveNodeToGroup', () => {
  const group = (id: string, x: number, y: number): CanvasNodeState => ({
    id,
    kind: 'group',
    position: { x, y },
    size: { width: 400, height: 300 },
    title: id,
    color: '#fff',
    group: null
  })
  const at = (id: string, x: number, y: number, parentId?: string): CanvasNodeState => ({
    ...mkNode(id),
    position: { x, y },
    ...(parentId ? { parentId } : {})
  })

  beforeEach(() => {
    useProjects.setState({
      projects: [
        {
          id: 'p1',
          name: 'P1',
          color: '#111',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [group('g1', 50, 50), at('n1', 200, 150)]
        }
      ],
      activeProjectId: 'p1'
    })
  })

  it('adds a node to a group with a group-relative position', () => {
    useProjects.getState().moveNodeToGroup('p1', 'n1', 'g1')
    const n1 = useProjects.getState().getProject('p1')!.nodes.find((n) => n.id === 'n1')!
    expect(n1.parentId).toBe('g1')
    expect(n1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    useProjects.setState({
      projects: [
        {
          id: 'p1',
          name: 'P1',
          color: '#111',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [group('g1', 50, 50), at('n1', 10, 10, 'g1')]
        }
      ],
      activeProjectId: 'p1'
    })
    useProjects.getState().moveNodeToGroup('p1', 'n1', null)
    const n1 = useProjects.getState().getProject('p1')!.nodes.find((n) => n.id === 'n1')!
    expect(n1.parentId).toBeUndefined()
    expect(n1.position).toEqual({ x: 60, y: 60 })
  })

  it('is a no-op when the node is missing', () => {
    const before = useProjects.getState().getProject('p1')!.nodes
    useProjects.getState().moveNodeToGroup('p1', 'nope', 'g1')
    expect(useProjects.getState().getProject('p1')!.nodes).toBe(before)
  })

    it('moves nested group subtrees and rejects a cycle', () => {
    const outer = group('outer', 100, 80)
    const inner = { ...group('inner', 30, 40), parentId: 'outer' }
    const target = group('target', 500, 200)
    useProjects.setState({
      projects: [
        {
          id: 'p1',
          name: 'P1',
          color: '#111',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [outer, inner, target]
        }
      ],
      activeProjectId: 'p1'
    })
    useProjects.getState().moveNodeToGroup('p1', 'inner', 'target')
    let nodes = useProjects.getState().getProject('p1')!.nodes
    expect(nodes.find((node) => node.id === 'inner')).toMatchObject({
      parentId: 'target',
      position: { x: -370, y: -80 }
    })
    useProjects.getState().moveNodeToGroup('p1', 'target', 'inner')
    nodes = useProjects.getState().getProject('p1')!.nodes
    expect(nodes.find((node) => node.id === 'target')!.parentId).toBeUndefined()
  })
})

describe('reorderNode', () => {
  const setup = (nodes: CanvasNodeState[]): void => {
    useProjects.setState({
      projects: [
        { id: 'p1', name: 'P1', color: '#111', viewport: { x: 0, y: 0, zoom: 1 }, nodes }
      ],
      activeProjectId: 'p1'
    })
  }
  const order = (): string[] =>
    useProjects.getState().getProject('p1')!.nodes.map((n) => n.id)

  it('moves a node to sit immediately before another in the same container', () => {
    setup([mkNode('a'), mkNode('b'), mkNode('c')])
    useProjects.getState().reorderNode('p1', 'c', 'a')
    expect(order()).toEqual(['c', 'a', 'b'])
  })

  it('joins the target container when reordering across groups', () => {
    const grp: CanvasNodeState = {
      id: 'g1',
      kind: 'group',
      position: { x: 50, y: 50 },
      size: { width: 400, height: 300 },
      title: 'g1',
      color: '#fff',
      group: null
    }
    const t1: CanvasNodeState = { ...mkNode('t1'), position: { x: 10, y: 10 }, parentId: 'g1' }
    const t2: CanvasNodeState = { ...mkNode('t2'), position: { x: 200, y: 150 } }
    setup([grp, t1, t2])
    useProjects.getState().reorderNode('p1', 't2', 't1')
    const out = useProjects.getState().getProject('p1')!.nodes.find((n) => n.id === 't2')!
    expect(out.parentId).toBe('g1')
    expect(out.position).toEqual({ x: 150, y: 100 })
  })

  it('is a no-op for same / missing ids', () => {
    setup([mkNode('a'), mkNode('b')])
    const before = useProjects.getState().getProject('p1')!.nodes
    useProjects.getState().reorderNode('p1', 'a', 'a')
    useProjects.getState().reorderNode('p1', 'nope', 'a')
    expect(useProjects.getState().getProject('p1')!.nodes).toBe(before)
  })
})

describe('link substrate persistence (context + lineage)', () => {
  // Context links (formerly `bridges`) and lineage ropes (formerly `ropes`) now persist as ONE
  // unified `Link[]` discriminated by `kind`. Committed with the canvas and carried into the
  // workspace written to disk.
  it('commitCanvas stores links and toWorkspace carries them', () => {
    const links: Link[] = [
      {
        id: 'bridge-n1-n2',
        kind: 'context',
        source: { ref: 'node', nodeId: 'n1' },
        target: { ref: 'node', nodeId: 'n2' }
      },
      {
        id: 'ctrl-n1-n2',
        kind: 'lineage',
        source: { ref: 'node', nodeId: 'n1' },
        target: { ref: 'node', nodeId: 'n2' },
        meta: { displayOnly: true }
      }
    ]
    useProjects.getState().commitCanvas('p1', [mkNode('n1')], { x: 0, y: 0, zoom: 1 }, links)
    const p = useProjects.getState().projects[0]
    expect(p.links).toEqual(links)
    // Legacy fields are dropped on write (a migrated project stops carrying them).
    expect(p.bridges).toBeUndefined()
    expect(p.ropes).toBeUndefined()
    expect(useProjects.getState().toWorkspace().projects[0].links).toHaveLength(2)
  })
})
