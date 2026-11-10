// @vitest-environment jsdom
//
// The board's multi-select: ⌘/Ctrl-click and Shift-click pick session cards, a floating bar (and
// the right-click menu of a selected card) acts on all of them at once — move, delete — and a drag
// of a selected card carries the selection. The click rules themselves are lib/cardSelection's
// (unit-tested there); this pins that the board wires them to the cards, the bar and the canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession, type KanbanViewProps } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { assignedTo } from '../../lib/kanban'
import { popDialog, pushDialog, resetDialogStack } from '../dialog-stack'

vi.mock('../../session/session', async () => {
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ source: 'local', api: window.nodeTerminal }),
    sessionForProject: () => ({ id: 'local', source: 'local', api: window.nodeTerminal }),
    SessionProvider: ({ children }: { children: unknown }) => children,
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})

vi.mock('./CardModal', () => ({
  CardModal: ({ session }: { session: { id: string } }) => {
    useEffect(() => {
      pushDialog('card-modal')
      return () => popDialog('card-modal')
    }, [])
    return <div className="kanban-modal" data-node-id={session.id} />
  }
}))

let root: Root
let host: HTMLElement
const card = (id: string): KanbanSession =>
  ({ id, title: `Card ${id}`, color: '#fff', kind: 'sticky', text: '', spawn: {} }) as unknown as KanbanSession

// Ungrouped: u1. To Do: a1 a2 a3. Done: b1.
const board = (): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Done', color: '#32d74b' }
  ],
  assignments: [
    { nodeId: 'a1', columnId: 'a' },
    { nodeId: 'a2', columnId: 'a' },
    { nodeId: 'a3', columnId: 'a' },
    { nodeId: 'b1', columnId: 'b' }
  ]
})
const ALL = ['u1', 'a1', 'a2', 'a3', 'b1']

const onChange = vi.fn<(next: ProjectKanban) => void>()
const onDeleteNode = vi.fn<(id: string) => void>()
const onDeleteNodes = vi.fn<(ids: string[]) => void>()

const render = (over: Partial<KanbanViewProps> = {}, ids: string[] = ALL): void => {
  const noop = (): void => {}
  act(() =>
    root.render(
      <KanbanView
        board={board()}
        sessions={ids.map(card)}
        onChange={onChange}
        onOpenNode={noop}
        onCreateNode={noop}
        onRenameNode={noop}
        onEditSticky={noop}
        onDeleteNode={onDeleteNode}
        onDeleteNodes={onDeleteNodes}
        onModalNodeChange={noop}
        onBrowserNav={noop}
        onSetIcon={noop}
        {...over}
      />
    )
  )
}

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
  resetDialogStack()
  onChange.mockClear()
  onDeleteNode.mockClear()
  onDeleteNodes.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  render()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  resetDialogStack()
  vi.unstubAllGlobals()
})

const cardEl = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-kanban-card="${id}"]`)!
const click = (id: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}): void =>
  act(() => {
    cardEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }))
  })
const rightClick = (id: string): void =>
  act(() => {
    cardEl(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  })
const selected = (): string[] =>
  [...document.querySelectorAll('.kanban-card--selected')].map((el) => el.getAttribute('data-kanban-card')!)
const bar = (): HTMLElement | null => document.querySelector('.kanban-select-bar')
const barCount = (): string | null => bar()?.querySelector('.kanban-select-bar__count')?.textContent ?? null
const modalCard = (): string | null =>
  document.querySelector('.kanban-modal')?.getAttribute('data-node-id') ?? null
const press = (el: Element, label: string): void => {
  const target = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!target) throw new Error(`no button "${label}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  act(() => target.click())
}
const menu = (): HTMLElement => document.querySelector<HTMLElement>('.ctx-menu')!
const menuLabels = (): string[] =>
  [...document.querySelectorAll('.ctx-menu .ctx-item')].map((el) => el.textContent?.trim() ?? '')
const escape = (target: EventTarget = window): void =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
const drag = (type: string, el: Element): void =>
  act(() => {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(ev, { dataTransfer: {}, clientY: 0 })
    el.dispatchEvent(ev)
  })
const column = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.kanban-col')].find(
    (el) => el.querySelector('.kanban-col__title')?.textContent === title
  )!

