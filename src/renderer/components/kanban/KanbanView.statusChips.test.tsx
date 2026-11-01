// @vitest-environment jsdom
//
// The transient Running / Needs you / Unread chips: derived from the agent-status store, OR'd
// together, and NEVER persisted — a filter on second-by-second state that survived a restart would
// show a wrong board before anyone had looked at it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
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

const board = (): ProjectKanban => ({
  columns: [{ id: 'col', title: 'Work', color: '#0a84ff' }],
  assignments: [
    { nodeId: 'a', columnId: 'col' },
    { nodeId: 'b', columnId: 'col' },
    { nodeId: 'c', columnId: 'col' }
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
  useAgentStatus.setState({
    byId: {
      a: { unread: false, state: 'working' },
      b: { unread: true, state: 'waiting' }
    }
  } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  useAgentStatus.setState({ byId: {} } as never)
  vi.unstubAllGlobals()
})

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() =>
    root!.render(
      <KanbanView
        board={board()}
        sessions={['a', 'b', 'c'].map(card)}
        onChange={noop}
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
}

const visible = (): string[] =>
  [...document.querySelectorAll('.kanban-card--session .kanban-card__title')].map((el) => el.textContent ?? '')

const chip = (label: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.kanban-status-chip')].find((el) =>
    el.textContent?.startsWith(label)
  )!

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const storageSnapshot = (): Record<string, string | null> => {
  const out: Record<string, string | null> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    out[k] = localStorage.getItem(k)
  }
  return out
}

describe('KanbanView — status chips', () => {
  it('shows a count per chip, derived from the agent-status store', () => {
    mount()
    expect(chip('Running').textContent).toContain('1')
    expect(chip('Needs you').textContent).toContain('1')
    expect(chip('Unread').textContent).toContain('1')
  })

  it('one chip narrows the board; two are an OR', () => {
    mount()
    click(chip('Running'))
    expect(visible()).toEqual(['Card a'])
    click(chip('Unread'))
    expect(visible()).toEqual(['Card a', 'Card b'])
  })

  it('follows the store live (a card that stops running leaves the Running view)', () => {
    mount()
    click(chip('Running'))
    act(() => useAgentStatus.setState({ byId: { a: { unread: false, state: 'done' } } } as never))
    expect(visible()).toEqual([])
  })

  it('is never persisted: no storage write, and a remount starts unfiltered', () => {
    mount()
    const before = storageSnapshot()
    click(chip('Running'))
    click(chip('Needs you'))
    expect(storageSnapshot()).toEqual(before)
    act(() => root!.unmount())
    root = null
    host.remove()
    mount()
    expect(visible()).toEqual(['Card a', 'Card b', 'Card c'])
    expect(document.querySelector('.kanban-status-chip--on')).toBeNull()
  })
})
