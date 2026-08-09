import { describe, it, expect } from 'vitest'
import {
  alignNodes,
  arrangeNodes,
  commonParentId,
  createAccountLoginNode,
  createAgentNode,
  createDinoNode,
  fitGroupToChildren,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  nodeSshFor,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  ungroupNodes
} from './workspace'
import type { CanvasNode } from './workspace'

const term = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: 320,
    height: 240,
    data: { title: id, color: '#888', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

const grp = (id: string, pos: { x: number; y: number }): CanvasNode =>
  ({
    id,
    type: 'group',
    position: pos,
    width: 400,
    height: 300,
    data: { title: id, color: '#fff', group: null }
  }) as unknown as CanvasNode

describe('reparentNode', () => {
  it('adds a top-level node to a group with a group-relative position', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe('g1')
    expect(t1.extent).toBe('parent')
    expect(t1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = reparentNode(nodes, 't1', null)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('orders group nodes before their children', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    expect(out.findIndex((n) => n.id === 'g1')).toBeLessThan(out.findIndex((n) => n.id === 't1'))
  })

  it('is a no-op when the node is already in the target group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(reparentNode(nodes, 't1', 'g1')).toBe(nodes)
  })

  it('is a no-op when the node is missing or the target is not a group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 })]
    expect(reparentNode(nodes, 'nope', 'g1')).toBe(nodes)
    expect(reparentNode(nodes, 't1', 't1')).toBe(nodes) // target is a terminal, not a group
  })
})

describe('commonParentId', () => {
  it('is null when every id is top-level', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), grp('g1', { x: 5, y: 5 })]
    expect(commonParentId(nodes, ['t1', 'g1'])).toBeNull()
  })
  it('is the group id when every id is a child of the same group', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1'), term('t2', { x: 20, y: 20 }, 'g1')]
    expect(commonParentId(nodes, ['t1', 't2'])).toBe('g1')
  })
  it('is undefined for a mixed set (framed + loose, or two frames) or no matching ids', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 500, y: 0 })
    ]
    expect(commonParentId(nodes, ['t1', 'loose'])).toBeUndefined()
    expect(commonParentId(nodes, ['nope'])).toBeUndefined()
  })
})

describe('arrange/align inside a frame', () => {
  // Children of one frame arrange in the frame's coordinate space — the gap this closes: after
  // grouping, the frame's contents could not be tidied from the canvas-control CLI.
  const framed = () => [
    grp('g1', { x: 100, y: 100 }),
    term('a', { x: 5, y: 5 }, 'g1'),
    term('b', { x: 400, y: 300 }, 'g1'), // scattered inside the frame
    term('c', { x: 900, y: 40 }, 'g1')
  ]

  it('arranges a frame\'s children in a row without touching the frame or top-level nodes', () => {
    const out = arrangeNodes(framed(), ['a', 'b', 'c'], { layout: 'row', gap: 40 })
    const pos = (id: string) => out.find((n) => n.id === id)!.position
    // Row starts at the bounding-box top-left of the children (relative coords), y shared.
    expect(pos('a')).toEqual({ x: 5, y: 5 })
    expect(pos('b')).toEqual({ x: 5 + 320 + 40, y: 5 })
    expect(pos('c')).toEqual({ x: 5 + (320 + 40) * 2, y: 5 })
  })

  it('refuses a set spanning two containers (no-op)', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('a', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 800, y: 0 })
    ]
    expect(arrangeNodes(nodes, ['a', 'loose'], { layout: 'row' })).toBe(nodes)
    expect(alignNodes(nodes, ['a', 'loose'], 'left')).toBe(nodes)
  })

  it('aligns a frame\'s children to a shared left edge', () => {
    const out = alignNodes(framed(), ['a', 'b', 'c'], 'left')
    const xs = ['a', 'b', 'c'].map((id) => out.find((n) => n.id === id)!.position.x)
    expect(new Set(xs)).toEqual(new Set([5])) // all snapped to the leftmost (a.x = 5)
  })
})