describe('KanbanView — multi-select', () => {
  it('a plain click with nothing selected still opens the card, and shows no bar', () => {
    click('a1')
    expect(modalCard()).toBe('a1')
    expect(selected()).toEqual([])
    expect(bar()).toBeNull()
  })

  it('⌘-click (or Ctrl-click) selects instead of opening, and the bar counts the selection', () => {
    click('a1', { metaKey: true })
    expect(modalCard()).toBeNull()
    expect(selected()).toEqual(['a1'])
    expect(barCount()).toBe('1 card selected')
    click('b1', { ctrlKey: true })
    expect(selected()).toEqual(['a1', 'b1'])
    expect(barCount()).toBe('2 cards selected')
    click('a1', { metaKey: true })
    expect(selected()).toEqual(['b1'])
  })

  it('while cards are selected a plain click keeps picking — it does not open a modal over them', () => {
    click('a1', { metaKey: true })
    click('a3')
    expect(modalCard()).toBeNull()
    expect(selected()).toEqual(['a1', 'a3'])
    click('a3')
    click('a1')
    // Back to nothing selected: the next plain click opens again.
    expect(bar()).toBeNull()
    click('a2')
    expect(modalCard()).toBe('a2')
  })

  it('Shift-click selects the whole span from the last picked card, across columns', () => {
    click('a1', { metaKey: true })
    click('b1', { shiftKey: true })
    expect(selected()).toEqual(['a1', 'a2', 'a3', 'b1'])
    expect(barCount()).toBe('4 cards selected')
  })

  it('Escape and the bar’s ✕ clear the selection', () => {
    click('a1', { metaKey: true })
    escape()
    expect(selected()).toEqual([])
    click('a1', { metaKey: true })
    act(() => bar()!.querySelector<HTMLElement>('.kanban-select-bar__clear')!.click())
    expect(selected()).toEqual([])
  })

  it('Escape is not the board’s while a dialog is up, or from inside a text field', () => {
    click('a1', { metaKey: true })
    pushDialog('some-dialog')
    escape()
    expect(selected()).toEqual(['a1'])
    popDialog('some-dialog')
    const input = document.createElement('input')
    document.body.appendChild(input)
    escape(input)
    expect(selected()).toEqual(['a1'])
  })

  it('the bar’s Delete asks the canvas ONCE, for every selected card in board order', () => {
    click('b1', { metaKey: true })
    click('a2')
    click('u1')
    press(bar()!, 'Delete')
    expect(onDeleteNodes).toHaveBeenCalledTimes(1)
    expect(onDeleteNodes).toHaveBeenCalledWith(['u1', 'a2', 'b1'])
    expect(onDeleteNode).not.toHaveBeenCalled()
  })

  it('a board with no bulk delete behind it still selects and moves, but offers no Delete', () => {
    render({ onDeleteNodes: undefined })
    click('a1', { metaKey: true })
    click('a2')
    expect(bar()!.textContent).not.toContain('Delete')
    rightClick('a1')
    expect(menuLabels().some((l) => l.startsWith('Delete'))).toBe(false)
  })

  it('the bar’s Move to… files the whole selection in the column, together and in board order', () => {
    click('a3', { metaKey: true })
    click('a1')
    press(bar()!, 'Move to…')
    // Ungrouped and Done; not "To Do", where every selected card already is.
    expect(menuLabels()).toEqual(['Ungrouped', 'Done'])
    press(menu(), 'Done')
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(assignedTo(next, 'b')).toEqual(['a1', 'a3', 'b1'])
    expect(assignedTo(next, 'a')).toEqual(['a2'])
  })

  it('right-click on a card INSIDE a multi-card selection acts on all of them', () => {
    click('a1', { metaKey: true })
    click('a2')
    rightClick('a2')
    expect(menu().querySelector('.ctx-label')?.textContent).toBe('2 cards selected')
    expect(menuLabels()).toEqual(['Move to', 'Clear selection', 'Delete 2 cards'])
    press(menu(), 'Delete 2 cards')
    expect(onDeleteNodes).toHaveBeenCalledWith(['a1', 'a2'])
  })

  it('right-click on a card OUTSIDE the selection is that card’s own menu, and keeps the selection', () => {
    click('a1', { metaKey: true })
    click('a2')
    rightClick('b1')
    expect(menuLabels()).toContain('Select')
    expect(menuLabels()).toContain('Delete')
    press(menu(), 'Delete')
    expect(onDeleteNode).toHaveBeenCalledWith('b1')
    expect(onDeleteNodes).not.toHaveBeenCalled()
    expect(selected()).toEqual(['a1', 'a2'])
  })

  it('the card menu’s Select row starts a selection without knowing the modifier-click', () => {
    rightClick('a2')
    press(menu(), 'Select')
    expect(selected()).toEqual(['a2'])
    rightClick('a2')
    expect(menuLabels()).toContain('Deselect')
  })

  it('dragging a selected card onto a column carries the whole selection', () => {
    click('a1', { metaKey: true })
    click('u1')
    drag('dragstart', cardEl('a1'))
    drag('drop', column('Done'))
    const next = onChange.mock.calls.at(-1)![0]
    expect(assignedTo(next, 'b')).toEqual(['b1', 'u1', 'a1'])
  })

  it('dragging an UNSELECTED card moves only that card', () => {
    click('a1', { metaKey: true })
    click('a2')
    drag('dragstart', cardEl('a3'))
    drag('drop', column('Done'))
    const next = onChange.mock.calls.at(-1)![0]
    expect(assignedTo(next, 'b')).toEqual(['b1', 'a3'])
    expect(assignedTo(next, 'a')).toEqual(['a1', 'a2'])
  })

  it('a selected card that leaves the board (deleted) leaves the selection', () => {
    click('a1', { metaKey: true })
    click('a2')
    render({}, ['u1', 'a2', 'a3', 'b1'])
    expect(selected()).toEqual(['a2'])
    expect(barCount()).toBe('1 card selected')
    render({}, ['u1', 'a3', 'b1'])
    expect(bar()).toBeNull()
  })

  it('a card that left the board does not come back selected (no ghost selection)', () => {
    click('a1', { metaKey: true })
    click('a2')
    render({}, ['u1', 'a2', 'a3', 'b1'])
    render()
    expect(selected()).toEqual(['a2'])
  })
})
