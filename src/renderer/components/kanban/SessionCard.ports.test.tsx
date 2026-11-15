// @vitest-environment jsdom
//
// The card face carries the canvas node header's Ports chip (one component), for a terminal card
// of the project the dev-port scanner covers. Opening a port is the board handing over to the
// canvas, never opening the card.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCard } from './SessionCard'
import type { KanbanSession } from './KanbanView'

vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../PortsChip', () => ({
  PortsChip: (p: { projectId: string; remote: boolean; onOpenUrl: (url: string) => void }) => (
    <button
      className="ports-mock"
      data-project={p.projectId}
      data-remote={String(p.remote)}
      onClick={(e) => {
        e.stopPropagation()
        p.onOpenUrl('http://localhost:5173')
      }}
    />
  )
}))

const terminal: KanbanSession = { id: 'n1', title: 'dev', color: '#fff', kind: 'terminal', spawn: {} }
const sticky: KanbanSession = { id: 's1', title: 'note', color: '#fff', kind: 'sticky', text: '', spawn: {} }
const ports = { projectId: 'p1', remote: true }

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
})

function render(session: KanbanSession, extra: { ports?: typeof ports; onOpenPort?: (id: string, url: string) => void; onOpen?: (id: string) => void } = {}): void {
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
        ports={extra.ports}
        onOpenPort={extra.onOpenPort}
      />
    )
  )
}

describe('SessionCard — Ports chip', () => {
  it('a terminal card of the scanned project shows the chip for that project', () => {
    render(terminal, { ports, onOpenPort: vi.fn() })
    const chip = document.querySelector<HTMLElement>('.ports-mock')
    expect(chip?.dataset.project).toBe('p1')
    expect(chip?.dataset.remote).toBe('true')
  })

  it('no chip without the scanned project (an Omni lane of a background project)', () => {
    render(terminal, { onOpenPort: vi.fn() })
    expect(document.querySelector('.ports-mock')).toBeNull()
  })

  it('no chip on a note', () => {
    render(sticky, { ports, onOpenPort: vi.fn() })
    expect(document.querySelector('.ports-mock')).toBeNull()
  })

  it('opening a port hands the node and url over, and does not open the card', () => {
    const onOpenPort = vi.fn()
    const onOpen = vi.fn()
    render(terminal, { ports, onOpenPort, onOpen })
    act(() => document.querySelector<HTMLButtonElement>('.ports-mock')!.click())
    expect(onOpenPort).toHaveBeenCalledWith('n1', 'http://localhost:5173')
    expect(onOpen).not.toHaveBeenCalled()
  })
})