describe('fitGroupToChildren', () => {
  it('shrinks the frame to hug its children and keeps them fixed on canvas', () => {
    // Frame is oversized (400×300) but its two children sit in a small cluster.
    const nodes = [
      grp('g1', { x: 100, y: 100 }),
      term('a', { x: 20, y: 40 }, 'g1'), // abs (120,140), 320×240
      term('b', { x: 60, y: 20 }, 'g1') // abs (160,120)
    ]
    const out = fitGroupToChildren(nodes, 'g1')
    const g = out.find((n) => n.id === 'g1')!
    const a = out.find((n) => n.id === 'a')!
    const b = out.find((n) => n.id === 'b')!
    // Children keep their ABSOLUTE canvas positions (frame origin + relative pos unchanged).
    expect({ x: g.position.x + a.position.x, y: g.position.y + a.position.y }).toEqual({ x: 120, y: 140 })
    expect({ x: g.position.x + b.position.x, y: g.position.y + b.position.y }).toEqual({ x: 160, y: 120 })
    // Frame hugs the child bbox with the standard pad (28) + header (34) on top.
    const GROUP_PAD = 28
    const GROUP_HEADER = 34
    const minX = 120, minY = 120
    const maxX = 160 + 320, maxY = 140 + 240
    expect(g.position).toEqual({ x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER })
    expect(g.width).toBe(maxX - minX + GROUP_PAD * 2)
    expect(g.height).toBe(maxY - minY + GROUP_PAD * 2 + GROUP_HEADER)
  })

  it('is a no-op for a missing id, a non-group, or an empty frame', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 0, y: 0 })]
    expect(fitGroupToChildren(nodes, 'nope')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 't1')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 'g1')).toBe(nodes) // g1 has no children
  })
})

describe('groupSelectedNodes', () => {
  it('wraps the selection in a group frame with group-relative child positions', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const out = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const group = out[0]
    expect(group.type).toBe('group') // parent placed first (React Flow requirement)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe(group.id)
    expect(t1.extent).toBe('parent')
    // absolute position preserved: group position + relative child position
    expect(group.position.x + t1.position.x).toBe(100)
    expect(group.position.y + t1.position.y).toBe(100)
    // frame encloses both members (t2 spans to x=820, y=540)
    expect(group.position.x + (group.width as number)).toBeGreaterThanOrEqual(820)
    expect(group.position.y + (group.height as number)).toBeGreaterThanOrEqual(540)
  })

  it('groups a single node', () => {
    const out = groupSelectedNodes([term('t1', { x: 100, y: 100 })], ['t1'], 0)
    expect(out[0].type).toBe('group')
    expect(out.find((n) => n.id === 't1')!.parentId).toBe(out[0].id)
  })

  it('skips already-grouped children and group frames; all-skipped is a no-op', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(groupSelectedNodes(nodes, ['g1', 't1'], 1)).toBe(nodes)
  })
})

describe('ungroupNodes', () => {
  it('removes the frame and restores children to absolute positions', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = ungroupNodes(nodes, 'g1')
    expect(out.find((n) => n.id === 'g1')).toBeUndefined()
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('round-trips with groupSelectedNodes', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const grouped = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const out = ungroupNodes(grouped, grouped[0].id)
    expect(out.find((n) => n.id === 't1')!.position).toEqual({ x: 100, y: 100 })
    expect(out.find((n) => n.id === 't2')!.position).toEqual({ x: 500, y: 300 })
  })

  it('is a no-op when the group is missing', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    expect(ungroupNodes(nodes, 'nope')).toBe(nodes)
  })
})

describe('reorderNodeBefore', () => {
  const ids = (out: CanvasNode[]): string[] => out.filter((n) => n.type !== 'group').map((n) => n.id)

  it('reorders within the same container (moves dragged before target)', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 }), term('c', { x: 0, y: 0 })]
    expect(ids(reorderNodeBefore(nodes, 'c', 'a'))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderNodeBefore(nodes, 'a', 'c'))).toEqual(['b', 'a', 'c'])
  })

  it('keeps position unchanged for a same-container reorder', () => {
    const nodes = [term('a', { x: 5, y: 5 }), term('b', { x: 9, y: 9 })]
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out.find((n) => n.id === 'b')!.position).toEqual({ x: 9, y: 9 })
  })

  it('moves across containers (joins target group) and lands before the target', () => {
    const nodes = [
      grp('g1', { x: 50, y: 50 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('t2', { x: 200, y: 150 }) // ungrouped
    ]
    const out = reorderNodeBefore(nodes, 't2', 't1')
    const t2 = out.find((n) => n.id === 't2')!
    expect(t2.parentId).toBe('g1')
    expect(t2.position).toEqual({ x: 150, y: 100 }) // 200-50, 150-50
    expect(ids(out)).toEqual(['t2', 't1']) // t2 placed before t1
  })

  it('keeps group nodes first and is a no-op for same/ missing / group drags', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 })]
    expect(reorderNodeBefore(nodes, 'a', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'nope', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'g1', 'a')).toBe(nodes) // can't drag a group row
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out[0].id).toBe('g1')
  })
})

