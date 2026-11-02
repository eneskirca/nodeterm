// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullConversationResult, GitHubPullDetail, GitHubPullDetailResult } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import type { PullNodeTab } from '@shared/pull-node'
import { PullNodeView, type PullNodeApi } from './PullNodeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail: GitHubPullDetail = {
  number: 7, title: 'Add the pull node', body: '## Why it matters\n\nIt keeps review **in place**.',
  lifecycle: 'open', author: { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' },
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat/pull', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 10, deletions: 2, changedFiles: 3, url: 'https://github.com/o/r/pull/7'
}

function fakeApi(result: GitHubPullDetailResult, checks: GitHubPullChecksResult = {
  status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [{ name: 'test', state: 'passed' }]
}, conversation: GitHubPullConversationResult = { status: 'ok', items: [], truncated: false, observedAt: 1 }):
  PullNodeApi & {
    pullDetail: ReturnType<typeof vi.fn>; pullChecks: ReturnType<typeof vi.fn>; pullConversation: ReturnType<typeof vi.fn>
    commentOnPull: ReturnType<typeof vi.fn>; reviewPull: ReturnType<typeof vi.fn>
  } {
  return {
    pullDetail: vi.fn(async () => result),
    pullChecks: vi.fn(async () => checks),
    pullConversation: vi.fn(async () => conversation),
    commentOnPull: vi.fn(async () => ({ ok: true as const })),
    reviewPull: vi.fn(async () => ({ ok: true as const }))
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(
  api: PullNodeApi, repository = 'o/r', tab: PullNodeTab = 'overview', onTab = vi.fn(), onOpenExternal = vi.fn(),
  onWritten = vi.fn()
): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository, pullNumber: 7, tab }}
      refreshTick={0} onTab={onTab} onOpenExternal={onOpenExternal} onWritten={onWritten} />)
  })
  // The markdown renderer is a lazy chunk; let it land.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  return host
}

describe('PullNodeView overview', () => {
  it('shows title, number, state, author, branches, rendered description, checks and merge state', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await render(api)
    expect(api.pullDetail).toHaveBeenCalledWith('p', 'o/r', 7)
    expect(view.textContent).toContain('Add the pull node')
    expect(view.textContent).toContain('#7')
    expect(view.textContent).toContain('Open')
    expect(view.textContent).toContain('octocat')
    expect(view.textContent).toContain('main')
    expect(view.textContent).toContain('feat/pull')
    expect(view.querySelector('h2')?.textContent).toBe('Why it matters')
    expect(view.querySelector('strong')?.textContent).toBe('in place')
    expect(view.querySelector('[aria-label="Checks"]')?.textContent).toContain('test')
    expect(view.textContent).toContain('Ready to merge')
  })

  it('never runs script from the description', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, body: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }, observedAt: 1 })
    const view = await render(api)
    expect(view.querySelector('script')).toBeNull()
    expect(view.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it.each([
    ['not-approved', 'approve'],
    ['signed-out', 'sign in'],
    ['repository-mismatch', 'o/r'],
    ['not-configured', 'repository']
  ] as const)('names the %s state with its fix and reads no checks', async (reason, fix) => {
    const api = fakeApi({ status: 'refused', reason })
    const view = await render(api)
    expect(view.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain(fix.toLowerCase())
    expect(api.pullChecks).not.toHaveBeenCalled()
  })

  it('keeps the last content and says throttled when the latest read was throttled', async () => {
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1, stale: 'throttled' }))
    expect(view.textContent).toContain('Add the pull node')
    expect(view.textContent?.toLowerCase()).toContain('throttled')
  })

  it('reads again when the refresh tick moves', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await render(api)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'overview' }}
        refreshTick={1} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} />)
    })
    expect(api.pullDetail).toHaveBeenCalledTimes(2)
  })
})

