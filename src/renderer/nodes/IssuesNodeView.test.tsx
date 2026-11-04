// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { GitHubPullTimelineResult, PullTimelineItem } from '@shared/github-pull-timeline'
import { IssuesNodeView, type IssuesNodeApi } from './IssuesNodeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const issue = (number: number, over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: number, number, title: `Issue ${number}`, body: '', state: 'open', stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`, apiUrl: '', labels: [], assignees: [],
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', locked: false, columnId: null, conflict: null,
  ...over
})

function fakeApi(items: GitHubIssueCardView[], timeline: GitHubPullTimelineResult = {
  status: 'ok', items: [], openedAt: '2026-10-01T10:00:00Z', observedAt: 1
}) {
  return {
    refresh: vi.fn(async (_projectId: string) => {}),
    query: vi.fn(async () => ({ items, counts: {}, partial: false, readOnly: true })),
    issueTimeline: vi.fn(async (_p: string, _r: string, _n: number, _after?: string): Promise<GitHubPullTimelineResult> => timeline),
    commentOnIssue: vi.fn(async () => ({ ok: true as const }))
  } satisfies IssuesNodeApi
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })

const ana = { id: 1, login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }
const at = '2026-10-02T10:00:00Z'
const PNG = 'data:image/png;base64,AA=='

async function render(
  api: IssuesNodeApi, issueNumber?: number, onSelect = vi.fn(), onWork = vi.fn(), onOpenPull = vi.fn(), onOpenExternal = vi.fn()
) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<IssuesNodeView api={api} projectId="p" issues={{ repository: 'o/r', issueNumber }} refreshTick={0}
      onSelect={onSelect} onWork={onWork} onOpenExternal={onOpenExternal} onOpenPull={onOpenPull} />)
  })
  await settle()
  return host
}

