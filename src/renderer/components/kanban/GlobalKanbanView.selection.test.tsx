// @vitest-environment jsdom
//
// Multi-select on the Omni (all-projects) board. Each lane is its own board, so:
//  - a selection lives in ONE lane — picking a card in another lane starts over there (cards of
//    two projects share no columns to be moved to together);
//  - the bulk Delete is delegated to Canvas like the single one, naming the lane's project and
//    every selected card in one event, so Canvas asks ONCE.
// The click rules and the per-project board's wiring are pinned in lib/cardSelection.test.ts and
// KanbanView.selection.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CanvasNodeState, Project } from '@shared/types'
import { GlobalKanbanView } from './GlobalKanbanView'
import { useProjects } from '../../state/projects'
import { useViewMode } from '../../state/viewMode'

vi.mock('../../session/session', async () => {
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ id: 'local', source: 'local', api: {} }),
    sessionForProject: () => ({ id: 'local', source: 'local', api: {} }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./CardModal', () => ({ CardModal: () => null }))

const note = (id: string): CanvasNodeState =>
  ({ id, kind: 'sticky', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: id, color: '#fff', group: null, text: id }) as CanvasNodeState
const project = (id: string, nodes: CanvasNodeState[]): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes }) as unknown as Project

let root: Root | null = null
let host: HTMLElement
const deletes: Array<{ projectId: string; nodeId?: string; nodeIds?: string[] }> = []
const onDelete = (e: Event): void => {
  deletes.push((e as CustomEvent).detail)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useViewMode.setState({ requestedCardNodeId: null } as never)
  // jsdom has no scrollIntoView, and a lane's header calls it when it collapses.
  Element.prototype.scrollIntoView = () => {}
  deletes.length = 0
  window.addEventListener('nodeterm:global-delete', onDelete)
  useProjects.setState({
    projects: [project('a', [note('a1'), note('a2'), note('a3')]), project('b', [note('b1'), note('b2')])],
    activeProjectId: 'a'
  } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GlobalKanbanView />))
})
afterEach(() => {
  window.removeEventListener('nodeterm:global-delete', onDelete)
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const cardEl = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-kanban-card="${id}"]`)!
const click = (id: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}): void =>
  act(() => {
    cardEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }))
  })
const selected = (): string[] =>
  [...document.querySelectorAll('.kanban-card--selected')].map((el) => el.getAttribute('data-kanban-card')!)
const bars = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.kanban-select-bar')]
const press = (el: Element, label: string): void => {
  const target = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!
  act(() => target.click())
}

describe('Omni board — multi-select', () => {
  it('selects within a lane and deletes the lot through ONE delegated event', () => {
    click('a3', { metaKey: true })
    click('a1')
    expect(selected()).toEqual(['a1', 'a3'])
    expect(bars()).toHaveLength(1)
    expect(bars()[0].textContent).toContain('2 cards selected')
    press(bars()[0], 'Delete')
    expect(deletes).toEqual([{ projectId: 'a', nodeIds: ['a1', 'a3'] }])
  })

  it('picking a card in another lane starts over there — one selection, one bar', () => {
    click('a1', { metaKey: true })
    click('a2')
    click('b1', { metaKey: true })
    expect(selected()).toEqual(['b1'])
    expect(bars()).toHaveLength(1)
    press(bars()[0], 'Delete')
    expect(deletes).toEqual([{ projectId: 'b', nodeIds: ['b1'] }])
    // …and back again.
    click('a3', { metaKey: true })
    expect(selected()).toEqual(['a3'])
  })

  it('Shift-click ranges stay inside the lane', () => {
    click('a1', { metaKey: true })
    click('a3', { shiftKey: true })
    expect(selected()).toEqual(['a1', 'a2', 'a3'])
  })

  it('collapsing a lane drops its selection — nothing out of sight stays selected', () => {
    click('a1', { metaKey: true })
    act(() => document.querySelector<HTMLElement>('#swimlane-a .kanban-swimlane__header')!.click())
    expect(bars()).toHaveLength(0)
    act(() => document.querySelector<HTMLElement>('#swimlane-a .kanban-swimlane__header')!.click())
    expect(selected()).toEqual([])
  })
})
