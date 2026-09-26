// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { pushDialog, popDialog, resetDialogStack } from '../dialog-stack'
import { useAgentStatus } from '../../state/agentStatus'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

vi.mock('../../session/session', () => ({
  useSession: () => ({
    api: {
      pty: { generateName: vi.fn(async () => ({ ok: true, message: 'AI Name' })) },
      shell: { openExternal: vi.fn(async () => {}) }
    }
  })
}))

// Stub non-terminal/non-browser child panels so CardModal tests run in isolation without store/context dependencies
vi.mock('./BoardLogPanel', () => ({
  BoardLogPanel: () => null
}))

vi.mock('./CardMetaBar', () => ({
  CardMetaBar: () => null
}))

vi.mock('../ContextMeter', () => ({
  ContextMeter: () => null
}))

// Mock ModalTerminal and BrowserSurface to keep tests lightweight and focused on CardModal.
// The terminal mock counts its MOUNTS and exposes `covered`, so the ⌘M tests can prove the live
// viewer stays mounted (never unmounted/remounted) while the view is laid over it.
const termMock = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('./ModalTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    ModalTerminal: ({ nodeId, covered }: { nodeId: string; covered?: boolean }) => {
      useEffect(() => {
        termMock.mounts++
        return () => {
          termMock.unmounts++
        }
      }, [])
      return (
        <div className="kanban-modal__term" data-node-id={nodeId} data-covered={String(!!covered)} tabIndex={0}>
          Terminal Mock
        </div>
      )
    }
  }
})

// The two ⌘M faces, stubbed to record the props they are handed.
vi.mock('../../nodes/TerminalMarkdownView', () => ({
  TerminalMarkdownView: ({ nodeId, hint }: { nodeId: string; hint: string }) => (
    <div className="md-view-mock" data-node-id={nodeId} data-hint={hint} />
  )
}))
vi.mock('../../nodes/ChatPanel', () => ({
  ChatPanel: (p: { nodeId: string; sessionId?: string; cwd?: string; accountId?: string; agentId: string }) => (
    <div
      className="chat-panel-mock"
      data-node-id={p.nodeId}
      data-session-id={p.sessionId}
      data-cwd={p.cwd}
      data-account-id={p.accountId ?? ''}
      data-agent-id={p.agentId}
    />
  )
}))

// The wake trigger the header's DROPPED / PAUSED / SLEEPING chips click through, spied so a test can
// prove the chip reaches the SAME trigger the canvas node's chip uses (not a bespoke resume path).
const wakeMock = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../nodes/TerminalNode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../nodes/TerminalNode')>()),
  wakeHibernatedNode: (nodeId: string) => void wakeMock.calls.push(nodeId)
}))

