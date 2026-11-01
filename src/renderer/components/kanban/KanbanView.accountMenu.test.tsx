// @vitest-environment jsdom
//
// The card right-click menu carries the node's own rows — the SAME builder the canvas node menu
// uses (lib/nodeActionItems, narrowed by Canvas to BOARD_NODE_ACTION_IDS), passed in as
// `nodeActionItems`. A card is a second view of its node, so color, icon, live link and the
// account switch must be reachable from the board without going back to the canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import { defaultKanban } from '../../lib/kanban'
import type { MenuItem } from '../ContextMenu'

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
vi.mock('./CardModal', () => ({
  CardModal: (p: { session: { id: string }; initialView?: string; onDelete?: () => void; onSetColor?: (c: string) => void }) => (
    <div className="card-modal-mock" data-node={p.session.id} data-view={p.initialView ?? ''}>
      <button className="modal-delete" onClick={p.onDelete} />
      <button className="modal-color" onClick={() => p.onSetColor?.('#0a84ff')} />
    </div>
  )
}))

let root: Root
let host: HTMLElement
const session = {
  id: 'n1',
  title: 'Agent',
  color: '#fff',
  kind: 'terminal',
  agentId: 'claude',
  spawn: {}
} as unknown as KanbanSession

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // The context menu measures itself to stay on screen; jsdom has no ResizeObserver.
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
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function render(
  nodeActionItems?: (id: string) => MenuItem[],
  onAiName?: (id: string) => void,
  more: { onDeleteNode?: (id: string) => void; onSetColor?: (id: string, c: string) => void } = {}
): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() =>
    root.render(
      <KanbanView
        board={defaultKanban('p')}
        sessions={[session]}
        onChange={noop}
        onOpenNode={noop}
        onCreateNode={noop}
        onRenameNode={noop}
        onEditSticky={noop}
        onDeleteNode={more.onDeleteNode ?? noop}
        onSetColor={more.onSetColor}
        onModalNodeChange={noop}
        onBrowserNav={noop}
        onSetIcon={noop}
        nodeActionItems={nodeActionItems}
        onAiName={onAiName}
      />
    )
  )
}

function openCardMenu(): void {
  const card = [...document.querySelectorAll('[title="Open card"]')][0] as HTMLElement
  act(() => {
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  })
}
function clickRow(label: string): void {
  const rowEl = [...document.querySelectorAll<HTMLElement>('.ctx-item')].find((el) => el.textContent?.includes(label))
  if (!rowEl) throw new Error(`no row ${label}`)
  act(() => rowEl.click())
}

describe('KanbanView — card menu node rows', () => {
  it('shows the node’s rows from the shared builder, built for that card’s node', () => {
    const rows = vi.fn((id: string): MenuItem[] => [
      { label: `Switch Claude account (${id})`, onClick: () => {} },
      { label: `Share live link… (${id})`, onClick: () => {} }
    ])
    render(rows)
    openCardMenu()
    expect(rows).toHaveBeenCalledWith('n1')
    expect(document.body.textContent).toContain('Switch Claude account (n1)')
    expect(document.body.textContent).toContain('Share live link… (n1)')
  })

  it('shows none without a builder (no canvas behind the board)', () => {
    render()
    openCardMenu()
    expect(document.body.textContent).toContain('Open card')
    expect(document.body.textContent).not.toContain('Switch Claude account')
    expect(document.body.textContent).not.toContain('Share live link')
  })

  it('"Open card in chat / markdown view" opens the card modal on that view', () => {
    render()
    openCardMenu()
    clickRow('Open card in chat / markdown view')
    const modal = document.querySelector<HTMLElement>('.card-modal-mock')
    expect(modal?.dataset.node).toBe('n1')
    expect(modal?.dataset.view).toBe('md')
  })

  it('a plain "Open card" opens it on the live terminal', () => {
    render()
    openCardMenu()
    clickRow('Open card')
    expect(document.querySelector<HTMLElement>('.card-modal-mock')?.dataset.view).toBe('')
  })

  it('"Name with AI" names that card’s session', () => {
    const ai = vi.fn()
    render(undefined, ai)
    openCardMenu()
    clickRow('Name with AI')
    expect(ai).toHaveBeenCalledWith('n1')
  })

  it("the card modal's Delete and Color reach the board handlers for THAT card", () => {
    const del = vi.fn()
    const color = vi.fn()
    render(undefined, undefined, { onDeleteNode: del, onSetColor: color })
    openCardMenu()
    clickRow('Open card')
    act(() => document.querySelector<HTMLButtonElement>('.modal-color')!.click())
    act(() => document.querySelector<HTMLButtonElement>('.modal-delete')!.click())
    expect(color).toHaveBeenCalledWith('n1', '#0a84ff')
    expect(del).toHaveBeenCalledWith('n1')
  })
})
