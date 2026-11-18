// @vitest-environment jsdom
/**
 * Escape while the ⌘M thread's "Add to chat" button shows hides the BUTTON, not the card modal.
 * Both listen on the window in the capture phase, so their order is registration order: the button
 * owns the key only while it shows, and the modal steps aside for it whichever runs first.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'

// jsdom draws nothing: the modal's imports ask a canvas for a 2D context, and jsdom prints "Not
// implemented" for every ask. No context is what a page without canvas support gets. Hoisted: some
// of those asks happen while the imports below load.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
})
import { resetDialogStack } from '../dialog-stack'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

vi.mock('../../session/session', async () => {
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ api: { pty: {}, shell: {} } }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = { columns: [{ id: 'c', title: 'To Do', color: '#3b82f6' }], assignments: [] }
const session: KanbanSession = { id: 'n1', title: 'Note', color: '#ffd60a', kind: 'sticky', text: 'x', spawn: {} }

describe('CardModal Escape vs the chat thread quote button', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    resetDialogStack()
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { onMarkdownToggle: () => () => {} }
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    resetDialogStack()
    document.body.innerHTML = ''
  })

  async function escape(withButton: boolean): Promise<ReturnType<typeof vi.fn>> {
    const onClose = vi.fn()
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <CardModal projectId="p1" session={session} columnTitle={null} board={board} onChangeBoard={vi.fn()} onClose={onClose}
          onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onBrowserNav={vi.fn()} onSetIcon={vi.fn()} />
      )
    })
    // The button is portaled to <body> while it shows (nodes/ChatQuoteButton.tsx).
    const btn = document.createElement('button')
    btn.className = 'chat-quote-btn'
    if (withButton) document.body.append(btn)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    act(() => root.unmount())
    btn.remove()
    return onClose
  }

  it('a showing quote button keeps Escape', async () => {
    expect(await escape(true)).not.toHaveBeenCalled()
  })

  it('with no quote button, Escape still closes the modal (unchanged)', async () => {
    expect(await escape(false)).toHaveBeenCalledTimes(1)
  })
})
