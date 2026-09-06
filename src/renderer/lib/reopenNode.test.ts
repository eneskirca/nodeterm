import { describe, it, expect, vi, beforeEach } from 'vitest'
import { snapshotNode, recreateNodeFromSnapshot, type ReopenNodeSnapshot } from './reopenNode'

// createAgentNode reads settings/CLI-caps singletons — none of that matters for these tests,
// so stub the pieces snapshotNode/recreateNodeFromSnapshot actually touch.
vi.mock('@renderer/state/settings', () => ({
  useSettings: { getState: () => ({ settings: { customAgents: [], defaultNodeWidth: undefined, defaultNodeHeight: undefined, agentLaunchCommands: {} } }) }
}))
vi.mock('@renderer/state/permissionMode', () => ({ claudeCliCapsNow: () => ({ sessionIdFlag: false }) }))
vi.mock('@renderer/state/codexIdentity', () => ({ codexSharedIdentity: () => undefined }))

const baseCtx = () => ({
  liveNodeIds: new Set<string>(),
  project: undefined,
  resolveAccountId: (id: string | undefined) => id,
  permissionModeFor: () => undefined
})

describe('snapshotNode', () => {
  it('captures a leaf node, resolving absolute position through its parent chain', () => {
    const all = [
      { id: 'group-1', position: { x: 100, y: 200 }, parentId: undefined },
      { id: 'sticky-1', position: { x: 10, y: 20 }, parentId: 'group-1' }
    ]
    const node = {
      type: 'sticky' as const,
      position: { x: 10, y: 20 },
      parentId: 'group-1',
      extent: 'parent' as const,
      width: 240,
      height: 200,
      data: { title: 'Note', color: '#ffd60a', group: null, text: 'hi' }
    }
    const snap = snapshotNode(node, all)
    expect(snap).toEqual({
      type: 'sticky',
      position: { x: 10, y: 20 },
      absolutePosition: { x: 110, y: 220 },
      parentId: 'group-1',
      extent: 'parent',
      size: { width: 240, height: 200 },
      data: node.data
    })
  })

  it('returns null for group/subagent/loop/trigger nodes', () => {
    for (const type of ['group', 'subagent', 'loop', 'trigger'] as const) {
      const node = { type, position: { x: 0, y: 0 }, data: { title: 'x', color: '#fff', group: null } }
      expect(snapshotNode(node, [])).toBeNull()
    }
  })

  it('returns null for an account-login node', () => {
    const node = {
      type: 'terminal' as const,
      position: { x: 0, y: 0 },
      data: { title: 'Claude login', color: '#fff', group: null, initialCommand: 'claude /login' }
    }
    expect(snapshotNode(node, [])).toBeNull()
  })
})

describe('recreateNodeFromSnapshot', () => {
  const snap = (over: Partial<ReopenNodeSnapshot>): ReopenNodeSnapshot => ({
    type: 'sticky',
    position: { x: 10, y: 20 },
    absolutePosition: { x: 10, y: 20 },
    data: { title: 'Note', color: '#ffd60a', group: null, text: 'hi' },
    ...over
  })

  it('recreates a sticky at its absolute position when the parent is gone', () => {
    const node = recreateNodeFromSnapshot(snap({ parentId: 'dead-group' }), baseCtx())
    expect(node).not.toBeNull()
    expect(node!.type).toBe('sticky')
    expect(node!.position).toEqual({ x: 10, y: 20 })
    expect(node!.parentId).toBeUndefined()
    expect(node!.data.text).toBe('hi')
    expect(node!.data.title).toBe('Note')
  })

  it('reattaches to the parent group when it still exists, using the RELATIVE position', () => {
    const ctx = { ...baseCtx(), liveNodeIds: new Set(['group-1']) }
    const node = recreateNodeFromSnapshot(
      snap({ parentId: 'group-1', extent: 'parent', position: { x: 5, y: 5 }, absolutePosition: { x: 105, y: 205 } }),
      ctx
    )
    expect(node!.parentId).toBe('group-1')
    expect(node!.extent).toBe('parent')
    expect(node!.position).toEqual({ x: 5, y: 5 })
  })

  it('carries over size when the snapshot has one', () => {
    const node = recreateNodeFromSnapshot(snap({ size: { width: 900, height: 500 } }), baseCtx())
    expect(node!.width).toBe(900)
    expect(node!.height).toBe(500)
  })

  it('recreates an editor node from filePath, carrying the custom title', () => {
    const node = recreateNodeFromSnapshot(
      snap({
        type: 'editor',
        data: { title: 'My renamed editor', color: '#6ac4dc', group: null, filePath: '/tmp/a.ts' }
      }),
      baseCtx()
    )
    expect(node!.type).toBe('editor')
    expect(node!.data.filePath).toBe('/tmp/a.ts')
    expect(node!.data.title).toBe('My renamed editor')
  })

  it('returns null for an editor snapshot missing filePath (never a silently blank node)', () => {
    const node = recreateNodeFromSnapshot(
      snap({ type: 'editor', data: { title: 'x', color: '#fff', group: null } }),
      baseCtx()
    )
    expect(node).toBeNull()
  })

  it('recreates a dino node carrying its high score', () => {
    const node = recreateNodeFromSnapshot(
      snap({ type: 'dino', data: { title: 'Dino', color: '#a2a2a2', group: null, highScore: 42 } }),
      baseCtx()
    )
    expect(node!.data.highScore).toBe(42)
  })
})
