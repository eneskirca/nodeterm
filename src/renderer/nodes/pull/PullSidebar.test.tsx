// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { PullSidebar as Sidebar } from '@shared/github-pull-sidebar'
import { ISSUE_OPEN_EVENT } from '../../lib/openIssueNode'
import { PullSidebar } from './PullSidebar'
import type { PullNodeApi } from './shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user = (id: number, login: string) => ({ id, login, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` })
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: user(1, 'octocat'),
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}
const sidebar: Sidebar = {
  reviewers: [{ user: user(3, 'cy'), state: 'approved' }, { user: user(2, 'ana'), state: 'pending', previous: 'changes-requested' }],
  assignees: [user(4, 'dee')],
  labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: 'fef2c0' }],
  closingIssues: [
    { repository: 'o/r', number: 12, title: 'Crash on load', state: 'open' },
    { repository: 'x/y', number: 3, title: 'Elsewhere', state: 'closed' }
  ],
  participants: [user(1, 'octocat'), user(3, 'cy')]
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(d: GitHubPullDetail, onOpenExternal = vi.fn(), onWritten = vi.fn()) {
  const api = {
    repoCollaborators: vi.fn(async () => ({ status: 'ok' as const, users: [] })),
    requestPullReviewer: vi.fn(async () => ({ ok: true as const }))
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullSidebar api={api as unknown as PullNodeApi} projectId="p" pull={{ repository: 'O/R', pullNumber: 7, tab: 'conversation' }}
      refreshTick={0} onOpenExternal={onOpenExternal} onWritten={onWritten} detail={d} />)
  })
  return { view: host, api, onOpenExternal, onWritten }
}

const rowText = (view: HTMLElement, label: string) =>
  [...view.querySelectorAll('.pull-sidebar__row')].find((row) => row.textContent?.startsWith(label))?.textContent

describe('PullSidebar', () => {
  it('shows each reviewer state, a re-request as pending, assignees, label chips and participants', async () => {
    const { view } = await render({ ...detail, sidebar })
    const reviewers = view.querySelector('.pull-reviewers')?.textContent
    expect(reviewers).toContain('cyApproved')
    expect(reviewers).toContain('anaPending (was changes requested)')
    expect(rowText(view, 'Assignees')).toContain('dee')
    const chips = [...view.querySelectorAll('.pull-label')] as HTMLElement[]
    expect(chips.map((chip) => chip.textContent)).toEqual(['bug', 'docs'])
    expect(chips[0].style.color).toBe('rgb(255, 255, 255)')
    expect(chips[1].style.color).toBe('rgb(31, 35, 40)')
    expect(view.querySelectorAll('.pull-sidebar__row:last-child .pull-avatar')).toHaveLength(2)
  })

  it('re-requests a review from a reviewer who answered, with the existing write', async () => {
    const { view, api, onWritten } = await render({ ...detail, sidebar })
    expect(view.querySelector('[aria-label="Re-request review from ana"]')).toBeNull()
    await act(async () => { (view.querySelector('[aria-label="Re-request review from cy"]') as HTMLButtonElement).click() })
    expect(api.requestPullReviewer).toHaveBeenCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, reviewer: 'cy' })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('opens a linked issue of this repository in the Issues node, and one elsewhere on GitHub', async () => {
    const opened = vi.fn()
    const listener = (event: Event) => opened((event as CustomEvent).detail)
    window.addEventListener(ISSUE_OPEN_EVENT, listener)
    const { view, onOpenExternal } = await render({ ...detail, sidebar })
    const [here, elsewhere] = [...view.querySelectorAll('.pull-sidebar__issue')] as HTMLButtonElement[]
    expect(here.textContent).toContain('#12 Crash on load')
    act(() => here.click())
    expect(opened).toHaveBeenCalledWith({ repository: 'O/R', issueNumber: 12 })
    act(() => elsewhere.click())
    expect(onOpenExternal).toHaveBeenCalledWith('https://github.com/x/y/issues/3')
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(ISSUE_OPEN_EVENT, listener)
  })

  it('hides a part the read could not answer, and falls back to requested reviewers without a sidebar', async () => {
    const { view } = await render({ ...detail, requestedReviewers: [user(2, 'ana')] })
    expect(view.querySelectorAll('.pull-sidebar__row')).toHaveLength(0)
    expect(view.querySelector('.pull-reviewers')?.textContent).toContain('anaPending')
  })
})
