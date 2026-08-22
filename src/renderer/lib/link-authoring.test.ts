import { describe, it, expect } from 'vitest'
import {
  resolveEndpoint,
  describeEndpoint,
  linksForNode,
  kindAllowed,
  linkKindEndpointOf,
  newLinkId,
  offCanvasLinkColor,
  isBranchDependencyLink,
  isCrossProjectDependencyLink,
  depHostEdges,
  applyDependencyLink,
  removeDependencyLinkConfig,
  type ProjectLookup
} from './link-authoring'
import { contextLink, dependencyLink, lineageLink, nodeEndpoints } from './noteLink'
import type { CanvasNodeState, Link } from '@shared/types'

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 240 },
    title: id,
    color: '#888',
    group: null,
    ...over
  }) as CanvasNodeState

const proj = (id: string, name: string, nodes: CanvasNodeState[], over: Partial<ProjectLookup> = {}): ProjectLookup => ({
  id,
  name,
  nodes,
  ...over
})

describe('resolveEndpoint', () => {
  it('classifies a node in the source project as ref:node', () => {
    expect(resolveEndpoint({ kind: 'node', projectId: 'p1', nodeId: 'a' }, 'p1')).toEqual({
      ref: 'node',
      nodeId: 'a'
    })
  })

  it('classifies a node in a DIFFERENT project as ref:xnode', () => {
    expect(resolveEndpoint({ kind: 'node', projectId: 'p2', nodeId: 'b' }, 'p1')).toEqual({
      ref: 'xnode',
      projectId: 'p2',
      nodeId: 'b'
    })
  })

  it('classifies a branch selection as ref:branch', () => {
    expect(resolveEndpoint({ kind: 'branch', repoPath: '/repo', branch: 'main' }, 'p1')).toEqual({
      ref: 'branch',
      repoPath: '/repo',
      branch: 'main'
    })
  })

  it('branch is unaffected by the source project', () => {
    // A branch endpoint is the same regardless of which project the link originates from.
    expect(resolveEndpoint({ kind: 'branch', repoPath: '/r', branch: 'dev' }, 'p1')).toEqual(
      resolveEndpoint({ kind: 'branch', repoPath: '/r', branch: 'dev' }, 'p2')
    )
  })
})

describe('describeEndpoint', () => {
  const projects = [
    proj('p1', 'Alpha', [node('a1', { title: 'api-service' })]),
    proj('p2', 'Beta', [node('b1', { title: 'worker' })])
  ]

  it('describes a same-project node with the project name + title', () => {
    expect(describeEndpoint({ ref: 'node', nodeId: 'a1' }, projects)).toEqual({
      label: 'Alpha · api-service',
      available: true
    })
  })

  it('describes a foreign-project (xnode) target from its named project', () => {
    expect(describeEndpoint({ ref: 'xnode', projectId: 'p2', nodeId: 'b1' }, projects)).toEqual({
      label: 'Beta · worker',
      available: true
    })
  })

  it('describes a branch as repoName · branch', () => {
    expect(describeEndpoint({ ref: 'branch', repoPath: '/repos/nodeterm', branch: 'main' }, projects)).toEqual({
      label: 'nodeterm · main',
      available: true
    })
  })

  it('falls back to the node id when the title is empty', () => {
    expect(describeEndpoint({ ref: 'node', nodeId: 'a1' }, [proj('p1', 'Alpha', [node('a1', { title: '' })])])).toEqual({
      label: 'Alpha · a1',
      available: true
    })
  })

  it('reports an xnode target as unavailable when the project is missing', () => {
    expect(describeEndpoint({ ref: 'xnode', projectId: 'gone', nodeId: 'b1' }, projects)).toEqual({
      label: 'unavailable project',
      available: false
    })
  })

  it('reports an xnode target as unavailable when the project is marked unavailable', () => {
    const withUnavail = [proj('p2', 'Beta', [node('b1')], { unavailable: true })]
    expect(describeEndpoint({ ref: 'xnode', projectId: 'p2', nodeId: 'b1' }, withUnavail)).toEqual({
      label: 'unavailable project',
      available: false
    })
  })

  it('reports an xnode target as unavailable when the node is gone from a live project', () => {
    expect(describeEndpoint({ ref: 'xnode', projectId: 'p2', nodeId: 'ghost' }, projects)).toEqual({
      label: 'Beta · unavailable node',
      available: false
    })
  })

  it('reports a node endpoint as unavailable when no project holds it', () => {
    expect(describeEndpoint({ ref: 'node', nodeId: 'ghost' }, projects)).toEqual({
      label: 'unavailable node',
      available: false
    })
  })
})

