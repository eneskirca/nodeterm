// @vitest-environment jsdom
//
// Live links on the Omni (all-projects) board — R49 and R57:
//  - every lane's card menu offers "Share live link…" from Canvas's ONE builder, asked for THAT
//    lane's project (a link needs no node on screen, so another tab's card can share too);
//  - a lane of a relay project never shows this machine's LIVE chip for a node id that collides
//    with a local one (the same git-shared canvas opened both ways).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CanvasNodeState, Project } from '@shared/types'
import type { WatchLinkView } from '@shared/watch-link-types'
import { GlobalKanbanView } from './GlobalKanbanView'
import { useProjects } from '../../state/projects'
import { useViewMode } from '../../state/viewMode'
import { useWatchLinks } from '../../state/watchLinks'
import type { MenuItem } from '../ContextMenu'

vi.mock('../../session/session', () => ({
  useSession: () => ({ id: 'local', source: 'local', api: {} }),
  sessionForProject: (projectId: string) =>
    projectId === 'relay' ? { id: 'relay-session', source: 'relay', api: {} } : { id: 'local', source: 'local', api: {} }
}))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('./CardModal', () => ({ CardModal: () => null }))

const terminal = (id: string, title: string): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title, color: '#fff', group: null }) as CanvasNodeState
const project = (id: string, nodes: CanvasNodeState[]): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes }) as unknown as Project
const link = (nodeId: string): WatchLinkView => ({
  linkId: `L-${nodeId}`,
  nodeId,
  role: 'viewer',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: Date.now() + 3_600_000,
  url: 'u',
  status: 'live',
  viewers: []
})

let root: Root | null = null
let host: HTMLElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  useViewMode.setState({ requestedCardNodeId: null } as never)
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mount(projects: Project[], liveLinkMenuItems?: (nodeId: string, projectId: string) => MenuItem[]): void {
  useProjects.setState({ projects, activeProjectId: projects[0].id } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<GlobalKanbanView liveLinkMenuItems={liveLinkMenuItems} />))
}
const cardIn = (lane: string): HTMLElement =>
  document.querySelector<HTMLElement>(`#swimlane-${lane} [title="Open card"]`)!

describe('Omni board — live links', () => {
  it('a card of a NON-active project offers the row, built for that node and that project', () => {
    const rows = vi.fn((nodeId: string, projectId: string): MenuItem[] => [
      { label: `Share live link… (${nodeId} in ${projectId})`, onClick: () => {} }
    ])
    mount([project('a', [terminal('n-a', 'alpha')]), project('b', [terminal('n-b', 'beta')])], rows)
    act(() => {
      cardIn('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    expect(rows).toHaveBeenCalledWith('n-b', 'b')
    expect(document.body.textContent).toContain('Share live link… (n-b in b)')
  })

  it('a board with no canvas behind it offers none', () => {
    mount([project('a', [terminal('n-a', 'alpha')])])
    act(() => {
      cardIn('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    expect(document.body.textContent).toContain('Open card')
    expect(document.body.textContent).not.toContain('Share live link')
  })

  it('R57: the local lane shows the chip; a relay lane with the SAME node id does not', () => {
    mount([project('a', [terminal('same', 'alpha')]), project('relay', [terminal('same', 'theirs')])])
    act(() => useWatchLinks.getState().setLinks([link('same')]))
    expect(document.querySelector('#swimlane-a .live-chip')).not.toBeNull()
    expect(document.querySelector('#swimlane-relay .live-chip')).toBeNull()
  })
})
