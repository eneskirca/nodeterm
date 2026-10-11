// @vitest-environment jsdom
//
// Card modal parity with the canvas node: open on the ⌘M view when the card menu asked for it,
// set the node's color, and delete through the board's confirm — closing the modal first.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { resetDialogStack } from '../dialog-stack'
import { useSessionNaming } from '../../state/sessionNaming'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'
import type { MenuItem } from '../ContextMenu'

const generateName = vi.fn()
vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { pty: { generateName }, shell: { openExternal: vi.fn() } } })
}))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
// Every `covered` the live viewer was rendered with, in order — the ⌘M view is laid OVER it.
const coveredLog = vi.hoisted(() => [] as (boolean | undefined)[])
vi.mock('./ModalTerminal', () => ({
  ModalTerminal: (p: { covered?: boolean }) => {
    coveredLog.push(p.covered)
    return <div className="kanban-modal__term" />
  }
}))
vi.mock('../../nodes/TerminalMarkdownView', () => ({
  TerminalMarkdownView: () => <div className="md-view-mock" />
}))
vi.mock('../../nodes/ChatPanel', () => ({ ChatPanel: () => <div className="chat-panel-mock" /> }))

const board: ProjectKanban = { columns: [{ id: 'c1', title: 'To Do', color: '#fff' }], assignments: [] }
const session: KanbanSession = { id: 'n1', title: 'Shell', color: '#fff', kind: 'terminal', spawn: { cwd: '/p' } }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  resetDialogStack()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { onMarkdownToggle: () => () => {} }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  resetDialogStack()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(extra: Partial<Parameters<typeof CardModal>[0]> = {}): void {
  act(() =>
    root.render(
      <CardModal
        projectId="p1"
        session={session}
        columnTitle="To Do"
        board={board}
        onChangeBoard={vi.fn()}
        onClose={vi.fn()}
        onOpenCanvas={vi.fn()}
        onRename={vi.fn()}
        onEditSticky={vi.fn()}
        onSetIcon={vi.fn()}
        onBrowserNav={vi.fn()}
        {...extra}
      />
    )
  )
}
const button = (label: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('CardModal — node actions in the header', () => {
  it('opens on the live terminal by default', () => {
    render()
    expect(document.querySelector('.md-view-mock')).toBeNull()
  })

  it('opens on the ⌘M view when the card menu asked for it', () => {
    render({ initialView: 'md' })
    expect(document.querySelector('.md-view-mock')).not.toBeNull()
    expect(button('Markdown view')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('Color opens the swatches and writes the picked color', () => {
    const onSetColor = vi.fn()
    render({ onSetColor })
    act(() => button('Color')!.click())
    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Blue"]')!.click())
    expect(onSetColor).toHaveBeenCalledWith('#0a84ff')
  })

  it('Delete closes the modal first, then asks the board (whose Delete confirms)', () => {
    const order: string[] = []
    render({ onClose: () => order.push('close'), onDelete: () => order.push('delete') })
    act(() => button('Delete')!.click())
    expect(order).toEqual(['close', 'delete'])
  })

  it('no Color or Delete button without a handler', () => {
    render()
    expect(button('Color')).toBeNull()
    expect(button('Delete')).toBeNull()
  })
})

describe('CardModal — session actions menu', () => {
  const actionsButton = (): HTMLButtonElement | null =>
    document.body.querySelector<HTMLButtonElement>('[data-action="session-actions"]')
  const row = (label: string): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>('.ctx-item')).find((e) => e.textContent?.includes(label))

  it('shows a session actions button only when sessionActions is given, for terminal cards', () => {
    render()
    expect(actionsButton()).toBeNull()
    render({ sessionActions: () => [{ label: 'Restart agent', onClick: vi.fn() }] })
    expect(actionsButton()).not.toBeNull()
    render({
      sessionActions: () => [{ label: 'Restart agent', onClick: vi.fn() }],
      session: { ...session, kind: 'sticky' }
    })
    expect(actionsButton()).toBeNull()
  })

  it('no button when the card has no session rows (empty or separator-only)', () => {
    render({ sessionActions: () => [] })
    expect(actionsButton()).toBeNull()
    render({ sessionActions: () => [{ type: 'separator' }, { type: 'separator' }] })
    expect(actionsButton()).toBeNull()
    render({ sessionActions: () => [{ type: 'separator' }, { label: 'Pause', onClick: vi.fn() }] })
    expect(actionsButton()).not.toBeNull()
  })

  it('choosing a row closes the modal first and then runs the action once', () => {
    const order: string[] = []
    render({
      onClose: () => order.push('close'),
      sessionActions: () => [{ label: 'Restart agent', onClick: () => order.push('run') }]
    })
    act(() => actionsButton()!.click())
    act(() => row('Restart agent')!.click())
    expect(order).toEqual(['close', 'run'])
  })

  it('a disabled row neither closes nor runs', () => {
    const onClose = vi.fn()
    const run = vi.fn()
    render({
      onClose,
      sessionActions: () => [{ label: 'Pause', disabled: true, hint: 'busy', onClick: run }]
    })
    act(() => actionsButton()!.click())
    act(() => row('Pause')!.click())
    expect(onClose).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('builds the rows fresh on each open', () => {
    const sessionActions = vi.fn(() => [{ label: 'Restart agent', onClick: vi.fn() }])
    render({ sessionActions })
    act(() => actionsButton()!.click())
    const afterFirst = sessionActions.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    // Dismiss by clicking away (the menu's backdrop).
    act(() => document.querySelector<HTMLElement>('.ctx-backdrop')!.click())
    expect(row('Restart agent')).toBeUndefined()
    act(() => actionsButton()!.click())
    expect(sessionActions.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('click-away and Esc dismiss the menu without closing the modal or running anything', () => {
    const onClose = vi.fn()
    const run = vi.fn()
    render({ onClose, sessionActions: () => [{ label: 'Restart agent', onClick: run }] })
    act(() => actionsButton()!.click())
    act(() => document.querySelector<HTMLElement>('.ctx-backdrop')!.click())
    expect(row('Restart agent')).toBeUndefined()
    act(() => actionsButton()!.click())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(row('Restart agent')).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('a menu opened for one card is gone after the modal steps to another card', () => {
    const run = vi.fn()
    render({ sessionActions: () => [{ label: 'Restart agent', onClick: run }] })
    act(() => actionsButton()!.click())
    expect(row('Restart agent')).toBeDefined()
    render({
      sessionActions: () => [{ label: 'Restart agent', onClick: run }],
      session: { ...session, id: 'n2', title: 'Other' }
    })
    expect(row('Restart agent')).toBeUndefined()
  })

  it('menus closed by a J/K step do not reappear when the modal steps back', () => {
    const sessionActions = (): MenuItem[] => [{ label: 'Restart agent', onClick: vi.fn() }]
    render({ sessionActions, onSetColor: vi.fn() })
    act(() => actionsButton()!.click())
    expect(row('Restart agent')).toBeDefined()
    render({ sessionActions, onSetColor: vi.fn(), session: { ...session, id: 'n2', title: 'Other' } })
    render({ sessionActions, onSetColor: vi.fn() })
    expect(row('Restart agent')).toBeUndefined()
    act(() => button('Color')!.click())
    expect(document.body.querySelector('button[aria-label="Blue"]')).not.toBeNull()
    render({ sessionActions, onSetColor: vi.fn(), session: { ...session, id: 'n2', title: 'Other' } })
    render({ sessionActions, onSetColor: vi.fn() })
    expect(document.body.querySelector('button[aria-label="Blue"]')).toBeNull()
  })
})

describe('CardModal — review fixes (header Color, ✦, ⌘M first paint)', () => {
  const blue = (): HTMLButtonElement | null =>
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Blue"]')
  const esc = (): void => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }

  it('Esc with the swatches open closes the swatches, not the modal', () => {
    const onClose = vi.fn()
    render({ onSetColor: vi.fn(), onClose })
    act(() => button('Color')!.click())
    expect(blue()).not.toBeNull()
    esc()
    expect(blue()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // …and the next Esc is the modal's again.
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('swatches opened for one card never recolor the card the modal stepped to', () => {
    const onSetColor = vi.fn()
    render({ onSetColor })
    act(() => button('Color')!.click())
    expect(blue()).not.toBeNull()
    // J/K re-renders the SAME modal with the next card (it is not remounted per card).
    render({ onSetColor, session: { ...session, id: 'n2', title: 'Other' } })
    expect(blue()).toBeNull()
    expect(onSetColor).not.toHaveBeenCalled()
  })

  it('✦ goes through the board funnel when there is one, and shows its progress', () => {
    const onAiName = vi.fn()
    render({ onAiName })
    const star = (): HTMLButtonElement =>
      document.body.querySelector<HTMLButtonElement>('button[title="Name with AI (from terminal output)"]')!
    act(() => star().click())
    expect(onAiName).toHaveBeenCalledTimes(1)
    expect(generateName).not.toHaveBeenCalled()
    // The funnel's spinner is per node and shared with the card menu's row.
    act(() => useSessionNaming.getState().set('n1', true))
    expect(star().disabled).toBe(true)
    act(() => useSessionNaming.getState().set('n1', false))
    expect(star().disabled).toBe(false)
  })

  it('✦ without a funnel reports a rejected request and never leaves the spinner on', async () => {
    generateName.mockRejectedValueOnce(new Error('connection dropped'))
    const toasts: string[] = []
    const onToast = (e: Event): void => {
      toasts.push((e as CustomEvent<{ message: string }>).detail.message)
    }
    window.addEventListener('nodeterm:toast', onToast)
    render()
    const star = (): HTMLButtonElement =>
      document.body.querySelector<HTMLButtonElement>('button[title="Name with AI (from terminal output)"]')!
    await act(async () => {
      star().click()
    })
    window.removeEventListener('nodeterm:toast', onToast)
    expect(toasts).toEqual(["Couldn't name this session with AI: connection dropped"])
    expect(star().disabled).toBe(false)
  })

  it('✦ without a funnel reports a refused request (ok:false) instead of doing nothing', async () => {
    generateName.mockResolvedValueOnce({ ok: false, message: 'no output to name from' })
    const onRename = vi.fn()
    const toasts: string[] = []
    const onToast = (e: Event): void => {
      toasts.push((e as CustomEvent<{ message: string }>).detail.message)
    }
    window.addEventListener('nodeterm:toast', onToast)
    render({ onRename })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[title="Name with AI (from terminal output)"]')!
        .click()
    })
    window.removeEventListener('nodeterm:toast', onToast)
    expect(toasts).toEqual(["Couldn't name this session with AI: no output to name from"])
    expect(onRename).not.toHaveBeenCalled()
  })

  it('a card opened on the ⌘M view is covered from its very first paint', () => {
    // The live viewer stays mounted under the ⌘M face by design; what must not happen is a first
    // frame with it UNcovered (the view used to arrive one effect later).
    coveredLog.length = 0
    render({ initialView: 'md' })
    expect(coveredLog[0]).toBe(true)
    expect(document.querySelector('.md-view-mock')).not.toBeNull()
  })
})