const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('IssuesNodeView', () => {
  it('lists the open issues of every column and selects one on click', async () => {
    const api = fakeApi([issue(2), issue(1)])
    const onSelect = vi.fn()
    const view = await render(api, undefined, onSelect)
    expect(api.refresh).toHaveBeenCalledWith('p')
    expect(api.query).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', anyColumn: true, openOnly: true }))
    expect(view.textContent).toContain('#2 Issue 2')
    act(() => (view.querySelector('.issues-node__row') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('reads only my issues with Assigned to me, and passes the label and search', async () => {
    const api = fakeApi([issue(1, { labels: [{ id: 1, name: 'bug', color: 'd73a4a' }] })])
    const view = await render(api)
    const pick = (label: string, value: string) => act(() => {
      const select = view.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    pick('Filter', 'mine')
    pick('Label', 'bug')
    await settle()
    expect(api.query).toHaveBeenLastCalledWith(expect.objectContaining({ assignedToMe: true, labelFilter: ['bug'] }))
  })

  it('shows the selected issue with its comments, comments on it, and asks to work on it', async () => {
    const api = fakeApi([issue(5, { body: 'It **breaks**' })], {
      status: 'ok', openedAt: at, observedAt: 1,
      items: [{ kind: 'comment', id: 'IC_9', databaseId: 9, actor: ana, body: 'Me too', at, url: 'https://github.com/o/r/issues/5#issuecomment-9' }]
    })
    const onWork = vi.fn()
    const view = await render(api, 5, vi.fn(), onWork)
    await settle() // the markdown renderer is a lazy chunk
    expect(api.issueTimeline).toHaveBeenCalledWith('p', 'o/r', 5)
    expect(view.querySelector('strong')?.textContent).toBe('breaks')
    expect(view.textContent).toContain('ana')
    expect(view.textContent).toContain('Me too')

    const box = view.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'On it')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(view, 'Comment').click())
    expect(api.commentOnIssue).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', issueNumber: 5, body: 'On it' })
    expect(api.issueTimeline).toHaveBeenCalledTimes(2)

    act(() => button(view, 'Work on this').click())
    act(() => button(view, 'Work on this in a new worktree').click())
    expect(onWork.mock.calls.map(([i, worktree]) => [i.number, worktree])).toEqual([[5, false], [5, true]])
  })

  it('says why a comment did not land', async () => {
    const api = { ...fakeApi([issue(5)]), commentOnIssue: vi.fn(async () => ({ ok: false as const, reason: 'forbidden' as const })) }
    const view = await render(api, 5)
    const box = view.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'x')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(view, 'Comment').click())
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Issues write access')
  })

  it('shows labels and assignees with avatars, a lettered fallback, and the state', async () => {
    const bo = { id: 2, login: 'bo', avatarUrl: 'https://avatars.githubusercontent.com/u/2' }
    const api = fakeApi([issue(5, {
      labels: [{ id: 1, name: 'bug', color: 'd73a4a' }, { id: 2, name: 'odd', color: 'nothex' }],
      assignees: [ana, bo], avatarDataUrls: { 1: PNG }
    })])
    const view = await render(api, 5)
    const detail = view.querySelector('.issues-node__detail')!
    expect([...detail.querySelectorAll('.pull-label')].map((chip) => chip.textContent)).toEqual(['bug', 'odd'])
    expect((detail.querySelector('.pull-label[title="odd"]') as HTMLElement).style.background).toBe('rgb(139, 148, 158)')
    expect(detail.querySelector('img.pull-avatar[alt="ana"]')?.getAttribute('src')).toBe(PNG)
    expect(detail.querySelector('.pull-avatar--letter[aria-label="bo"]')?.textContent).toBe('B')
    expect(detail.querySelector('.pull-node__lifecycle--open')?.textContent).toBe('Open')
    // The list row carries the chips and avatars too.
    expect(view.querySelector('.issues-node__row .pull-label')?.textContent).toBe('bug')
    expect(view.querySelector('.issues-node__row img.pull-avatar')).not.toBeNull()
  })

  it('says when no one is assigned', async () => {
    const view = await render(fakeApi([issue(5)]), 5)
    expect(view.querySelector('.issues-node__detail')!.textContent).toContain('No one assigned.')
  })

  it('renders each issue timeline type with its actor and drops unknown ones', async () => {
    const event = (kind: string, extra: object = {}) => ({ id: kind, actor: ana, at, kind, ...extra }) as PullTimelineItem
    const items = [
      event('labeled', { label: { name: 'bug', color: 'd73a4a' } }),
      event('unlabeled', { label: { name: 'triage', color: 'ededed' } }),
      event('assigned', { assignee: ana }),
      event('unassigned', { assignee: null }),
      event('closed'), event('reopened'),
      event('cross-referenced', { source: { pull: false, number: 3, title: 'Other', repository: 'o/r', url: 'https://github.com/o/r/issues/3' } }),
      event('pinned-someday')
    ]
    const api = fakeApi([issue(5)], { status: 'ok', openedAt: at, observedAt: 1, items, avatarDataUrls: { 1: PNG } })
    const view = await render(api, 5)
    const text = view.querySelector('.pull-convo')!.textContent
    for (const words of ['added the bug label', 'removed the triage label', 'assigned ana', 'unassigned ghost', 'closed this', 'reopened this', 'mentioned this in issue o/r#3 Other']) {
      expect(text).toContain(words)
    }
    expect(view.querySelector('.pull-convo__item--pinned-someday')).toBeNull()
    expect(view.querySelector('.pull-convo__item--closed img.pull-avatar')?.getAttribute('src')).toBe(PNG)
  })

  it('names who opened the issue, with their avatar', async () => {
    const api = fakeApi([issue(5)], { status: 'ok', openedAt: at, author: ana, observedAt: 1, items: [], avatarDataUrls: { 1: PNG } })
    const view = await render(api, 5)
    const opened = view.querySelector('.pull-convo__item--description .pull-convo__head')!
    expect(opened.textContent).toContain('ana')
    expect(opened.querySelector('img.pull-avatar')?.getAttribute('src')).toBe(PNG)
  })

  it('opens a cross-referenced PR of this repository as a pull node, and one elsewhere on GitHub', async () => {
    const ref = (id: string, repository: string, number: number) => ({
      id, actor: ana, at, kind: 'cross-referenced' as const,
      source: { pull: true, number, title: 'Fix', repository, url: `https://github.com/${repository}/pull/${number}` }
    })
    const api = fakeApi([issue(5)], { status: 'ok', openedAt: at, observedAt: 1, items: [ref('a', 'o/r', 12), ref('b', 'x/y', 4)] })
    const onOpenPull = vi.fn()
    const onOpenExternal = vi.fn()
    const view = await render(api, 5, vi.fn(), vi.fn(), onOpenPull, onOpenExternal)
    act(() => button(view, 'Open #12 as a pull node').click())
    act(() => button(view, 'Open x/y#4 on GitHub').click())
    expect(onOpenPull).toHaveBeenCalledWith(12)
    expect(onOpenExternal).toHaveBeenCalledWith('https://github.com/x/y/pull/4')
  })

  it('loads the next page with its cursor, and says why the timeline did not load', async () => {
    const comment = (id: string) => ({ kind: 'comment' as const, id, databaseId: 1, actor: ana, body: id, at, url: 'https://github.com/o/r/issues/5' })
    const api = fakeApi([issue(5)])
    api.issueTimeline.mockImplementation(async (_p, _r, _n, after) => after
      ? { status: 'ok', openedAt: at, observedAt: 1, items: [comment('later')] }
      : { status: 'ok', openedAt: at, observedAt: 1, items: [comment('first')], next: 'Y3Vy' })
    const view = await render(api, 5)
    await act(async () => button(view, 'Load more').click())
    expect(api.issueTimeline).toHaveBeenLastCalledWith('p', 'o/r', 5, 'Y3Vy')
    expect(view.textContent).toContain('later')
    expect(button(view, 'Load more')).toBeUndefined()

    const refused = fakeApi([issue(5)], { status: 'refused', reason: 'not-approved' })
    act(() => root.unmount()); host.remove()
    const second = await render(refused, 5)
    expect(second.querySelector('.issues-node__detail [role="status"]')?.textContent).toContain('not allowed on this machine')
  })
})
