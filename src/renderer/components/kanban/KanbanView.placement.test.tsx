// @vitest-environment jsdom
//
// Where a moved card lands. An UNANCHORED move (the card menu's "Move to", the agent `assign` verb)
// goes to the TOP of the destination; a POSITIONAL drop keeps saying where it was dropped — below
// the last card, or on the column's empty space under its cards, is the BOTTOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { assignedTo } from '../../lib/kanban'

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
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Done', color: '#32d74b' }
  ],
  assignments: [
    { nodeId: 'n1', columnId: 'a' },
    { nodeId: 'n2', columnId: 'b' },
    { nodeId: 'n3', columnId: 'b' }
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
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(): ReturnType<typeof vi.fn> {
  const onChange = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() =>
    root.render(
      <KanbanView
        board={board()}
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
  )
  return onChange
}

/** A drag event jsdom will carry: the handlers read `dataTransfer.effectAllowed` and `clientY`. */
function dragEvent(type: string, clientY = 0): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { effectAllowed: 'move' } })
  Object.defineProperty(e, 'clientY', { value: clientY })
  return e
}

const cardEl = (id: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.kanban-card--session')].find((el) =>
    el.textContent?.includes(`Card ${id}`)
  )!

const columnEl = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.kanban-col')].find(
    (c) => c.querySelector('.kanban-col__title')?.textContent === title
  )!

describe('KanbanView — card placement', () => {
  it('a drop BELOW the last card lands at the bottom', () => {
    const onChange = render()
    act(() => {
      cardEl('n1').dispatchEvent(dragEvent('dragstart'))
    })
    // jsdom rects are all zero, so any positive clientY is the lower half ⇒ "after".
    act(() => {
      cardEl('n3').dispatchEvent(dragEvent('drop', 10))
    })
    expect(assignedTo(onChange.mock.calls[0][0], 'b')).toEqual(['n2', 'n3', 'n1'])
  })

  it('a drop on the column body (not on a card) lands at the bottom', () => {
    const onChange = render()
    act(() => {
      cardEl('n1').dispatchEvent(dragEvent('dragstart'))
    })
    act(() => {
      columnEl('Done').dispatchEvent(dragEvent('drop'))
    })
    expect(assignedTo(onChange.mock.calls[0][0], 'b')).toEqual(['n2', 'n3', 'n1'])
  })

  it('the card menu’s "Move to" is unanchored and lands at the TOP', () => {
    const onChange = render()
    act(() => {
      cardEl('n1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    })
    const moveTo = [...document.querySelectorAll('.ctx-item')].find((el) => el.textContent?.includes('Move to'))!
    act(() => {
      moveTo.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const done = [...document.querySelectorAll('.ctx-item')].find((el) => el.textContent === 'Done')!
    act(() => {
      done.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(assignedTo(onChange.mock.calls[0][0], 'b')).toEqual(['n1', 'n2', 'n3'])
  })
})
