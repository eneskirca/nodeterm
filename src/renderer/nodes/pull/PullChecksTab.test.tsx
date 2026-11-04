// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail, PullWriteResult } from '@shared/github-pull-detail'
import type { GitHubPullCheckLogResult } from '@shared/github-pull-check-log'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { PullNodeView, type PullNodeApi } from '../PullNodeView'
import type { SendToHost } from './SendTo'

// Monaco does not run in jsdom; this tab never shows a diff.
vi.mock('../../editor/TextDiff', () => ({ TextDiff: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'd'.repeat(40) }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}
const runs: GitHubPullChecksResult = {
  status: 'ok', headRefOid: HEAD, truncated: false, checks: [
    { name: 'test', state: 'failed', url: 'https://github.com/o/r/actions/runs/12/job/34', startedAt: '2026-11-03T10:00:00Z', completedAt: '2026-11-03T10:00:42Z' },
    { name: 'build', state: 'passed', url: 'https://github.com/o/r/actions/runs/12/job/35', startedAt: '2026-11-03T10:00:00Z', completedAt: '2026-11-03T10:02:05Z' },
    { name: 'deploy', state: 'pending', url: 'https://ci.example/x' }
  ]
}

function fakeApi(checks: GitHubPullChecksResult = runs) {
  const api = {
    pullDetail: vi.fn(async () => ({ status: 'ok' as const, detail, observedAt: 1 })),
    pullChecks: vi.fn(async () => checks),
    pullConversation: vi.fn(async () => ({ status: 'refused' as const, reason: 'not-approved' as const })),
    pullCheckLog: vi.fn(async (): Promise<GitHubPullCheckLogResult> => ({
      status: 'ok', observedAt: 1, lines: ['##[group]Run npm test', '  ✗ pill hides at the bottom', '##[endgroup]', '##[error]Process completed with exit code 1.']
    })),
    rerunFailedJobs: vi.fn(async (): Promise<PullWriteResult> => ({ ok: true }))
  }
  // ponytail: the shell and this tab call only these; the rest of the bridge is never reached here.
  return api as typeof api & PullNodeApi
}

const sendHost = (unavailable?: string) => {
  const send = vi.fn(async () => null)
  const host: SendToHost = {
    unavailable, pullId: 'pull', send, status: () => ({ state: 'done' }), edges: () => [],
    nodes: () => [{ id: 'pull', type: 'pull', data: {} }, { id: 'a1', type: 'terminal', data: { title: 'Fixer', agentId: 'claude' } }]
  }
  return { host, send }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(api: PullNodeApi, extra: { sendToHost?: SendToHost; onOpenWeb?: (url: string) => void; onWritten?: () => void } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onOpenExternal = vi.fn()
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'checks' }}
      refreshTick={0} onTab={vi.fn()} onOpenExternal={onOpenExternal} onWritten={extra.onWritten ?? vi.fn()} onSelectFile={vi.fn()} {...extra} />)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { view: host, onOpenExternal }
}

const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll('button')].filter((el) => el.textContent === text)
const click = async (element: Element) => {
  await act(async () => { (element as HTMLElement).click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('PullChecksTab', () => {
  it('sums the head up and lists every run with its name and duration, the failure first and open', async () => {
    const api = fakeApi()
    const { view } = await render(api)
    expect(view.querySelector('.pr-checks__summary > span')?.textContent).toBe('1 failing · 1 passed · 1 running · on ccccccc')
    expect([...view.querySelectorAll('.pr-checks__run')].map((row) =>
      [row.querySelector('.pr-checks__name')?.textContent, row.querySelector('.pr-checks__time')?.textContent]))
      .toEqual([['test', '42s'], ['build', '2m 5s'], ['deploy', '']])
    expect(api.pullCheckLog).toHaveBeenCalledWith('p', 'o/r', 7, 34)
    expect([...view.querySelectorAll('.pr-checks__line')].map((line) => line.textContent))
      .toEqual(['Run npm test', '  ✗ pill hides at the bottom', 'Process completed with exit code 1.'])
    expect(view.querySelector('.pr-checks__line--error')?.textContent).toBe('Process completed with exit code 1.')
  })

  it('expands another Actions run on click and collapses the open one', async () => {
    const api = fakeApi()
    const { view } = await render(api)
    const rows = [...view.querySelectorAll<HTMLButtonElement>('button.pr-checks__row')]
    expect(rows).toHaveLength(2)
    await click(rows[1])
    expect(api.pullCheckLog).toHaveBeenLastCalledWith('p', 'o/r', 7, 35)
    expect(rows[0].getAttribute('aria-expanded')).toBe('false')
    expect(button(view, 'Fix with agent')).toHaveLength(0)
    await click(rows[1])
    expect(view.querySelector('.pr-checks__log')).toBeNull()
  })

  it('opens the full log in a web node, and gives another app\'s check a Details link only', async () => {
    const onOpenWeb = vi.fn()
    const { view, onOpenExternal } = await render(fakeApi(), { onOpenWeb })
    await click(button(view, 'Full log')[0])
    expect(onOpenWeb).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/12/job/34')
    const deploy = [...view.querySelectorAll('.pr-checks__run')][2]
    expect(deploy.querySelector('button.pr-checks__row')).toBeNull()
    await click(button(deploy as HTMLElement, 'Details')[0])
    expect(onOpenExternal).toHaveBeenCalledWith('https://ci.example/x')
  })

  it('re-runs the failed jobs of the failing run once, then reads again', async () => {
    const api = fakeApi()
    const onWritten = vi.fn()
    const { view } = await render(api, { onWritten })
    await click(button(view, 'Re-run failed')[0])
    expect(api.rerunFailedJobs).toHaveBeenCalledTimes(1)
    expect(api.rerunFailedJobs).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, runId: 12 })
    expect(onWritten).toHaveBeenCalled()
    expect(view.textContent).toContain('GitHub is re-running the failed jobs.')
  })

  it('says why a re-run was refused', async () => {
    const api = fakeApi()
    api.rerunFailedJobs.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const { view } = await render(api)
    await click(button(view, 'Re-run failed')[0])
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('may not write to this repository')
  })

  it('offers no Re-run when only another app\'s check failed', async () => {
    const { view } = await render(fakeApi({ ...runs, checks: [{ name: 'ext', state: 'failed', url: 'https://ci.example/1' }] }))
    expect(button(view, 'Re-run failed')).toHaveLength(0)
    expect(view.querySelector('.pr-checks__log')).toBeNull()
  })

  it('Fix with agent opens the Send to picker for the failing check', async () => {
    const { host: sendToHost, send } = sendHost()
    const { view } = await render(fakeApi(), { sendToHost })
    await click(button(view, 'Fix with agent')[0])
    expect(view.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Send the failing check to')
    await click(view.querySelector('[role="option"]')!)
    expect(send).toHaveBeenCalledWith('a1', expect.objectContaining({ number: 7 }), { kind: 'check', name: 'test' })
  })

  it('keeps Fix with agent off with the reason in a relay tab', async () => {
    const { view } = await render(fakeApi(), { sendToHost: sendHost('Send to agent is not available in a relay tab.').host })
    expect(button(view, 'Fix with agent')[0].disabled).toBe(true)
    expect(view.textContent).toContain('Send to agent is not available in a relay tab.')
  })

  it('says so when the head has no checks', async () => {
    const { view } = await render(fakeApi({ status: 'no-checks' }))
    expect(view.textContent).toContain('No checks on the head commit.')
    expect(view.querySelector('.pr-checks__list')).toBeNull()
  })
})
