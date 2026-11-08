// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail, GitHubPullFileContentsResult } from '@shared/github-pull-detail'
import type { GitHubPullCommitFilesResult, GitHubPullCommitsResult, PullCommit } from '@shared/github-pull-commits'
import { PullNodeView, type PullNodeApi } from '../PullNodeView'

// Monaco does not run in jsdom: the diff shows its path and its two texts.
vi.mock('../../editor/TextDiff', () => ({
  TextDiff: ({ path, original, modified }: { path: string; original: string; modified: string }) =>
    <div className="text-diff" data-path={path} data-original={original} data-modified={modified} />
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'd'.repeat(40) }, head: { ref: 'feat', sha: B },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7', commits: 2
}
const octocat = { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' }
const commits: PullCommit[] = [
  { oid: A, headline: 'Add the reads', author: octocat, authorName: 'Octo', committedAt: '2026-11-01T12:00:00Z', verified: true },
  { oid: B, headline: 'Wire the tab', author: null, authorName: 'Robot', committedAt: '2026-11-03T12:00:00Z', verified: false, coAuthors: ['Claude'], ci: 'failed' }
]

function fakeApi(read: GitHubPullCommitsResult = {
  status: 'ok', commits, truncated: false, observedAt: 1, avatarDataUrls: { 2: 'data:image/png;base64,AA==' }
}) {
  const files: GitHubPullCommitFilesResult = {
    status: 'ok', parent: A, truncated: false, observedAt: 1,
    files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }, { path: 'src/b.ts', status: 'added', additions: 2, deletions: 0 }]
  }
  const api = {
    pullDetail: vi.fn(async () => ({ status: 'ok' as const, detail, observedAt: 1 })),
    pullChecks: vi.fn(async () => ({ status: 'ok' as const, headRefOid: B, truncated: false, checks: [] })),
    pullConversation: vi.fn(async () => ({ status: 'refused' as const, reason: 'not-approved' as const })),
    pullCommits: vi.fn(async () => read),
    pullCommitFiles: vi.fn(async () => files),
    pullCommitFileContents: vi.fn(async (_p: string, _r: string, _n: number, sha: string, path: string): Promise<GitHubPullFileContentsResult> =>
      ({ status: 'ok', observedAt: 1, contents: { kind: 'diff', base: { kind: 'text', text: `${path} before` }, head: { kind: 'text', text: `${path}@${sha[0]}` } } }))
  }
  // ponytail: the shell and this tab call only these; the rest of the bridge is never reached here.
  return api as typeof api & PullNodeApi
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(api: PullNodeApi): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'commits' }}
      refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} />)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return host
}

const click = async (element: Element | null | undefined) => {
  await act(async () => { (element as HTMLElement).click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll('button')].find((el) => el.textContent === text)

describe('PullNodeView Commits tab', () => {
  it('names the tab with the commit count and groups the commits by day', async () => {
    const view = await render(fakeApi())
    expect(view.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Commits 2')
    const days = [...view.querySelectorAll('.pr-commits__group')]
    expect(days).toHaveLength(2)
    expect(days[0].querySelector('h3')?.textContent).toContain('Commits on')
    expect(days[0].textContent).toContain('Add the reads')
    expect(days[1].textContent).toContain('Wire the tab')
  })

  it('shows avatar, authors, CI state, short SHA and Verified only for a signed commit', async () => {
    const view = await render(fakeApi())
    const [signed, unsigned] = [...view.querySelectorAll('.pr-commits__row')]
    expect(signed.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
    expect(signed.querySelector('.pr-commits__author')?.textContent).toBe('octocat')
    expect(signed.querySelector('.pr-commits__sha')?.textContent).toBe('aaaaaaa')
    expect(signed.textContent).toContain('Verified')
    expect(signed.querySelector('.pr-commits__ci')).toBeNull()
    expect(unsigned.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Robot')
    expect(unsigned.querySelector('.pr-commits__author')?.textContent).toBe('Robot and Claude')
    expect(unsigned.querySelector('.pr-commits__agent')?.textContent).toBe('Claude')
    expect(unsigned.querySelector('[aria-label="Checks failed"]')).not.toBeNull()
    expect(unsigned.textContent).not.toContain('Verified')
  })

  it('opens a commit from anywhere on its row, but Copy only copies', async () => {
    Object.assign(window, { nodeTerminal: { clipboard: { writeText: vi.fn() } } })
    const api = fakeApi()
    const view = await render(api)
    await click(view.querySelector('[aria-label="Copy the full SHA of bbbbbbb"]'))
    expect(api.pullCommitFiles).not.toHaveBeenCalled()
    await click(view.querySelectorAll('.pr-commits__meta')[1])
    expect(api.pullCommitFiles).toHaveBeenCalledTimes(1)
  })

  it('copies the full SHA in one click', async () => {
    const writeText = vi.fn()
    Object.assign(window, { nodeTerminal: { clipboard: { writeText } } })
    const view = await render(fakeApi())
    await click(view.querySelector('[aria-label="Copy the full SHA of bbbbbbb"]'))
    expect(writeText).toHaveBeenCalledWith(B)
  })

  it('opens a commit\'s own diff under the list: its files, the first one against the parent, then All commits', async () => {
    const api = fakeApi()
    const view = await render(api)
    await click(button(view, 'bbbbbbb'))
    expect(api.pullCommitFiles).toHaveBeenCalledWith('p', 'o/r', 7, B)
    expect(view.querySelectorAll('.pr-commits__group')).toHaveLength(2)
    expect(view.querySelector('.pr-commits__row--selected')?.textContent).toContain('Wire the tab')
    expect(view.querySelector('.pr-commits__diff-head')?.textContent).toContain('Showing bbbbbbb · 2 files')
    expect([...view.querySelectorAll('.pr-commits__path')].map((el) => el.textContent)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(api.pullCommitFileContents).toHaveBeenCalledWith('p', 'o/r', 7, B, 'src/a.ts')
    const diff = () => view.querySelector('.text-diff')
    expect(diff()?.getAttribute('data-modified')).toBe('src/a.ts@b')
    await click([...view.querySelectorAll('.pr-commits__file')][1])
    expect(diff()?.getAttribute('data-path')).toBe('src/b.ts')
    expect(diff()?.getAttribute('data-original')).toBe('src/b.ts before')
    await click(button(view, 'All commits'))
    expect(view.querySelector('.pr-commits__diff')).toBeNull()
    expect(view.querySelector('.pr-commits__row--selected')).toBeNull()
  })

  it('names a refusal with its fix, as every tab does', async () => {
    const view = await render(fakeApi({ status: 'refused', reason: 'signed-out' }))
    expect(view.querySelector('[role="status"]')?.textContent).toContain('not signed in')
  })
})
