// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClosedHistorySection } from './ClosedHistorySection'
import type { Project } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const projects: Project[] = [
  {
    id: 'p1', name: 'closed-proj', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    closed: true, closedAt: 100
  },
  {
    id: 'p2', name: 'open-proj', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    closedSessions: [{
      id: 'e1', closedAt: 200,
      node: { id: 'n1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'my shell', color: '#fff', group: null, cwd: '/tmp/x' },
      absolutePosition: { x: 0, y: 0 }
    }]
  }
]

const noop = () => {}
const baseProps = {
  nowMs: 1000, collapsed: false, onToggleCollapse: noop,
  onReopenProject: noop, onDeleteProject: noop, onReopenSession: noop, onDiscardSession: noop
}

describe('ClosedHistorySection', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  it('renders nothing when there is no history', async () => {
    await render(
      <ClosedHistorySection
        {...baseProps}
        projects={[{ id: 'p3', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }]}
      />
    )
    expect(host.innerHTML).toBe('')
  })

  it('renders closed projects and closed sessions, one reopenable row each', async () => {
    await render(<ClosedHistorySection {...baseProps} projects={projects} />)
    const rows = host.querySelectorAll('.sessions-sidebar__history-item')
    expect(rows).toHaveLength(2)
    expect(host.textContent).toContain('my shell')
    expect(host.textContent).toContain('closed-proj')
  })

  it('renders a project row glyph with the sidebar\'s own monogram class', async () => {
    // ProjectGlyph carries no box CSS of its own — "every wired call site passes its own
    // className" — so without this the monogram fallback is a bare colored span, not the 18px
    // circular badge every other project row in this sidebar shows.
    await render(<ClosedHistorySection {...baseProps} projects={projects} />)
    const projectRow = Array.from(host.querySelectorAll('.sessions-sidebar__history-item'))
      .find((el) => el.textContent?.includes('closed-proj'))
    expect(projectRow?.querySelector('.ss-group__monogram')).toBeTruthy()
  })

  it('calls onReopenSession with projectId+entryId on click', async () => {
    const onReopenSession = vi.fn()
    await render(<ClosedHistorySection {...baseProps} projects={projects} onReopenSession={onReopenSession} />)
    const sessionRow = Array.from(host.querySelectorAll('.sessions-sidebar__history-item'))
      .find((el) => el.textContent?.includes('my shell'))
    expect(sessionRow).toBeDefined()
    await act(async () => sessionRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onReopenSession).toHaveBeenCalledWith('p2', 'e1')
  })

  it('calls onDiscardSession from its × without also triggering reopen', async () => {
    const onReopenSession = vi.fn()
    const onDiscardSession = vi.fn()
    await render(
      <ClosedHistorySection
        {...baseProps} projects={projects}
        onReopenSession={onReopenSession} onDiscardSession={onDiscardSession}
      />
    )
    const del = host.querySelector('.sessions-sidebar__history-del[aria-label="Discard"]') as HTMLElement
    expect(del).toBeTruthy()
    await act(async () => del.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDiscardSession).toHaveBeenCalledWith('p2', 'e1')
    expect(onReopenSession).not.toHaveBeenCalled()
  })

  it('pressing Enter on the × keyboard-activates discard without also triggering reopen', async () => {
    // A real browser synthesizes a `click` on a focused <button> when Enter/Space is pressed,
    // AFTER the keydown has already bubbled (a keydown handler's stopPropagation cannot stop a
    // separate click event from firing). jsdom's dispatchEvent does not synthesize that click for
    // us, so both events are dispatched explicitly here to reproduce the real sequence: the
    // keydown must not reach the row's onKeyDown (which would fire reopen), and the button's own
    // onClick still fires discard as it always did for a mouse click.
    const onReopenSession = vi.fn()
    const onDiscardSession = vi.fn()
    await render(
      <ClosedHistorySection
        {...baseProps} projects={projects}
        onReopenSession={onReopenSession} onDiscardSession={onDiscardSession}
      />
    )
    const del = host.querySelector('.sessions-sidebar__history-del[aria-label="Discard"]') as HTMLElement
    expect(del).toBeTruthy()
    await act(async () => {
      del.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDiscardSession).toHaveBeenCalledWith('p2', 'e1')
    expect(onReopenSession).not.toHaveBeenCalled()
  })

  it('collapsed hides the row list but keeps the header', async () => {
    await render(<ClosedHistorySection {...baseProps} projects={projects} collapsed={true} />)
    expect(host.textContent).toContain('Recently closed')
    expect(host.textContent).not.toContain('my shell')
  })
})
