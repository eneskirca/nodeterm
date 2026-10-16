// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { MenuItem } from '../components/ContextMenu'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import type { CanvasNode } from '../state/workspace'
import {
  BOARD_NODE_ACTION_IDS,
  BOARD_SPATIAL_ROW_IDS,
  buildNodeActionItems,
  NOT_ATTACHED_HINT,
  RELEASED_HINT,
  type NodeActionCtx
} from './nodeActionItems'

const term = (id: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { title: id, ...data } }) as unknown as CanvasNode

function fakeCtx(nodes: CanvasNode[], over: Partial<NodeActionCtx> = {}): NodeActionCtx {
  const noop = (): void => {}
  return {
    nodes,
    sessionSource: 'local',
    attached: () => true,
    // Like the live canvas: the canvas holds every node it was given.
    onCanvas: (id) => nodes.some((n) => n.id === id),
    agentIdOf: (id) => nodes.find((n) => n.id === id)?.data.agentId as never,
    gatewayModels: [],
    gatewayStatus: 'idle',
    gatewayError: '',
    grokModels: () => [],
    addToExistingGroup: noop,
    groupSelection: noop,
    removeFromGroup: noop,
    setNodesColor: vi.fn(),
    pickNodeIcon: vi.fn(),
    duplicateNodes: noop,
    snapNodeToZone: () => true,
    toggleCollapseNodes: noop,
    toggleMarkdown: noop,
    reloadTerminals: noop,
    liveLinkMenuItems: () => [],
    branchClaude: async () => ({ ok: true }),
    transferConversation: noop,
    restartAgentNode: async () => {},
    pauseAgentNode: async () => {},
    pauseNodes: noop,
    resumeAgentNode: noop,
    switchClaudeAccountNode: async () => {},
    switchCodexAccountNode: async () => {},
    connectedProjectIdForHost: () => undefined,
    deleteNodes: vi.fn(),
    ...over
  }
}

/** Top-level rows as text: `#` label, `—` rule, `[colors]` swatches, `▸` submenu. */
const top = (items: MenuItem[]): string[] =>
  items.map((it) =>
    it.type === 'separator'
      ? '—'
      : it.type === 'colors'
        ? '[colors]'
        : it.type === 'label'
          ? `#${it.label}`
          : it.type === 'submenu'
            ? `${it.label} ▸`
            : it.label
  )

/** Depth-first search for a row by its label. */
function row(items: MenuItem[], label: string): Extract<MenuItem, { label: string }> | undefined {
  for (const it of items) {
    if (it.type === 'separator' || it.type === 'colors') continue
    if (it.label === label) return it
    if (it.type === 'submenu') {
      const hit = row(it.children, label)
      if (hit) return hit
    }
  }
  return undefined
}
const hintOf = (items: MenuItem[], label: string): string | undefined => {
  const r = row(items, label)
  return r && 'hint' in r ? r.hint : undefined
}
const disabledOf = (items: MenuItem[], label: string): boolean | undefined => {
  const r = row(items, label)
  return r && 'disabled' in r ? r.disabled : undefined
}

beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAgentStatus.setState({ byId: {} })
})

