// @vitest-environment jsdom
//
// The worktree frame's pull-request suggestion. The rule under test is "suggest, never adopt": the
// frame may ASK, and only a click writes a link — a wrong guess must cost a dismissed prompt, not
// a wrong chip on someone's canvas.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubBranchPull, GitHubLink } from '@shared/github-issues'
import { useProjects } from '../state/projects'
import { useGitHubLinks } from '../state/githubLinks'
import { setGitHubLinkHandler } from '../canvas/githubLinkActions'

vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  useReactFlow: () => ({ updateNodeData: vi.fn(), setNodes: vi.fn() })
}))

const { pullsForBranch, gitStatus } = vi.hoisted(() => ({ pullsForBranch: vi.fn(), gitStatus: vi.fn() }))
vi.mock('../session/session', async () => {
  const { createContext } = await import('react')
  const api = { githubIssues: { pullsForBranch }, git: { status: gitStatus } }
  return {
    SessionContext: createContext({ api }),
    useSession: () => ({ api }),
    activeSessionApi: () => api
  }
})

import { GroupNode } from './GroupNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// This environment's localStorage is a partial shim; dismissals need a real read/write pair.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear()
  }
})

// jsdom has no IntersectionObserver. This one reports only when a test says the frame moved, so
// "not on screen yet" is the state a frame mounts in, exactly as in the app.
const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
class FakeIntersectionObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observers.push(callback)
  }
  observe(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: FakeIntersectionObserver
})
const onScreen = async (isIntersecting = true): Promise<void> => {
  await act(async () => {
    for (const callback of observers) callback([{ isIntersecting }])
    await Promise.resolve()
  })
}

const GROUP_ID = 'group-1'
const pull = (number: number, over: Partial<GitHubBranchPull> = {}): GitHubBranchPull => ({
  number,
  title: `PR ${number}`,
  draft: false,
  head: 'feat',
  updatedAt: '2026-08-09T10:00:00Z',
  htmlUrl: `https://github.com/o/r/pull/${number}`,
  state: 'open',
  ...over
})

const setProject = (options: { repository?: string; ssh?: boolean } = {}): void => {
  useProjects.setState({
    activeProjectId: 'p1',
    projects: [{
      id: 'p1',
      name: 'P',
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      ...(options.ssh ? { ssh: { server: { host: 'h', user: 'u' } } } : {}),
      ...(options.repository !== undefined
        ? { kanban: { columns: [], assignments: [], github: { repository: options.repository, columnMappings: [] } } }
        : {})
    }]
  } as never)
}

let host: HTMLDivElement
let root: Root

const render = (options: { worktree?: boolean; github?: GitHubLink[] } = {}): void => {
  const props = {
    id: GROUP_ID,
    data: {
      title: 'wt',
      color: '#888',
      ...(options.github ? { github: options.github } : {}),
      ...(options.worktree === false
        ? {}
        : { worktree: { repoPath: '/repo', path: '/repo/wt', branch: 'feat', baseRef: 'main' } })
    },
    selected: false
  } as unknown as Parameters<typeof GroupNode>[0]
  act(() => root.render(<GroupNode {...props} />))
}

const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
/** Render and bring the frame on screen — the state every suggestion test starts from. */
const show = async (options: Parameters<typeof render>[0] = {}): Promise<void> => {
  render(options)
  await onScreen()
  await settle()
}
const row = (): HTMLElement | null => host.querySelector('.group-node__pr-suggest')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  observers.length = 0
  gitStatus.mockReset()
  gitStatus.mockRejectedValue(new Error('no git in this test'))
  pullsForBranch.mockReset()
  pullsForBranch.mockResolvedValue({ ok: true, pulls: [pull(7)], fetchedAt: 1, fromCache: false })
  useGitHubLinks.setState({
    cards: {}, pending: {}, missing: {}, backoff: {}, gate: {}, pullSuggestions: {}, dismissed: new Set()
  })
  localStorage.clear()
  setProject({ repository: 'o/r' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setGitHubLinkHandler(null)
})

