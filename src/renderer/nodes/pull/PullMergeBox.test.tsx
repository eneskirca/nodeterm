// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullConversationResult, GitHubPullDetail, PullLineComment } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import type { GitHubPullTimelineResult } from '@shared/github-pull-timeline'
import type { PullProposal } from '@shared/pull-agent-verbs'
import type { SendToApi } from './SendTo'
import { PullJumpContext } from './PullJumpContext'
import { PullMergeBox } from './PullMergeBox'
import { useMergeMethod, useUpdateBranch } from './mergeActions'
import { PullProposalBar } from './PullProposalBar'
import type { PullNodeApi } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

const sendToApi: { current: SendToApi } = { current: { sendTo: undefined, why: undefined } }
vi.mock('./SendTo', () => ({ useSendTo: () => sendToApi.current }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'Add the pull node', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat/pull', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7', commits: 2
}
const passing: GitHubPullChecksResult = { status: 'ok', headRefOid: HEAD, truncated: false, checks: [{ name: 't', state: 'passed' }], review: 'approved' }
const comment = (id: number): PullLineComment => ({
  reviewId: null, id, path: 'a.ts', line: 1, side: 'RIGHT', outdated: false, body: 'x', author: null, at: '2026-11-01T00:00:00Z', url: ''
})
const conversation: GitHubPullConversationResult = {
  status: 'ok', items: [], lineComments: [comment(1), comment(2)], resolvedThreads: [], truncated: false, observedAt: 1
}
const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

function fakeApi() {
  const ok = async () => ({ ok: true as const })
  const api = {
    mergePull: vi.fn(ok), enablePullAutoMerge: vi.fn(ok), disablePullAutoMerge: vi.fn(ok), updatePullBranch: vi.fn(ok),
    reviewPull: vi.fn(ok), commentOnPull: vi.fn(ok), markPullReady: vi.fn(ok), setPullState: vi.fn(ok), deleteHeadBranch: vi.fn(ok),
    pullForBranch: vi.fn(async () => ({ status: 'ok' as const, defaultBranch: 'main' }))
  }
  // ponytail: the merge box and the proposal bar write only through these.
  return api as typeof api & PullNodeApi
}

let host: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove(); root = host = undefined
  sendToApi.current = { sendTo: undefined, why: undefined }
})

const ALLOWED: MergeMethodsRead = { status: 'ok', methods: ['squash', 'rebase'], autoMerge: true }

async function mount(change: Partial<GitHubPullDetail> = {}, extra: {
  checks?: GitHubPullChecksResult; methods?: MergeMethodsRead; onWork?: () => void
  top?: React.ReactNode; timeline?: GitHubPullTimelineResult
} = {}) {
  const api = fakeApi()
  const onJump = vi.fn()
  const onWritten = vi.fn()
  const view = host = document.createElement('div')
  document.body.append(view)
  root = createRoot(view)
  const base = { api, projectId: 'p', pull: { repository: 'o/r', pullNumber: 7, tab: 'conversation' as const }, refreshTick: 0, onOpenExternal: vi.fn(), onWritten }
  const d = { ...detail, ...change }
  // The shell's picked method and Update branch, as PullNodeView holds them.
  function Box() {
    const methods = extra.methods ?? ALLOWED
    const { method, pick } = useMergeMethod(methods)
    const update = useUpdateBranch(base, d)
    return <PullMergeBox {...base} onWork={extra.onWork} detail={d} checks={extra.checks ?? passing} methods={methods}
      onLoadMethods={vi.fn()} conversation={conversation} method={method} onPickMethod={pick} update={update}
      top={extra.top} timeline={extra.timeline} />
  }
  await act(async () => {
    root!.render(<PullJumpContext.Provider value={onJump}><Box /></PullJumpContext.Provider>)
  })
  return { view, api, onJump, onWritten }
}

