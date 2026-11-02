// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { GitHubIssueConversationResult } from '@shared/github-pull-detail'
import { IssuesNodeView, type IssuesNodeApi } from './IssuesNodeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const issue = (number: number, over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: number, number, title: `Issue ${number}`, body: '', state: 'open', stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`, apiUrl: '', labels: [], assignees: [],
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', locked: false, columnId: null, conflict: null,
  ...over
})

function fakeApi(items: GitHubIssueCardView[], conversation: GitHubIssueConversationResult = {
  status: 'ok', items: [], truncated: false, observedAt: 1
}) {
  return {
    refresh: vi.fn(async () => {}),
    query: vi.fn(async () => ({ items, counts: {}, partial: false, readOnly: true })),
    issueConversation: vi.fn(async () => conversation),
    commentOnIssue: vi.fn(async () => ({ ok: true as const }))
  } satisfies IssuesNodeApi
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })

async function render(api: IssuesNodeApi, issueNumber?: number, onSelect = vi.fn(), onWork = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<IssuesNodeView api={api} projectId="p" issues={{ repository: 'o/r', issueNumber }} refreshTick={0}
      onSelect={onSelect} onWork={onWork} onOpenExternal={vi.fn()} />)
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
      status: 'ok', truncated: false, observedAt: 1,
      items: [{ kind: 'comment', id: 9, author: { id: 1, login: 'ana', avatarUrl: '' }, body: 'Me too', at: '2026-10-02T10:00:00Z', url: '' }]
    })
    const onWork = vi.fn()
    const view = await render(api, 5, vi.fn(), onWork)
    await settle() // the markdown renderer is a lazy chunk
    expect(api.issueConversation).toHaveBeenCalledWith('p', 'o/r', 5)
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
    expect(api.issueConversation).toHaveBeenCalledTimes(2)

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
})
