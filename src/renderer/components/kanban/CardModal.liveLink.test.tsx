// @vitest-environment jsdom
//
// The card modal's "Share live link" action (Task 17, H4) and its LIVE chip gate (R57). The modal
// sits over the board at z 55, ABOVE the canvas's notice strip, so an unavailable share must say
// why ON the button — a notice raised behind the scrim would be a silent dead click.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import type { WatchLinkView } from '@shared/watch-link-types'
import { resetDialogStack } from '../dialog-stack'
import { useWatchLinks } from '../../state/watchLinks'
import { CardModal } from './CardModal'
import type { KanbanSession } from './KanbanView'

const flags = vi.hoisted(() => ({ browser: false, relayProjects: new Set<string>() }))
vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { pty: {}, shell: { openExternal: vi.fn(async () => {}) } } }),
  sessionForProject: (id: string) => ({ source: flags.relayProjects.has(id) ? 'relay' : 'local', api: {} })
}))
vi.mock('@renderer/bridge/runtime', () => ({ isBrowserRuntime: () => flags.browser }))
vi.mock('./BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./ModalTerminal', () => ({ ModalTerminal: () => <div className="kanban-modal__term" /> }))
vi.mock('../../nodes/BrowserSurface', () => ({ BrowserSurface: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const R43 = 'Live links need a Pro license on this server — not available in the Server Edition yet'
const RELAY = 'Live links are created on the machine that runs this terminal.'
const LIMIT = 'Stop a live link first — 5 can be active at once.'

const terminal: KanbanSession = { id: 'n1', title: 'build', color: '#fff', kind: 'terminal', spawn: {} } as KanbanSession
const sticky: KanbanSession = { id: 's1', title: 'note', color: '#fff', kind: 'sticky', text: 'note', spawn: {} } as KanbanSession
const board = { columns: [], assignments: [] } as unknown as ProjectKanban
const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n1',
  role: 'viewer',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: Date.now() + 3_600_000,
  url: 'https://nodeterm.dev/s/L#1.secret',
  status: 'live',
  viewers: [],
  ...over
})

let host: HTMLDivElement
let events: CustomEvent[]
const onLive = (e: Event): void => void events.push(e as CustomEvent)
beforeEach(() => {
  resetDialogStack()
  flags.browser = false
  flags.relayProjects.clear()
  events = []
  window.addEventListener('nodeterm:live-link', onLive)
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    onMarkdownToggle: () => () => {},
    boardLog: { list: async () => [], onChanged: () => () => {} }
  }
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  window.removeEventListener('nodeterm:live-link', onLive)
  resetDialogStack()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(session: KanbanSession, projectId = 'p1'): () => void {
  const root = createRoot(host)
  act(() =>
    root.render(
      <CardModal session={session} projectId={projectId} columnTitle={null} board={board} onChangeBoard={vi.fn()}
        onClose={vi.fn()} onOpenCanvas={vi.fn()} onRename={vi.fn()} onEditSticky={vi.fn()} onSetIcon={vi.fn()}
        onBrowserNav={vi.fn()} />
    )
  )
  return () => act(() => root.unmount())
}
const shareButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.kanban-modal__action[data-action="live-link"]')

describe('CardModal — Share live link', () => {
  it('a terminal card asks the canvas to share THIS node, naming its project', () => {
    const unmount = mount(terminal, 'p-omni')
    const b = shareButton()!
    expect(b.disabled).toBe(false)
    expect(b.title).toBe('Share live link')
    act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({ nodeId: 'n1', title: 'build', projectId: 'p-omni' })
    unmount()
  })

  it('is disabled WITH the reason where it cannot work, and a click sends nothing', () => {
    for (const [setup, why] of [
      [() => (flags.browser = true), R43],
      [() => flags.relayProjects.add('p1'), RELAY],
      [
        () =>
          useWatchLinks
            .getState()
            .setLinks(['a', 'b', 'c', 'd', 'e'].map((id) => link({ linkId: id, nodeId: `x-${id}` }))),
        LIMIT
      ]
    ] as const) {
      flags.browser = false
      flags.relayProjects.clear()
      useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
      events = []
      act(() => void setup())
      const unmount = mount(terminal)
      const b = shareButton()!
      expect(b.disabled).toBe(true)
      expect(b.title).toBe(why)
      act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(events).toHaveLength(0)
      unmount()
    }
  })

  it('a sticky card has no share action', () => {
    const unmount = mount(sticky)
    expect(shareButton()).toBeNull()
    unmount()
  })

  it('R57: the LIVE chip shows for a local project and not for a relay project with the same node id', () => {
    act(() => useWatchLinks.getState().setLinks([link()]))
    let unmount = mount(terminal, 'p1')
    expect(document.querySelector('.kanban-modal__header .live-chip')).not.toBeNull()
    unmount()
    flags.relayProjects.add('p-relay')
    unmount = mount(terminal, 'p-relay')
    expect(document.querySelector('.kanban-modal__header .live-chip')).toBeNull()
    unmount()
  })
})
