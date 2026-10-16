// @vitest-environment jsdom
//
// A held launch is visible on the board and can be started from it: the card shows the canvas
// node's QUEUED chip, and ▶ asks the board to run it without opening the card.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCard } from './SessionCard'
import type { KanbanSession } from './KanbanView'
import { useLaunchDelivery } from '../../state/launchDelivery'
import { toKanbanSession } from '../../canvas/toKanbanSession'
import type { CanvasNode } from '../../state/workspace'

vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

const queued: KanbanSession = {
  id: 'n1',
  title: 'reviewer',
  color: '#fff',
  kind: 'terminal',
  spawn: {},
  pendingLaunch: { after: ['a1'], command: 'claude' }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useLaunchDelivery.setState({ byId: {} })
})

function render(session: KanbanSession, extra: { onRunQueued?: (id: string) => void; onOpen?: (id: string) => void } = {}): void {
  const noop = (): void => {}
  act(() =>
    root.render(
      <SessionCard
        session={session}
        onOpen={extra.onOpen ?? noop}
        onDragStart={noop}
        onDragEnd={noop}
        onDropAt={noop}
        onContext={noop}
        liveLinkSource="local"
        onRunQueued={extra.onRunQueued}
      />
    )
  )
}

describe('SessionCard — QUEUED chip', () => {
  it('shows QUEUED, and ▶ runs the launch without opening the card', () => {
    const onRunQueued = vi.fn()
    const onOpen = vi.fn()
    render(queued, { onRunQueued, onOpen })
    const chip = document.querySelector<HTMLElement>('.kanban-queued')
    expect(chip?.textContent).toContain('QUEUED')
    act(() => chip!.querySelector<HTMLButtonElement>('.term-node__queued-run')!.click())
    expect(onRunQueued).toHaveBeenCalledWith('n1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('no held launch, no chip', () => {
    render({ ...queued, pendingLaunch: undefined }, { onRunQueued: vi.fn() })
    expect(document.querySelector('.kanban-queued')).toBeNull()
  })

  it('a failed delivery reads ⚠ QUEUED; a headless start reads STARTING with ▶ disabled', () => {
    useLaunchDelivery.getState().markFailed('n1', 1)
    render(queued, { onRunQueued: vi.fn() })
    expect(document.querySelector('.kanban-queued')?.textContent).toContain('⚠ QUEUED')
    act(() => useLaunchDelivery.getState().markStarting('n1'))
    expect(document.querySelector('.kanban-queued')?.textContent).toContain('STARTING')
    expect(document.querySelector<HTMLButtonElement>('.term-node__queued-run')?.disabled).toBe(true)
  })

  it('without a run handler the chip shows but has no ▶', () => {
    render(queued)
    expect(document.querySelector('.kanban-queued')).not.toBeNull()
    expect(document.querySelector('.term-node__queued-run')).toBeNull()
  })

  // A node's own first open: `initialCommand` is still set and nothing holds the launch. The node
  // hides its chip while the delivery is merely in flight, and shows ⚠ QUEUED once the delivery
  // loop reports a failure — the card must follow the SAME rule, so it is derived from the node.
  const firstOpenNode = {
    id: 'n1',
    type: 'terminal',
    position: { x: 0, y: 0 },
    data: { title: 'agent', initialCommand: 'claude', pendingLaunch: { command: 'claude', manualOnly: true } }
  } as unknown as CanvasNode

  it("a first open still in flight shows no chip, like the node", () => {
    render(toKanbanSession(firstOpenNode)!, { onRunQueued: vi.fn() })
    expect(document.querySelector('.kanban-queued')).toBeNull()
  })

  it('a first open whose delivery failed shows ⚠ QUEUED, like the node', () => {
    useLaunchDelivery.getState().markFailed('n1', 1)
    render(toKanbanSession(firstOpenNode)!, { onRunQueued: vi.fn() })
    expect(document.querySelector('.kanban-queued')?.textContent).toContain('⚠ QUEUED')
  })
})
