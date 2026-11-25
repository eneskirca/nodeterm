// @vitest-environment jsdom
//
// The subagent rows under an agent session: one row per card the canvas draws for that node (the
// same store), a click asks the canvas to open that card, and a row re-renders only when ITS node's
// cards change. Then the sidebar: the rows sit under the session row in both grouping modes, and a
// node with no cards adds nothing under its row.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import { SubagentRows } from './SubagentRows'
import { useAgentNodes } from '../state/agentNodes'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { createSession, setActiveSession, SessionProvider, resetSessionsForTest } from '../session/session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function start(id: string, parentNodeId: string, type: string, label: string, startedAt: number): void {
  useAgentNodes.getState().start(id, { parentNodeId, type, label, startedAt })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  for (const p of ['p1', 'p2', 'n-agent', 'n-plain']) useAgentNodes.getState().clearForParent(p)
})

describe('SubagentRows', () => {
  it("renders one row per card of the node, in start order: type · task, a working dot or a done mark", async () => {
    start('a-late', 'p1', 'Explore', 'Map the repo', 20)
    start('a-early', 'p1', 'general-purpose', 'Find the bug', 10)
    useAgentNodes.getState().finish('a-early', { result: 'found it' })
    start('a-other', 'p2', 'Plan', 'Not mine', 5)
    await act(async () => root.render(<SubagentRows parentNodeId="p1" />))
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.ss-subagents .subagent-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.subagent-row__type')!.textContent).toBe('general-purpose')
    expect(rows[0].querySelector('.subagent-row__label')!.textContent).toBe('Find the bug')
    expect(rows[0].querySelector('.subagent-row__done')).not.toBeNull()
    expect(rows[0].querySelector('.nt-spinner')).toBeNull()
    expect(rows[1].querySelector('.subagent-row__type')!.textContent).toBe('Explore')
    // A static dot for the running one — never the spinner (see the frame-loop test below).
    expect(rows[1].querySelector('.subagent-row__working')).not.toBeNull()
    expect(rows[1].querySelector('.nt-spinner')).toBeNull()
    expect(rows[1].querySelector('.subagent-row__done')).toBeNull()
    expect(rows[1].getAttribute('aria-label')).toBe('Explore: Map the repo, working')
  })

  it('a working row animates nothing, in either variant: a subagent runs for minutes (issue #1454)', async () => {
    start('a', 'p1', 'Explore', 'Map it', 1)
    for (const variant of ['sidebar', 'list'] as const) {
      await act(async () => root.render(<SubagentRows parentNodeId="p1" variant={variant} />))
      const row = host.querySelector('.subagent-row--working')!
      expect(row).not.toBeNull()
      expect(row.querySelector('.nt-spinner')).toBeNull()
      expect(row.querySelector('.subagent-row__working')).not.toBeNull()
    }
    // …and no rule these rows or the board chip match declares an animation.
    const css = readFileSync(path.join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
    const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].trim(), body: m[2] }))
      .filter((r) => /subagent-row|ss-subagents|card-subagents|kanban-subagent-chip/.test(r.selector))
    expect(rules.length).toBeGreaterThan(5)
    for (const r of rules) expect(r.body, r.selector).not.toMatch(/animation/)
  })

  it('a node with no cards renders nothing at all', async () => {
    start('a', 'p2', 'Plan', 'x', 1)
    await act(async () => root.render(<SubagentRows parentNodeId="p1" />))
    expect(host.innerHTML).toBe('')
  })

  it('a click asks the canvas to open that card, after the caller has run its own step', async () => {
    start('a089017271138740d', 'p1', 'general-purpose', 'Find the bug', 1)
    const order: string[] = []
    const seen: unknown[] = []
    const listener = (e: Event): void => {
      order.push('event')
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeterm:open-subagent', listener)
    await act(async () => root.render(<SubagentRows parentNodeId="p1" onBeforeOpen={() => order.push('before')} />))
    await act(async () => host.querySelector<HTMLButtonElement>('.subagent-row')!.click())
    window.removeEventListener('nodeterm:open-subagent', listener)
    expect(seen).toEqual([{ parentNodeId: 'p1', cardId: 'a089017271138740d' }])
    expect(order).toEqual(['before', 'event'])
  })

  it("does not re-render for another node's cards, nor for streamed text; it does for its own", async () => {
    start('a', 'p1', 'Explore', 'Mine', 1)
    start('b', 'p2', 'Plan', 'Theirs', 1)
    let renders = 0
    await act(async () =>
      root.render(
        <Profiler id="rows" onRender={() => void renders++}>
          <SubagentRows parentNodeId="p1" />
        </Profiler>
      )
    )
    const base = renders
    await act(async () => {
      useAgentNodes.getState().appendActivity('a', 'streaming…') // text the row does not draw
      useAgentNodes.getState().appendActivity('b', 'streaming…')
      useAgentNodes.getState().finish('b', { result: 'done' }) // another node's card
      start('c', 'p2', 'Explore', 'Also theirs', 2)
      useAgentNodes.getState().select('b')
    })
    expect(renders).toBe(base)
    await act(async () => useAgentNodes.getState().finish('a', { result: 'done' }))
    expect(renders).toBe(base + 1)
    expect(host.querySelector('.subagent-row__done')).not.toBeNull()
  })

  it('redraws a running card relabelled under its own id', async () => {
    start('a', 'p1', 'general-purpose', 'A guess', 1)
    await act(async () => root.render(<SubagentRows parentNodeId="p1" />))
    await act(async () => start('a', 'p1', 'general-purpose', 'The right task', 1))
    expect(host.querySelector('.subagent-row__label')!.textContent).toBe('The right task')
  })

  it("the card modal's list carries a heading and each row's state in words", async () => {
    start('a', 'p1', 'Explore', 'Map it', 1)
    start('b', 'p1', 'Plan', 'Plan it', 2)
    useAgentNodes.getState().finish('b', {})
    await act(async () => root.render(<SubagentRows parentNodeId="p1" variant="list" />))
    const list = host.querySelector('.card-subagents')!
    expect(list.getAttribute('aria-label')).toBe('Subagents')
    expect(list.querySelector('.card-subagents__title')!.textContent).toBe('Subagents')
    expect([...list.querySelectorAll('.subagent-row__state')].map((s) => s.textContent)).toEqual(['working', 'done'])
    // The sidebar row draws the mark, not the word.
    await act(async () => root.render(<SubagentRows parentNodeId="p1" />))
    expect(host.querySelector('.subagent-row__state')).toBeNull()
  })

  it("the card modal's list sums its states in the heading and folds away from it", async () => {
    start('a', 'p1', 'Explore', 'Map it', 1)
    start('b', 'p1', 'Plan', 'Plan it', 2)
    start('c', 'p1', 'Plan', 'Plan more', 3)
    useAgentNodes.getState().finish('b', {})
    useAgentNodes.getState().finish('c', {})
    await act(async () => root.render(<SubagentRows parentNodeId="p1" variant="list" />))
    const header = host.querySelector<HTMLButtonElement>('.card-subagents__header')!
    expect(host.querySelector('.card-subagents__count')!.textContent).toBe('1 working · 2 done')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    // The rows sit in their own (height-capped, scrolling) list, not straight in the section.
    expect(host.querySelectorAll('.card-subagents__list .subagent-row')).toHaveLength(3)
    await act(async () => header.click())
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.card-subagents__list')).toBeNull()
    expect(host.querySelector('.card-subagents__count')!.textContent).toBe('1 working · 2 done')
    await act(async () => header.click())
    expect(host.querySelectorAll('.subagent-row')).toHaveLength(3)
  })
})