describe('linksForNode', () => {
  const links: Link[] = [
    { id: 'l1', kind: 'context', source: { ref: 'node', nodeId: 'me' }, target: { ref: 'node', nodeId: 'other' } },
    { id: 'l2', kind: 'dependency', source: { ref: 'node', nodeId: 'them' }, target: { ref: 'branch', repoPath: '/r', branch: 'main' } },
    // 'me' is the source of a dependency to a foreign node (xnode)
    { id: 'l3', kind: 'dependency', source: { ref: 'node', nodeId: 'me' }, target: { ref: 'xnode', projectId: 'p2', nodeId: 'b1' } },
    // 'me' is the target of an incoming lineage from another node
    { id: 'l4', kind: 'lineage', source: { ref: 'node', nodeId: 'parent' }, target: { ref: 'node', nodeId: 'me' } }
  ]

  it('partitions outgoing (me is source) and incoming (me is target)', () => {
    const { outgoing, incoming } = linksForNode(links, 'me')
    expect(outgoing.map((l) => l.id)).toEqual(['l1', 'l3'])
    expect(incoming.map((l) => l.id)).toEqual(['l4'])
  })

  it('does not match an xnode endpoint that happens to share the node id (foreign node)', () => {
    // A link whose xnode target nodeId is 'me' does NOT involve THIS node — 'me' here is a
    // foreign node. Only the ref:'node' side matches.
    const foreign: Link[] = [
      { id: 'lx', kind: 'context', source: { ref: 'node', nodeId: 'them' }, target: { ref: 'xnode', projectId: 'p2', nodeId: 'me' } }
    ]
    expect(linksForNode(foreign, 'me')).toEqual({ outgoing: [], incoming: [] })
  })

  it('a branch endpoint never matches a node', () => {
    const branchy: Link[] = [
      { id: 'lb', kind: 'dependency', source: { ref: 'node', nodeId: 'me' }, target: { ref: 'branch', repoPath: '/r', branch: 'main' } }
    ]
    // 'me' is the source (outgoing); the branch target is not 'me'.
    expect(linksForNode(branchy, 'me').outgoing.map((l) => l.id)).toEqual(['lb'])
    expect(linksForNode(branchy, 'me').incoming).toEqual([])
  })
})

describe('kindAllowed', () => {
  const agent = { kind: 'terminal', contextCapable: true }
  const plain = { kind: 'terminal', contextCapable: false }
  const sticky = { kind: 'sticky', contextCapable: false }
  const editor = { kind: 'editor', contextCapable: false }

  it('context admits two context-capable agent terminals', () => {
    expect(kindAllowed('context', agent, agent)).toBe(true)
  })

  it('context rejects a context-capable agent paired with a non-capable terminal', () => {
    expect(kindAllowed('context', agent, plain)).toBe(false)
  })

  it('context admits exactly one sticky + one terminal — even an agent terminal (the sticky→terminal note persists as context)', () => {
    expect(kindAllowed('context', sticky, plain)).toBe(true)
    expect(kindAllowed('context', sticky, agent)).toBe(true) // agent is still a terminal
    expect(kindAllowed('context', agent, sticky)).toBe(true) // order-independent
  })

  it('context rejects a sticky paired with a non-terminal (editor)', () => {
    expect(kindAllowed('context', agent, editor)).toBe(false)
    expect(kindAllowed('context', sticky, editor)).toBe(false)
  })

  it('context rejects two stickies and two non-terminal non-stickies', () => {
    expect(kindAllowed('context', sticky, sticky)).toBe(false)
    expect(kindAllowed('context', editor, editor)).toBe(false)
  })

  it('lineage and dependency are unconstrained (any endpoint pair)', () => {
    expect(kindAllowed('lineage', agent, agent)).toBe(true)
    expect(kindAllowed('lineage', sticky, editor)).toBe(true)
    expect(kindAllowed('dependency', plain, sticky)).toBe(true)
    expect(kindAllowed('dependency', editor, editor)).toBe(true)
  })
})

