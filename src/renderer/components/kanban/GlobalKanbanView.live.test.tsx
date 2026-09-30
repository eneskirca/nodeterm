// @vitest-environment jsdom
//
// The Omni overview's three contracts with the canvas underneath it:
//  1. the ACTIVE project's lane is the live canvas (GlobalKanbanLive), not the store copy that
//     lags it by an autosave — a store-fed lane reverted the sticky textarea on every keystroke;
//  2. the open card modal is ONE fact reported to Canvas (`onModalNodeChange`), so lanes without
//     a modal cannot clobber the lane that has one;
//  3. a lane's board write belongs to ITS project's session — refused for a hosted read-only role,
//     and logged on that session's api, never the active one's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import { GlobalKanbanView, type GlobalKanbanLive } from './GlobalKanbanView'
import type { KanbanSession } from './KanbanView'
import { useProjects } from '../../state/projects'
import { useViewMode } from '../../state/viewMode'
import { useBoardLog } from '../../state/boardLog'
import { useSettings } from '../../state/settings'
import { addColumn, defaultKanban } from '../../lib/kanban'

const localApi = { tag: 'local-api' }
const hostedApi = { tag: 'hosted-api' }
vi.mock('../../session/session', () => ({
  useSession: () => ({ id: 'local', source: 'local', api: localApi }),
  sessionForProject: (projectId: string) =>
    projectId === 'hosted'
      ? { id: 'hosted-session', source: 'relay', api: hostedApi }
      : projectId === 'relay'
        ? { id: 'relay-session', source: 'relay', api: hostedApi }
        : { id: 'local', source: 'local', api: localApi }
}))
vi.mock('../../state/hostedTeams', () => ({
  isHostedReadOnly: (sessionId: string) => sessionId === 'hosted-session'
}))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
// The modal itself is not under test — only what the overview hands it and hears back.
vi.mock('./CardModal', () => ({
  CardModal: (props: { session: KanbanSession; board: ProjectKanban; onChangeBoard: (b: ProjectKanban) => void; onClose: () => void }) => (
    <div data-testid="modal" data-node={props.session.id} data-title={props.session.title}>
      <button data-testid="add-col" onClick={() => props.onChangeBoard(addColumn(props.board, 'Added', '#fff'))} />
      <button
        data-testid="assign"
        onClick={() => props.onChangeBoard({ ...props.board, assignments: [{ nodeId: props.session.id, columnId: props.board.columns[0].id }] })}
      />
      <button data-testid="close" onClick={props.onClose} />
    </div>
  )
}))

let root: Root | null = null
let host: HTMLElement

const sticky = (id: string, text: string): CanvasNodeState => ({
  id, kind: 'sticky', position: { x: 0, y: 0 }, size: { width: 200, height: 200 },
  title: '', color: '#fff', group: null, text
} as CanvasNodeState)
const project = (id: string, nodes: CanvasNodeState[]): Project => ({
  id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes
} as unknown as Project)
const liveCard = (id: string, text: string): KanbanSession => ({
  id, title: text, color: '#fff', kind: 'sticky', text, spawn: {}
} as unknown as KanbanSession)

