// @vitest-environment jsdom
//
// The card modal lists the node's subagents (type · task · state). A row closes the modal, leaves
// the board for the card's own project's canvas, and asks the canvas to open that subagent's card —
// in that order, so the canvas's travel sees the canvas view, not the board. The conversation is
// never rendered a second time inside the board.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'

// jsdom draws nothing, and prints "Not implemented" each time the modal's imports ask a canvas for a
// context while they load (CardModal.quoteEscape.test.tsx): answer as a page without canvas would.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
})
import { resetDialogStack } from '../dialog-stack'
import { useProjects } from '../../state/projects'
import { useAgentNodes } from '../../state/agentNodes'
import { useViewMode, viewFor } from '../../state/viewMode'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

vi.mock('../../session/session', async () => {
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ api: { pty: {}, shell: { openExternal: vi.fn(async () => {}) } } }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./ModalTerminal', () => ({ ModalTerminal: () => <div className="kanban-modal__term" /> }))
vi.mock('../../nodes/BrowserSurface', () => ({ BrowserSurface: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const terminal: KanbanSession = { id: 'orch', title: 'Orchestrator', color: '#fff', kind: 'terminal', agentId: 'claude', spawn: {} } as KanbanSession
const board: ProjectKanban = { columns: [{ id: 'c', title: 'To Do', color: '#3b82f6' }], assignments: [] }

let host: HTMLDivElement
let opened: unknown[]
let order: string[]
const onOpen = (e: Event): void => {
  order.push(`event:${viewFor(useViewMode.getState(), 'p-lane')}`)
  opened.push((e as CustomEvent).detail)
}
beforeEach(() => {
  resetDialogStack()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    onMarkdownToggle: () => () => {},
    boardLog: { list: async () => [], onChanged: () => () => {} }
  }
  useProjects.setState({ activeProjectId: 'p-active' } as never)
  useViewMode.getState().setView('p-lane', 'kanban')
  opened = []
  order = []
  window.addEventListener('nodeterm:open-subagent', onOpen)
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  window.removeEventListener('nodeterm:open-subagent', onOpen)
  resetDialogStack()
  document.body.innerHTML = ''
  useAgentNodes.getState().clearForParent('orch')
  vi.unstubAllGlobals()
})

function mount(session: KanbanSession, onClose = vi.fn()): () => void {
  const root = createRoot(host)
  act(() =>
    root.render(
      <CardModal projectId="p-lane" session={session} columnTitle={null} board={board} onChangeBoard={vi.fn()} onClose={onClose}
        onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onSetIcon={vi.fn()} onBrowserNav={vi.fn()} />
    )
  )
  return () => act(() => root.unmount())
}

describe('CardModal — the subagent list', () => {
  it('lists the subagents; a row closes the modal, shows the canvas of the CARD\'s project, then opens the card', () => {
    useAgentNodes.getState().start('a089017271138740d', { parentNodeId: 'orch', type: 'Explore', label: 'Map the repo', startedAt: 1 })
    useAgentNodes.getState().start('a2', { parentNodeId: 'orch', type: 'Plan', label: 'Plan it', startedAt: 2 })
    useAgentNodes.getState().finish('a2', {})
    const onClose = vi.fn(() => order.push('close'))
    const unmount = mount(terminal, onClose)
    const list = document.body.querySelector('.kanban-modal .card-subagents')!
    expect(list).not.toBeNull()
    const rows = [...list.querySelectorAll<HTMLButtonElement>('.subagent-row')]
    expect(rows.map((r) => r.textContent)).toEqual(['Explore·Map the repoworking', 'Plan·Plan itdone'])
    // Not a second conversation inside the board.
    expect(list.querySelector('.term-chat')).toBeNull()

    act(() => rows[0].click())
    expect(onClose).toHaveBeenCalledTimes(1)
    // The board was left for p-lane's canvas BEFORE the canvas was asked (the travel reads it).
    expect(order).toEqual(['close', 'event:canvas'])
    expect(opened).toEqual([{ parentNodeId: 'orch', cardId: 'a089017271138740d' }])
    unmount()
  })

  it('shows no list while the node has no subagent cards', () => {
    const unmount = mount(terminal)
    expect(document.body.querySelector('.card-subagents')).toBeNull()
    unmount()
  })

  it('a note card has no list, whatever the store holds under its id', () => {
    useAgentNodes.getState().start('a', { parentNodeId: 'orch', type: 'Explore' })
    const unmount = mount({ id: 'orch', title: 'Note', color: '#fff', kind: 'sticky', text: 'x', spawn: {} })
    expect(document.body.querySelector('.card-subagents')).toBeNull()
    unmount()
  })
})