vi.mock('../../nodes/BrowserSurface', () => ({
  BrowserSurface: ({ nodeId }: { nodeId: string }) => (
    <div className="browser-surface" data-node-id={nodeId}>
      Browser Mock
    </div>
  )
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = {
  columns: [{ id: 'col-1', title: 'To Do', color: '#3b82f6' }],
  assignments: []
}

/** Subscribers of the ⌘M chord (window.nodeTerminal.onMarkdownToggle), fired by `pressCmdM`. */
const mdToggleSubs = new Set<() => void>()
const pressCmdM = () => act(() => mdToggleSubs.forEach((cb) => cb()))

describe('CardModal', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    resetDialogStack()
    mdToggleSubs.clear()
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      onMarkdownToggle: (cb: () => void) => {
        mdToggleSubs.add(cb)
        return () => mdToggleSubs.delete(cb)
      }
    }
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => {
    resetDialogStack()
    document.body.innerHTML = ''
  })

  it('writes through raw textarea value on sticky note edit (including whitespace and newlines)', () => {
    const session: KanbanSession = {
      id: 'node-sticky-1',
      title: 'First line',
      color: '#ffd60a',
      kind: 'sticky',
      text: 'First line',
      spawn: {}
    }

    const root = createRoot(host)
    const onEditSticky = vi.fn()
    const onClose = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={vi.fn()}
          onRename={vi.fn()}
          onEditSticky={onEditSticky}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    // Initially rendered markdown preview
    const view = document.body.querySelector<HTMLElement>('.kanban-modal__sticky-view')!
    expect(view).toBeTruthy()
    expect(view.textContent).toContain('First line')

    // Click to edit
    act(() => {
      view.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Textarea is rendered
    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea.kanban-modal__sticky')!
    expect(textarea).toBeTruthy()
    expect(textarea.value).toBe('First line')

    // Type a space at the end of the text
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'First line '
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onEditSticky).toHaveBeenCalledWith('First line ')

    // Type multiple lines and trailing spaces
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'First line\n  indented line  '
      )
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onEditSticky).toHaveBeenCalledWith('First line\n  indented line  ')

    // Escape while editing cancels edit mode without closing the modal
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.querySelector('textarea.kanban-modal__sticky')).toBeNull()

    // Escape when not editing closes the modal
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })

  it('enters sticky note editing mode via Enter key on the preview', () => {
    const session: KanbanSession = {
      id: 'node-sticky-enter',
      title: 'Press Enter Note',
      color: '#ffd60a',
      kind: 'sticky',
      text: 'Press Enter Note',
      spawn: {}
    }

    const root = createRoot(host)
    act(() =>
      root.render(
        <CardModal
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
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    const view = document.body.querySelector<HTMLElement>('.kanban-modal__sticky-view')!
    expect(view).toBeTruthy()

    act(() => {
      view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea.kanban-modal__sticky')
    expect(textarea).toBeTruthy()

    act(() => root.unmount())
  })

  it('handles title renaming and Esc cancellation for non-sticky cards', () => {
    const session: KanbanSession = {
      id: 'node-term-1',
      title: 'Original Title',
      color: '#0a84ff',
      kind: 'terminal',
      spawn: {}
    }

    const root = createRoot(host)
    const onRename = vi.fn()
    const onClose = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={vi.fn()}
          onRename={onRename}
          onEditSticky={vi.fn()}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    const titleSpan = document.body.querySelector<HTMLElement>('.kanban-modal__title')!
    expect(titleSpan).toBeTruthy()
    expect(titleSpan.textContent).toBe('Original Title')

    // Click title to enter rename mode
    act(() => {
      titleSpan.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const input = document.body.querySelector<HTMLInputElement>('input.kanban-modal__rename')!
    expect(input).toBeTruthy()
    expect(input.value).toBe('Original Title')

    // Press Escape to cancel rename mode without closing the modal
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(onRename).not.toHaveBeenCalled()
    expect(document.body.querySelector('input.kanban-modal__rename')).toBeNull()

    // Re-enter rename mode and submit new title via Enter
    const titleSpanAgain = document.body.querySelector<HTMLElement>('.kanban-modal__title')!
    act(() => {
      titleSpanAgain.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const inputAgain = document.body.querySelector<HTMLInputElement>('input.kanban-modal__rename')!

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        inputAgain,
        'Updated Title'
      )
      inputAgain.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => {
      inputAgain.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onRename).toHaveBeenCalledWith('Updated Title')

    act(() => root.unmount())
  })

  it('closes modal when clicking the scrim or close button or Open Canvas', () => {
    const session: KanbanSession = {
      id: 'node-sticky-close',
      title: 'Close Note',
      color: '#ffd60a',
      kind: 'sticky',
      text: 'Close Note',
      spawn: {}
    }

    const root = createRoot(host)
    const onClose = vi.fn()
    const onOpenCanvas = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={onOpenCanvas}
          onRename={vi.fn()}
          onEditSticky={vi.fn()}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    const closeBtn = document.body.querySelector<HTMLButtonElement>('button[title="Close"]')!
    expect(closeBtn).toBeTruthy()
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    const scrim = document.body.querySelector<HTMLElement>('.kanban-modal-scrim')!
    expect(scrim).toBeTruthy()
    act(() => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)

    const openCanvasBtn = document.body.querySelector<HTMLButtonElement>('button[title="Open on canvas"]')!
    expect(openCanvasBtn).toBeTruthy()
    act(() => {
      openCanvasBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenCanvas).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })

  it('does not close modal on mousedown inside the card sheet (stopPropagation)', () => {
    const session: KanbanSession = {
      id: 'node-sticky-sheet',
      title: 'Sheet Note',
      color: '#ffd60a',
      kind: 'sticky',
      text: 'Sheet Note',
      spawn: {}
    }

    const root = createRoot(host)
    const onClose = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={vi.fn()}
          onRename={vi.fn()}
          onEditSticky={vi.fn()}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    const sheet = document.body.querySelector<HTMLElement>('.kanban-modal')!
    expect(sheet).toBeTruthy()

    // Clicking inside the modal sheet must NOT propagate to the scrim onMouseDown (onClose)
    act(() => {
      sheet.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it('respects isTopDialog ownership: ignores Escape when another dialog is stacked on top', () => {
    const session: KanbanSession = {
      id: 'node-sticky-dialog-stack',
      title: 'Dialog Stack Note',
      color: '#ffd60a',
      kind: 'sticky',
      text: 'Dialog Stack Note',
      spawn: {}
    }

    const root = createRoot(host)
    const onClose = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={vi.fn()}
          onRename={vi.fn()}
          onEditSticky={vi.fn()}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    // Simulate another modal dialog opening on top of CardModal in the dialog stack
    act(() => {
      pushDialog('dialog-overlay-top')
    })

    // Escape should NOT close CardModal while another dialog is top of stack
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    // When the top dialog is dismissed, CardModal becomes top dialog again
    act(() => {
      popDialog('dialog-overlay-top')
    })

    // Escape now closes CardModal
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })

  it('does not close modal on Escape when terminal is focused', () => {
    const session: KanbanSession = {
      id: 'node-term-focused',
      title: 'Terminal Card',
      color: '#0a84ff',
      kind: 'terminal',
      spawn: {}
    }

    const root = createRoot(host)
    const onClose = vi.fn()

    act(() =>
      root.render(
        <CardModal
          session={session}
          columnTitle="To Do"
          board={board}
          onChangeBoard={vi.fn()}
          onClose={onClose}
          onOpenCanvas={vi.fn()}
          onRename={vi.fn()}
          onEditSticky={vi.fn()}
          onSetIcon={vi.fn()}
          onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
        />
      )
    )

    const term = document.body.querySelector<HTMLElement>('.kanban-modal__term')!
    expect(term).toBeTruthy()
    term.focus()

    // Escape while terminal is focused should NOT trigger modal close
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    // Blur terminal and press Escape
    term.blur()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })

  describe('⌘M view (board parity with the canvas node)', () => {
    const termSession = (over: Partial<KanbanSession> = {}): KanbanSession => ({
      id: 'node-md-1',
      title: 'Agent',
      color: '#0a84ff',
      kind: 'terminal',
      agentId: 'claude',
      spawn: { cwd: '/work/repo', agentId: 'claude' },
      ...over
    })

    const render = (root: ReturnType<typeof createRoot>, session: KanbanSession) =>
      act(() =>
        root.render(
          <CardModal
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
            onChangeNodeLinks={vi.fn()}
            onAttachLink={vi.fn()}
          />
        )
      )
    const toggle = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Markdown view"]')!
    /** Let the lazily imported ChatPanel resolve. */
    const settle = async () => {
      for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }

    beforeEach(() => {
      termMock.mounts = 0
      termMock.unmounts = 0
      useAgentStatus.setState({ byId: {} } as never)
    })

    it('the header toggle lays the OUTPUT view over the live terminal, which stays mounted', () => {
      const root = createRoot(host)
      render(root, termSession({ agentId: undefined, spawn: { cwd: '/w' } }))
      expect(termMock.mounts).toBe(1)
      act(() => toggle().click())
      const md = document.body.querySelector<HTMLElement>('.md-view-mock')!
      expect(md.dataset.nodeId).toBe('node-md-1')
      expect(document.body.querySelector('.kanban-modal__term')!.getAttribute('data-covered')).toBe('true')
      act(() => toggle().click())
      expect(document.body.querySelector('.md-view-mock')).toBeNull()
      expect(document.body.querySelector('.kanban-modal__term')!.getAttribute('data-covered')).toBe('false')
      expect(termMock.mounts).toBe(1)
      expect(termMock.unmounts).toBe(0)
      act(() => root.unmount())
    })

    it('a chat-capable agent with a known session gets ChatPanel with the node\'s props', async () => {
      useAgentStatus.setState({ byId: { 'node-md-1': { sessionId: 'sess-42' } } } as never)
      const root = createRoot(host)
      render(root, termSession())
      act(() => toggle().click())
      await settle()
      const chat = document.body.querySelector<HTMLElement>('.chat-panel-mock')!
      expect(chat).toBeTruthy()
      expect(chat.dataset.sessionId).toBe('sess-42')
      expect(chat.dataset.agentId).toBe('claude')
      expect(chat.dataset.cwd).toBe('/work/repo')
      expect(chat.dataset.nodeId).toBe('node-md-1')
      expect(document.body.querySelector('.md-view-mock')).toBeNull()
      act(() => root.unmount())
    })

    it('falls back to the output view while the session id is unknown', () => {
      const root = createRoot(host)
      render(root, termSession())
      act(() => toggle().click())
      expect(document.body.querySelector('.md-view-mock')).toBeTruthy()
      expect(document.body.querySelector('.chat-panel-mock')).toBeNull()
      act(() => root.unmount())
    })

    it('the ⌘M chord toggles the modal view while it is the top dialog, and only then', () => {
      const root = createRoot(host)
      render(root, termSession({ agentId: undefined, spawn: {} }))
      pressCmdM()
      expect(document.body.querySelector('.md-view-mock')).toBeTruthy()
      pushDialog('another-dialog-on-top')
      pressCmdM()
      expect(document.body.querySelector('.md-view-mock')).toBeTruthy()
      popDialog('another-dialog-on-top')
      pressCmdM()
      expect(document.body.querySelector('.md-view-mock')).toBeNull()
      act(() => root.unmount())
    })

    it('never subscribes to the chord for a non-terminal card', () => {
      const root = createRoot(host)
      render(root, { id: 's', title: 'n', color: '#ffd60a', kind: 'sticky', text: 'n', spawn: {} })
      expect(mdToggleSubs.size).toBe(0)
      act(() => root.unmount())
    })

    it('the view is per opening: switching cards neither carries it over nor brings it back (A → B → A)', () => {
      const root = createRoot(host)
      render(root, termSession({ agentId: undefined, spawn: {} }))
      act(() => toggle().click())
      expect(document.body.querySelector('.md-view-mock')).toBeTruthy()
      render(root, termSession({ id: 'node-md-2', agentId: undefined, spawn: {} }))
      expect(document.body.querySelector('.md-view-mock')).toBeNull()
      // …and it is per OPENING: coming back to the first card shows its live terminal again.
      render(root, termSession({ agentId: undefined, spawn: {} }))
      expect(document.body.querySelector('.md-view-mock')).toBeNull()
      act(() => root.unmount())
    })

    it('a hibernated session shows a SLEEPING chip in the header that wakes it (the placeholder names it)', () => {
      // The ChatPanel's asleep placeholder tells the user to click SLEEPING "in the header" — true
      // on the canvas node, and it has to be true here too, or the modal user is sent looking for a
      // chip that does not exist.
      const root = createRoot(host)
      wakeMock.calls.length = 0
      useAgentStatus.setState({ byId: { 'node-md-1': { hibernated: true } } } as never)
      render(root, termSession())
      const chip = () =>
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('button.kanban-badge')).find((b) =>
          b.textContent?.startsWith('SLEEPING')
        )
      expect(chip()).toBeTruthy()
      act(() => chip()!.click())
      expect(wakeMock.calls).toEqual(['node-md-1'])
      // A refused wake carries its sentence on the chip, exactly as on the canvas node.
      act(() =>
        useAgentStatus.setState({ byId: { 'node-md-1': { hibernated: true, wakeBlocked: 'Pane is busy' } } } as never)
      )
      expect(chip()!.textContent).toBe('SLEEPING — NOT RESUMED')
      expect(chip()!.title).toBe('Pane is busy')
      // Mutually exclusive with PAUSED / DROPPED, in the canvas node's order: one chip, never two.
      act(() => useAgentStatus.setState({ byId: { 'node-md-1': { hibernated: true, paused: true } } } as never))
      expect(chip()).toBeUndefined()
      expect(document.body.textContent).toContain('PAUSED')
      act(() => useAgentStatus.setState({ byId: { 'node-md-1': {} } } as never))
      expect(chip()).toBeUndefined()
      act(() => root.unmount())
    })

    it('search is disabled while the view covers the terminal it searches', () => {
      const root = createRoot(host)
      render(root, termSession({ agentId: undefined, spawn: {} }))
      const search = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Search this terminal"]')!
      expect(search().disabled).toBe(false)
      act(() => toggle().click())
      expect(search().disabled).toBe(true)
      act(() => root.unmount())
    })
  })
})