describe('linkKindEndpointOf', () => {
  it('marks a created context-capable agent terminal as contextCapable', () => {
    expect(linkKindEndpointOf(node('a', { agentId: 'claude' })).contextCapable).toBe(true)
  })

  it('marks a plain terminal (no agentId) as not contextCapable', () => {
    expect(linkKindEndpointOf(node('t')).contextCapable).toBe(false)
  })

  it('marks a sticky as not contextCapable', () => {
    expect(linkKindEndpointOf(node('s', { kind: 'sticky' })).contextCapable).toBe(false)
    expect(linkKindEndpointOf(node('s', { kind: 'sticky' })).kind).toBe('sticky')
  })

  it('a non-context-capable agent (copilot) is not contextCapable', () => {
    expect(linkKindEndpointOf(node('c', { agentId: 'copilot' })).contextCapable).toBe(false)
  })
})

describe('newLinkId', () => {
  it('mints a link- prefixed id', () => {
    expect(newLinkId()).toMatch(/^link-[0-9a-f-]{36}$/)
  })

  it('mints unique ids', () => {
    expect(newLinkId()).not.toBe(newLinkId())
  })
})

describe('offCanvasLinkColor', () => {
  it('dependency is amber', () => {
    expect(offCanvasLinkColor({ id: 'l', kind: 'dependency', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'branch', repoPath: '/r', branch: 'main' } })).toBe('#f59e0b')
  })
  it('lineage is grey', () => {
    expect(offCanvasLinkColor({ id: 'l', kind: 'lineage', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'node', nodeId: 'b' } })).toBe('#8e8e93')
  })
  it('a context link with an xnode target is violet', () => {
    expect(offCanvasLinkColor({ id: 'l', kind: 'context', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'xnode', projectId: 'p2', nodeId: 'b' } })).toBe('#a855f7')
  })
  it('a branch target on a dependency falls back to blue only for non-xnode non-dependency — here dependency wins', () => {
    // dependency is checked first, so a dependency link is amber regardless of endpoint.
    expect(offCanvasLinkColor({ id: 'l', kind: 'dependency', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'xnode', projectId: 'p2', nodeId: 'b' } })).toBe('#f59e0b')
  })
})

/**
 * The round-trip that ticket 06 must keep lossless. `Canvas.tsx` splits a project's `Link[]` on
 * load into runtime edge arrays (only node↔node `context`/`lineage`) and an `offCanvasLinksRef`
 * (everything `nodeEndpoints` returns null for), then at commit `mergeLinks` composes the two back
 * together. This test reconstructs that exact composition against the pure primitives — pinning
 * that a `dependency`→`branch` link and a cross-project `xnode` link (the ones this ticket
 * introduces) survive, while a `context` node↔node link round-trips through the runtime split.
 */