describe('buildNodeActionItems — the canvas node menu, moved verbatim', () => {
  it('a plain terminal gets exactly the rows the canvas menu showed before the move', () => {
    expect(top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')])))).toEqual([
      '#1 node',
      'Group node',
      '—',
      '[colors]',
      'Set icon…',
      '—',
      'Duplicate',
      'Snap to zone ▸',
      'Collapse / Expand',
      'Markdown view',
      'Refresh terminal',
      '—',
      'Delete'
    ])
  })

  it('an idle Claude agent with a session id gets the conversation rows, enabled', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    const rows = top(items)
    expect(rows).toContain('Branch conversation')
    expect(rows).toContain('Restart ▸')
    expect(rows).toContain('Pause session ▸')
    expect(disabledOf(items, 'Restart agent')).toBe(false)
    expect(rows.at(-1)).toBe('Delete')
  })

  it('a busy agent keeps its Restart row, disabled with the reason', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'working', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    expect(disabledOf(items, 'Restart agent')).toBe(true)
    expect(hintOf(items, 'Restart agent')).toBe(
      'This session is busy — restart it once its turn (or permission prompt) is done.'
    )
  })

  it('an agent with no session id says there is nothing to resume yet', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    expect(hintOf(items, 'Restart agent')).toBe('Nothing to resume yet — this session has not reported an id.')
  })

  it('an agent not on the canvas says its terminal is not attached', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude' })], { attached: () => false, onCanvas: () => false })
    )
    expect(hintOf(items, 'Restart agent')).toBe('This terminal is not attached right now.')
  })

  it('a relay tab refuses the shell recycle and the account switch', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'acc1', label: 'Work', createdAt: 0 }] as never }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude' })], { sessionSource: 'relay' })
    )
    expect(hintOf(items, 'Restart agent and shell')).toBe('Restart the shell on the machine hosting this relay session.')
    expect(disabledOf(items, 'Switch Claude account')).toBe(true)
    expect(hintOf(items, 'Switch Claude account')).toBe('Not available for relay sessions.')
  })

  it("an SSH project's node offers only the accounts pinned to its host", () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        claudeAccounts: [
          { id: 'local', label: 'Local', createdAt: 0 },
          { id: 'remote', label: 'Remote', host: 'me@box', createdAt: 0 }
        ] as never
      }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude', ssh: { host: 'box', user: 'me' } })])
    )
    // The node runs on the host's own (system) account: that row carries the ✓.
    expect(row(items, '✓ System account (me@box)')).toBeDefined()
    expect(row(items, 'Remote')).toBeDefined()
    expect(row(items, 'Local')).toBeUndefined()
  })

  it('a hidden row is left out', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['colors', 'icon'] } })
    const rows = top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')])))
    expect(rows).not.toContain('[colors]')
    expect(rows).not.toContain('Set icon…')
  })
})

describe('buildNodeActionItems — filters', () => {
  it('omit drops a section and leaves no dangling rule', () => {
    expect(
      top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')]), { omit: ['delete'] }))
    ).toEqual([
      '#1 node',
      'Group node',
      '—',
      '[colors]',
      'Set icon…',
      '—',
      'Duplicate',
      'Snap to zone ▸',
      'Collapse / Expand',
      'Markdown view',
      'Refresh terminal'
    ])
  })

  it('allow keeps only the listed sections', () => {
    const live = vi.fn((): MenuItem[] => [{ label: 'Share live link…', onClick: () => {} }])
    expect(
      top(
        buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')], { liveLinkMenuItems: live }), {
          allow: BOARD_NODE_ACTION_IDS
        })
      )
    ).toEqual(['[colors]', 'Set icon…', '—', 'Refresh terminal', 'Share live link…'])
  })

  it('on the board list the live-link row comes before the account switch', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'acc1', label: 'Work', createdAt: 0 }] as never }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const live = (): MenuItem[] => [{ label: 'Share live link…', onClick: () => {} }]
    const rows = top(
      buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })], { liveLinkMenuItems: live }), {
        allow: BOARD_NODE_ACTION_IDS
      })
    )
    const liveAt = rows.indexOf('Share live link…')
    const switchAt = rows.findIndex((r) => r.startsWith('Switch Claude account'))
    expect(liveAt).toBeGreaterThan(-1)
    expect(switchAt).toBeGreaterThan(-1)
    expect(liveAt).toBeLessThan(switchAt)
  })

  it('no spatial row is ever on the board list, nor a row the board owns itself', () => {
    for (const id of BOARD_SPATIAL_ROW_IDS) expect(BOARD_NODE_ACTION_IDS).not.toContain(id)
    for (const id of ['label', 'markdown-view', 'delete'] as const) expect(BOARD_NODE_ACTION_IDS).not.toContain(id)
  })
})

