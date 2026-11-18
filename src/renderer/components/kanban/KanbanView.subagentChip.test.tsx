// @vitest-environment jsdom
//
// The per-project board draws a session card's subagent chip from THIS machine's card store, so a
// relay / team project's cards draw none: their node ids are the host's (after Share with team the
// handed-off SSH project holds the same ids), and the count would describe another project.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { useProjects } from '../../state/projects'
import { useAgentStatus } from '../../state/agentStatus'
import { useAgentNodes } from '../../state/agentNodes'

vi.mock('../../session/session', async () => {
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ source: 'local', api: window.nodeTerminal }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

let root: Root | null = null
let host: HTMLElement
const card: KanbanSession = { id: 'n1', title: 'Claude', color: '#fff', kind: 'terminal', agentId: 'claude', spawn: {} }
const board = { columns: [{ id: 'doing', title: 'In Progress', color: '#ffd60a' }], assignments: [] } as unknown as ProjectKanban

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useAgentStatus.setState({ byId: {} } as never)
  useAgentNodes.getState().start('a', { parentNodeId: 'n1', type: 'Explore' })
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  useAgentNodes.getState().clearForParent('n1')
  vi.unstubAllGlobals()
})

function mount(remote: boolean): void {
  useProjects.setState({ activeProjectId: 'p', projects: [{ id: 'p', name: 'P', nodes: [], ...(remote ? { remote: true } : {}) }] } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() => root!.render(
    <KanbanView board={board} sessions={[card]} onChange={noop} onOpenNode={noop} onCreateNode={noop}
      onRenameNode={noop} onEditSticky={noop} onDeleteNode={noop} onModalNodeChange={noop}
      onBrowserNav={noop} onSetIcon={noop} />
  ))
}

const chip = (): Element | null => document.querySelector('[data-kanban-card="n1"] .kanban-subagent-chip')

describe('KanbanView — the subagent chip and the project it is on', () => {
  it("a local project's card counts its node's subagent cards", () => {
    mount(false)
    expect(chip()?.textContent).toBe('1 subagent · 1 working')
  })

  it("a relay / team project's card shows no chip, though the store holds a card for that node id", () => {
    mount(true)
    expect(document.querySelector('[data-kanban-card="n1"]')).not.toBeNull()
    expect(chip()).toBeNull()
  })
})
