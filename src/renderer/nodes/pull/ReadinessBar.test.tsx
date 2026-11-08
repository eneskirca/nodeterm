// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail, PullLineComment } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { PullNodeView, type PullNodeApi } from '../PullNodeView'
import { ReadinessBar } from './ReadinessBar'
import { openThreadCount, pullReadiness, type ReadinessInput } from './readiness'

vi.mock('../../editor/TextDiff', () => ({ TextDiff: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'd'.repeat(40) }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}
const checks = (states: Array<'passed' | 'failed' | 'pending'>, review?: 'approved' | 'changes-requested' | 'required'): GitHubPullChecksResult =>
  ({ status: 'ok', headRefOid: HEAD, truncated: false, checks: states.map((state, i) => ({ name: `c${i}`, state })), review })
const comment = (id: number, inReplyTo?: number): PullLineComment => ({ reviewId: null,
  id, path: 'a.ts', line: 1, side: 'RIGHT' as const, outdated: false, body: 'x', author: null, at: '2026-11-01T00:00:00Z', url: '', inReplyTo
})
const labels = (input: ReadinessInput) => pullReadiness(input).map((s) => `${s.key}:${s.label}:${s.tone}`)

describe('pullReadiness', () => {
  it('names review, checks, threads, conflicts and the agent, left to right', () => {
    expect(labels({
      detail, checks: checks(['passed', 'passed'], 'approved'), openThreads: 2, agent: { title: 'claude #2', state: 'working' }
    })).toEqual([
      'review:Approved:ok', 'checks:2/2 checks:ok', 'threads:2 open threads:attention', 'conflicts:No conflicts:ok',
      'agent:claude #2 working:agent'
    ])
  })

  it('says failing, pending, changes requested and conflicts in their tone', () => {
    expect(labels({ detail: { ...detail, merge: 'conflict' }, checks: checks(['passed', 'failed'], 'changes-requested'), openThreads: 0 }))
      .toEqual(['review:Changes requested:danger', 'checks:1 failing check:danger', 'threads:No open threads:ok', 'conflicts:Conflicts with main:danger'])
    expect(labels({ detail: { ...detail, merge: 'behind' }, checks: checks(['passed', 'pending'], 'required') }))
      .toEqual(['review:Review required:attention', 'checks:1/2 checks:attention', 'conflicts:Behind main:attention'])
  })

  it('leaves out what the reads do not know yet, and names a proposal over the agent state', () => {
    expect(labels({ detail: { ...detail, merge: 'undecided' }, checks: 'loading', proposal: { action: 'merge' }, agent: { title: 'a' } }))
      .toEqual(['agent:a proposes merge:agent'])
    expect(labels({ detail: { ...detail, lifecycle: 'merged' }, checks: checks(['passed']), openThreads: 3 })).toEqual([])
  })

  it('jumps each segment to its tab and section', () => {
    const jumps = pullReadiness({ detail, checks: checks(['passed']), openThreads: 1, agent: { title: 'a' } })
      .map((s) => [s.key, s.jump.tab, s.jump.section ?? ''])
    expect(jumps).toEqual([
      ['review', 'conversation', 'details'], ['checks', 'checks', ''], ['threads', 'files', ''],
      ['conflicts', 'conversation', 'merge'], ['agent', 'conversation', 'agent']
    ])
  })

  it('counts unresolved threads, and none when GitHub did not say which are resolved', () => {
    const ok = { status: 'ok' as const, items: [], truncated: false, observedAt: 1, lineComments: [comment(1), comment(2, 1), comment(3)] }
    expect(openThreadCount({ ...ok, resolvedThreads: [3] })).toBe(1)
    expect(openThreadCount(ok)).toBeUndefined()
    expect(openThreadCount('loading')).toBeUndefined()
  })
})

let host: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = host = undefined })
const mount = async (node: React.ReactNode) => {
  const view = host = document.createElement('div')
  document.body.append(view)
  const at = root = createRoot(view)
  await act(async () => { at.render(node) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return view
}

describe('ReadinessBar', () => {
  it('renders one button per segment and hands its jump to onJump', async () => {
    const onJump = vi.fn()
    const segments = pullReadiness({ detail, checks: checks(['failed']), openThreads: 0 })
    const view = await mount(<ReadinessBar segments={segments} onJump={onJump} />)
    const buttons = [...view.querySelectorAll<HTMLButtonElement>('[aria-label="Merge readiness"] button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['No review required', '1 failing check', 'No open threads', 'No conflicts'])
    await act(async () => { buttons[1].click() })
    expect(onJump).toHaveBeenCalledWith({ tab: 'checks' })
  })

  it('renders nothing without segments', async () => {
    expect((await mount(<ReadinessBar segments={[]} onJump={vi.fn()} />)).innerHTML).toBe('')
  })

  it('in the node: reads the shell data once and switches tab on a click', async () => {
    const api = {
      pullDetail: vi.fn(async () => ({ status: 'ok' as const, detail, observedAt: 1 })),
      pullChecks: vi.fn(async () => checks(['passed'], 'approved')),
      pullConversation: vi.fn(async () => ({
        status: 'ok' as const, items: [], truncated: false, observedAt: 1, lineComments: [comment(1)], resolvedThreads: []
      }))
    }
    const onTab = vi.fn()
    // ponytail: the Checks tab and the header call only these three reads.
    const view = await mount(<PullNodeView api={api as typeof api & PullNodeApi} projectId="p"
      pull={{ repository: 'o/r', pullNumber: 7, tab: 'checks' }} refreshTick={0} onTab={onTab} onOpenExternal={vi.fn()}
      onWritten={vi.fn()} onSelectFile={vi.fn()} agents={[{ id: 'n1', title: 'claude #2' }]} agentState="working" />)
    const bar = view.querySelector('[aria-label="Merge readiness"]')!
    expect(bar.textContent).toContain('1 open thread')
    expect(bar.textContent).toContain('claude #2 working')
    await act(async () => { bar.querySelector<HTMLButtonElement>('[data-segment="threads"]')!.click() })
    expect(onTab).toHaveBeenCalledWith('files')
    expect(api.pullConversation).toHaveBeenCalledTimes(1)
  })
})
