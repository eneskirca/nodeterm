// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { useProjects } from '../../state/projects'
import { useGitHubLinks } from '../../state/githubLinks'
import { setGitHubLinkHandler } from '../../canvas/githubLinkActions'
import { GitHubLinkChip } from './GitHubLinkChip'

const openExternal = vi.fn()
vi.mock('../../session/session', () => ({
  useSession: () => ({
    api: {
      shell: { openExternal: (url: string) => openExternal(url) },
      githubIssues: { lookup: vi.fn(async () => ({ ok: false, reason: 'not-found' })) }
    }
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no ResizeObserver; the menu's edge-flip hook observes itself.
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

const card = (number: number, over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: number,
  number,
  title: `Item ${number}`,
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`,
  apiUrl: `https://api.github.com/repos/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  locked: false,
  columnId: null,
  conflict: null,
  ...over
})

const withRepository = (repository?: string): void => {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{
      id: 'p1',
      name: 'P',
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      ...(repository ? { kanban: { columns: [], assignments: [], github: { repository, columnMappings: [] } } } : {})
    }]
  } as never)
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useGitHubLinks.setState({ cards: {}, pending: {}, missing: {}, gate: {} })
  withRepository('o/r')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setGitHubLinkHandler(null)
  vi.clearAllMocks()
})

const render = (links: Parameters<typeof GitHubLinkChip>[0]['links']): void => {
  act(() => root.render(<GitHubLinkChip nodeId="n1" links={links} variant="node" />))
}

describe('GitHubLinkChip', () => {
  it('labels the first link and counts the rest', () => {
    render([{ kind: 'issue', number: 12 }, { kind: 'pull', number: 3 }])
    expect(host.querySelector('.github-link-chip')?.textContent).toBe('#12 +1')
  })

  it('paints the dot from the cached card', () => {
    useGitHubLinks.setState({ cards: { p1: { 'issue#12': { card: card(12, { state: 'closed' }), at: Date.now() } } } })
    render([{ kind: 'issue', number: 12 }])
    expect(host.querySelector('.github-link-chip__dot')?.className).toContain('--closed')
  })

  it('renders nothing without links, and nothing without a repository', () => {
    render([])
    expect(host.querySelector('.github-link-chip')).toBeNull()
    withRepository(undefined)
    render([{ kind: 'issue', number: 12 }])
    expect(host.querySelector('.github-link-chip')).toBeNull()
  })

  it('opens a menu whose actions reach the canvas handler', () => {
    const detach = vi.fn()
    const openPicker = vi.fn()
    setGitHubLinkHandler({ attach: vi.fn(), detach, openPicker, openDetails: vi.fn() })
    render([{ kind: 'pull', number: 3, title: 'Ship' }])
    act(() => {
      host.querySelector('.github-link-chip')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const labels = [...document.querySelectorAll('.ctx-menu button')].map((b) => b.textContent)
    expect(labels).toEqual(expect.arrayContaining([
      'Open #3 details', 'Open #3 on GitHub', 'Detach #3', 'Attach another…'
    ]))

    const detachRow = [...document.querySelectorAll('.ctx-menu button')]
      .find((b) => b.textContent === 'Detach #3')!
    act(() => detachRow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(detach).toHaveBeenCalledWith('n1', { kind: 'pull', number: 3, title: 'Ship' })
  })

  it('opens the item on github.com through the shell, at its own kind’s path', () => {
    setGitHubLinkHandler({ attach: vi.fn(), detach: vi.fn(), openPicker: vi.fn(), openDetails: vi.fn() })
    render([{ kind: 'pull', number: 3 }])
    act(() => {
      host.querySelector('.github-link-chip')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const row = [...document.querySelectorAll('.ctx-menu button')]
      .find((b) => b.textContent === 'Open #3 on GitHub')!
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/3')
  })
})
