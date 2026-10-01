// @vitest-environment jsdom
/**
 * Escape while the comment composer's @ picker is open closes the PICKER, not the card modal — the
 * modal's own Escape runs in the capture phase, ahead of the composer, and used to close the whole
 * modal (and throw the draft away) instead.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { resetDialogStack } from '../dialog-stack'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

const picker = vi.hoisted(() => ({ open: true }))

vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { pty: {}, shell: {} } })
}))
vi.mock('./BoardLogPanel', () => ({
  BoardLogPanel: () => (
    <textarea className="board-log__composer" aria-expanded={picker.open ? true : undefined} />
  )
}))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = { columns: [{ id: 'c', title: 'To Do', color: '#3b82f6' }], assignments: [] }
const session: KanbanSession = { id: 'n1', title: 'Note', color: '#ffd60a', kind: 'sticky', text: 'x', spawn: {} }

describe('CardModal Escape vs the comment @ picker', () => {
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

  async function escapeInComposer(): Promise<ReturnType<typeof vi.fn>> {
    const onClose = vi.fn()
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <CardModal projectId="p1" session={session} columnTitle={null} board={board} onChangeBoard={vi.fn()} onClose={onClose}
          onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onBrowserNav={vi.fn()} onSetIcon={vi.fn()} />
      )
    })
    const ta = document.querySelector('.board-log__composer') as HTMLTextAreaElement
    ta.focus()
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    act(() => root.unmount())
    return onClose
  }

  it('an open picker keeps Escape', async () => {
    picker.open = true
    expect(await escapeInComposer()).not.toHaveBeenCalled()
  })

  it('with no picker open, Escape in the composer still closes the modal (unchanged)', async () => {
    picker.open = false
    expect(await escapeInComposer()).toHaveBeenCalledTimes(1)
  })
})
