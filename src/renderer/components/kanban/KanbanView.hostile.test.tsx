// @vitest-environment jsdom
//
// A hand-edited or merged project.json can put anything in `meta[].assignees`. The board must still
// render — a throw here is a boot loop, because the board view choice persists in localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { useProjects } from '../../state/projects'
import { useAgentStatus } from '../../state/agentStatus'

vi.mock('../../session/session', async () => {
  // The agent-status reads now resolve a store per project / per session (bug D, covered in
  // session/agent-status-lookup.test.tsx). Here every one answers the default store, as before.
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ source: 'local', api: window.nodeTerminal }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})

let root: Root | null = null
let host: HTMLElement
const card = (id: string): KanbanSession =>
  ({ id, title: `Card ${id}`, color: '#fff', kind: 'terminal', spawn: {} }) as unknown as KanbanSession

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useProjects.setState({ activeProjectId: 'p-hostile' } as never)
  useAgentStatus.setState({ byId: {} } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(k: ProjectKanban): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() => root!.render(
    <KanbanView board={k} sessions={['n1', 'n2'].map(card)} onChange={noop} onOpenNode={noop}
      onCreateNode={noop} onRenameNode={noop} onEditSticky={noop} onDeleteNode={noop}
      onModalNodeChange={noop} onBrowserNav={noop} onSetIcon={noop} />
  ))
}

describe('KanbanView — hostile meta.assignees', () => {
  for (const bad of [5, {}, true, 'enes', [null, 3, { name: 7 }]]) {
    it(`renders with assignees=${JSON.stringify(bad)}, and the member filter still works`, () => {
      const k = {
        columns: [{ id: 'a', title: 'To Do', color: '#0a84ff' }],
        assignments: [{ nodeId: 'n1', columnId: 'a' }, { nodeId: 'n2', columnId: 'a' }],
        meta: [
          { nodeId: 'n1', assignees: bad, priority: 'high' },
          { nodeId: 'n2', assignees: [{ name: 'sam', color: '#ff453a' }] }
        ]
      } as unknown as ProjectKanban
      expect(() => mount(k)).not.toThrow()
      expect(document.querySelectorAll('.kanban-card--session')).toHaveLength(2)
      act(() => {
        document.querySelector('.kanban-filter-btn:not(.kanban-closed-toggle):not(.kanban-views-btn)')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const sam = [...document.querySelectorAll('.kanban-filter-row')].find((el) => el.textContent?.includes('sam'))!
      act(() => {
        sam.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(
        [...document.querySelectorAll('.kanban-card--session .kanban-card__title')].map((el) => el.textContent)
      ).toEqual(['Card n2'])
    })
  }
})