const appended: Array<{ api: unknown; projectId: string }> = []

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  appended.length = 0
  useBoardLog.setState({
    append: (api: unknown, projectId: string) => { appended.push({ api, projectId }) }
  } as never)
  useViewMode.setState({ requestedCardNodeId: null } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(projects: Project[], props: { live?: GlobalKanbanLive | null; onModalNodeChange?: (id: string | null) => void } = {}): void {
  useProjects.setState({ projects, activeProjectId: projects[0].id } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GlobalKanbanView {...props} />))
}
const openCard = (nodeId: string): void => {
  act(() => useViewMode.getState().requestCard(nodeId))
}
const modal = (): HTMLElement | null => document.querySelector('[data-testid="modal"]')
const click = (testId: string): void => {
  act(() => (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click())
}

describe('Omni overview — the active lane is the live canvas', () => {
  it('renders the live cards for the active project and the stored ones elsewhere', () => {
    mount(
      [project('p1', [sticky('a', 'stored text')]), project('p2', [sticky('b', 'other')])],
      { live: { projectId: 'p1', sessions: [liveCard('a', 'typed just now'), liveCard('fresh', 'created a moment ago')], teams: new Map() } }
    )
    const p1 = document.querySelector('#swimlane-p1')!
    expect(p1.querySelectorAll('.kanban-card--session').length).toBe(2)
    expect(p1.textContent).toContain('created a moment ago')
    expect(document.querySelector('#swimlane-p2')!.querySelectorAll('.kanban-card--session').length).toBe(1)
    openCard('a')
    // The modal edits what the canvas holds, not what the store held at the last autosave.
    expect(modal()?.dataset.title).toBe('typed just now')
  })

  it('a board write keeps the assignment of a live card the store has not seen yet', () => {
    const board = { ...defaultKanban('p1'), assignments: [] as ProjectKanban['assignments'] }
    const col = board.columns[0].id
    board.assignments = [{ nodeId: 'fresh', columnId: col }]
    const p1 = { ...project('p1', [sticky('a', 'x')]), kanban: board } as Project
    mount([p1], { live: { projectId: 'p1', sessions: [liveCard('a', 'x'), liveCard('fresh', 'new')], teams: new Map() } })
    openCard('a')
    click('add-col')
    const saved = useProjects.getState().getProject('p1')!.kanban!
    expect(saved.assignments).toContainEqual({ nodeId: 'fresh', columnId: col })
  })
})

describe('Omni overview — the open card modal is reported to the canvas', () => {
  it('reports the open card, is not clobbered by the other lanes, and clears on close and unmount', () => {
    const seen: Array<string | null> = []
    mount([project('p1', [sticky('a', 'one')]), project('p2', [sticky('b', 'two')])], { onModalNodeChange: (id) => seen.push(id) })
    openCard('b') // the SECOND lane — every lane before it used to report its own null after it
    expect(modal()?.dataset.node).toBe('b')
    expect(seen.at(-1)).toBe('b')
    click('close')
    expect(seen.at(-1)).toBeNull()
    openCard('a')
    expect(seen.at(-1)).toBe('a')
    act(() => root!.unmount())
    root = null
    expect(seen.at(-1)).toBeNull()
  })
})

describe("Omni overview — a lane's board belongs to its project's session", () => {
  it('refuses a board write on a hosted read-only project', () => {
    mount([project('p1', [sticky('a', 'x')]), project('hosted', [sticky('h', 'host')])])
    openCard('h')
    click('add-col')
    expect(useProjects.getState().getProject('hosted')!.kanban).toBeUndefined()
    expect(appended).toHaveLength(0)
  })

  it("logs a writable relay project's board change on that project's api", () => {
    mount([project('p1', [sticky('a', 'x')]), project('relay', [sticky('r', 'relay')])])
    openCard('r')
    click('assign') // a card move — the diff funnel logs it
    expect(useProjects.getState().getProject('relay')!.kanban!.assignments).toHaveLength(1)
    expect(appended.length).toBeGreaterThan(0)
    for (const entry of appended) expect(entry.api).toBe(hostedApi)
  })
})

describe('Omni header — the scope switch replaces the close button', () => {
  it('"This project" lands on the active project board, not the canvas', () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, omniKanbanEnabled: true } }))
    useViewMode.setState({ globalKanban: true, viewByProject: { p1: 'canvas' } } as never)
    mount([project('p1', [sticky('a', 'x')])])
    expect(document.querySelector('.kanban-header__close')).toBeNull()
    const thisProject = [...document.querySelectorAll('.kanban-scope-switch button')].find(
      (b) => b.textContent === 'This project'
    ) as HTMLElement
    act(() => thisProject.click())
    expect(useViewMode.getState().globalKanban).toBe(false)
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
  })
})
