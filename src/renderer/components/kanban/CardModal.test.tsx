// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { pushDialog, popDialog, resetDialogStack } from '../dialog-stack'
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

// Mock ModalTerminal and BrowserSurface to keep tests lightweight and focused on CardModal
vi.mock('./ModalTerminal', () => ({
  ModalTerminal: ({ nodeId }: { nodeId: string }) => (
    <div className="kanban-modal__term" data-node-id={nodeId} tabIndex={0}>
      Terminal Mock
    </div>
  )
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

describe('CardModal', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    resetDialogStack()
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
})
