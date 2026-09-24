// @vitest-environment jsdom
//
// The card right-click menu carries the node's account-switch rows — the SAME builder the canvas
// node menu uses (Canvas `accountSwitchRows`), passed in as `accountMenuItems`. A card is a second
// view of its node, so the switch must be reachable from the board without going back to the canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KanbanView, type KanbanSession } from './KanbanView'
import { defaultKanban } from '../../lib/kanban'
import type { MenuItem } from '../ContextMenu'

vi.mock('../../session/session', () => ({
  useSession: () => ({ source: 'local', api: window.nodeTerminal })
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

function render(accountMenuItems?: (id: string) => MenuItem[]): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  act(() =>
    root.render(
      <KanbanView
        board={defaultKanban()}
        sessions={[session]}
        onChange={noop}
        onOpenNode={noop}
        onCreateNode={noop}
        onRenameNode={noop}
        onEditSticky={noop}
        onDeleteNode={noop}
        onModalNodeChange={noop}
        onBrowserNav={noop}
        onSetIcon={noop}
        accountMenuItems={accountMenuItems}
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

describe('KanbanView — card menu account switch', () => {
  it('shows the node’s account-switch rows, built for that card’s node', () => {
    const rows = vi.fn((id: string): MenuItem[] => [
      { label: `Switch Claude account (${id})`, onClick: () => {} }
    ])
    render(rows)
    openCardMenu()
    expect(rows).toHaveBeenCalledWith('n1')
    expect(document.body.textContent).toContain('Switch Claude account (n1)')
  })

  it('shows none without a builder (no canvas behind the board)', () => {
    render()
    openCardMenu()
    expect(document.body.textContent).toContain('Open card')
    expect(document.body.textContent).not.toContain('Switch Claude account')
  })
})
