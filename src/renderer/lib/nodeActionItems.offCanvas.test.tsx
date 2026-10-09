// @vitest-environment jsdom
//
// A kanban card of a project the canvas does NOT hold (an Omni lane of a background project):
// its rows come from the same builder, over the project's STORED nodes, and nothing may act on
// the live canvas of another project or fail in silence.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '@shared/types'
import type { MenuItem } from '../components/ContextMenu'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { nodeStatesToFlow } from '../state/workspace'
import {
  BOARD_NODE_ACTION_IDS,
  buildNodeActionItems,
  offCanvasNodeActionCtx,
  type OffCanvasCtxInput
} from './nodeActionItems'

const stored = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    title: id,
    color: '#fff',
    group: null,
    ...extra
  }) as CanvasNodeState

function input(nodes: CanvasNodeState[], over: Partial<OffCanvasCtxInput> = {}): OffCanvasCtxInput {
  return {
    nodes: nodeStatesToFlow(nodes),
    sessionSource: 'local',
    gatewayModels: [],
    gatewayStatus: 'idle',
    gatewayError: '',
    grokModels: () => [],
    cursorModels: () => [],
    writes: { setColor: vi.fn(), pickIcon: vi.fn() },
    liveLinkMenuItems: () => [],
    connectedProjectIdForHost: () => undefined,
    refuse: vi.fn(),
    ...over
  }
}

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

beforeEach(() => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'acc1', label: 'Work', createdAt: 0 }] as never }
  })
  useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
})

describe('offCanvasNodeActionCtx — a card of a background project', () => {
  it('shows the account rows, disabled because the terminal is not attached', () => {
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      offCanvasNodeActionCtx(input([stored('a1', { agentId: 'claude' })])),
      { allow: BOARD_NODE_ACTION_IDS }
    )
    const work = row(items, 'Work')
    expect(work && 'disabled' in work && work.disabled).toBe(true)
    expect(work && 'hint' in work && work.hint).toBe('This terminal is not attached right now.')
  })

  it('a relay lane refuses the account switch with the relay reason', () => {
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      offCanvasNodeActionCtx(input([stored('a1', { agentId: 'claude' })], { sessionSource: 'relay' })),
      { allow: BOARD_NODE_ACTION_IDS }
    )
    const sw = row(items, 'Switch Claude account')
    expect(sw && 'hint' in sw && sw.hint).toBe('Not available for relay sessions.')
  })

  it('color and icon go to the project write router, not the live canvas', () => {
    const i = input([stored('a1', { agentId: 'claude' })])
    const items = buildNodeActionItems(['a1'], undefined, offCanvasNodeActionCtx(i), {
      allow: BOARD_NODE_ACTION_IDS
    })
    const colors = items.find((it) => it.type === 'colors')
    if (!colors || colors.type !== 'colors') throw new Error('no colors row')
    colors.onPick('#0a84ff')
    const icon = row(items, 'Set icon…')
    if (!icon || !('onClick' in icon)) throw new Error('no icon row')
    icon.onClick()
    expect(i.writes.setColor).toHaveBeenCalledWith(['a1'], '#0a84ff')
    expect(i.writes.pickIcon).toHaveBeenCalledWith('a1')
  })

  it('anything that needs the live canvas refuses out loud', () => {
    const i = input([stored('a1')])
    const ctx = offCanvasNodeActionCtx(i)
    ctx.duplicateNodes(['a1'])
    ctx.deleteNodes(['a1'])
    expect(i.refuse).toHaveBeenCalledTimes(2)
  })

  it('a node of the stored copy that names its agent only by the legacy claude tag is still an agent', () => {
    const ctx = offCanvasNodeActionCtx(input([stored('a1', { tags: ['claude'] } as never)]))
    expect(ctx.agentIdOf('a1')).toBe('claude')
  })
})
