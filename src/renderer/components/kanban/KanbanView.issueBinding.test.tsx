// @vitest-environment jsdom
//
// The board side of "Start with agent" on a GitHub issue card: the issue card shows every session
// bound to it as a live chip, a session card shows its `#N`, the issue card's menu offers the
// canvas's own agent picker — and a hook `done` never moves any card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GitHubIssueCardView, GitHubIssuePage } from '@shared/github-issues'
import type { ProjectKanban } from '@shared/types'
import { KanbanView, type KanbanSession } from './KanbanView'
import { defaultKanban } from '../../lib/kanban'
import type { MenuItem } from '../ContextMenu'
import { useAgentStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import { useViewMode } from '../../state/viewMode'
import { useGitHubIssues } from '../../state/githubIssues'

vi.mock('../../session/session', () => ({
  useSession: () => ({ source: 'local', api: window.nodeTerminal })
}))

const ISSUE: GitHubIssueCardView = {
  id: 9001, number: 42, title: 'Parser drops the last line', body: 'body text', state: 'open',
  stateReason: null, htmlUrl: 'https://github.com/eneskirca/nodeterm/issues/42',
  apiUrl: 'https://api.github.com/repos/eneskirca/nodeterm/issues/42', labels: [], assignees: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', locked: false,
  columnId: null, conflict: null
}

const page = (items: GitHubIssueCardView[]): GitHubIssuePage => ({
  items, counts: { ungrouped: items.length }, partial: false, readOnly: false
})

const bound = {
  id: 'term-bound',
  title: 'Claude',
  color: '#fff',
  kind: 'terminal',
  agentId: 'claude',
  issueRef: { owner: 'eneskirca', repo: 'nodeterm', number: 42 },
  spawn: {}
} as unknown as KanbanSession

let root: Root
let host: HTMLElement
let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  openExternal = vi.fn(async () => {})
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { read: async () => ({ entries: [] }), onChanged: () => () => {}, append: async () => true },
    settings: { save: async () => {} },
    shell: { openExternal },
    githubIssues: {
      subscribe: async () => page([ISSUE]),
      unsubscribe: async () => {},
      query: async (q: { kind?: string; columnId: string | null }) =>
        q.kind === 'pull' || q.columnId !== null ? page([]) : page([ISSUE]),
      onChanged: () => () => {}
    }
  }
  useAgentStatus.setState({ byId: {} })
  useProjects.setState({ activeProjectId: 'p1' })
  useViewMode.setState({ requestedIssue: null, requestedCardNodeId: null })
  useGitHubIssues.setState({ projects: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(opts: {
  board?: ProjectKanban
  sessions?: KanbanSession[]
  onChange?: (b: ProjectKanban) => void
  issueAgentMenu?: (issue: GitHubIssueCardView) => MenuItem[]
  issueWorktreeMenu?: (issue: GitHubIssueCardView) => { items: MenuItem[] } | { refusal: string }
}): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const noop = (): void => {}
  await act(async () => {
    root.render(
      <KanbanView
        board={opts.board ?? { ...defaultKanban('p'), github: { columnMappings: [] } }}
        sessions={opts.sessions ?? [bound]}
        onChange={opts.onChange ?? noop}
        onOpenNode={noop}
        onCreateNode={noop}
        onRenameNode={noop}
        onEditSticky={noop}
        onDeleteNode={noop}
        onModalNodeChange={noop}
        onBrowserNav={noop}
        onSetIcon={noop}
        issueAgentMenu={opts.issueAgentMenu}
        issueWorktreeMenu={opts.issueWorktreeMenu}
      />
    )
  })
  // Let the GitHub lane connect and page.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const issueCard = (): HTMLElement =>
  document.querySelector<HTMLElement>('.kanban-card--github')!

describe('KanbanView — GitHub issue ↔ session binding', () => {
  it('shows the bound session as a live chip on the issue card, following its state', async () => {
    await render({})
    const chip = (): HTMLElement => issueCard().querySelector<HTMLElement>('.issue-run-chip')!
    expect(chip()).not.toBeNull()
    act(() => useAgentStatus.setState({ byId: { 'term-bound': { state: 'working', unread: false } } }))
    expect(chip().textContent).toContain('RUNNING')
    act(() => useAgentStatus.setState({ byId: { 'term-bound': { state: 'waiting', unread: false } } }))
    expect(chip().textContent).toContain('NEEDS YOU')
  })

  it('a hook `done` never moves a card — it only quiets the chip', async () => {
    const onChange = vi.fn()
    await render({ onChange })
    act(() => useAgentStatus.setState({ byId: { 'term-bound': { state: 'working', unread: false } } }))
    act(() => useAgentStatus.setState({ byId: { 'term-bound': { state: 'done', unread: true } } }))
    expect(issueCard().querySelector<HTMLElement>('.issue-run-chip')!.dataset.state).toBe('idle')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('an issue nobody works on draws no chips', async () => {
    await render({ sessions: [] })
    expect(issueCard().querySelector('.issue-run-chip')).toBeNull()
  })

  it('the issue card menu offers the canvas agent picker under "Start with agent"', async () => {
    const pick = vi.fn()
    const menu = vi.fn((issue: GitHubIssueCardView): MenuItem[] => [
      { label: 'Claude', onClick: () => pick(issue.number) }
    ])
    await render({ issueAgentMenu: menu })
    act(() => {
      issueCard().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    })
    expect(document.body.textContent).toContain('Start with agent')
    expect(menu).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }))
  })

  it('the issue card menu offers "Start with agent in a new worktree ▸" with the same picker', async () => {
    const pick = vi.fn()
    const menu = vi.fn((issue: GitHubIssueCardView) => ({
      items: [{ label: 'Claude', onClick: () => pick(issue.number) }] as MenuItem[]
    }))
    await render({ issueAgentMenu: () => [], issueWorktreeMenu: menu })
    act(() => {
      issueCard().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    })
    expect(menu).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }))
    const row = [...document.body.querySelectorAll<HTMLElement>('.ctx-item--submenu')].find((el) =>
      el.textContent?.includes('Start with agent in a new worktree')
    )
    expect(row).toBeDefined()
    act(() => {
      row!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const claude = [...document.body.querySelectorAll<HTMLElement>('.ctx-item')].filter((el) =>
      el.textContent === 'Claude'
    )
    act(() => claude[claude.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(pick).toHaveBeenCalledWith(42)
  })

  it('a project that cannot take a worktree shows the row DISABLED with its reason, never hides it', async () => {
    await render({
      issueAgentMenu: () => [],
      issueWorktreeMenu: () => ({ refusal: 'Not supported in SSH projects yet' })
    })
    act(() => {
      issueCard().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    })
    const row = [...document.body.querySelectorAll<HTMLElement>('.ctx-item')].find((el) =>
      el.textContent?.includes('Start with agent in a new worktree')
    )
    expect(row).toBeDefined()
    expect(row!.getAttribute('title')).toBe('Not supported in SSH projects yet')
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it("a session card's #N opens that issue's summary on the board", async () => {
    await render({})
    const chip = document.querySelector<HTMLElement>('.kanban-card--session .issue-ref-chip')!
    expect(chip.textContent).toBe('#42')
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('.github-issue-modal')?.textContent).toContain('Parser drops the last line')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('an issue the board cannot show opens on GitHub instead of doing nothing', async () => {
    await render({ board: defaultKanban('p') })
    await act(async () => {
      useViewMode.getState().requestIssue({ owner: 'other', repo: 'repo', number: 7 })
    })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/other/repo/issues/7')
    expect(useViewMode.getState().requestedIssue).toBeNull()
  })
})
