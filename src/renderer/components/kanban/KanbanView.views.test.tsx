// @vitest-environment jsdom
//
// Saved views: the member + column filters a view can carry, saving the current filters as a
// SHARED view (project.kanban.views), applying one, and the per-user half — which view this person
// last applied lives in localStorage, and the live-state chips never enter a view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { useKanbanDisplay } from '../../state/kanbanDisplay'
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
const prompt = vi.hoisted(() => ({ answer: 'Mine' as string | null }))
vi.mock('../promptDialog', () => ({ promptDialog: vi.fn(async () => prompt.answer) }))

let root: Root | null = null
let host: HTMLElement
const card = (id: string): KanbanSession =>
  ({ id, title: `Card ${id}`, color: '#fff', kind: 'terminal', spawn: {} }) as unknown as KanbanSession
const ENES = { name: 'enes', color: '#0a84ff' }
const SAM = { name: 'sam', color: '#ff453a' }

const board = (extra: Partial<ProjectKanban> = {}): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Done', color: '#32d74b' }
  ],
  assignments: [
    { nodeId: 'n1', columnId: 'a' },
    { nodeId: 'n2', columnId: 'b' }
  ],
  meta: [
    { nodeId: 'n1', assignees: [ENES] },
    { nodeId: 'n2', assignees: [SAM] }
  ],
  ...extra
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  prompt.answer = 'Mine'
  useProjects.setState({ activeProjectId: 'p-views' } as never)
  useKanbanDisplay.setState({ byProject: {} })
  useAgentStatus.setState({ byId: { n1: { unread: false, state: 'working' } } } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  useAgentStatus.setState({ byId: {} } as never)
  vi.unstubAllGlobals()
})

function mount(k: ProjectKanban, onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn>; rerender: (b: ProjectKanban) => void } {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  const el = (b: ProjectKanban) => (
    <KanbanView
      board={b}
      sessions={['n1', 'n2', 'n3'].map(card)}
      onChange={onChange}
      onOpenNode={noop}
      onCreateNode={noop}
      onRenameNode={noop}
      onEditSticky={noop}
      onDeleteNode={noop}
      onModalNodeChange={noop}
      onBrowserNav={noop}
      onSetIcon={noop}
    />
  )
  act(() => root!.render(el(k)))
  return { onChange, rerender: (b) => act(() => root!.render(el(b))) }
}

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('missing element')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const visible = (): string[] =>
  [...document.querySelectorAll('.kanban-card--session .kanban-card__title')].map((el) => el.textContent ?? '')
const columnTitles = (): string[] =>
  [...document.querySelectorAll('.kanban-col')].map(
    (c) => c.querySelector('.kanban-col__title')?.textContent ?? ''
  )
const row = (sel: string, text: string): Element | undefined =>
  [...document.querySelectorAll(sel)].find((el) => el.textContent?.includes(text))
const openFilter = (): void => click(document.querySelector('.kanban-filter-btn:not(.kanban-closed-toggle)'))
const openViews = (): void => click(document.querySelector('.kanban-views-btn'))

describe('KanbanView — member and column filters', () => {
  it('a member filter shows only that person’s cards', () => {
    mount(board())
    openFilter()
    click(row('.kanban-filter-row', 'enes'))
    expect(visible()).toEqual(['Card n1'])
  })

  it('a column filter shows only the chosen columns (Ungrouped included)', () => {
    mount(board())
    openFilter()
    click(row('.kanban-filter-row', 'Done'))
    expect(columnTitles()).toEqual(['Done'])
    click(row('.kanban-filter-row', 'Ungrouped'))
    expect(columnTitles()).toEqual(['Ungrouped', 'Done'])
  })
})

describe('KanbanView — saved views', () => {
  it('saves the current filters as a SHARED view, and remembers it as this user’s active one', async () => {
    const { onChange } = mount(board())
    openFilter()
    click(row('.kanban-filter-row', 'enes'))
    openViews()
    await act(async () => {
      row('.ctx-item', 'Save current filters')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const next = onChange.mock.calls.at(-1)![0] as ProjectKanban
    expect(next.views).toEqual([{ id: expect.any(String), name: 'Mine', query: { assignees: ['enes'] } }])
    expect(useKanbanDisplay.getState().activeViewId('p-views')).toBe(next.views![0].id)
  })

  it('a view NEVER carries the live-state chips', async () => {
    const { onChange } = mount(board())
    click(row('.kanban-status-chip', 'Running'))
    openViews()
    await act(async () => {
      row('.ctx-item', 'Save current filters')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const next = onChange.mock.calls.at(-1)![0] as ProjectKanban
    expect(next.views?.[0].query).toEqual({})
    expect(JSON.stringify(next.views)).not.toMatch(/running|chip/i)
  })

  it('applying a view sets its filters and leaves the chips exactly as they were', () => {
    mount(board({ views: [{ id: 'v1', name: 'Done only', query: { columns: ['b'] } }] }))
    click(row('.kanban-status-chip', 'Running'))
    openViews()
    click(row('.ctx-item', 'Done only'))
    expect(columnTitles()).toEqual(['Done'])
    expect(useKanbanDisplay.getState().activeViewId('p-views')).toBe('v1')
    expect(document.querySelector('.kanban-status-chip--running.kanban-status-chip--on')).not.toBeNull()
  })

  it('a remount restores the view this user last applied', () => {
    useKanbanDisplay.getState().setActiveViewId('p-views', 'v1')
    mount(board({ views: [{ id: 'v1', name: 'Mine', query: { assignees: ['sam'] } }] }))
    expect(visible()).toEqual(['Card n2'])
    expect(document.querySelector('.kanban-views-btn')?.textContent).toContain('Mine')
  })

  it('a remembered view that no longer exists (a teammate deleted it) is ignored', () => {
    useKanbanDisplay.getState().setActiveViewId('p-views', 'gone')
    mount(board())
    expect(visible()).toEqual(['Card n3', 'Card n1', 'Card n2'])
  })

  it('marks the active view as modified when the filters drift, and can update it', () => {
    const { onChange } = mount(board({ views: [{ id: 'v1', name: 'Mine', query: { assignees: ['enes'] } }] }))
    openViews()
    click(row('.ctx-item', 'Mine'))
    openFilter()
    click(row('.kanban-filter-row', 'sam'))
    expect(document.querySelector('.kanban-views-btn')?.textContent).toContain('•')
    openViews()
    click(row('.ctx-item', 'Update'))
    const next = onChange.mock.calls.at(-1)![0] as ProjectKanban
    expect(next.views?.[0].query.assignees?.sort()).toEqual(['enes', 'sam'])
  })

  it('a view naming a column or label that no longer exists is not "modified" just for that', () => {
    useKanbanDisplay.getState().setActiveViewId('p-views', 'v1')
    mount(board({ views: [{ id: 'v1', name: 'Mine', query: { assignees: ['enes'], columns: ['gone'], labels: ['local:gone'] } }] }))
    expect(document.querySelector('.kanban-views-btn')?.textContent).toBe('View: Mine')
  })

  it('deleting a view asks first — views are shared with everyone on the board', () => {
    const { onChange } = mount(board({ views: [{ id: 'v1', name: 'Mine', query: {} }] }))
    openViews()
    click(row('.ctx-item', 'Mine'))
    openViews()
    click(row('.ctx-item', 'Delete'))
    expect(onChange).not.toHaveBeenCalled()
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete view'))
    const next = onChange.mock.calls.at(-1)![0] as ProjectKanban
    expect(next.views).toBeUndefined()
    expect(useKanbanDisplay.getState().activeViewId('p-views')).toBeUndefined()
  })
})
