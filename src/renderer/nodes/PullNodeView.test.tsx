// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail, GitHubPullDetailResult } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
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
}): PullNodeApi & { pullDetail: ReturnType<typeof vi.fn>; pullChecks: ReturnType<typeof vi.fn> } {
  return {
    pullDetail: vi.fn(async () => result),
    pullChecks: vi.fn(async () => checks)
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(api: PullNodeApi, repository = 'o/r'): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository, pullNumber: 7, tab: 'overview' }}
      refreshTick={0} onOpenExternal={vi.fn()} />)
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
        refreshTick={1} onOpenExternal={vi.fn()} />)
    })
    expect(api.pullDetail).toHaveBeenCalledTimes(2)
  })
})