const button = (el: Element, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
const click = (el: HTMLElement | null | undefined) => act(async () => { el!.click() })
const row = (view: Element, key: string) => view.querySelector<HTMLElement>(`[data-row="${key}"]`)!

describe('PullMergeBox status rows', () => {
  it('shows review, checks, unresolved threads and conflicts, each link jumping to its place', async () => {
    const { view, onJump } = await mount()
    expect([...view.querySelectorAll('[data-row]')].map((el) => el.querySelector('strong')?.textContent)).toEqual([
      'Approved', 'All checks passed', '2 conversations unresolved', 'No conflicts'
    ])
    await click(button(row(view, 'review'), 'Request review'))
    await click(button(row(view, 'checks'), 'Show'))
    await click(button(row(view, 'threads'), 'Jump'))
    expect(onJump.mock.calls.map(([jump]) => jump)).toEqual([
      { tab: 'conversation', section: 'details' }, { tab: 'checks' }, { tab: 'files' }
    ])
    expect(row(view, 'merge').querySelector('button')).toBeNull()
  })

  it('names who approved or requested changes, and says when merging is still allowed with open threads', async () => {
    const user = (id: number, login: string) => ({ id, login, avatarUrl: 'https://avatars.githubusercontent.com/u/1' })
    const sidebar = { reviewers: [{ user: user(1, 'ana'), state: 'approved' as const }, { user: user(2, 'bo'), state: 'commented' as const }] }
    const approved = await mount({ sidebar })
    expect(row(approved.view, 'review').textContent).toContain('Approved by ana')
    expect(row(approved.view, 'threads').textContent).toContain('2 conversations unresolved merging is still allowed')
    act(() => root!.unmount()); host!.remove(); root = host = undefined

    const changes = await mount({ merge: 'blocked', sidebar: { reviewers: [{ user: user(2, 'bo'), state: 'changes-requested' }] } },
      { checks: { ...passing, review: 'changes-requested' } })
    expect(row(changes.view, 'review').textContent).toContain('Changes requested by bo')
    expect(row(changes.view, 'threads').textContent).not.toContain('still allowed')
  })

  it('names failing checks in the checks row', async () => {
    const { view } = await mount({}, { checks: { ...passing, checks: [{ name: 'a', state: 'failed' }, { name: 'b', state: 'passed' }] } })
    expect(row(view, 'checks').textContent).toContain('1 failing check of 2')
  })
})

describe('PullMergeBox method menu', () => {
  it('lists only the allowed methods; a pick renames the split button and merges with it after Confirm', async () => {
    const { view, api, onWritten } = await mount()
    const main = view.querySelector<HTMLButtonElement>('.pr-split__main')!
    expect(main.textContent).toBe('Squash and merge')
    await click(view.querySelector<HTMLButtonElement>('[aria-label="Choose merge method"]'))
    const items = [...view.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((el) => el.textContent)).toEqual([
      'Squash and mergeThe 2 commits become one on main.', 'Rebase and mergeThe 2 commits are rebased onto main.'
    ])
    await click(items[1])
    expect(view.querySelector('[role="menu"]')).toBeNull()
    expect(main.textContent).toBe('Rebase and merge')
    await click(main)
    expect(api.mergePull).not.toHaveBeenCalled()
    expect(view.querySelector('[role="dialog"]')?.textContent).toContain('Method: Rebase and merge at ccccccc')
    await click(button(view, 'Confirm merge'))
    expect(api.mergePull).toHaveBeenCalledWith({ ...at, method: 'rebase', headSha: HEAD })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('offers Merge when ready in the menu for a blocked PR, which opens the auto-merge confirmation', async () => {
    const { view, api } = await mount({ merge: 'blocked' })
    expect(view.querySelector<HTMLButtonElement>('.pr-split__main')!.disabled).toBe(true)
    await click(view.querySelector<HTMLButtonElement>('[aria-label="Choose merge method"]'))
    await click([...view.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent?.startsWith('Merge when ready')))
    await click(button(view, 'Enable auto-merge'))
    expect(api.enablePullAutoMerge).toHaveBeenCalledWith({ ...at, method: 'squash', headSha: HEAD })
  })

  it('Escape closes the menu', async () => {
    const { view } = await mount()
    await click(view.querySelector<HTMLButtonElement>('[aria-label="Choose merge method"]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(view.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('PullMergeBox states', () => {
  it('draft: says so and offers Ready for review, no merge button', async () => {
    const { view, api } = await mount({ lifecycle: 'draft' })
    expect(view.querySelector('.pr-mstate')?.textContent).toContain('This is a draft')
    expect(view.querySelector('.pr-split__main')).toBeNull()
    await click(button(view, 'Ready for review'))
    expect(api.markPullReady).toHaveBeenCalledWith(at)
  })

  it('conflict: Resolve with agent sends the conflict through Send to…, Resolve myself is Work on this PR', async () => {
    const sendTo = vi.fn()
    sendToApi.current = { sendTo, why: undefined }
    const onWork = vi.fn()
    const { view } = await mount({ merge: 'conflict' }, { onWork })
    const merge = row(view, 'merge')
    expect(merge.textContent).toContain('Conflicts with main')
    await click(button(merge, 'Resolve with agent'))
    expect(sendTo).toHaveBeenCalledWith({ kind: 'conflict', base: 'main' })
    await click(button(merge, 'Resolve myself'))
    expect(onWork).toHaveBeenCalledWith({ ...detail, merge: 'conflict' })
  })

  it('conflict on a relay tab: Resolve with agent is off with the reason', async () => {
    sendToApi.current = { sendTo: undefined, why: 'Not on a relay tab.' }
    const { view } = await mount({ merge: 'conflict' })
    const agent = button(row(view, 'merge'), 'Resolve with agent')!
    expect(agent.disabled).toBe(true)
    expect(agent.title).toBe('Not on a relay tab.')
  })

  it('behind: the merge row offers Update branch at the head shown', async () => {
    const { view, api } = await mount({ merge: 'behind' })
    await click(button(row(view, 'merge'), 'Update branch'))
    expect(api.updatePullBranch).toHaveBeenCalledWith({ ...at, headSha: HEAD })
  })

  it('merged: says so and offers Delete branch beside the branch name', async () => {
    const { view, api } = await mount({ lifecycle: 'merged', merge: undefined })
    const state = view.querySelector('.pr-mstate')!
    expect(state.textContent).toContain('Merged into main')
    expect(state.querySelector('.pr-mstate__branch')?.textContent).toBe('feat/pull')
    expect(view.querySelector('[data-row]')).toBeNull()
    await click(button(view, 'Delete branch'))
    expect(api.deleteHeadBranch).toHaveBeenCalledWith(at)
    expect(view.textContent).toContain('Branch feat/pull was deleted.')
  })

  it('merged and closed: by whom and when, from the timeline read', async () => {
    const ago = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const timeline = (kind: 'merged' | 'closed'): GitHubPullTimelineResult => ({
      status: 'ok', openedAt: '2026-10-01T09:00:00Z', observedAt: 1,
      items: [{ id: 'e', actor: { id: 3, login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/3' }, at: ago,
        ...(kind === 'merged' ? { kind, oid: HEAD, base: 'main' } : { kind }) }]
    })
    const merged = await mount({ lifecycle: 'merged', merge: undefined }, { timeline: timeline('merged') })
    expect(merged.view.querySelector('.pr-mstate__sub')?.textContent).toBe('by octo · 3h ago')
    act(() => root!.unmount()); host!.remove(); root = host = undefined
    const closed = await mount({ lifecycle: 'closed', merge: undefined }, { timeline: timeline('closed') })
    expect(closed.view.querySelector('.pr-mstate__sub')?.textContent).toBe('by octo · 3h ago')
  })

  it('draws the agent proposal as the card\'s top section', async () => {
    const { view } = await mount({}, { top: <div className="pull-proposal">proposal</div> })
    const card = view.querySelector('.pr-mbox')!
    expect(card.firstElementChild?.className).toBe('pull-proposal')
  })

  it('closed: says so and offers Reopen pull request', async () => {
    const { view, api } = await mount({ lifecycle: 'closed', merge: undefined })
    expect(view.querySelector('.pr-mstate')?.textContent).toContain('Closed without merging')
    await click(button(view, 'Reopen pull request'))
    expect(api.setPullState).toHaveBeenCalledWith({ ...at, open: true })
  })
})

describe('PullProposalBar', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  async function propose(proposal: PullProposal) {
    const api = fakeApi()
    const onDismiss = vi.fn()
    const onWritten = vi.fn()
    const view = host = document.createElement('div')
    document.body.append(view)
    root = createRoot(view)
    await act(async () => {
      root!.render(<PullProposalBar api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={0} onOpenExternal={vi.fn()} onWritten={onWritten} agents={[{ id: 'a', title: 'Claude' }]}
        proposal={proposal} seen={detail} seenChecks={passing} ownPull={false} onDismiss={onDismiss} methods={ALLOWED} />)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    return { view, api, onDismiss, onWritten }
  }

  it('names the agent, the method and the head, and Details shows the exact call Confirm sends', async () => {
    const { view, api, onDismiss, onWritten } = await propose({ action: 'merge', method: 'squash' })
    expect(view.querySelector('.pr-proposal__head')?.textContent).toContain('Claude proposes squash and merge at ccccccc')
    const call = view.querySelector('details pre')!.textContent!
    expect(call.startsWith('mergePull(')).toBe(true)
    expect(JSON.parse(call.slice('mergePull('.length, -1))).toEqual({ repository: 'o/r', pullNumber: 7, method: 'squash', headSha: HEAD })
    expect(api.mergePull).not.toHaveBeenCalled()
    await click(button(view, 'Confirm'))
    expect(api.mergePull).toHaveBeenCalledWith({ ...at, method: 'squash', headSha: HEAD })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('Dismiss sends nothing', async () => {
    const { view, api, onDismiss } = await propose({ action: 'approve', message: 'LGTM' })
    expect(view.querySelector('details pre')?.textContent).toContain('"event": "APPROVE"')
    await click(button(view, 'Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(api.reviewPull).not.toHaveBeenCalled()
  })
})