describe('bulk pause from a multi-selection', () => {
  it('several agents selected → one "Pause N sessions" row that hands every agent to pauseNodes', () => {
    const pauseNodes = vi.fn()
    const nodes = ['a1', 'a2', 'a3'].map((id) => term(id, { agentId: 'claude' }))
    const items = buildNodeActionItems(['a1', 'a2', 'a3'], undefined, fakeCtx(nodes, { pauseNodes }))
    const r = row(items, 'Pause 3 sessions')
    expect(r).toBeDefined()
    expect(top(items)).not.toContain('Pause session ▸')
    ;(r as { onClick: () => void }).onClick()
    expect(pauseNodes).toHaveBeenCalledWith(['a1', 'a2', 'a3'])
  })

  it('counts only agent sessions in a mixed selection', () => {
    const pauseNodes = vi.fn()
    const nodes = [term('a1', { agentId: 'claude' }), term('a2', { agentId: 'codex' }), term('t1')]
    const items = buildNodeActionItems(['a1', 'a2', 't1'], undefined, fakeCtx(nodes, { pauseNodes }))
    ;(row(items, 'Pause 2 sessions') as { onClick: () => void }).onClick()
    expect(pauseNodes).toHaveBeenCalledWith(['a1', 'a2'])
  })

  it('one agent in a mixed selection keeps the single Pause session submenu (with Pause & end session)', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const pauseAgentNode = vi.fn(async () => {})
    const nodes = [term('a1', { agentId: 'claude' }), term('t1'), term('t2')]
    const items = buildNodeActionItems(['a1', 't1', 't2'], undefined, fakeCtx(nodes, { pauseAgentNode }))
    expect(top(items)).toContain('Pause session ▸')
    expect(row(items, 'Pause 1 session')).toBeUndefined()
    expect(row(items, 'Pause & end session')).toBeDefined()
    ;(row(items, 'Pause') as { onClick: () => void }).onClick()
    expect(pauseAgentNode).toHaveBeenCalledWith('a1', false)
  })

  it('no agent in the selection → no bulk pause row', () => {
    const items = buildNodeActionItems(['t1', 't2'], undefined, fakeCtx([term('t1'), term('t2')]))
    expect(top(items).some((r) => r.startsWith('Pause'))).toBe(false)
  })

  it('one agent keeps the single Pause session submenu', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    expect(top(items)).toContain('Pause session ▸')
    expect(row(items, 'Pause 1 sessions')).toBeUndefined()
  })
})

