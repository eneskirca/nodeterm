// @vitest-environment jsdom
//
// The board's keyboard: J/K (and arrows) walk the cards in board order, Space opens the focused
// card, and inside the card modal J/K step to the neighbouring card. Every action DECLINES — falls
// through to the platform — when the focused control uses the key itself or a dialog sits on top.
// (The typing / terminal refusals are the registry's, pinned in shared/keybindings.test.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import type { ProjectKanban } from '@shared/types'
import { runBoardKey } from '../../lib/boardKeys'
import { popDialog, pushDialog, resetDialogStack } from '../dialog-stack'

vi.mock('../../session/session', async () => {
  // The agent-status reads now resolve a store per project / per session (bug D, covered in
  // session/agent-status-lookup.test.tsx). Here every one answers the default store, as before.
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ source: 'local', api: window.nodeTerminal }),
    // The card modal's `ProjectSessionScope` asks for the card project's session and provides it.
    sessionForProject: () => ({ id: 'local', source: 'local', api: window.nodeTerminal }),
    SessionProvider: ({ children }: { children: unknown }) => children,
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})

// The real modal is exercised by CardModal.test; here it only has to be a dialog on the stack that
// names its card and can close.
vi.mock('./CardModal', () => ({
  CardModal: ({ session, onClose }: { session: { id: string }; onClose: () => void }) => {
    useEffect(() => {
      pushDialog('card-modal')
      return () => popDialog('card-modal')
    }, [])
    return (
      <div className="kanban-modal" data-node-id={session.id}>
        <button className="modal-close" onClick={onClose}>close</button>
        <select className="modal-select"><option>low</option><option>high</option></select>
      </div>
    )
  }
}))

let root: Root
let host: HTMLElement
const card = (id: string): KanbanSession =>
  ({ id, title: `Card ${id}`, color: '#fff', kind: 'sticky', text: '', spawn: {} }) as unknown as KanbanSession

// Ungrouped: u1. To Do: a1 a2. Done: b1.
const board = (): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Done', color: '#32d74b' }
  ],
  assignments: [
    { nodeId: 'a1', columnId: 'a' },
    { nodeId: 'a2', columnId: 'a' },
    { nodeId: 'b1', columnId: 'b' }
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
  resetDialogStack()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() =>
    root.render(
      <KanbanView
        board={board()}
        sessions={['u1', 'a1', 'a2', 'b1'].map(card)}
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
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  resetDialogStack()
  vi.unstubAllGlobals()
})

const focused = (): string | null =>
  (document.activeElement as HTMLElement | null)?.getAttribute('data-kanban-card') ?? null
const modalCard = (): string | null =>
  document.querySelector('.kanban-modal')?.getAttribute('data-node-id') ?? null
const press = (action: Parameters<typeof runBoardKey>[0]): boolean => {
  let claimed = false
  act(() => {
    claimed = runBoardKey(action)
  })
  return claimed
}
const cardEl = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-kanban-card="${id}"]`)!

describe('KanbanView — board keyboard', () => {
  it('J from nowhere focuses the first card; J/K then walk board order (column by column)', () => {
    expect(press('next')).toBe(true)
    expect(focused()).toBe('u1')
    press('next')
    expect(focused()).toBe('a1')
    press('next')
    press('next')
    expect(focused()).toBe('b1')
    expect(press('next')).toBe(false) // the end: nothing to move to, the key falls through
    press('prev')
    expect(focused()).toBe('a2')
  })

  it('K from nowhere focuses the LAST card', () => {
    press('prev')
    expect(focused()).toBe('b1')
  })

  it('left/right jump to the same row of the neighbouring column', () => {
    act(() => cardEl('a2').focus())
    press('right')
    expect(focused()).toBe('b1')
    press('left')
    expect(focused()).toBe('a1')
    press('left')
    expect(focused()).toBe('u1')
    expect(press('left')).toBe(false)
  })

  it('left/right with no card focused decline (the arrow keeps its native meaning)', () => {
    expect(press('right')).toBe(false)
  })

  it('Space opens the focused card', () => {
    act(() => cardEl('a1').focus())
    expect(press('open')).toBe(true)
    expect(modalCard()).toBe('a1')
  })

  it('Space with no card to open declines', () => {
    expect(press('open')).toBe(false)
    expect(modalCard()).toBeNull()
  })

  it('Space on a focused BUTTON is the button’s — the board declines', () => {
    const btn = document.querySelector<HTMLButtonElement>('.kanban-add-col')!
    act(() => btn.focus())
    expect(press('open')).toBe(false)
    expect(modalCard()).toBeNull()
  })

  it('inside the card modal, J/K step to the neighbouring card', () => {
    act(() => cardEl('a1').focus())
    press('open')
    expect(press('next')).toBe(true)
    expect(modalCard()).toBe('a2')
    press('prev')
    press('prev')
    expect(modalCard()).toBe('u1')
    expect(press('prev')).toBe(false)
    // Space and the column jumps are not the modal's: its focused controls keep them.
    expect(press('open')).toBe(false)
    expect(press('right')).toBe(false)
  })

  it('inside the modal, a focused <select> keeps its arrows and letters — no card step', () => {
    act(() => cardEl('a1').focus())
    press('open')
    act(() => document.querySelector<HTMLSelectElement>('.modal-select')!.focus())
    expect(press('next')).toBe(false)
    expect(modalCard()).toBe('a1')
  })

  it('declines while another dialog sits on top of the modal (it owns the keyboard)', () => {
    act(() => cardEl('a1').focus())
    press('open')
    pushDialog('icon-picker')
    expect(press('next')).toBe(false)
    expect(modalCard()).toBe('a1')
    popDialog('icon-picker')
  })

  it('declines on the board while any dialog is open', () => {
    pushDialog('confirm')
    expect(press('next')).toBe(false)
    popDialog('confirm')
  })

  it('closing the modal puts focus back on the card it showed, so J/K continue from there', () => {
    act(() => cardEl('a1').focus())
    press('open')
    press('next')
    act(() => {
      document.querySelector<HTMLButtonElement>('.modal-close')!.click()
    })
    expect(modalCard()).toBeNull()
    expect(focused()).toBe('a2')
  })
})
