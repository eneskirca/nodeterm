// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import type { LinkedAgent } from '../../state/pullAgent'
import { PullNodeView, type PullNodeApi } from '../PullNodeView'

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
    { name: 'build', state: 'passed', url: 'https://github.com/o/r/actions/runs/1', startedAt: '2026-11-03T10:00:00Z', completedAt: '2026-11-03T10:02:05Z' },
    { name: 'test', state: 'failed', url: 'https://github.com/o/r/actions/runs/2', startedAt: '2026-11-03T10:00:00Z', completedAt: '2026-11-03T10:00:42Z' },
    { name: 'deploy', state: 'pending', url: 'https://evil.example/x' }
  ]
}

function fakeApi(checks: GitHubPullChecksResult = runs) {
  const api = {
    pullDetail: vi.fn(async () => ({ status: 'ok' as const, detail, observedAt: 1 })),
    pullChecks: vi.fn(async () => checks)
  }
  // ponytail: the shell and this tab call only these; the rest of the bridge is never reached here.
  return api as typeof api & PullNodeApi
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(api: PullNodeApi, extra: {
  agents?: LinkedAgent[]; sendUnavailable?: string; onSendToAgent?: (id: string, message: string) => Promise<string | null>
  onOpenWeb?: (url: string) => void
} = {}): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'checks' }}
      refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} {...extra} />)
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return host
}

const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll('button')].filter((el) => el.textContent === text)

describe('PullChecksTab', () => {
  it('lists every run with its result, name and duration, and counts them in red when one fails', async () => {
    const view = await render(fakeApi())
    const rows = [...view.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].slice(0, 3).map((cell) => cell.textContent))
    expect(rows).toEqual([['✓ passed', 'build', '2m 5s'], ['✗ failed', 'test', '42s'], ['● pending', 'deploy', '']])
    const count = [...view.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.startsWith('Checks'))!
      .querySelector('.pull-node__count')!
    expect(count.textContent).toBe('3')
    expect(count.className).toContain('pull-node__count--failed')
    expect(count.getAttribute('title')).toBe('1 failing')
  })

  it('opens a github.com run page in a web node, and offers no Log for another host', async () => {
    const onOpenWeb = vi.fn()
    const view = await render(fakeApi(), { onOpenWeb })
    const logs = button(view, 'Log')
    expect(logs).toHaveLength(2)
    await act(async () => { logs[1].click() })
    expect(onOpenWeb).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/2')
  })

  it('sends a failed run to the one joined agent', async () => {
    const onSendToAgent = vi.fn(async () => null)
    const view = await render(fakeApi(), { agents: [{ id: 'a1', title: 'Claude' }], onSendToAgent })
    const send = button(view, 'Send failure to agent')
    expect(send).toHaveLength(1)
    await act(async () => { send[0].click() })
    expect(onSendToAgent).toHaveBeenCalledWith('a1', expect.stringContaining('Failing check: test'))
    expect(view.textContent).toContain('Sent test to Claude.')
  })

  it('keeps Send failure to agent off with the reason in a relay tab', async () => {
    const onSendToAgent = vi.fn(async () => null)
    const view = await render(fakeApi(), {
      agents: [{ id: 'a1', title: 'Claude' }], onSendToAgent, sendUnavailable: 'Send to agent is not available in a relay tab.'
    })
    expect(button(view, 'Send failure to agent')[0].disabled).toBe(true)
    expect(view.textContent).toContain('Send to agent is not available in a relay tab.')
  })

  it('says so when the head has no checks', async () => {
    const view = await render(fakeApi({ status: 'no-checks' }))
    expect(view.textContent).toContain('No checks on the head commit.')
    expect(view.querySelector('table')).toBeNull()
  })
})