describe('off-canvas round-trip (mergeLinks composition)', () => {
  // The load-side split: what linksToRuntime keeps (node↔node) vs stashes as off-canvas.
  const splitOnLoad = (links: Link[]) => ({
    onCanvas: links.filter((l) => nodeEndpoints(l) !== null),
    offCanvas: links.filter((l) => nodeEndpoints(l) === null)
  })
  // The commit-side merge: on-canvas node↔node links rebuilt via the same primitives runtimeToLinks
  // uses, then the off-canvas set appended (disjoint by construction).
  const mergeOnCommit = (onCanvas: Link[], offCanvas: Link[]): Link[] => [...onCanvas, ...offCanvas]

  it('a dependency→branch link survives the round-trip (the clobber regression)', () => {
    const persisted: Link[] = [
      contextLink('a', 'b'),
      { id: 'l-dep', kind: 'dependency', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'branch', repoPath: '/r', branch: 'main' } }
    ]
    const { onCanvas, offCanvas } = splitOnLoad(persisted)
    // The branch endpoint has no on-canvas node pair → stashed off-canvas, not dropped.
    expect(onCanvas.map((l) => l.id)).toEqual(['bridge-a-b'])
    expect(offCanvas.map((l) => l.id)).toEqual(['l-dep'])
    const roundTripped = mergeOnCommit(onCanvas, offCanvas)
    expect(roundTripped.map((l) => l.id).sort()).toEqual(['bridge-a-b', 'l-dep'])
  })

  it('a cross-project xnode context link survives the round-trip', () => {
    const persisted: Link[] = [
      { id: 'l-xnode', kind: 'context', source: { ref: 'node', nodeId: 'a' }, target: { ref: 'xnode', projectId: 'p2', nodeId: 'b' } }
    ]
    const { onCanvas, offCanvas } = splitOnLoad(persisted)
    expect(onCanvas).toEqual([]) // xnode target → no on-canvas pair
    expect(offCanvas.map((l) => l.id)).toEqual(['l-xnode'])
    expect(mergeOnCommit(onCanvas, offCanvas).map((l) => l.id)).toEqual(['l-xnode'])
  })

  it('a lineage rope and a context note both stay on-canvas; nothing leaks to off-canvas', () => {
    const persisted: Link[] = [contextLink('a', 'b'), lineageLink('c', 'd')]
    const { onCanvas, offCanvas } = splitOnLoad(persisted)
    expect(onCanvas.map((l) => l.id)).toEqual(['bridge-a-b', 'ctrl-c-d'])
    expect(offCanvas).toEqual([])
  })

  it('an empty project round-trips to empty (not undefined-shaped drift)', () => {
    const { onCanvas, offCanvas } = splitOnLoad([])
    expect(mergeOnCommit(onCanvas, offCanvas)).toEqual([])
  })

  it('a node↔node dependency link stays ON-canvas (ticket 09 meta-canvas auto-link, not off-canvas)', () => {
    // The meta-canvas submodule auto-link is a dependency between two real group nodes on the SAME
    // project, so nodeEndpoints !== null → it is on-canvas (a visible amber edge), NOT stashed in
    // offCanvasLinksRef. This is the gap task #47 closed: previously a node↔node dependency was
    // neither in the runtime arrays (dropped by the load split) nor off-canvas — silently lost.
    const persisted: Link[] = [dependencyLink('g-sub', 'g-parent')]
    const { onCanvas, offCanvas } = splitOnLoad(persisted)
    expect(onCanvas.map((l) => l.id)).toEqual(['dep-g-sub-g-parent'])
    expect(offCanvas).toEqual([])
    expect(mergeOnCommit(onCanvas, offCanvas).map((l) => l.id)).toEqual(['dep-g-sub-g-parent'])
  })

  it('a node↔node dependency coexists with a branch dependency (one on-canvas, one off)', () => {
    const persisted: Link[] = [
      dependencyLink('g-sub', 'g-parent'),
      { id: 'l-dep-branch', kind: 'dependency', source: { ref: 'branch', repoPath: '/r', branch: 'feat' }, target: { ref: 'branch', repoPath: '/r', branch: 'main' } }
    ]
    const { onCanvas, offCanvas } = splitOnLoad(persisted)
    expect(onCanvas.map((l) => l.id)).toEqual(['dep-g-sub-g-parent'])
    expect(offCanvas.map((l) => l.id)).toEqual(['l-dep-branch'])
    expect(mergeOnCommit(onCanvas, offCanvas).map((l) => l.id).sort()).toEqual(['dep-g-sub-g-parent', 'l-dep-branch'])
  })
})