describe('group worktree serialization', () => {
  it('round-trips data.worktree on a group node', () => {
    const group = {
      id: 'group_1',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 400,
      height: 300,
      data: {
        title: 'G',
        color: '#fff',
        group: null,
        worktree: {
          repoPath: '/repo',
          branch: 'feature/x',
          baseRef: 'main',
          path: '/wt/feature-x',
          createdByApp: true
        }
      }
    } as unknown as CanvasNode

    const states = flowToNodeStates([group])
    expect(states[0].worktree).toEqual(group.data.worktree)

    const back = nodeStatesToFlow(states)
    expect(back[0].data.worktree).toEqual(group.data.worktree)
  })

  it('leaves worktree undefined for unbound groups', () => {
    const group = {
      id: 'group_2', type: 'group', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'G', color: '#fff', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([group])[0].worktree).toBeUndefined()
  })
})

describe('resolveNewNodeAccount', () => {
  const accounts = [{ id: 'a1', label: 'work', createdAt: 0 }]
  it('prefers the explicit pick', () =>
    expect(resolveNewNodeAccount('a1', { defaultAccountId: 'a2' }, accounts)).toBe('a1'))
  it('falls back to the project default', () =>
    expect(resolveNewNodeAccount(undefined, { defaultAccountId: 'a1' }, accounts)).toBe('a1'))
  it('drops ids that no longer exist', () =>
    expect(resolveNewNodeAccount('gone', { defaultAccountId: 'gone' }, accounts)).toBeUndefined())
  it('undefined when nothing set', () =>
    expect(resolveNewNodeAccount(undefined, {}, accounts)).toBeUndefined())
  it('undefined when the project is undefined', () =>
    expect(resolveNewNodeAccount(undefined, undefined, accounts)).toBeUndefined())
})

describe('accountId on Claude node factories', () => {
  it('stamps accountId onto a Claude agent node', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('does not stamp accountId onto a non-Claude agent node', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBeUndefined()
  })
  it('omits accountId when none is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.accountId).toBeUndefined()
  })
})

describe('accountId serialization', () => {
  it('round-trips data.accountId on a terminal node', () => {
    const node = {
      id: 'term-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: { title: 'T', color: '#888', group: null, agentId: 'claude', accountId: 'a1' }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].accountId).toBe('a1')
    const back = nodeStatesToFlow(states)
    expect(back[0].data.accountId).toBe('a1')
  })
  it('leaves accountId undefined when unset', () => {
    const node = {
      id: 'term-2', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([node])[0].accountId).toBeUndefined()
  })
})

describe('nodeSshFor', () => {
  const projectSsh = {
    server: { host: 'h', user: 'u' },
    remoteCwd: '/srv/app'
  } as unknown as NonNullable<Parameters<typeof nodeSshFor>[0]>

  it('is undefined for a local project, so nothing changes there', () => {
    expect(nodeSshFor(undefined)).toBeUndefined()
    expect(nodeSshFor(undefined, '/some/dir')).toBeUndefined()
  })

  it('threads the caller cwd through remoteCwd — the factories read a node cwd from there', () => {
    // Passing the project's ssh unchanged would silently replace an explicit --cwd with the
    // project root, which is the second half of this bug.
    expect(nodeSshFor(projectSsh, '/srv/app/sub')).toEqual({
      server: projectSsh.server,
      remoteCwd: '/srv/app/sub'
    })
  })

  it('falls back to the project root when no cwd is given', () => {
    expect(nodeSshFor(projectSsh)).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
    expect(nodeSshFor(projectSsh, '')).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
  })

  it('produces a node that actually runs on the host (remote tmux, remote cwd)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, nodeSshFor(projectSsh, '/srv/app/sub'))
    expect(node.data.sshRemoteTmux).toBe(true)
    expect(node.data.ssh).toEqual(projectSsh.server)
    expect(node.data.cwd).toBe('/srv/app/sub')
  })
})