describe('session rows when the terminal is not attached', () => {
  const NOT_ATTACHED = 'This terminal is not attached right now.'
  const claude = term('a', { agentId: 'claude', agentSessionId: 'sess-1' })
  // Not on the canvas at all: an Omni lane of a project the canvas does not hold.
  const ctxDetached = (): NodeActionCtx =>
    fakeCtx([claude], { attached: () => false, onCanvas: () => false })
  // On the live canvas, its terminal released while off screen.
  const ctxReleased = (): NodeActionCtx => fakeCtx([claude], { attached: () => false })

  it('a node released off screen keeps Refresh terminal enabled (the respawn revives it)', () => {
    const items = buildNodeActionItems(['a'], undefined, ctxReleased())
    expect(disabledOf(items, 'Refresh terminal')).toBe(false)
    expect(hintOf(items, 'Refresh terminal')).not.toBe(NOT_ATTACHED_HINT)
  })

  it('a node not on the canvas disables Refresh terminal with the not-attached reason', () => {
    const items = buildNodeActionItems(['a'], undefined, ctxDetached())
    expect(disabledOf(items, 'Refresh terminal')).toBe(true)
    expect(hintOf(items, 'Refresh terminal')).toBe(NOT_ATTACHED_HINT)
  })

  it('released on the canvas: session rows say the terminal was released, not that it is unattached', () => {
    useAgentStatus.setState({ byId: { a: { state: 'done', sessionId: 'sess-1' } as never } })
    const items = buildNodeActionItems(['a'], undefined, ctxReleased())
    for (const label of ['Restart agent', 'Restart agent and shell', 'Restart on subscription', 'Pause', 'Pause & end session']) {
      expect(disabledOf(items, label)).toBe(true)
      expect(hintOf(items, label)).toBe(RELEASED_HINT)
    }
    useAgentStatus.setState({ byId: { a: { sessionId: 'sess-1', paused: true } as never } })
    const paused = buildNodeActionItems(['a'], undefined, ctxReleased())
    expect(disabledOf(paused, 'Resume session')).toBe(true)
    expect(hintOf(paused, 'Resume session')).toBe(RELEASED_HINT)
  })

  it('the released hint names no single surface (canvas menu, sidebar and board all show it)', () => {
    expect(RELEASED_HINT).not.toMatch(/card menu/i)
    expect(RELEASED_HINT).toMatch(/refresh the terminal/i)
  })

  it('not on the canvas: the same rows keep the not-attached reason', () => {
    useAgentStatus.setState({ byId: { a: { state: 'done', sessionId: 'sess-1' } as never } })
    const items = buildNodeActionItems(['a'], undefined, ctxDetached())
    for (const label of ['Restart agent', 'Restart agent and shell', 'Restart on subscription', 'Pause', 'Pause & end session']) {
      expect(hintOf(items, label)).toBe(NOT_ATTACHED_HINT)
    }
  })

  it('disables Pause and Pause & end session with the not-attached reason', () => {
    useAgentStatus.setState({ byId: { a: { state: 'done', sessionId: 'sess-1' } as never } })
    const items = buildNodeActionItems(['a'], undefined, ctxDetached())
    expect(disabledOf(items, 'Pause')).toBe(true)
    expect(hintOf(items, 'Pause')).toBe(NOT_ATTACHED)
    expect(disabledOf(items, 'Pause & end session')).toBe(true)
    expect(hintOf(items, 'Pause & end session')).toBe(NOT_ATTACHED)
  })

  it('disables Resume session when detached, enables it when attached', () => {
    useAgentStatus.setState({
      byId: { a: { state: undefined, sessionId: 'sess-1', paused: true } as never }
    })
    const detached = buildNodeActionItems(['a'], undefined, ctxDetached())
    expect(disabledOf(detached, 'Resume session')).toBe(true)
    expect(hintOf(detached, 'Resume session')).toBe(NOT_ATTACHED)
    const attached = buildNodeActionItems(['a'], undefined, fakeCtx([claude]))
    expect(disabledOf(attached, 'Resume session')).toBeFalsy()
  })

  it('disables Refresh terminal for one detached node and keeps the busy reason ahead of it', () => {
    const items = buildNodeActionItems(['a'], undefined, ctxDetached())
    expect(disabledOf(items, 'Refresh terminal')).toBe(true)
    expect(hintOf(items, 'Refresh terminal')).toBe(NOT_ATTACHED)
    useAgentStatus.setState({ byId: { a: { state: 'working', sessionId: 'sess-1' } as never } })
    const busy = buildNodeActionItems(['a'], undefined, fakeCtx([claude]))
    expect(hintOf(busy, 'Pause')).toMatch(/busy/)
  })

  it('busy and no-id outrank not-attached on a detached node', () => {
    useAgentStatus.setState({ byId: { a: { state: 'working', sessionId: 'sess-1' } as never } })
    expect(hintOf(buildNodeActionItems(['a'], undefined, ctxDetached()), 'Pause')).toMatch(/busy/)
    useAgentStatus.setState({ byId: { a: { state: 'done' } as never } })
    expect(hintOf(buildNodeActionItems(['a'], undefined, ctxDetached()), 'Pause')).toBe(
      'Nothing to resume yet — this session has not reported an id.'
    )
  })

  it('a selection of several detached terminals keeps Refresh terminal enabled', () => {
    const items = buildNodeActionItems(['t1', 't2'], undefined, fakeCtx([term('t1'), term('t2')], { attached: () => false }))
    expect(disabledOf(items, 'Refresh terminal')).toBe(false)
  })
})

