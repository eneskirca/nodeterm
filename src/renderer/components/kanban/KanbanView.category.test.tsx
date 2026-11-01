// @vitest-environment jsdom
//
// Column lifecycle categories on the board: the progress readout, hiding `closed` columns behind a
// per-user toggle, and the rule that a category is never changed SILENTLY under cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { useKanbanDisplay } from '../../state/kanbanDisplay'
import { useProjects } from '../../state/projects'

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

let root: Root
let host: HTMLElement
const card = (id: string): KanbanSession =>
  ({ id, title: `Card ${id}`, color: '#fff', kind: 'terminal', spawn: {} }) as unknown as KanbanSession

const board = (): ProjectKanban => ({
  columns: [
    { id: 'todo', title: 'To Do', color: '#0a84ff', category: 'unstarted' },
    { id: 'review', title: 'Review', color: '#ffd60a', category: 'started' },
    { id: 'done', title: 'Done', color: '#32d74b', category: 'done' },
    { id: 'wontfix', title: "Won't fix", color: '#8e8e93', category: 'closed' },
    { id: 'empty', title: 'Empty', color: '#bf5af2' }
  ],
  assignments: [
    { nodeId: 'a', columnId: 'todo' },
    { nodeId: 'b', columnId: 'review' },
    { nodeId: 'c', columnId: 'done' },
    { nodeId: 'd', columnId: 'wontfix' }
  ]
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
  useProjects.setState({ activeProjectId: 'p-cat' } as never)
  useKanbanDisplay.setState({ byProject: {} })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(k: ProjectKanban, onChange = vi.fn(), sessions = ['a', 'b', 'c', 'd', 'e'].map(card)) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  const el = (b: ProjectKanban) => (
    <KanbanView
      board={b}
      sessions={sessions}
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
  act(() => root.render(el(k)))
  return { onChange, rerender: (b: ProjectKanban) => act(() => root.render(el(b))) }
}

const columnTitles = (): string[] =>
  [...document.querySelectorAll('.kanban-col__title')].map((el) => el.textContent ?? '')

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('missing element')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function openColumnMenu(title: string): void {
  const col = [...document.querySelectorAll('.kanban-col')].find(
    (c) => c.querySelector('.kanban-col__title')?.textContent === title
  )
  click(col?.querySelector('.kanban-col__menu'))
}

const menuRow = (label: string): Element | undefined =>
  [...document.querySelectorAll('.ctx-item')].find((el) => el.textContent?.includes(label))

describe('KanbanView — lifecycle progress', () => {
  it('reads done+closed over every live card, Ungrouped included', () => {
    render(board())
    // c (done) + d (closed) of a,b,c,d,e (e is Ungrouped).
    expect(document.querySelector('.kanban-progress')?.textContent).toContain('2/5')
  })

  it('shows nothing when no column says what "complete" means', () => {
    const k = { ...board(), columns: board().columns.map(({ category: _c, ...c }) => c) }
    render(k)
    expect(document.querySelector('.kanban-progress')).toBeNull()
  })
})

describe('KanbanView — closed columns', () => {
  it('are hidden by default, behind a toggle that names how many', () => {
    render(board())
    expect(columnTitles()).not.toContain("Won't fix")
    const toggle = document.querySelector('.kanban-closed-toggle')
    expect(toggle?.textContent).toContain('1')
    click(toggle)
    expect(columnTitles()).toContain("Won't fix")
  })

  it('the choice is this user’s (localStorage), never a board edit', () => {
    const { onChange } = render(board())
    click(document.querySelector('.kanban-closed-toggle'))
    expect(onChange).not.toHaveBeenCalled()
    expect(useKanbanDisplay.getState().showClosed('p-cat')).toBe(true)
  })

  it('offers no toggle on a board with no closed column', () => {
    render({ ...board(), columns: board().columns.filter((c) => c.category !== 'closed') })
    expect(document.querySelector('.kanban-closed-toggle')).toBeNull()
  })
})

describe('KanbanView — changing a category', () => {
  it('an EMPTY column changes immediately', () => {
    const { onChange } = render(board())
    openColumnMenu('Empty')
    click(menuRow('Done'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as ProjectKanban
    expect(next.columns.find((c) => c.id === 'empty')?.category).toBe('done')
  })

  it('a column WITH cards asks first, naming the count — never silently re-means its cards', () => {
    const { onChange } = render(board())
    openColumnMenu('Review')
    click(menuRow('Done'))
    expect(onChange).not.toHaveBeenCalled()
    const dialog = document.querySelector('.confirm')
    expect(dialog?.textContent).toContain('1 card')
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Change category'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as ProjectKanban
    expect(next.columns.find((c) => c.id === 'review')?.category).toBe('done')
  })

  it('cancelling the confirmation changes nothing', () => {
    const { onChange } = render(board())
    openColumnMenu('Review')
    click(menuRow('Closed'))
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the Ungrouped column has no category menu (it is virtual)', () => {
    render(board())
    const ungrouped = document.querySelector('.kanban-col--ungrouped')
    expect(ungrouped?.querySelector('.kanban-col__menu')).toBeNull()
  })

  it('a column already titled as its category ("Done" / done) shows no redundant marker', () => {
    render(board())
    const done = [...document.querySelectorAll('.kanban-col')].find(
      (c) => c.querySelector('.kanban-col__title')?.textContent === 'Done'
    )
    expect(done?.querySelector('.kanban-col__category')).toBeNull()
  })

  it('a categorized column shows its category in the header', () => {
    render(board())
    const review = [...document.querySelectorAll('.kanban-col')].find(
      (c) => c.querySelector('.kanban-col__title')?.textContent === 'Review'
    )
    expect(review?.querySelector('.kanban-col__category')?.textContent).toBe('Started')
  })
})