describe('isBranchDependencyLink', () => {
  const branchLink = (id: string, child: string, parent: string): Link => ({
    id,
    kind: 'dependency',
    source: { ref: 'branch', repoPath: '/r', branch: child },
    target: { ref: 'branch', repoPath: '/r', branch: parent }
  })
  it('true only for a dependency with two branch endpoints', () => {
    expect(isBranchDependencyLink(branchLink('l', 'b', 'a'))).toBe(true)
  })
  it('false for a node↔branch dependency (cross-project style, no config entry)', () => {
    expect(
      isBranchDependencyLink({
        id: 'l',
        kind: 'dependency',
        source: { ref: 'node', nodeId: 'n1' },
        target: { ref: 'branch', repoPath: '/r', branch: 'a' }
      })
    ).toBe(false)
  })
  it('false for a context/lineage link even with branch endpoints', () => {
    expect(isBranchDependencyLink({ ...branchLink('l', 'b', 'a'), kind: 'context' })).toBe(false)
    expect(isBranchDependencyLink({ ...branchLink('l', 'b', 'a'), kind: 'lineage' })).toBe(false)
  })
})

describe('isCrossProjectDependencyLink', () => {
  // Ticket 04: a `dependency` with an `xnode` endpoint is declarative-only (no git topology, no
  // canvas edge). The gate `xlinkEdges` uses to keep it off the canvas. A `lineage`+`xnode` link
  // is NOT this — it renders as a projection (ticket 05) — so the kind matters, not just the ref.
  const xnodeDep = (id: string): Link => ({
    id,
    kind: 'dependency',
    source: { ref: 'node', nodeId: 'a1' },
    target: { ref: 'xnode', projectId: 'B', nodeId: 'b1' }
  })
  it('true for a dependency with an xnode target (the consumer→producer case)', () => {
    expect(isCrossProjectDependencyLink(xnodeDep('l'))).toBe(true)
  })
  it('true when the xnode is the source instead of the target', () => {
    expect(
      isCrossProjectDependencyLink({
        id: 'l',
        kind: 'dependency',
        source: { ref: 'xnode', projectId: 'B', nodeId: 'b1' },
        target: { ref: 'node', nodeId: 'a1' }
      })
    ).toBe(true)
  })
  it('false for a same-repo branch↔branch dependency (that one renders a dep- edge, ticket 03)', () => {
    expect(
      isCrossProjectDependencyLink({
        id: 'l',
        kind: 'dependency',
        source: { ref: 'branch', repoPath: '/r', branch: 'b' },
        target: { ref: 'branch', repoPath: '/r', branch: 'a' }
      })
    ).toBe(false)
  })
  it('false for a lineage link with an xnode endpoint (that one renders a projection, ticket 05)', () => {
    expect(isCrossProjectDependencyLink({ ...xnodeDep('l'), kind: 'lineage' })).toBe(false)
  })
  it('false for a context link with an xnode endpoint', () => {
    expect(isCrossProjectDependencyLink({ ...xnodeDep('l'), kind: 'context' })).toBe(false)
  })
})

describe('depHostEdges', () => {
  const branchLink = (id: string, child: string, parent: string): Link => ({
    id,
    kind: 'dependency',
    source: { ref: 'branch', repoPath: '/r', branch: child },
    target: { ref: 'branch', repoPath: '/r', branch: parent }
  })
  it('emits a child→parent edge when both branches are hosted by group nodes', () => {
    const hosts = new Map([
      ['feat-b', 'gB'],
      ['feat-a', 'gA']
    ])
    const edges = depHostEdges([branchLink('l1', 'feat-b', 'feat-a')], hosts)
    expect(edges).toEqual([
      { id: 'dep-l1', source: 'gB', target: 'gA', label: 'feat-b → feat-a', linkId: 'l1' }
    ])
  })
  it('emits nothing when only one branch is hosted (link survives at repo level)', () => {
    const hosts = new Map([['feat-b', 'gB']])
    expect(depHostEdges([branchLink('l1', 'feat-b', 'feat-a')], hosts)).toEqual([])
  })
  it('emits nothing when neither branch is hosted', () => {
    expect(depHostEdges([branchLink('l1', 'feat-b', 'feat-a')], new Map())).toEqual([])
  })
  it('ignores non-branch-dependency links (disjoint from the xlink path)', () => {
    const hosts = new Map([
      ['feat-b', 'gB'],
      ['feat-a', 'gA']
    ])
    expect(depHostEdges([{ ...branchLink('l1', 'feat-b', 'feat-a'), kind: 'context' }], hosts)).toEqual([])
  })
  it('skips a self-edge where both branches share one host group', () => {
    const hosts = new Map([
      ['feat-b', 'gB'],
      ['feat-a', 'gB']
    ])
    expect(depHostEdges([branchLink('l1', 'feat-b', 'feat-a')], hosts)).toEqual([])
  })
  it('handles a multi-level stack: b→a and c→b both render', () => {
    const hosts = new Map([
      ['feat-a', 'gA'],
      ['feat-b', 'gB'],
      ['feat-c', 'gC']
    ])
    const edges = depHostEdges([branchLink('l1', 'feat-b', 'feat-a'), branchLink('l2', 'feat-c', 'feat-b')], hosts)
    expect(edges.map((e) => e.label).sort()).toEqual(['feat-b → feat-a', 'feat-c → feat-b'])
  })
})