const author = { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' }
const at = (hour: number) => `2026-10-01T${hour}:00:00Z`
const url = 'https://github.com/o/r/pull/7'

describe('PullNodeView conversation', () => {
  it('lists comments and reviews in the order read, each review with its verdict', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined, {
      status: 'ok', truncated: false, observedAt: 1, items: [
        { kind: 'comment', id: 1, author, body: 'First **comment**', at: at(10), url },
        { kind: 'review', id: 2, author, body: '', at: at(11), url, verdict: 'approved' },
        { kind: 'review', id: 3, author: null, body: 'Fix the test', at: at(12), url, verdict: 'changes-requested' },
        { kind: 'review', id: 4, author, body: 'Note', at: at(13), url, verdict: 'commented' }
      ]
    })
    const view = await render(api, 'o/r', 'conversation')
    expect(api.pullConversation).toHaveBeenCalledWith('p', 'o/r', 7)
    expect(api.pullDetail).not.toHaveBeenCalled()
    const items = [...view.querySelectorAll('.pull-convo__item')].map((item) => item.textContent)
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('First comment')
    expect(view.querySelector('.pull-convo__item strong')?.textContent).toBe('comment')
    expect(items[1]).toContain('Approved')
    expect(items[2]).toContain('Changes requested')
    expect(items[2]).toContain('Fix the test')
    expect(items[3]).toContain('Commented')
  })

  it('never runs script from a comment', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined, {
      status: 'ok', truncated: false, observedAt: 1,
      items: [{ kind: 'comment', id: 1, author, body: '<img src=x onerror="alert(1)"><script>alert(2)</script>', at: at(10), url }]
    })
    const view = await render(api, 'o/r', 'conversation')
    expect(view.querySelector('script')).toBeNull()
    expect(view.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it('says when there is nothing yet, and names a refusal with its fix', async () => {
    expect((await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'conversation')).textContent)
      .toContain('No comments or reviews yet.')
    act(() => root.unmount()); host.remove()
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined,
      { status: 'refused', reason: 'not-approved' }), 'o/r', 'conversation')
    expect(view.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain('approve')
  })

  it('switches tab through onTab and opens the PR on GitHub from every tab', async () => {
    const onTab = vi.fn()
    const onOpen = vi.fn()
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'overview', onTab, onOpen)
    const tab = [...view.querySelectorAll('[role="tab"]')].find((el) => el.textContent === 'Conversation')!
    await act(async () => { (tab as HTMLElement).click() })
    expect(onTab).toHaveBeenCalledWith('conversation')
    const link = [...view.querySelectorAll('button')].find((el) => el.textContent === 'Open on GitHub')!
    await act(async () => { link.click() })
    expect(onOpen).toHaveBeenCalledWith('https://github.com/o/r/pull/7')
  })
})

describe('PullNodeView tab switching', () => {
  it('keeps a tab mounted after a switch, so switching back reads nothing again', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await render(api)
    const show = async (tab: PullNodeTab) => act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} />)
    })
    await show('conversation')
    await show('overview')
    await show('conversation')
    expect(api.pullDetail).toHaveBeenCalledTimes(1)
    expect(api.pullConversation).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.pull-node__overview')?.closest('[hidden]')).not.toBeNull()
  })
})

function type(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (view: HTMLElement, label: string) =>
  [...view.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement

describe('PullNodeView composer', () => {
  it('posts a comment, clears the draft and refreshes the node', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    const box = view.querySelector('textarea')!
    expect(button(view, 'Comment').disabled).toBe(true)
    await act(async () => { type(box, 'Looks good') })
    await act(async () => { button(view, 'Comment').click() })
    expect(api.commentOnPull).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, body: 'Looks good' })
    expect(box.value).toBe('')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('approves with an optional message against the head commit of the latest detail read', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await render(api, 'o/r', 'conversation')
    await act(async () => { button(view, 'Approve').click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'APPROVE', body: '', headSha: 'c'.repeat(40)
    })
  })

  it('needs a message to request changes', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await render(api, 'o/r', 'conversation')
    expect(button(view, 'Request changes').disabled).toBe(true)
    await act(async () => { type(view.querySelector('textarea')!, 'Fix the test') })
    await act(async () => { button(view, 'Request changes').click() })
    expect(api.reviewPull).toHaveBeenCalledWith(expect.objectContaining({ event: 'REQUEST_CHANGES', body: 'Fix the test' }))
  })

  it('disables every button while a write runs', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    let land!: (value: { ok: true }) => void
    api.commentOnPull.mockImplementation(() => new Promise((resolve) => { land = resolve }))
    const view = await render(api, 'o/r', 'conversation')
    await act(async () => { type(view.querySelector('textarea')!, 'x') })
    await act(async () => { button(view, 'Comment').click() })
    expect(['Comment', 'Approve', 'Request changes'].map((label) => button(view, label).disabled)).toEqual([true, true, true])
    await act(async () => { button(view, 'Comment').click() })
    expect(api.commentOnPull).toHaveBeenCalledTimes(1)
    await act(async () => { land({ ok: true }) })
    expect(button(view, 'Approve').disabled).toBe(false)
  })

  it.each([
    ['own-pull', 'your own pull request'],
    ['forbidden', 'write access'],
    ['throttled', 'throttling'],
    ['signed-out', 'sign in'],
    ['not-approved', 'approve'],
    ['validation', 'refused'],
    ['network', 'could not be reached']
  ] as const)('says what a %s refusal means and keeps the draft', async (reason, words) => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.reviewPull.mockResolvedValue({ ok: false, reason })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { type(view.querySelector('textarea')!, 'Ship it') })
    await act(async () => { button(view, 'Approve').click() })
    expect(view.querySelector('[role="alert"]')?.textContent?.toLowerCase()).toContain(words)
    expect(view.querySelector('textarea')!.value).toBe('Ship it')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('keeps the draft across a tab switch', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await render(api, 'o/r', 'conversation')
    await act(async () => { type(host.querySelector('textarea')!, 'half a thought') })
    for (const tab of ['overview', 'conversation'] as const) {
      await act(async () => {
        root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab }}
          refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} />)
      })
    }
    expect(host.querySelector('textarea')!.value).toBe('half a thought')
  })
})
