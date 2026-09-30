// @vitest-environment jsdom
//
// The Omni overview reads each lane's team straight out of the project in the store — `ropes`
// included, which is git-shared, hand-editable input. Whatever it holds, the overview renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CanvasNodeState, Project } from '@shared/types'
import { GlobalKanbanView } from './GlobalKanbanView'
import { useProjects } from '../../state/projects'
import { useAgentStatus, type AgentNodeStatus } from '../../state/agentStatus'

vi.mock('../../session/session', () => ({
  useSession: () => ({ source: 'local', api: window.nodeTerminal }),
  sessionForProject: () => ({ id: 'local', source: 'local', api: window.nodeTerminal })
}))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

let root: Root | null = null
let host: HTMLElement

const term = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
  title: `Station ${id}`, color: '#fff', group: null, agentId: 'claude', ...over
})
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const project = (id: string, ropes: unknown): Project => ({
  id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [term('orch', { title: 'Orchestrator' }), term('a'), term('b')],
  ropes
} as unknown as Project)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useAgentStatus.setState({
    byId: { a: { unread: false, state: 'done' } as AgentNodeStatus }
  } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(projects: Project[]): void {
  useProjects.setState({ projects, activeProjectId: projects[0].id } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GlobalKanbanView />))
}

const orchChip = (laneId: string): HTMLElement | null =>
  document.querySelector(`#swimlane-${laneId} [data-kanban-card="orch"] .team-progress`)

describe('Omni overview — team progress from the stored ropes', () => {
  it("shows each lane's orchestrator its own team", () => {
    mount([project('p1', [rope('orch', 'a'), rope('orch', 'b')])])
    expect(orchChip('p1')?.textContent).toBe('1/2')
  })

  for (const [name, ropes] of [
    ['a string', 'ropes'],
    ['an object', { 0: rope('orch', 'a'), length: 1 }],
    ['null entries and wrong types', [null, 5, 'x', [], { source: {}, target: 'a' }, { source: 'orch', target: 7 }]],
    ['self and cyclic ropes', [rope('orch', 'orch'), rope('a', 'b'), rope('b', 'a')]]
  ] as const) {
    it(`renders with hostile ropes (${name})`, () => {
      expect(() => mount([project('p1', ropes), project('p2', [rope('orch', 'a')])])).not.toThrow()
      expect(document.querySelectorAll('#swimlane-p1 .kanban-card--session').length).toBe(3)
      expect(orchChip('p1')).toBeNull()
      // A hostile lane does not take the healthy one with it.
      expect(orchChip('p2')?.textContent).toBe('1/1')
    })
  }
})
