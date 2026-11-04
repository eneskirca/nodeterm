// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullTimelineResult, PullTimelineItem } from '@shared/github-pull-timeline'
import { PullTimeline } from './PullTimeline'
import type { PullNodeApi } from './shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ana = { id: 4, login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/4' }
const bo = { id: 5, login: 'bo', avatarUrl: 'https://avatars.githubusercontent.com/u/5' }
const at = '2026-10-01T10:00:00Z'
const url = 'https://github.com/o/r/pull/7'
const sha = (c: string) => c.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: 'The **why**', lifecycle: 'open', author: bo,
  base: { ref: 'main', sha: sha('b') }, head: { ref: 'feat', sha: sha('c') }, additions: 1, deletions: 0, changedFiles: 1, url
}
const ev = <K extends PullTimelineItem['kind']>(kind: K, id: string, extra: object = {}) =>
  ({ kind, id, actor: ana, at, ...extra }) as PullTimelineItem

const everyEvent: PullTimelineItem[] = [
  ev('comment', 'c', { databaseId: 1, body: 'A comment', url }),
  ev('review', 'r', { databaseId: 2, body: '', url, verdict: 'approved' }),
  ev('commit', 'k1', { oid: sha('1'), headline: 'First commit' }),
  ev('commit', 'k2', { oid: sha('2'), headline: 'Second commit' }),
  ev('force-push', 'f', { before: sha('3'), after: sha('4') }),
  ev('labeled', 'l', { label: { name: 'bug', color: 'd73a4a' } }),
  ev('unlabeled', 'u', { label: { name: 'wip', color: '000000' } }),
  ev('review-requested', 'rr', { reviewer: 'bo' }),
  ev('assigned', 'a', { assignee: bo }),
  ev('unassigned', 'ua', { assignee: bo }),
  ev('closed', 'cl'), ev('reopened', 'ro'), ev('ready-for-review', 'rf'), ev('converted-to-draft', 'cd'),
  ev('merged', 'm', { oid: sha('5'), base: 'main' }),
  ev('cross-referenced', 'x', { source: { pull: false, number: 9, title: 'Crash on start', repository: 'o/r', url: 'https://github.com/o/r/issues/9' } })
]
const ok = (items: PullTimelineItem[], next?: string): GitHubPullTimelineResult =>
  ({ status: 'ok', items, openedAt: '2026-10-01T09:00:00Z', observedAt: 1, ...(next ? { next } : {}) })

let host: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host?.remove(); host = undefined })

async function render(pullTimeline: ReturnType<typeof vi.fn>, refreshTick = 0): Promise<HTMLDivElement> {
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
  await act(async () => {
    root.render(<PullTimeline api={{ pullTimeline } as unknown as PullNodeApi} projectId="p"
      pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }} refreshTick={refreshTick}
      onOpenExternal={vi.fn()} onWritten={vi.fn()} detail={detail} lineComments={[]} />)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  return host!
}

describe('PullTimeline', () => {
  it('puts the description first, with the author and when it was opened', async () => {
    const view = await render(vi.fn(async () => ok([])))
    const first = view.querySelector('.pull-convo > li')!
    expect(first.textContent).toContain('bo')
    expect(first.textContent).toContain('opened this pull request')
    expect(first.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-01T09:00:00Z')
    expect(first.querySelector('strong')?.textContent).toBe('why')
  })

  it('renders each event type with avatar, actor and time, and groups commits pushed together', async () => {
    const view = await render(vi.fn(async () => ok(everyEvent)))
    const entries = [...view.querySelectorAll('.pull-convo > li')].slice(1)
    expect(entries).toHaveLength(everyEvent.length - 1)
    for (const entry of entries) {
      expect(entry.querySelector('.pull-avatar')).not.toBeNull()
    }
    expect(entries.filter((entry) => entry.querySelector('time')).length).toBe(entries.length - 1)
    const text = entries.map((entry) => entry.textContent ?? '')
    expect(text[2]).toContain('2 commits pushed')
    expect(text[2]).toContain('First commit')
    expect(text[2]).toContain('2222222')
    for (const words of [
      'force-pushed from 3333333 to 4444444', 'added the bug label', 'removed the wip label', 'requested a review from bo',
      'assigned bo', 'unassigned bo', 'closed this', 'reopened this', 'marked this as ready for review',
      'marked this as a draft', 'merged commit 5555555 into main', 'mentioned this in issue o/r#9 Crash on start'
    ]) expect(text.some((entry) => entry.includes(words) && entry.includes('ana'))).toBe(true)
    expect(text[1]).toContain('Approved')
  })

  it('loads the next page by its cursor and appends it; a refresh starts from the first page again', async () => {
    const read = vi.fn(async (_p: string, _r: string, _n: number, after?: string) => after
      ? ok([ev('closed', 'late')])
      : ok([ev('reopened', 'early')], 'Y3Vy'))
    const view = await render(read)
    const more = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Load more')!
    await act(async () => { more.click() })
    expect(read).toHaveBeenLastCalledWith('p', 'o/r', 7, 'Y3Vy')
    expect(view.textContent).toContain('closed this')
    expect([...view.querySelectorAll('button')].some((button) => button.textContent === 'Load more')).toBe(false)
    await render(read, 1)
    expect(view.textContent).not.toContain('closed this')
    expect(read).toHaveBeenLastCalledWith('p', 'o/r', 7)
  })

  it('says why a later page did not load and keeps what it has', async () => {
    const read = vi.fn(async (_p: string, _r: string, _n: number, after?: string): Promise<GitHubPullTimelineResult> => after
      ? { status: 'failed', reason: 'throttled' }
      : ok([ev('reopened', 'early')], 'Y3Vy'))
    const view = await render(read)
    await act(async () => { [...view.querySelectorAll('button')].find((button) => button.textContent === 'Load more')!.click() })
    expect(view.textContent).toContain('reopened this')
    expect(view.textContent).toContain('GitHub is throttling requests')
  })

  it('keeps the last answer and says so when the latest read was throttled', async () => {
    const view = await render(vi.fn(async () => ({ ...ok([ev('closed', 'c')]), stale: 'throttled' as const })))
    expect(view.textContent).toContain('closed this')
    expect(view.querySelector('[role="status"]')?.textContent).toContain('Throttled by GitHub')
  })
})
