// @vitest-environment jsdom
//
// The card modal keeps what the card leaves out, and carries the same team ring the card does.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { resetDialogStack } from '../dialog-stack'
import { useAgentStatus, type AgentNodeStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'
import type { TeamStation } from '../../lib/teamProgress'

vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { pty: {}, shell: { openExternal: vi.fn(async () => {}) } } })
}))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./ModalTerminal', () => ({ ModalTerminal: () => <div className="kanban-modal__term" /> }))
vi.mock('../../nodes/BrowserSurface', () => ({ BrowserSurface: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const status = (patch: Partial<AgentNodeStatus>): AgentNodeStatus => ({ unread: false, ...patch }) as AgentNodeStatus
const session: KanbanSession = {
  id: 'orch', title: 'Orchestrator', color: '#fff', kind: 'terminal', agentId: 'claude', spawn: {}
} as KanbanSession
const team: TeamStation[] = [
  { id: 'a', title: 'Station a', agentId: 'claude', queued: false },
  { id: 'b', title: 'Station b', agentId: 'claude', queued: true }
]
const board: ProjectKanban = {
  columns: [{ id: 'done', title: 'Done', color: '#32d74b', category: 'done' }],
  assignments: [{ nodeId: 'orch', columnId: 'done' }],
  meta: [{ nodeId: 'orch', dueAt: 1 }]
} as unknown as ProjectKanban

let host: HTMLDivElement
beforeEach(() => {
  resetDialogStack()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    onMarkdownToggle: () => () => {},
    boardLog: { list: async () => [], onChanged: () => () => {} }
  }
  useProjects.setState({ activeProjectId: 'p-modal' } as never)
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  resetDialogStack()
  document.body.innerHTML = ''
  useAgentStatus.setState({ byId: {} } as never)
  vi.unstubAllGlobals()
})

function mount(onTravel = vi.fn()): () => void {
  const root = createRoot(host)
  act(() =>
    root.render(
      <CardModal projectId="p1" session={session} columnTitle="Done" board={board} onChangeBoard={vi.fn()} onClose={vi.fn()}
        onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onSetIcon={vi.fn()}
        onBrowserNav={vi.fn()} team={team} onTravel={onTravel} />
    )
  )
  return () => act(() => root.unmount())
}

describe('CardModal — team progress and the facts the card leaves out', () => {
  it('carries the same ring as the card, and travels from its list', () => {
    useAgentStatus.setState({ byId: { a: status({ state: 'done' }) } } as never)
    const onTravel = vi.fn()
    const unmount = mount(onTravel)
    const chip = document.querySelector<HTMLButtonElement>('.kanban-modal__header .team-progress')!
    expect(chip.textContent).toBe('1/2')
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const rows = [...document.querySelectorAll<HTMLElement>('.ctx-menu .ctx-item')]
    expect(rows.map((r) => r.textContent)).toEqual(['Station a — done', 'Station b — queued'])
    act(() => rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onTravel).toHaveBeenCalledWith('b')
    unmount()
  })

  it('names the session when it is not the title, and stays quiet when it is', () => {
    useAgentStatus.setState({ byId: { orch: status({ session: 'Fan out the auth fix' }) } } as never)
    let unmount = mount()
    expect(document.querySelector('.kanban-modal__session')?.textContent).toBe('Fan out the auth fix')
    unmount()
    useAgentStatus.setState({ byId: { orch: status({ session: 'orchestrator' }) } } as never)
    unmount = mount()
    expect(document.querySelector('.kanban-modal__session')).toBeNull()
    unmount()
  })

  it('still says "Overdue" in a Done column — the card drops the alarm, the modal keeps the fact', () => {
    const unmount = mount()
    expect(
      [...document.querySelectorAll('.kanban-due--overdue')].map((el) => el.textContent)
    ).toContain('Overdue')
    unmount()
  })
})
