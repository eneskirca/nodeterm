// @vitest-environment jsdom
//
// The board is the canvas's other view of the same nodes: a session card says how many subagent
// cards its node has on the canvas (the running ones emphasized), and says nothing while it has none.
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCard } from './SessionCard'
import type { KanbanSession } from './KanbanView'
import { useAgentNodes } from '../../state/agentNodes'

vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const terminal: KanbanSession = { id: 'n1', title: 'Claude', color: '#fff', kind: 'terminal', agentId: 'claude', spawn: {} }
const sticky: KanbanSession = { id: 'n1', title: 'Note', color: '#fff', kind: 'sticky', text: 'x', spawn: {} }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useAgentNodes.getState().clearForParent('n1')
  useAgentNodes.getState().clearForParent('n2')
})

function render(session: KanbanSession, onOpen = vi.fn(), relayProject?: boolean): void {
  const noop = (): void => {}
  act(() =>
    root.render(
      <SessionCard
        session={session}
        onOpen={onOpen}
        onDragStart={noop}
        onDragEnd={noop}
        onDropAt={noop}
        onContext={noop}
        relayProject={relayProject}
      />
    )
  )
}

const chip = (): HTMLElement | null => host.querySelector('.kanban-subagent-chip')

describe('SessionCard — subagent chip', () => {
  it('is absent while the node has no subagent cards (another node having some changes nothing)', () => {
    useAgentNodes.getState().start('x', { parentNodeId: 'n2', type: 'Plan' })
    render(terminal)
    expect(chip()).toBeNull()
  })

  it('counts the cards and emphasizes the running ones; it follows the store', () => {
    useAgentNodes.getState().start('a', { parentNodeId: 'n1', type: 'Explore', startedAt: 1 })
    useAgentNodes.getState().start('b', { parentNodeId: 'n1', type: 'Plan', startedAt: 2 })
    useAgentNodes.getState().start('c', { parentNodeId: 'n1', type: 'Plan', startedAt: 3 })
    useAgentNodes.getState().finish('c', {})
    render(terminal)
    expect(chip()!.textContent).toBe('3 subagents · 2 working')
    expect(chip()!.querySelector('.kanban-subagent-chip__working')!.textContent).toBe('2 working')
    act(() => {
      useAgentNodes.getState().finish('a', {})
      useAgentNodes.getState().finish('b', {})
    })
    // All finished: the count stays while the cards do, with nothing emphasized.
    expect(chip()!.textContent).toBe('3 subagents')
    expect(chip()!.querySelector('.kanban-subagent-chip__working')).toBeNull()
    act(() => useAgentNodes.getState().clearForParent('n1'))
    expect(chip()).toBeNull()
  })

  it('says "subagent" for one, and is not a control: a click on it opens the card', () => {
    useAgentNodes.getState().start('a', { parentNodeId: 'n1', type: 'Explore' })
    const onOpen = vi.fn()
    render(terminal, onOpen)
    expect(chip()!.textContent).toBe('1 subagent · 1 working')
    act(() => chip()!.click())
    expect(onOpen).toHaveBeenCalledWith('n1')
  })

  it('a note card never shows it', () => {
    useAgentNodes.getState().start('a', { parentNodeId: 'n1', type: 'Explore' })
    render(sticky)
    expect(chip()).toBeNull()
  })

  it("a relay / team project's card never shows it: the card store is this machine's", () => {
    useAgentNodes.getState().start('a', { parentNodeId: 'n1', type: 'Explore' })
    render(terminal, vi.fn(), true)
    expect(chip()).toBeNull()
    render(terminal, vi.fn(), false)
    expect(chip()).not.toBeNull()
  })
})

describe('both boards tell the card whether its project is a relay / team tab', () => {
  const src = (f: string): string => readFileSync(join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')
  for (const f of ['KanbanView.tsx', 'GlobalKanbanView.tsx']) {
    it(f, () => {
      const s = src(f)
      expect(s).toContain('const relayProject = useProjects((s) => !!s.getProject(projectId)?.remote)')
      const card = s.slice(s.indexOf('<SessionCard'), s.indexOf('/>', s.indexOf('<SessionCard')))
      expect(card).toContain('relayProject={relayProject}')
    })
  }
})
