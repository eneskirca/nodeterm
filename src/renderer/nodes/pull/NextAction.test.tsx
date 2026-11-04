// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { NextAction } from './NextAction'
import { nextStep, type ReadinessInput } from './readiness'
import type { PullNodeApi } from './shared'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'd'.repeat(40) }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}
const failing: GitHubPullChecksResult = { status: 'ok', headRefOid: HEAD, truncated: false, checks: [{ name: 'test', state: 'failed' }] }
const at = { projectId: 'p', repository: 'o/r', pullNumber: 7 }

describe('nextStep', () => {
  it.each<[string, Partial<ReadinessInput> & { method?: 'squash' }, string | null]>([
    ['closed', { detail: { ...detail, lifecycle: 'closed' } }, 'reopen:Reopen'],
    ['merged', { detail: { ...detail, lifecycle: 'merged' } }, null],
    ['draft', { detail: { ...detail, lifecycle: 'draft', merge: 'conflict' } }, 'ready:Ready for review'],
    ['conflict', { detail: { ...detail, merge: 'conflict' }, checks: failing }, 'conflicts:Resolve conflicts'],
    ['failing checks', { checks: failing, openThreads: 2 }, 'checks:Fix checks'],
    ['open threads', { openThreads: 2 }, 'threads:Review 2 open threads'],
    ['one thread', { openThreads: 1 }, 'threads:Review 1 open thread'],
    ['ready, squash allowed', { openThreads: 0, method: 'squash' }, 'merge:Squash and merge'],
    ['ready, methods unknown', {}, 'merge:Merge']
  ])('%s', (_name, input, expected) => {
    const step = nextStep({ detail, ...input })
    expect(step && `${step.kind}:${step.label}`).toBe(expected)
  })
})

function fakeApi() {
  const api = {
    setPullState: vi.fn(async () => ({ ok: true as const })),
    markPullReady: vi.fn(async () => ({ ok: true as const })),
    updatePullBranch: vi.fn(async () => ({ ok: false as const, reason: 'forbidden' as const }))
  }
  // ponytail: the header button and its menu write only through these three.
  return api as typeof api & PullNodeApi
}

let host: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = host = undefined })

async function mount(d: GitHubPullDetail, input: Partial<ReadinessInput> & { method?: 'squash' } = {}, extra: {
  onWork?: () => void; onCopy?: (text: string) => void; onOpenExternal?: (url: string) => void
} = {}) {
  const api = fakeApi()
  const onJump = vi.fn()
  const onWritten = vi.fn()
  const view = host = document.createElement('div')
  document.body.append(view)
  const r = root = createRoot(view)
  await act(async () => {
    r.render(<NextAction api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }} refreshTick={0}
      onOpenExternal={extra.onOpenExternal ?? vi.fn()} onWritten={onWritten} detail={d} next={nextStep({ detail: d, ...input })}
      onJump={onJump} onWork={extra.onWork} onCopy={extra.onCopy} />)
  })
  const lead = view.querySelector<HTMLButtonElement>('[data-next]')
  const openMenu = async () => act(async () => { view.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click() })
  const item = (label: string) => [...view.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.startsWith(label))
  return { api, view, lead, onJump, onWritten, openMenu, item }
}

describe('NextAction', () => {
  it('reopens a closed PR and marks a draft ready through the existing writes', async () => {
    const closed = await mount({ ...detail, lifecycle: 'closed' })
    expect(closed.lead?.textContent).toBe('Reopen')
    await act(async () => { closed.lead!.click() })
    expect(closed.api.setPullState).toHaveBeenCalledWith({ ...at, open: true })
    expect(closed.onWritten).toHaveBeenCalledTimes(1)
    act(() => root!.unmount()); host!.remove(); root = host = undefined

    const draft = await mount({ ...detail, lifecycle: 'draft' })
    await act(async () => { draft.lead!.click() })
    expect(draft.api.markPullReady).toHaveBeenCalledWith(at)
  })

  it('jumps instead of writing for checks, threads and merge', async () => {
    const checks = await mount(detail, { checks: failing })
    await act(async () => { checks.lead!.click() })
    expect(checks.onJump).toHaveBeenCalledWith({ tab: 'checks' })
    act(() => root!.unmount()); host!.remove(); root = host = undefined

    const merge = await mount(detail, { method: 'squash' })
    await act(async () => { merge.lead!.click() })
    expect(merge.onJump).toHaveBeenCalledWith({ tab: 'conversation', section: 'merge' })
  })

  it('resolves conflicts with the agent through onWork', async () => {
    const onWork = vi.fn()
    const view = await mount({ ...detail, merge: 'conflict' }, {}, { onWork })
    await act(async () => { view.lead!.click() })
    expect(onWork).toHaveBeenCalledWith({ ...detail, merge: 'conflict' }, true)
  })

  it('shows no lead button for a merged PR, and only Copy link and Open on GitHub in its menu', async () => {
    const view = await mount({ ...detail, lifecycle: 'merged' }, {}, { onCopy: vi.fn(), onWork: vi.fn() })
    expect(view.lead).toBeNull()
    await view.openMenu()
    expect([...view.view.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['Copy link', 'Open on GitHub'])
  })

  it('lists the More actions of an open PR and runs each one', async () => {
    const onWork = vi.fn()
    const onCopy = vi.fn()
    const onOpenExternal = vi.fn()
    const view = await mount(detail, {}, { onWork, onCopy, onOpenExternal })
    await view.openMenu()
    expect([...view.view.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual([
      'Work on this PRCheck out the branch in a new agent node.', 'Update branchMerge main into feat.', 'Copy link', 'Open on GitHub',
      'Close pull request'
    ])
    await act(async () => { view.item('Copy link')!.click() })
    expect(onCopy).toHaveBeenCalledWith('https://github.com/o/r/pull/7')
    expect(view.view.querySelector('[role="menu"]')).toBeNull()
    await view.openMenu()
    await act(async () => { view.item('Update branch')!.click() })
    expect(view.api.updatePullBranch).toHaveBeenCalledWith({ ...at, headSha: HEAD })
    expect(view.view.querySelector('[role="alert"]')?.textContent).toContain('token')
    await view.openMenu()
    await act(async () => { view.item('Close pull request')!.click() })
    expect(view.api.setPullState).toHaveBeenCalledWith({ ...at, open: false })
    await view.openMenu()
    await act(async () => { view.item('Work on this PR')!.click() })
    expect(onWork).toHaveBeenCalledWith(detail)
  })

  it('closes the menu on Escape', async () => {
    const view = await mount(detail)
    await view.openMenu()
    expect(view.view.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(view.view.querySelector('[role="menu"]')).toBeNull()
  })
})