describe('board allowlist carries the session sections', () => {
  const labels = (items: MenuItem[]): string[] => top(items)

  it('offers refresh, restart, pause for an idle attached claude card, and no node-creating rows', () => {
    useAgentStatus.setState({ byId: { a: { state: 'done', sessionId: 's' } as never } })
    const n = term('a', { agentId: 'claude', agentSessionId: 's' })
    const l = labels(buildNodeActionItems(['a'], undefined, fakeCtx([n]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l).toEqual(expect.arrayContaining(['Refresh terminal', 'Restart ▸', 'Pause session ▸']))
    for (const never of ['Duplicate', 'Branch conversation', 'Group node', 'Collapse'])
      expect(l.some((x) => x.startsWith(never))).toBe(false)
    for (const id of BOARD_SPATIAL_ROW_IDS) expect(BOARD_NODE_ACTION_IDS).not.toContain(id)
  })

  it('a working agent: restarts and pauses are disabled with the busy reason and nothing runs', () => {
    useAgentStatus.setState({ byId: { a: { state: 'working', sessionId: 's' } as never } })
    const restartAgentNode = vi.fn(async () => {})
    const pauseAgentNode = vi.fn(async () => {})
    const n = term('a', { agentId: 'claude', agentSessionId: 's' })
    const items = buildNodeActionItems(['a'], undefined, fakeCtx([n], { restartAgentNode, pauseAgentNode }), {
      allow: BOARD_NODE_ACTION_IDS
    })
    for (const label of ['Restart agent', 'Restart agent and shell', 'Pause', 'Pause & end session']) {
      expect(disabledOf(items, label)).toBe(true)
      expect(hintOf(items, label)).toMatch(/busy/)
    }
    // Building the menu never runs a session action on its own.
    expect(restartAgentNode).not.toHaveBeenCalled()
    expect(pauseAgentNode).not.toHaveBeenCalled()
  })

  it('a relay card: recycling rows are disabled with the host wording', () => {
    useAgentStatus.setState({ byId: { a: { state: 'done', sessionId: 's' } as never } })
    const n = term('a', { agentId: 'claude', agentSessionId: 's' })
    const items = buildNodeActionItems(['a'], undefined, fakeCtx([n], { sessionSource: 'relay' }), {
      allow: BOARD_NODE_ACTION_IDS
    })
    expect(disabledOf(items, 'Restart agent and shell')).toBe(true)
    expect(hintOf(items, 'Restart agent and shell')).toBe('Restart the shell on the machine hosting this relay session.')
    expect(disabledOf(items, 'Pause & end session')).toBe(true)
    expect(hintOf(items, 'Pause & end session')).toBe(
      'Ends the tmux session on the machine hosting this relay session, not here.'
    )
    expect(disabledOf(items, 'Restart on subscription')).toBe(true)
    expect(hintOf(items, 'Restart on subscription')).toBe('Restart the shell on the machine hosting this relay session.')
    expect(disabledOf(items, 'Restart agent')).toBeFalsy()
  })

  it('a browser card gets no session rows', () => {
    const browser = {
      id: 'b1',
      type: 'browser',
      position: { x: 0, y: 0 },
      data: { title: 'b1', url: 'https://example.com' }
    } as unknown as CanvasNode
    const l = labels(buildNodeActionItems(['b1'], undefined, fakeCtx([browser]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l.some((x) => /Restart|Pause|Switch model|Refresh/.test(x))).toBe(false)
  })

  it('a paused node shows Resume and never Pause', () => {
    useAgentStatus.setState({ byId: { a: { sessionId: 's', paused: true } as never } })
    const n = term('a', { agentId: 'claude', agentSessionId: 's' })
    const l = labels(buildNodeActionItems(['a'], undefined, fakeCtx([n]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l).toContain('Resume session')
    expect(l).not.toContain('Pause session ▸')
  })

  it('sticky and plain-shell cards get no agent rows; the shell still refreshes', () => {
    const sticky = { id: 's1', type: 'sticky', position: { x: 0, y: 0 }, data: {} } as unknown as CanvasNode
    const shell = term('t')
    const l1 = labels(buildNodeActionItems(['s1'], undefined, fakeCtx([sticky]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l1.some((x) => /Restart|Pause|Refresh/.test(x))).toBe(false)
    const l2 = labels(buildNodeActionItems(['t'], undefined, fakeCtx([shell]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l2).toContain('Refresh terminal')
    expect(l2.some((x) => /Restart|Pause/.test(x))).toBe(false)
  })

  it('hiding refresh-terminal in Settings hides it on the card', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['refresh-terminal'] }
    })
    const l = labels(buildNodeActionItems(['t'], undefined, fakeCtx([term('t')]), { allow: BOARD_NODE_ACTION_IDS }))
    expect(l).not.toContain('Refresh terminal')
  })

  it('the modal allowlist is a subset without refresh', async () => {
    const mod = await import('./nodeActionItems')
    expect(mod.BOARD_MODAL_ACTION_IDS).toEqual(['restart', 'switch-model', 'switch-account', 'pause'])
    for (const id of mod.BOARD_MODAL_ACTION_IDS) expect(BOARD_NODE_ACTION_IDS).toContain(id)
  })
})
