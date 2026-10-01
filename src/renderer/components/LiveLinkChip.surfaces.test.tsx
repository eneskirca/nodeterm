// @vitest-environment jsdom
//
// The LIVE chip on the surfaces that show a node — the kanban card, the card modal header and the
// sessions sidebar row (the canvas node header is pinned at source level by lib/live-link.guard.test.ts:
// TerminalNode is too large to mount here). Each renders the SAME component, and each keeps the
// popover's clicks away from what the surface itself does with a click.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { WatchLinkView } from '@shared/watch-link-types'
import { resetDialogStack } from './dialog-stack'
import { useWatchLinks } from '../state/watchLinks'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { SessionCard } from './kanban/SessionCard'
import { CardModal } from './kanban/CardModal'
import { SessionRow } from './SessionRow'
import type { KanbanSession } from './kanban/KanbanView'
import type { SessionRowVM } from '../lib/sessionList'

vi.mock('../session/session', () => ({
  useSession: () => ({ api: { pty: {}, shell: { openExternal: vi.fn(async () => {}) } } }),
  sessionForProject: () => ({ source: 'local', api: {} })
}))
vi.mock('./kanban/BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('./ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./kanban/ModalTerminal', () => ({ ModalTerminal: () => <div className="kanban-modal__term" /> }))
vi.mock('../nodes/BrowserSurface', () => ({ BrowserSurface: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n1',
  role: 'viewer',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: Date.now() + 3_600_000,
  url: 'u',
  status: 'live',
  viewers: [{ viewerId: 'v', name: null, joinedAt: 0, waiting: false }],
  ...over
})
const session: KanbanSession = { id: 'n1', title: 'build', color: '#fff', kind: 'terminal', spawn: {} } as KanbanSession
const row: SessionRowVM = {
  id: 'n1',
  title: 'build',
  color: '#888',
  isAgent: false,
  statusKind: 'unknown',
  stateLabel: 'Unknown',
  unread: false,
  usesContext: false,
  projectId: 'p1'
} as SessionRowVM
const board = { columns: [], assignments: [] } as unknown as ProjectKanban

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  useAgentStatus.setState({ byId: {} } as never)
  useProjects.setState({ activeProjectId: 'p1', projects: [] } as never)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    onMarkdownToggle: () => () => {},
    boardLog: { list: async () => [], onChanged: () => () => {} },
    watchLink: { revoke: async () => {}, kick: async () => true, chatHistory: async () => [], sendChat: async () => null },
    clipboard: { writeText: () => {} }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
  vi.unstubAllGlobals()
})

const render = (ui: React.ReactElement): void => act(() => root.render(ui))
const setLinks = (links: WatchLinkView[]): void => act(() => useWatchLinks.getState().setLinks(links))
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const pop = (): HTMLElement | null => document.querySelector<HTMLElement>('.live-pop')

function card(onOpen = vi.fn(), onDropAt = vi.fn(), liveLinkSource: 'local' | 'relay' = 'local') {
  return (
    <SessionCard
      session={session}
      liveLinkSource={liveLinkSource}
      onOpen={onOpen}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onDropAt={onDropAt}
      onContext={vi.fn()}
    />
  )
}

describe('LIVE chip — kanban card', () => {
  it('a link alone is detail enough to show; no link, no chip and no empty detail row', () => {
    render(card())
    expect(host.querySelector('.live-chip')).toBeNull()
    expect(host.querySelector('.kanban-card__detail')).toBeNull()
    setLinks([link()])
    const chip = host.querySelector('.kanban-card__detail .live-chip.kanban-card__live')
    expect(chip?.textContent).toBe('LIVE · 1')
    setLinks([])
    expect(host.querySelector('.kanban-card__detail')).toBeNull()
  })

  // R57: a relay tab's board shows another machine's nodes, and a git-shared project opened both
  // locally and over the relay carries the SAME node ids — this machine's link must not light up
  // (or add a detail row to) the relay copy of the card.
  it('a card on a relay project shows no chip and no detail row for a colliding node id', () => {
    render(card(vi.fn(), vi.fn(), 'relay'))
    setLinks([link()])
    expect(host.querySelector('.live-chip')).toBeNull()
    expect(host.querySelector('.kanban-card__detail')).toBeNull()
  })

  it('opening the popover and clicking inside it never opens the card', () => {
    const onOpen = vi.fn()
    render(card(onOpen))
    setLinks([link()])
    click(host.querySelector('.live-chip')!)
    expect(pop()).not.toBeNull()
    click(pop()!)
    click(document.querySelector('.live-pop__scrim')!)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('another card dragged over this card\'s chip can still be dropped on the card (I1)', () => {
    const onDropAt = vi.fn()
    render(card(vi.fn(), onDropAt))
    setLinks([link()])
    const chip = host.querySelector('.live-chip')!
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    act(() => void chip.dispatchEvent(over))
    // The card's handler ran: it accepted the drop and drew its drop line.
    expect(over.defaultPrevented).toBe(true)
    expect(host.querySelector('.kanban-card')!.className).toMatch(/kanban-card--drop-(before|after)/)
    act(() => void chip.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })))
    expect(onDropAt).toHaveBeenCalledWith('n1', expect.stringMatching(/before|after/))
  })
})

describe('LIVE chip — card modal header', () => {
  it('shows in the header, and Escape closes the popover, not the modal', () => {
    const onClose = vi.fn()
    render(
      <CardModal projectId="p1"
        session={session}
        columnTitle="Doing"
        board={board}
        onChangeBoard={vi.fn()}
        onClose={onClose}
        onOpenCanvas={vi.fn()}
        onRename={vi.fn()}
        onEditSticky={vi.fn()}
        onSetIcon={vi.fn()}
        onBrowserNav={vi.fn()}
      />
    )
    expect(document.querySelector('.kanban-modal__header .live-chip')).toBeNull()
    setLinks([link({ status: 'reconnecting' })])
    const chip = document.querySelector('.kanban-modal__header .live-chip.kanban-modal__live')!
    expect(chip.textContent).toBe('LIVE · offline')
    click(chip)
    expect(pop()).not.toBeNull()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(pop()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // With the popover gone, Escape is the modal's again.
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('LIVE chip — sessions sidebar row', () => {
  it('shows on the row; a click or a middle press in the popover neither travels nor ends the session', () => {
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(
      <SessionRow
        row={row}
        liveLinkSource="local"
        onClick={onClick}
        onClose={onClose}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )
    expect(host.querySelector('.live-chip')).toBeNull()
    setLinks([link({ status: 'refused' })])
    const chip = host.querySelector('.ss-row .live-chip.ss-live')!
    expect(chip.textContent).toBe('LIVE · refused')
    click(chip)
    act(() => void pop()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })))
    click(pop()!)
    expect(onClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('R57: a row of a relay project shows no chip for a colliding node id', () => {
    render(
      <SessionRow
        row={row}
        liveLinkSource="relay"
        onClick={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onAiName={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    )
    setLinks([link()])
    expect(host.querySelector('.live-chip')).toBeNull()
  })
})
