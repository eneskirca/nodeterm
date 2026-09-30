// @vitest-environment jsdom
//
// Team progress on an orchestrator's board card, and the card leaving out what its place on the
// board (or its own title) already says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { useProjects } from '../../state/projects'
import { useAgentStatus, type AgentNodeStatus } from '../../state/agentStatus'
import { stationsByOpener, type StationNodeLike } from '../../lib/teamProgress'
import { waitRopeId } from '../../lib/edgeModel'

vi.mock('../../session/session', () => ({
  useSession: () => ({ source: 'local', api: window.nodeTerminal })
}))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

let root: Root | null = null
let host: HTMLElement
const card = (id: string, title = `Card ${id}`): KanbanSession =>
  ({ id, title, color: '#fff', kind: 'terminal', agentId: 'claude', spawn: {} }) as unknown as KanbanSession
const term = (id: string, extra: Partial<StationNodeLike> = {}): StationNodeLike =>
  ({ id, kind: 'terminal', title: `Station ${id}`, agentId: 'claude', ...extra })
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const status = (patch: Partial<AgentNodeStatus>): AgentNodeStatus => ({ unread: false, ...patch }) as AgentNodeStatus

const board = (): ProjectKanban => ({
  columns: [
    { id: 'doing', title: 'In Progress', color: '#ffd60a', category: 'started' },
    { id: 'done', title: 'Done', color: '#32d74b', category: 'done' }
  ],
  assignments: [
    { nodeId: 'orch', columnId: 'doing' },
    { nodeId: 'late-doing', columnId: 'doing' },
    { nodeId: 'late-done', columnId: 'done' }
  ],
  meta: [
    { nodeId: 'late-doing', dueAt: 1 },
    { nodeId: 'late-done', dueAt: 1 }
  ]
} as unknown as ProjectKanban)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useProjects.setState({ activeProjectId: 'p-team' } as never)
  useAgentStatus.setState({ byId: {} } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(opts: { onOpenNode?: (id: string) => void } = {}): void {
  // orch opened a, b, c, d, gone and a plain terminal; d also waits on a (an `--after` rope, minted
  // with its wait id, which must not make `a` a team leader); `gone` was deleted.
  const nodes = [term('orch'), term('a'), term('b'), term('c'), term('d'), term('plain', { agentId: undefined })]
  const teams = stationsByOpener(
    [rope('orch', 'a'), rope('orch', 'b'), rope('orch', 'c'), rope('orch', 'd'),
      { id: waitRopeId('a', 'd'), source: 'a', target: 'd' }, rope('orch', 'gone'), rope('orch', 'plain')],
    nodes
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  const sessions = [card('orch', 'Orchestrator'), card('a'), card('late-doing'), card('late-done')]
  act(() => root!.render(
    <KanbanView board={board()} sessions={sessions} onChange={noop} onOpenNode={opts.onOpenNode ?? noop}
      onCreateNode={noop} onRenameNode={noop} onEditSticky={noop} onDeleteNode={noop}
      onModalNodeChange={noop} onBrowserNav={noop} onSetIcon={noop} teams={teams} />
  ))
}

const cardEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-kanban-card="${id}"]`)!
const chipOf = (id: string): HTMLButtonElement | null => cardEl(id).querySelector<HTMLButtonElement>('.team-progress')

describe('team progress on the orchestrator card', () => {
  it('counts each station by its hook state; unknown is not done, a deleted or plain station is not in M', () => {
    useAgentStatus.setState({
      byId: {
        a: status({ state: 'done' }),
        b: status({ state: 'working' }),
        c: status({ state: 'blocked' })
        // d: no status yet — unknown
      }
    } as never)
    mount()
    const chip = chipOf('orch')!
    expect(chip.textContent).toBe('1/4')
    expect(chip.dataset.done).toBe('1')
    expect(chip.dataset.total).toBe('4')
    expect(chip.getAttribute('aria-label')).toBe(
      'Team progress: 1 of 4 done — 1 needs you, 1 working, 1 unknown (+1 without status)'
    )
    expect(chip.className).toContain('team-progress--needs')
    // `a` opened nothing — its `--after` rope into d is a wait, not a team.
    expect(chipOf('a')).toBeNull()
  })

  it('follows the store: a station finishing moves the count', () => {
    useAgentStatus.setState({ byId: { a: status({ state: 'working' }) } } as never)
    mount()
    expect(chipOf('orch')!.textContent).toBe('0/4')
    act(() => useAgentStatus.setState({ byId: { a: status({ state: 'done' }) } } as never))
    expect(chipOf('orch')!.textContent).toBe('1/4')
  })

  it('lists the stations and travels to the one picked, without opening the card', () => {
    useAgentStatus.setState({ byId: { a: status({ state: 'done', lastTurnError: { at: 1 } }) } } as never)
    const onOpenNode = vi.fn()
    mount({ onOpenNode })
    act(() => chipOf('orch')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const rows = [...document.querySelectorAll<HTMLElement>('.ctx-menu .ctx-item')]
    expect(rows.map((r) => r.textContent)).toEqual([
      'Station a — last turn failed',
      'Station b — unknown',
      'Station c — unknown',
      'Station d — unknown',
      'Station plain — no status'
    ])
    expect(document.querySelector('.ctx-menu .ctx-label')?.textContent).toBe(
      '0 of 4 done — 1 last turn failed, 3 unknown (+1 without status)'
    )
    act(() => rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenNode).toHaveBeenCalledWith('b')
    // The pick did not bubble to the card and open its modal.
    expect(document.querySelector('.kanban-modal')).toBeNull()
  })
})

describe('the card does not repeat what its place already says', () => {
  it('hides the session-name chip when it is the title, keeps it when it says more', () => {
    useAgentStatus.setState({
      byId: {
        orch: status({ session: '  orchestrator ', sessionId: 's1' }),
        a: status({ session: 'Refactor auth', sessionId: 's2' })
      }
    } as never)
    mount()
    expect(cardEl('orch').querySelector('.kanban-card__session')).toBeNull()
    expect(cardEl('a').querySelector('.kanban-card__session')?.textContent).toBe('Refactor auth')
  })

  it('no overdue alarm on a card the Done column already settled; the date stays', () => {
    mount()
    const doing = cardEl('late-doing').querySelector('.kanban-due')!
    const done = cardEl('late-done').querySelector('.kanban-due')!
    expect(doing.classList.contains('kanban-due--overdue')).toBe(true)
    expect(done.classList.contains('kanban-due--overdue')).toBe(false)
    expect(done.textContent).not.toBe('')
  })
})
