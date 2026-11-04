// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { ShownProposal } from '@shared/pull-agent-verbs'
import { PullNodeView, type PullNodeApi } from '../PullNodeView'
import { isCardZoom } from './PullZoomCard'

// Monaco does not run in jsdom.
vi.mock('../../editor/TextDiff', () => ({ TextDiff: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail: GitHubPullDetail = {
  number: 1342, title: 'Scroll-to-latest pill in chat', body: '', lifecycle: 'open',
  author: { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' },
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat/pill', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/1342'
}

// The reads the shell makes; anything else a tab asks for answers "not approved".
function fakeApi(checks: { name: string; state: 'passed' | 'failed' }[]) {
  const known: Record<string, ReturnType<typeof vi.fn>> = {
    pullDetail: vi.fn(async () => ({ status: 'ok', detail, observedAt: 1 })),
    pullChecks: vi.fn(async () => ({ status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, review: 'approved', checks })),
    pullConversation: vi.fn(async () => ({ status: 'ok', items: [], lineComments: [], truncated: false, observedAt: 1 })),
    pullTimeline: vi.fn(async () => ({ status: 'ok', items: [], openedAt: '2026-10-01T09:00:00Z', observedAt: 1 })),
    repoMergeMethods: vi.fn(async () => ({ status: 'ok', methods: ['squash'], autoMerge: true }))
  }
  const api = new Proxy(known, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => ({ status: 'refused', reason: 'not-approved' })))
  })
  return { api: api as unknown as PullNodeApi, known }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

function view(api: PullNodeApi, zoom: number, proposal?: ShownProposal) {
  return (
    <PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 1342, tab: 'conversation' }}
      refreshTick={0} onTab={vi.fn()} onSelectFile={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()}
      proposal={proposal} zoomedOut={isCardZoom(zoom)} />
  )
}

async function render(api: PullNodeApi, zoom: number, proposal?: ShownProposal): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(view(api, zoom, proposal)) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

const card = () => host.querySelector<HTMLElement>('.pr-zoom')
const tabs = () => host.querySelector('[role="tablist"]')

describe('PullZoomCard', () => {
  it('zoom 0.4 renders the status card with state, number, title, readiness and the proposal; the tabs stay mounted, hidden', async () => {
    const { api } = fakeApi([{ name: 'a', state: 'passed' }, { name: 'b', state: 'passed' }])
    await render(api, 0.4, { action: 'merge', seq: 1 })
    expect(card()).not.toBeNull()
    expect(card()?.querySelector('.pr-state--open [aria-label="open"]')).not.toBeNull()
    expect(card()?.textContent).toContain('#1342')
    expect(card()?.querySelector('.pr-zoom__title')?.textContent).toBe('Scroll-to-latest pill in chat')
    expect(card()?.querySelector('.pr-zoom__line--ok')?.textContent).toBe('Approved · 2/2 checks')
    expect(card()?.querySelector('.pr-zoom__line--agent')?.textContent).toBe('Agent proposes merge')
    expect(tabs()?.closest('[hidden]')).not.toBeNull()
  })

  it('zoom 1 renders the tabs and no card; switching zoom makes no new request', async () => {
    const { api, known } = fakeApi([{ name: 'a', state: 'passed' }])
    await render(api, 1)
    expect(card()).toBeNull()
    expect(tabs()?.closest('[hidden]')).toBeNull()
    const calls = Object.values(known).map((fn) => fn.mock.calls.length)
    await act(async () => { root.render(view(api, 0.4)) })
    expect(card()).not.toBeNull()
    await act(async () => { root.render(view(api, 1)) })
    expect(card()).toBeNull()
    expect(Object.values(known).map((fn) => fn.mock.calls.length)).toEqual(calls)
  })

  it('shows the first blocker as the readiness line, and no agent line without a proposal', async () => {
    const { api } = fakeApi([{ name: 'a', state: 'passed' }, { name: 'b', state: 'failed' }])
    await render(api, 0.3)
    expect(card()?.querySelector('.pr-zoom__line--danger')?.textContent).toBe('1 failing check')
    expect(card()?.querySelector('.pr-zoom__line--agent')).toBeNull()
  })
})
