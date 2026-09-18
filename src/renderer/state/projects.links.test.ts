import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { BridgeLink } from '@shared/types'

const link = (source: string, target: string, prefix = 'bridge'): BridgeLink => ({
  id: `${prefix}-${source}-${target}`,
  source,
  target
})

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

/**
 * `appendCanvasLinks` is the EDGE counterpart of `applyNodeMutation`, and it exists for the same
 * reason: React Flow holds only the active project's edges, so a cold open (canvas control's
 * `open-*` answered out of a non-active project's serialized nodes) has nowhere else to put the
 * opener's rope and the fan-in bridge it owes. Without it a spawned team would be a write-only
 * fan-out — the thing the `link` work exists to have ended.
 *
 * Persistence is the unified `Project.links` substrate (the store is the ONE conversion site —
 * the canvas commits plain node-id-pair edges and never learns the Link shape), so every
 * assertion reads the link kinds back out of `links`.
 */
describe('appendCanvasLinks', () => {
  it('appends bridges and ropes to a project that is not active', () => {
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, {
      bridges: [link('a', 'b')],
      ropes: [link('a', 'b', 'ctrl')]
    })
    const links = useProjects.getState().getProject(p.id)?.links ?? []
    expect(links.filter((l) => l.kind === 'context').map((l) => l.id)).toEqual(['bridge-a-b'])
    expect(links.filter((l) => l.kind === 'lineage').map((l) => l.id)).toEqual(['ctrl-a-b'])
    // A rope is display-only by construction (never a context link — the invariant migrateLinks
    // preserves and `hiddenLinkIds` relies on).
    expect(links.find((l) => l.kind === 'lineage')?.meta).toEqual({ displayOnly: true })
  })

  it('keeps what is already there', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .commitCanvas(p.id, [], { x: 0, y: 0, zoom: 1 }, [link('x', 'y')], [link('x', 'y', 'ctrl')])
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('a', 'b')] })
    const links = useProjects.getState().getProject(p.id)?.links ?? []
    expect(links.filter((l) => l.kind === 'context').map((l) => l.id)).toEqual([
      'bridge-x-y',
      'bridge-a-b'
    ])
    expect(links.filter((l) => l.kind === 'lineage').map((l) => l.id)).toEqual(['ctrl-x-y'])
  })

  it('dedupes by ENDPOINT PAIR, in either direction — one relationship, one edge', () => {
    // `planBridges` mints `bridge-<source>-<target>` and a rope is `ctrl-<source>-<target>`, so id
    // equality alone would let a repeated open stack duplicate arrows between the same two nodes.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('a', 'b')] })
    useProjects.getState().appendCanvasLinks(p.id, { bridges: [link('b', 'a', 'other')] })
    expect(
      (useProjects.getState().getProject(p.id)?.links ?? []).filter((l) => l.kind === 'context')
    ).toEqual([
      {
        id: 'bridge-a-b',
        kind: 'context',
        source: { ref: 'node', nodeId: 'a' },
        target: { ref: 'node', nodeId: 'b' }
      }
    ])
  })

  it('dedupes WITHIN one call too', () => {
    const p = useProjects.getState().addProject('p')
    useProjects
      .getState()
      .appendCanvasLinks(p.id, { bridges: [link('a', 'b'), link('a', 'b'), link('a', 'c')] })
    expect(
      (useProjects.getState().getProject(p.id)?.links ?? [])
        .filter((l) => l.kind === 'context')
        .map((l) => l.id)
    ).toEqual(['bridge-a-b', 'bridge-a-c'])
  })

  it('keeps ropes and bridges in SEPARATE kinds — a rope and the bridge it covers coexist', () => {
    // `hiddenLinkIds` hides the bridge under the rope at render time; they are two facts (lineage
    // vs readable context) and collapsing them here would lose the link when the rope is deleted.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, {
      bridges: [link('a', 'b')],
      ropes: [link('a', 'b', 'ctrl')]
    })
    const links = useProjects.getState().getProject(p.id)?.links ?? []
    expect(links.filter((l) => l.kind === 'context')).toHaveLength(1)
    expect(links.filter((l) => l.kind === 'lineage')).toHaveLength(1)
  })

  it('leaves the substrate ABSENT when nothing is appended', () => {
    // A project that never had links must not gain an empty array — the shared project.json is
    // committed, and an empty key is a diff for everyone on the repo.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().appendCanvasLinks(p.id, { ropes: [link('a', 'b', 'ctrl')] })
    expect(useProjects.getState().getProject(p.id)?.links).toHaveLength(1)
    const q = useProjects.getState().addProject('q')
    useProjects.getState().appendCanvasLinks(q.id, {})
    expect(useProjects.getState().getProject(q.id)?.links).toBeUndefined()
  })

  it('is a no-op for an unknown project', () => {
    const before = useProjects.getState().projects
    useProjects.getState().appendCanvasLinks('nope', { bridges: [link('a', 'b')] })
    expect(useProjects.getState().projects).toEqual(before)
  })

  it('commitCanvas REPLACES the on-canvas set but keeps off-canvas links', () => {
    // The commit is a whole-arrays contract (nodes/viewport/edges), so a canvas commit that kept
    // stale on-canvas links would resurrect edges the user deleted. But an xnode/branch link the
    // canvas does not render must survive it — that is `commitLinks`' whole subject, and here the
    // edge-view form is what must not clobber one.
    const p = useProjects.getState().addProject('p')
    useProjects.getState().commitLinks(p.id, [
      {
        id: 'dep-l',
        kind: 'dependency',
        source: { ref: 'node', nodeId: 'a' },
        target: { ref: 'branch', repoPath: '/r', branch: 'main' }
      }
    ])
    useProjects
      .getState()
      .commitCanvas(p.id, [], { x: 0, y: 0, zoom: 1 }, [link('x', 'y')], [])
    const links = useProjects.getState().getProject(p.id)?.links ?? []
    expect(links.map((l) => l.id).sort()).toEqual(['bridge-x-y', 'dep-l'])
  })
})