describe('the sessions sidebar lists subagents under their session', () => {
  const noop = (): void => {}
  const props: SessionsSidebarProps = {
    open: true, pinned: true, liveActiveNodes: null, onTogglePin: noop, onClose: noop,
    onFocusNode: noop, onCloseSession: noop, onRenameSession: noop, onAiNameSession: noop,
    onRowContextMenu: noop, onProjectContextMenu: noop, onSwitchProject: noop, onAddToProject: noop,
    onMoveToGroup: noop, onAiNameGroup: noop, onReorder: noop, onReorderGroup: noop,
    onReorderProject: noop, onReopenProject: noop, onDeleteProject: noop,
    onReopenClosedSession: noop, onDiscardClosedSession: noop, onOpenClosedTranscript: noop
  }
  const project = {
    id: 'proj',
    cwd: '/repo/proj',
    name: 'proj',
    color: '#fff',
    nodes: [
      { id: 'n-agent', kind: 'terminal', title: 'Claude', color: '#d97757', agentId: 'claude', position: { x: 0, y: 0 } },
      { id: 'n-plain', kind: 'terminal', title: 'Shell', color: '#888', position: { x: 0, y: 500 } }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  } as unknown as Project
  let grouping: 'project' | 'status'

  beforeEach(() => {
    resetSessionsForTest()
    window.nodeTerminal = { sshFs: {} } as NodeTerminalApi
    useProjects.setState({ projects: [project], activeProjectId: 'proj' })
    grouping = useSettings.getState().settings.sidebarGrouping
  })
  afterEach(async () => {
    // Empty the tree before the settings and sessions it reads go away.
    await act(async () => root.render(null))
    useSettings.setState((s) => ({ settings: { ...s.settings, sidebarGrouping: grouping } }))
    resetSessionsForTest()
  })

  async function mountSidebar(mode: 'project' | 'status'): Promise<void> {
    useSettings.setState((s) => ({ settings: { ...s.settings, sidebarGrouping: mode } }))
    const api = { git: { status: vi.fn(async () => ({ hasRepo: false })) }, fs: {} } as unknown as NodeTerminalApi
    const session = createSession('local', api, 'local')
    setActiveSession(session.id)
    await act(async () =>
      root.render(
        <SessionProvider session={session}>
          <SessionsSidebar {...props} />
        </SessionProvider>
      )
    )
  }

  for (const mode of ['project', 'status'] as const) {
    it(`${mode} mode: a relay / team tab's node gets no rows, whatever the local store holds`, async () => {
      // A team tab shares node ids with the SSH project handed to it; the local card store is not
      // its host's, so nothing listed under it may come from there.
      useProjects.setState({ projects: [{ ...project, remote: true } as Project], activeProjectId: 'proj' })
      start('a1', 'n-agent', 'Explore', 'Map the repo', 1)
      await mountSidebar(mode)
      expect(host.querySelector('.ss-row')).not.toBeNull()
      expect(host.querySelector('.ss-subagents')).toBeNull()
    })

    it(`${mode} mode: the rows follow the agent's session row, and only that one`, async () => {
      start('a1', 'n-agent', 'Explore', 'Map the repo', 1)
      start('a2', 'n-agent', 'Plan', 'Plan the fix', 2)
      await mountSidebar(mode)
      const lists = [...host.querySelectorAll('.ss-subagents')]
      expect(lists).toHaveLength(1)
      // Directly under the agent's session row, inside the same row wrapper.
      const row = lists[0].previousElementSibling!
      expect(row.classList.contains('ss-row')).toBe(true)
      expect(row.textContent).toContain('Claude')
      expect(lists[0].querySelectorAll('.subagent-row')).toHaveLength(2)
      // The plain terminal's wrapper holds its row and nothing else.
      const plain = [...host.querySelectorAll('.ss-rowdrop')].find((w) => w.textContent!.includes('Shell'))!
      expect(plain.children).toHaveLength(1)
    })
  }
})
