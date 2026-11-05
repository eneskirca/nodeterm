// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail, PullWriteResult } from '@shared/github-pull-detail'
import type { PullSidebar as Sidebar } from '@shared/github-pull-sidebar'
import { ISSUE_OPEN_EVENT } from '../../lib/openIssueNode'
import { PullSidebar } from './PullSidebar'
import type { PullNodeApi } from './shared'
import { PULL_WATCH_UNLINKED, type PullWatchStatus } from '@shared/github-issues'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user = (id: number, login: string) => ({ id, login, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` })
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: user(1, 'octocat'),
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7'
}
const sidebar: Sidebar = {
  reviewers: [{ user: user(3, 'cy'), state: 'approved' }, { user: user(2, 'ana'), state: 'pending', previous: 'changes-requested' }],
  assignees: [user(4, 'dee')],
  labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: 'fef2c0' }],
  closingIssues: [
    { repository: 'o/r', number: 12, title: 'Crash on load', state: 'open' },
    { repository: 'x/y', number: 3, title: 'Elsewhere', state: 'closed' }
  ],
  participants: [user(1, 'octocat'), user(3, 'cy')]
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(d: GitHubPullDetail, onOpenExternal = vi.fn(), onWritten = vi.fn(),
  extra: { nodeId?: string; agents?: { id: string; title: string }[]; watch?: PullWatchStatus } = {}) {
  const api = {
    pullWatch: vi.fn(async (): Promise<PullWatchStatus> => extra.watch ?? { on: false }),
    setPullWatch: vi.fn(async (r: { on: boolean }): Promise<PullWatchStatus> => ({ on: r.on })),
    repoCollaborators: vi.fn(async () => ({ status: 'ok' as const, users: [] })),
    requestPullReviewer: vi.fn(async () => ({ ok: true as const })),
    repoLabels: vi.fn(async () => ({ status: 'ok' as const, labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: '0e8a16' }] })),
    setPullLabels: vi.fn(async (): Promise<PullWriteResult> => ({ ok: true })),
    setPullAssignees: vi.fn(async (): Promise<PullWriteResult> => ({ ok: true }))
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullSidebar api={api as unknown as PullNodeApi} projectId="p" pull={{ repository: 'O/R', pullNumber: 7, tab: 'conversation' }}
      refreshTick={0} onOpenExternal={onOpenExternal} onWritten={onWritten} detail={d} nodeId={extra.nodeId} agents={extra.agents} />)
  })
  return { view: host, api, onOpenExternal, onWritten }
}

const section = (view: HTMLElement, label: string) => view.querySelector<HTMLElement>(`section[aria-label="${label}"]`)
const button = (view: HTMLElement, name: string) =>
  ([...view.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!
/** The picker's checkbox rows, by name. */
const rows = (view: HTMLElement, label: string) => Object.fromEntries(
  [...view.querySelectorAll(`[role="dialog"][aria-label="${label}"] label.pr-pick__opt`)]
    .map((row) => [row.querySelector('.pr-pick__name')!.textContent!, row.querySelector('input') as HTMLInputElement]))

describe('PullSidebar', () => {
  it('shows each reviewer state, a re-request as pending, assignees, label chips and participants', async () => {
    const { view } = await render({ ...detail, sidebar })
    const reviewers = view.querySelector('.pull-reviewers')?.textContent
    expect(reviewers).toContain('cyApproved')
    expect(reviewers).toContain('anaPending (was changes requested)')
    expect(section(view, 'Assignees')?.textContent).toContain('dee')
    const chips = [...view.querySelectorAll('.pull-label')] as HTMLElement[]
    expect(chips.map((chip) => chip.textContent)).toEqual(['bug', 'docs'])
    expect(chips[0].style.color).toBe('rgb(255, 255, 255)')
    expect(chips[1].style.color).toBe('rgb(31, 35, 40)')
    expect(section(view, 'Participants')!.querySelectorAll('.pull-avatar')).toHaveLength(2)
  })

  it('puts the Agent section first, marked as the agent jump target; without a linked agent Watch is off and says why', async () => {
    const { view, api } = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1' })
    const agent = view.querySelector('aside > section')!
    expect(agent.getAttribute('aria-label')).toBe('Agent')
    expect(agent.getAttribute('data-pull-section')).toBe('agent')
    expect(agent.textContent).toContain('No agent linked.')
    const watch = agent.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect([watch.disabled, watch.getAttribute('aria-checked')]).toEqual([true, 'false'])
    expect(agent.textContent).toContain('Link an agent first')
    expect(api.pullWatch).toHaveBeenCalledWith('p', 'pr1')
  })

  it('Watch: a click turns it on for this node, a second click turns it off', async () => {
    const { view, api } = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1', agents: [{ id: 'a1', title: 'Claude' }] })
    const watch = view.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect([watch.disabled, watch.getAttribute('aria-checked')]).toEqual([false, 'false'])
    await act(async () => { watch.click() })
    expect(api.setPullWatch).toHaveBeenCalledWith({ projectId: 'p', nodeId: 'pr1', on: true })
    expect(watch.getAttribute('aria-checked')).toBe('true')
    await act(async () => { watch.click() })
    expect(api.setPullWatch).toHaveBeenLastCalledWith({ projectId: 'p', nodeId: 'pr1', on: false })
    expect(watch.getAttribute('aria-checked')).toBe('false')
  })

  it('Watch: shows why it turned itself off, and why a wake did not land', async () => {
    const reason = 'Watch stopped after 10 wakes with no new commit. Switch it on to watch again.'
    const off = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1', agents: [{ id: 'a1', title: 'Claude' }], watch: { on: false, reason } })
    expect(off.view.querySelector('[role="status"]')?.textContent).toBe(reason)
    expect(off.view.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false)
    act(() => root.unmount()); host.remove()
    const note = 'Watch could not wake the agent: agent messaging is off for this project.'
    const on = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1', watch: { on: true, note } })
    const watch = on.view.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect([watch.disabled, watch.getAttribute('aria-checked')]).toEqual([false, 'true']) // an unlinked node can still switch it off
    expect(on.view.querySelector('[role="status"]')?.textContent).toBe(note)
  })

  it('Watch: switched on with agent messaging off, it shows the warning at once', async () => {
    const note = 'Watch cannot wake the agent: agent messaging is off for this project.'
    const { view, api } = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1', agents: [{ id: 'a1', title: 'Claude' }] })
    api.setPullWatch.mockResolvedValueOnce({ on: true, note })
    await act(async () => { view.querySelector<HTMLButtonElement>('[role="switch"]')!.click() })
    expect(view.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(view.querySelector('[role="status"]')?.textContent).toBe(note)
  })

  it('Watch: an agent unlinked while it is on says so at once, and a relinked one drops a stale unlinked note', async () => {
    const off = await render({ ...detail, sidebar }, vi.fn(), vi.fn(), { nodeId: 'pr1', watch: { on: true } })
    expect(off.view.querySelector('[role="status"]')?.textContent).toBe(PULL_WATCH_UNLINKED)
    act(() => root.unmount()); host.remove()
    const back = await render({ ...detail, sidebar }, vi.fn(), vi.fn(),
      { nodeId: 'pr1', agents: [{ id: 'a1', title: 'Claude' }], watch: { on: true, note: PULL_WATCH_UNLINKED } })
    expect(back.view.querySelector('[role="status"]')).toBeNull()
  })

  it('re-requests a review from a reviewer who answered, with the existing write', async () => {
    const { view, api, onWritten } = await render({ ...detail, sidebar })
    expect(view.querySelector('[aria-label="Re-request review from ana"]')).toBeNull()
    await act(async () => { (view.querySelector('[aria-label="Re-request review from cy"]') as HTMLButtonElement).click() })
    expect(api.requestPullReviewer).toHaveBeenCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, reviewer: 'cy' })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('opens a linked issue of this repository in the Issues node, and one elsewhere on GitHub', async () => {
    const opened = vi.fn()
    const listener = (event: Event) => opened((event as CustomEvent).detail)
    window.addEventListener(ISSUE_OPEN_EVENT, listener)
    const { view, onOpenExternal } = await render({ ...detail, sidebar })
    const [here, elsewhere] = [...section(view, 'Development')!.querySelectorAll('.pull-sidebar__issue')] as HTMLButtonElement[]
    expect(here.textContent).toContain('#12 Crash on load')
    act(() => here.click())
    expect(opened).toHaveBeenCalledWith({ repository: 'O/R', issueNumber: 12 })
    act(() => elsewhere.click())
    expect(onOpenExternal).toHaveBeenCalledWith('https://github.com/x/y/issues/3')
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener(ISSUE_OPEN_EVENT, listener)
  })

  it('hides a part the read could not answer, and falls back to requested reviewers without a sidebar', async () => {
    const { view } = await render({ ...detail, requestedReviewers: [user(2, 'ana')] })
    expect([...view.querySelectorAll('aside > section')].map((s) => s.getAttribute('aria-label'))).toEqual(['Agent', 'Reviewers'])
    expect(view.querySelector('.pull-reviewers')?.textContent).toContain('anaPending')
  })
})

describe('PullSidebar pickers', () => {
  it('Edit opens a search picker of the repository labels, the PR\'s own ticked; the filter narrows it', async () => {
    const { view, api } = await render({ ...detail, sidebar })
    expect(api.repoLabels).not.toHaveBeenCalled()
    await act(async () => { button(view, 'Edit labels').click() })
    expect(api.repoLabels).toHaveBeenCalledWith('p', 'O/R')
    const picked = rows(view, 'Labels')
    expect(Object.keys(picked)).toEqual(['bug', 'ui'])
    expect([picked.bug.checked, picked.ui.checked]).toEqual([true, false])
    const filter = view.querySelector<HTMLInputElement>('input[aria-label="Filter labels"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'UI')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(Object.keys(rows(view, 'Labels'))).toEqual(['ui'])
  })

  it('ticking adds a label and unticking removes one, one call each, then the node reloads', async () => {
    const { view, api, onWritten } = await render({ ...detail, sidebar })
    await act(async () => { button(view, 'Edit labels').click() })
    await act(async () => { rows(view, 'Labels').ui.click() })
    expect(api.setPullLabels).toHaveBeenCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, label: 'ui', add: true })
    expect(rows(view, 'Labels').ui.checked).toBe(true)
    await act(async () => { rows(view, 'Labels').bug.click() })
    expect(api.setPullLabels).toHaveBeenLastCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, label: 'bug', add: false })
    expect(api.setPullLabels).toHaveBeenCalledTimes(2)
    expect(onWritten).toHaveBeenCalledTimes(2)
  })

  it('adds an assignee from the collaborators and removes one', async () => {
    const { view, api } = await render({ ...detail, sidebar })
    api.repoCollaborators.mockResolvedValueOnce({ status: 'ok', users: [user(4, 'dee'), user(5, 'eve')] } as never)
    await act(async () => { button(view, 'Edit assignees').click() })
    expect(rows(view, 'Assignees').dee.checked).toBe(true)
    await act(async () => { rows(view, 'Assignees').eve.click() })
    expect(api.setPullAssignees).toHaveBeenCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, login: 'eve', add: true })
    await act(async () => { rows(view, 'Assignees').dee.click() })
    expect(api.setPullAssignees).toHaveBeenLastCalledWith({ projectId: 'p', repository: 'O/R', pullNumber: 7, login: 'dee', add: false })
  })

  it('disables every row while its write runs, and shows a plain sentence when it fails', async () => {
    const { view, api, onWritten } = await render({ ...detail, sidebar })
    let land: (result: PullWriteResult) => void = () => undefined
    api.setPullLabels.mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
    await act(async () => { button(view, 'Edit labels').click() })
    await act(async () => { rows(view, 'Labels').bug.click() })
    expect(Object.values(rows(view, 'Labels')).map((box) => box.disabled)).toEqual([true, true])
    await act(async () => { land({ ok: false, reason: 'forbidden' }) })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('may not write to this repository')
    expect(rows(view, 'Labels').bug.disabled).toBe(false)
    expect(rows(view, 'Labels').bug.checked).toBe(true)
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('Escape closes the picker', async () => {
    const { view } = await render({ ...detail, sidebar })
    await act(async () => { button(view, 'Edit labels').click() })
    const dialog = view.querySelector('[role="dialog"]')!
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes on Escape and on a press outside even when the canvas stops both from bubbling', async () => {
    const { view } = await render({ ...detail, sidebar })
    // The canvas pane: d3-zoom stops a press from bubbling, and a focused node can swallow Escape.
    const pane = document.createElement('div')
    document.body.append(pane)
    const swallow = (event: Event) => event.stopPropagation()
    pane.addEventListener('pointerdown', swallow)
    pane.addEventListener('keydown', swallow)
    try {
      await act(async () => { button(view, 'Edit labels').click() })
      await act(async () => { pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(view.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => { button(view, 'Edit labels').click() })
      await act(async () => { view.querySelector('[role="dialog"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
      expect(view.querySelector('[role="dialog"]')).not.toBeNull()
      await act(async () => { pane.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
      expect(view.querySelector('[role="dialog"]')).toBeNull()
    } finally { pane.remove() }
  })

  it('shows no edit controls for a part the read could not answer', async () => {
    const { view } = await render({ ...detail, sidebar: { ...sidebar, labels: undefined, assignees: undefined } })
    expect(button(view, 'Edit labels')).toBeUndefined()
    expect(button(view, 'Edit assignees')).toBeUndefined()
  })
})
