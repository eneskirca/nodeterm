// @vitest-environment jsdom
/**
 * Escape typed inside the Live chat drawer never closes the kanban card modal under it (ruling on
 * Task 8 concern 4). The drawer is opened from the card's LIVE chip and sits RAISED above the modal.
 * Pinned, it is not a dialog, so the card modal is the top dialog — and its capture-phase Escape used
 * to close the modal while the owner was typing a reply. Escape in the drawer follows the drawer's
 * own rule: unpinned, close the drawer (it is the top dialog); pinned, nothing.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { WatchLinkView } from '@shared/watch-link-types'
import { resetDialogStack } from '../dialog-stack'
import { LiveChatDrawer } from '../LiveChatDrawer'
import { useWatchLinks } from '../../state/watchLinks'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

vi.mock('../../session/session', async () => {
  // The agent-status reads now resolve a store per project / per session (bug D, covered in
  // session/agent-status-lookup.test.tsx). Here every one answers the default store, as before.
  const { defaultAgentStatus } = await import('../../state/agentStatus')
  return {
    useSession: () => ({ api: { pty: {}, shell: {} } }),
    agentStatusForProject: () => defaultAgentStatus,
    useSessionRegistryVersion: () => 0,
    useSessionStores: () => ({ agentStatus: defaultAgentStatus })
  }
})
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => <textarea className="board-log__composer" /> }))
vi.mock('./CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board: ProjectKanban = { columns: [{ id: 'c', title: 'To Do', color: '#3b82f6' }], assignments: [] }
const session: KanbanSession = { id: 'n1', title: 'Note', color: '#ffd60a', kind: 'sticky', text: 'x', spawn: {} }
const link: WatchLinkView = {
  linkId: 'L',
  nodeId: 'n1',
  role: 'commenter',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: null,
  url: 'u',
  status: 'live',
  viewers: [],
  control: null
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  useWatchLinks.getState().setLinks([link])
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    onMarkdownToggle: () => () => {},
    watchLink: { chatHistory: vi.fn(async () => []), sendChat: vi.fn(), kick: vi.fn() },
    clipboard: { writeText: vi.fn() }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  resetDialogStack()
  document.body.innerHTML = ''
})

const escapeOn = (el: HTMLElement): void => {
  el.focus()
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
}

async function open(pinned: boolean): Promise<{ closeModal: ReturnType<typeof vi.fn>; closeDrawer: ReturnType<typeof vi.fn> }> {
  const closeModal = vi.fn()
  const closeDrawer = vi.fn()
  const modal = (
    <CardModal projectId="p1" session={session} columnTitle={null} board={board} onChangeBoard={vi.fn()} onClose={closeModal}
      onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onBrowserNav={vi.fn()} onSetIcon={vi.fn()} />
  )
  // The card modal first; then Open chat on its LIVE chip raises the drawer over it.
  await act(async () => root.render(<>{modal}</>))
  await act(async () =>
    root.render(
      <>
        {modal}
        <LiveChatDrawer linkId="L" pinned={pinned} raised onPickLink={vi.fn()} onClose={closeDrawer} onTogglePin={vi.fn()} onGoToNode={vi.fn()} />
      </>
    )
  )
  expect(document.querySelector('.drawer-overlay--raised')).not.toBeNull()
  return { closeModal, closeDrawer }
}

const composer = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.live-chat__reply input')!

describe('Escape in the Live chat drawer over a card modal', () => {
  it('pinned: Escape in the drawer closes neither the drawer nor the card modal', async () => {
    const { closeModal, closeDrawer } = await open(true)
    escapeOn(composer())
    expect(closeModal).not.toHaveBeenCalled()
    expect(closeDrawer).not.toHaveBeenCalled()
  })

  it('unpinned (the top dialog): Escape in the drawer closes the drawer only', async () => {
    const { closeModal, closeDrawer } = await open(false)
    escapeOn(composer())
    expect(closeDrawer).toHaveBeenCalledTimes(1)
    expect(closeModal).not.toHaveBeenCalled()
  })

  it('Escape outside the drawer still closes the card modal when the docked drawer is up (unchanged)', async () => {
    const { closeModal, closeDrawer } = await open(true)
    escapeOn(document.querySelector<HTMLTextAreaElement>('.board-log__composer')!)
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(closeDrawer).not.toHaveBeenCalled()
  })
})