describe('applyDependencyLink / removeDependencyLinkConfig', () => {
  const branchLink = (id: string, child: string, parent: string): Link => ({
    id,
    kind: 'dependency',
    source: { ref: 'branch', repoPath: '/r', branch: child },
    target: { ref: 'branch', repoPath: '/r', branch: parent }
  })
  const fakeGit = (log: { set: string[]; unset: string[] }) => ({
    setBranchParent: async (repoPath: string, child: string, parent: string) => {
      log.set.push(`${repoPath}|${child}|${parent}`)
      return { ok: true, message: 'set' }
    },
    unsetBranchParent: async (repoPath: string, child: string) => {
      log.unset.push(`${repoPath}|${child}`)
      return { ok: true, message: 'unset' }
    }
  })
  it('writes the parent config with source=child, target=parent', async () => {
    const log = { set: [] as string[], unset: [] as string[] }
    await applyDependencyLink(fakeGit(log), branchLink('l1', 'feat-b', 'feat-a'))
    expect(log.set).toEqual(['/r|feat-b|feat-a'])
  })
  it('unsets the parent config on delete using the child (source) branch', async () => {
    const log = { set: [] as string[], unset: [] as string[] }
    await removeDependencyLinkConfig(fakeGit(log), branchLink('l1', 'feat-b', 'feat-a'))
    expect(log.unset).toEqual(['/r|feat-b'])
  })
  it('a non-branch-dependency link touches no config (no-op, ok)', async () => {
    const log = { set: [] as string[], unset: [] as string[] }
    const g = fakeGit(log)
    const nodeLink: Link = {
      id: 'l2',
      kind: 'dependency',
      source: { ref: 'node', nodeId: 'n1' },
      target: { ref: 'branch', repoPath: '/r', branch: 'a' }
    }
    expect((await applyDependencyLink(g, nodeLink)).ok).toBe(true)
    expect((await removeDependencyLinkConfig(g, nodeLink)).ok).toBe(true)
    expect(log.set).toEqual([])
    expect(log.unset).toEqual([])
  })
  it('a cross-project (xnode) dependency touches no config — declarative-only (ticket 04)', async () => {
    // No shared git → no git-town topology → nothing to write. The link is purely a persisted
    // relationship, authored + inspected off-canvas; it renders no canvas edge either.
    const log = { set: [] as string[], unset: [] as string[] }
    const g = fakeGit(log)
    const xnodeLink: Link = {
      id: 'l3',
      kind: 'dependency',
      source: { ref: 'node', nodeId: 'a1' },
      target: { ref: 'xnode', projectId: 'B', nodeId: 'b1' }
    }
    expect((await applyDependencyLink(g, xnodeLink)).ok).toBe(true)
    expect((await removeDependencyLinkConfig(g, xnodeLink)).ok).toBe(true)
    expect(log.set).toEqual([])
    expect(log.unset).toEqual([])
  })
})