describe('pendingLaunch round-trip', () => {
  // Unlike initialCommand (one-shot, deliberately NOT persisted), an armed node's held launch
  // must survive a reload — the station it waits on can take hours, and a restart in between
  // must not silently turn the node into an idle shell that never runs anything.
  it('persists the held launch and its dependencies', () => {
    const node = {
      id: 'term-3',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: {
        title: 'T',
        color: '#888',
        group: null,
        agentId: 'claude',
        pendingLaunch: { after: ['term-1', 'term-2'], command: 'claude "go"' }
      }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toEqual({ after: ['term-1', 'term-2'], command: 'claude "go"' })
    expect(nodeStatesToFlow(states)[0].data.pendingLaunch).toEqual({
      after: ['term-1', 'term-2'],
      command: 'claude "go"'
    })
  })

  it('stays undefined for an ordinary node', () => {
    const node = {
      id: 'term-4', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null, initialCommand: 'claude' }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toBeUndefined()
    // initialCommand is still not persisted — arming is what makes a launch durable.
    expect((states[0] as { initialCommand?: string }).initialCommand).toBeUndefined()
  })
})

describe('createAccountLoginNode', () => {
  it('produces a terminal node that logs the given account in', () => {
    const node = createAccountLoginNode('acct-1', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Claude login')
    expect(node.data.accountId).toBe('acct-1')
    expect(node.data.initialCommand).toBe('claude /login')
  })
})

describe('dino node serialization', () => {
  it('round-trips a dino node and its highScore', () => {
    const dino = {
      id: 'dino-1',
      type: 'dino',
      position: { x: 10, y: 20 },
      width: 600,
      height: 200,
      data: { title: 'Dino', color: '#a2a2a2', group: null, highScore: 1337 }
    } as unknown as CanvasNode

    const states = flowToNodeStates([dino])
    expect(states[0].kind).toBe('dino')
    expect(states[0].highScore).toBe(1337)

    const back = nodeStatesToFlow(states)
    expect(back[0].type).toBe('dino')
    expect(back[0].data.highScore).toBe(1337)
  })

  it('createDinoNode produces a dino node with highScore 0', () => {
    const node = createDinoNode(0)
    expect(node.type).toBe('dino')
    expect(node.data.highScore).toBe(0)
    expect(node.width).toBe(600)
  })
})

describe('chat node tombstone', () => {
  it('converts a persisted chat node into a sticky with the resume hint', () => {
    const flow = nodeStatesToFlow([
      {
        id: 'chat-1', kind: 'chat', x: 10, y: 20, width: 420, height: 520,
        title: 'API brainstorm', color: '#8b5cf6', chatSessionId: 'sess-abc123'
      } as any
    ])
    expect(flow).toHaveLength(1)
    const n = flow[0]
    expect(n.type).toBe('sticky')
    expect(n.position).toEqual({ x: 10, y: 20 })
    expect(n.data.title).toBe('API brainstorm')
    expect(String(n.data.text)).toContain('claude --resume sess-abc123')
  })
  it('converts a chat node without a session id into a plain explanatory sticky', () => {
    const flow = nodeStatesToFlow([{ id: 'chat-2', kind: 'chat', x: 0, y: 0 } as any])
    expect(flow[0].type).toBe('sticky')
    expect(String(flow[0].data.text)).toContain('removed')
    expect(String(flow[0].data.text)).not.toContain('--resume')
  })
})

describe('createAgentNode permission mode', () => {
  it('appends the flag for claude', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('claude --permission-mode auto')
  })

  it('stays bare in manual mode (legacy parity)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'manual')
    expect(node.data.initialCommand).toBe('claude')
  })

  it('stays bare when no mode is passed at all (legacy parity)', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.initialCommand).toBe('claude')
  })

  it('keeps the flag after the initial prompt so the prompt stays claude argv', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, 'fix the bug', undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe("claude 'fix the bug' --permission-mode auto")
  })

  it('never flags a non-capable agent', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('codex')
  })
})

describe('createAgentNode prompt injection', () => {
  it('uses --prompt for flag-prompt agents (opencode)', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "rerank the results")
    expect(n.data.initialCommand).toBe("opencode --prompt 'rerank the results'")
  })
  it('shell-quotes a flag-prompt safely', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "it's tricky")
    expect(n.data.initialCommand).toBe("opencode --prompt 'it'\\''s tricky'")
  })
  it('keeps argv injection byte-identical for codex and gemini', () => {
    expect(createAgentNode('codex', 0, undefined, undefined, 'do X').data.initialCommand).toBe("codex 'do X'")
    expect(createAgentNode('gemini', 0, undefined, undefined, 'do X').data.initialCommand).toBe("gemini 'do X'")
  })
})