describe('worktree frame pull-request suggestion', () => {
  it('asks nothing while off screen, then once when shown, and not again on a timer', async () => {
    vi.useFakeTimers()
    render()
    await settle()
    expect(pullsForBranch).not.toHaveBeenCalled()

    await onScreen()
    await settle()
    expect(pullsForBranch).toHaveBeenCalledTimes(1)
    expect(pullsForBranch).toHaveBeenCalledWith({ projectId: 'p1', branch: 'feat' })

    await onScreen(false)
    await onScreen(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(pullsForBranch).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('renders the suggestion and writes NOTHING until Attach is clicked', async () => {
    const attach = vi.fn()
    setGitHubLinkHandler({ attach, detach: vi.fn(), set: vi.fn(), openPicker: vi.fn(), openDetails: vi.fn() })
    await show()
    expect(row()?.textContent).toContain('PR #7 open')
    expect(attach).not.toHaveBeenCalled()

    const button = [...host.querySelectorAll('.group-node__pr-suggest button')]
      .find((b) => b.textContent === 'Attach')!
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(attach).toHaveBeenCalledWith(GROUP_ID, { kind: 'pull', number: 7, title: 'PR 7' }, undefined)
  })

  it('a draft says so, and several open PRs open the picker instead of guessing', async () => {
    const openPicker = vi.fn()
    setGitHubLinkHandler({ attach: vi.fn(), detach: vi.fn(), set: vi.fn(), openPicker, openDetails: vi.fn() })
    pullsForBranch.mockResolvedValue({
      ok: true, pulls: [pull(7), pull(8, { draft: true })], fetchedAt: 1, fromCache: false
    })
    await show()
    expect(row()?.textContent).toContain('2 open PRs')
    const button = [...host.querySelectorAll('.group-node__pr-suggest button')]
      .find((b) => b.textContent === 'Attach')!
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openPicker).toHaveBeenCalledTimes(1)
    const [nodeId, , projectId, options] = openPicker.mock.calls[0]
    expect(nodeId).toBe(GROUP_ID)
    expect(projectId).toBeUndefined()
    expect(options.kindFilter).toBe('pull')
    expect(options.preset.map((card: { number: number; pull?: { draft: boolean } }) =>
      [card.number, card.pull?.draft])).toEqual([[8, true], [7, false]])
  })

  it('says a failed check failed, and Retry asks again with force', async () => {
    pullsForBranch.mockResolvedValueOnce({ ok: false, reason: 'failed' })
    await show()
    expect(row()?.textContent).toContain('PR check failed')

    const retry = [...host.querySelectorAll('.group-node__pr-suggest button')]
      .find((b) => b.textContent === 'Retry')!
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(pullsForBranch).toHaveBeenLastCalledWith({ projectId: 'p1', branch: 'feat', force: true })
    expect(row()?.textContent).toContain('PR #7 open')
  })

  it('a dismissal survives a remount, and is remembered per frame', async () => {
    await show()
    const dismiss = [...host.querySelectorAll('.group-node__pr-suggest button')]
      .find((b) => b.textContent === '×')!
    act(() => dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(row()).toBeNull()
    expect(JSON.parse(localStorage.getItem('nodeterm.prSuggestDismissed')!))
      .toEqual([`p1:${GROUP_ID}:7`])

    act(() => root.unmount())
    root = createRoot(host)
    await show()
    expect(row()).toBeNull()
  })

  it('hides a pull request the frame already links', async () => {
    await show({ github: [{ kind: 'pull', number: 7 }] })
    expect(row()).toBeNull()
  })

  it('fetches nothing on an SSH project, or without a repository, or without a worktree', async () => {
    setProject({ repository: 'o/r', ssh: true })
    await show()
    setProject({})
    await show()
    setProject({ repository: 'o/r' })
    await show({ worktree: false })
    expect(pullsForBranch).not.toHaveBeenCalled()
  })
})
