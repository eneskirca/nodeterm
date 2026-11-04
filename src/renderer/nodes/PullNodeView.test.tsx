// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubPullConversationResult, GitHubPullDetail, GitHubPullDetailResult, GitHubPullFileContentsResult, GitHubPullFilesResult,
  PullLineComment
} from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { normalizePullRef, type PullNodeTab } from '@shared/pull-node'
import type { PullProposal, ShownProposal } from '@shared/pull-agent-verbs'
import { PullNodeView, type PullNodeApi } from './PullNodeView'

// Monaco does not run in jsdom: the diff shows its two texts and its path instead, its zones in
// place, and one button per side that stands for a click on line 3's number.
vi.mock('../editor/TextDiff', () => ({
  TextDiff: ({ path, original, modified, highlight, zones = [], onLineClick }: {
    path: string; original: string; modified: string; highlight?: { start: number; end: number }
    zones?: Array<{ key: string; side: string; line: number; content: React.ReactNode }>
    onLineClick?: (side: 'original' | 'modified', line: number) => void
  }) => (
    <div className="text-diff" data-path={path} data-original={original} data-modified={modified}
      data-highlight={highlight ? `${highlight.start}-${highlight.end}` : undefined}>
      {zones.map((zone) => <div key={zone.key} className="zone" data-at={`${zone.side}:${zone.line}`}>{zone.content}</div>)}
      <button onClick={() => onLineClick?.('original', 3)}>line original 3</button>
      <button onClick={() => onLineClick?.('modified', 3)}>line modified 3</button>
    </div>
  )
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail: GitHubPullDetail = {
  number: 7, title: 'Add the pull node', body: '## Why it matters\n\nIt keeps review **in place**.',
  lifecycle: 'open', author: { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' },
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat/pull', sha: 'c'.repeat(40) },
  merge: 'ready', additions: 10, deletions: 2, changedFiles: 3, url: 'https://github.com/o/r/pull/7'
}

function fakeApi(result: GitHubPullDetailResult, checks: GitHubPullChecksResult = {
  status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [{ name: 'test', state: 'passed' }]
}, conversation: GitHubPullConversationResult = { status: 'ok', items: [], lineComments: [], truncated: false, observedAt: 1 }):
  PullNodeApi & {
    pullDetail: ReturnType<typeof vi.fn>; pullChecks: ReturnType<typeof vi.fn>; pullConversation: ReturnType<typeof vi.fn>
    pullFiles: ReturnType<typeof vi.fn>; pullFileContents: ReturnType<typeof vi.fn>
    commentOnPull: ReturnType<typeof vi.fn>; reviewPull: ReturnType<typeof vi.fn>
    mergePull: ReturnType<typeof vi.fn>; repoMergeMethods: ReturnType<typeof vi.fn>
    repoCollaborators: ReturnType<typeof vi.fn>; requestPullReviewer: ReturnType<typeof vi.fn>
    commentOnPullLine: ReturnType<typeof vi.fn>; updatePullBranch: ReturnType<typeof vi.fn>
    enablePullAutoMerge: ReturnType<typeof vi.fn>; disablePullAutoMerge: ReturnType<typeof vi.fn>
    setFileViewed: ReturnType<typeof vi.fn>
  } {
  return {
    pullDetail: vi.fn(async () => result),
    pullChecks: vi.fn(async () => checks),
    pullConversation: vi.fn(async () => conversation),
    pullFiles: vi.fn(async (): Promise<GitHubPullFilesResult> => ({ status: 'ok', files: [], truncated: false, observedAt: 1 })),
    pullFileContents: vi.fn(async (): Promise<GitHubPullFileContentsResult> => ({ status: 'refused', reason: 'not-approved' })),
    commentOnPull: vi.fn(async () => ({ ok: true as const })),
    reviewPull: vi.fn(async () => ({ ok: true as const })),
    mergePull: vi.fn(async () => ({ ok: true as const })),
    repoMergeMethods: vi.fn(async () => ({ status: 'ok' as const, methods: ['squash' as const, 'rebase' as const], autoMerge: true as const })),
    repoCollaborators: vi.fn(async () => ({
      status: 'ok' as const,
      users: ['octocat', 'ana', 'bo'].map((login, id) => ({ id, login, avatarUrl: 'https://avatars.githubusercontent.com/u/1' }))
    })),
    requestPullReviewer: vi.fn(async () => ({ ok: true as const })),
    commentOnPullLine: vi.fn(async () => ({ ok: true as const })),
    updatePullBranch: vi.fn(async () => ({ ok: true as const })),
    enablePullAutoMerge: vi.fn(async () => ({ ok: true as const })),
    disablePullAutoMerge: vi.fn(async () => ({ ok: true as const })),
    setFileViewed: vi.fn(async () => ({ ok: true as const }))
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(
  api: PullNodeApi, repository = 'o/r', tab: PullNodeTab = 'conversation', onTab = vi.fn(), onOpenExternal = vi.fn(),
  onWritten = vi.fn(), selectedFile?: string, onSelectFile = vi.fn(), onWork = vi.fn()
): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository, pullNumber: 7, tab, selectedFile }}
      refreshTick={0} onTab={onTab} onOpenExternal={onOpenExternal} onWritten={onWritten} onSelectFile={onSelectFile}
      onWork={onWork} />)
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

  it('offers Allow for a repository not allowed yet, and reads again once it is', async () => {
    const api = fakeApi({ status: 'refused', reason: 'not-approved' })
    const onAllow = vi.fn(async () => true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} onAllow={onAllow} />)
    })
    const allow = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow o/r?')
    expect(allow).toBeDefined()
    await act(async () => { allow!.click() })
    expect(onAllow).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Could not allow')
  })

  it('says so when Allow did not land, and offers it again', async () => {
    const api = fakeApi({ status: 'refused', reason: 'not-approved' })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()}
        onAllow={vi.fn(async () => false)} />)
    })
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow o/r?')!.click() })
    expect(host.textContent).toContain('Could not allow o/r. Try again.')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Allow o/r?' && !b.disabled)).toBe(true)
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
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={1} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} />)
    })
    expect(api.pullDetail).toHaveBeenCalledTimes(2)
  })
})

const author = { id: 2, login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/2' }
const at = (hour: number) => `2026-10-01T${hour}:00:00Z`
const url = 'https://github.com/o/r/pull/7'

describe('PullNodeView conversation', () => {
  it('lists comments and reviews in the order read, each review with its verdict', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined, {
      status: 'ok', truncated: false, observedAt: 1, lineComments: [], items: [
        { kind: 'comment', id: 1, author, body: 'First **comment**', at: at(10), url },
        { kind: 'review', id: 2, author, body: '', at: at(11), url, verdict: 'approved' },
        { kind: 'review', id: 3, author: null, body: 'Fix the test', at: at(12), url, verdict: 'changes-requested' },
        { kind: 'review', id: 4, author, body: 'Note', at: at(13), url, verdict: 'commented' }
      ]
    })
    const view = await render(api, 'o/r', 'conversation')
    expect(api.pullConversation).toHaveBeenCalledWith('p', 'o/r', 7)
    const items = [...view.querySelectorAll('.pull-convo__item')].map((item) => item.textContent)
    expect(items).toHaveLength(4)
    expect(items[0]).toContain('First comment')
    expect(view.querySelector('.pull-convo__item strong')?.textContent).toBe('comment')
    expect(items[1]).toContain('Approved')
    expect(items[2]).toContain('Changes requested')
    expect(items[2]).toContain('Fix the test')
    expect(items[3]).toContain('Commented')
  })

  it('never runs script from a comment', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined, {
      status: 'ok', truncated: false, observedAt: 1, lineComments: [],
      items: [{ kind: 'comment', id: 1, author, body: '<img src=x onerror="alert(1)"><script>alert(2)</script>', at: at(10), url }]
    })
    const view = await render(api, 'o/r', 'conversation')
    expect(view.querySelector('script')).toBeNull()
    expect(view.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it('says when there is nothing yet, and names a refusal with its fix', async () => {
    expect((await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'conversation')).textContent)
      .toContain('No comments or reviews yet.')
    act(() => root.unmount()); host.remove()
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined,
      { status: 'refused', reason: 'not-approved' }), 'o/r', 'conversation')
    expect(view.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain('approve')
  })

  it('names the tabs Conversation and Files changed N, where N is the changed file count', async () => {
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'files')
    const tabs = [...view.querySelectorAll('[role="tab"]')]
    expect(tabs.map((el) => el.textContent)).toEqual(['Conversation', 'Files changed 3'])
    expect(tabs.map((el) => el.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it.each([
    ['overview', 'Conversation'],
    ['conversation', 'Conversation'],
    ['files', 'Files changed 3']
  ])('opens a node saved with tab %s on %s', async (saved, label) => {
    const pull = normalizePullRef({ repository: 'o/r', pullNumber: 7, tab: saved })!
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', pull.tab)
    expect(view.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(label)
  })

  it('shows Conversation for a tab this build has no panel for', async () => {
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'commits')
    expect(view.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Conversation')
    expect(view.textContent).toContain('No comments or reviews yet.')
  })

  it('switches tab through onTab and opens the PR on GitHub from every tab', async () => {
    const onTab = vi.fn()
    const onOpen = vi.fn()
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'conversation', onTab, onOpen)
    const tab = [...view.querySelectorAll('[role="tab"]')].find((el) => el.textContent === 'Files changed 3')!
    await act(async () => { (tab as HTMLElement).click() })
    expect(onTab).toHaveBeenCalledWith('files')
    const link = [...view.querySelectorAll('button')].find((el) => el.textContent === 'Open on GitHub')!
    await act(async () => { link.click() })
    expect(onOpen).toHaveBeenCalledWith('https://github.com/o/r/pull/7')
  })
})

describe('PullNodeView tab switching', () => {
  it('keeps a tab mounted after a switch, so switching back reads nothing again', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await render(api)
    const show = async (tab: PullNodeTab) => act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} />)
    })
    await show('files')
    await show('conversation')
    await show('files')
    expect(api.pullDetail).toHaveBeenCalledTimes(1)
    expect(api.pullFiles).toHaveBeenCalledTimes(1)
    // One conversation read per tab (Files reads its line comments); none again on a switch back.
    expect(api.pullConversation).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.pull-node__conversation')?.closest('[hidden]')).not.toBeNull()
  })
})

function type(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}
function typeInput(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (view: HTMLElement, label: string) =>
  [...view.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement

/** The Conversation tab, whose detail read gives the head a review is tied to. */
const renderSeen = (api: PullNodeApi, onWritten = vi.fn()): Promise<HTMLDivElement> =>
  render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)

describe('PullNodeView composer', () => {
  it('posts a comment, clears the draft and refreshes the node', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    const box = view.querySelector('textarea')!
    expect(button(view, 'Comment').disabled).toBe(true)
    await act(async () => { type(box, 'Looks good') })
    await act(async () => { button(view, 'Comment').click() })
    expect(api.commentOnPull).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, body: 'Looks good' })
    expect(box.value).toBe('')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('approves with an optional message against the head commit the Overview showed', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await renderSeen(api)
    await act(async () => { button(view, 'Approve').click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'APPROVE', body: '', headSha: 'c'.repeat(40)
    })
    expect(api.pullDetail).toHaveBeenCalledTimes(1)
  })

  it('offers no review before the detail read showed a head commit', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.pullDetail.mockImplementation(() => new Promise(() => {}))
    const view = await render(api, 'o/r', 'conversation')
    expect(view.textContent).toContain('Loading pull request')
    expect(button(view, 'Approve')).toBeUndefined()
    expect(api.reviewPull).not.toHaveBeenCalled()
  })

  it('offers only Comment on the viewer\'s own pull request', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1, ownPull: true })
    const view = await renderSeen(api)
    const labels = [...view.querySelectorAll('.pull-compose__actions button')].map((b) => b.textContent)
    expect(labels).toEqual(['Comment'])
    expect(view.textContent).toContain('your own pull request')
  })

  it('needs a message to request changes', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await renderSeen(api)
    expect(button(view, 'Request changes').disabled).toBe(true)
    await act(async () => { type(view.querySelector('textarea')!, 'Fix the test') })
    await act(async () => { button(view, 'Request changes').click() })
    expect(api.reviewPull).toHaveBeenCalledWith(expect.objectContaining({ event: 'REQUEST_CHANGES', body: 'Fix the test' }))
  })

  it('disables every button while a write runs', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    let land!: (value: { ok: true }) => void
    api.commentOnPull.mockImplementation(() => new Promise((resolve) => { land = resolve }))
    const view = await renderSeen(api)
    await act(async () => { type(view.querySelector('textarea')!, 'x') })
    await act(async () => { button(view, 'Comment').click() })
    expect(['Comment', 'Approve', 'Request changes'].map((label) => button(view, label).disabled)).toEqual([true, true, true])
    await act(async () => { button(view, 'Comment').click() })
    expect(api.commentOnPull).toHaveBeenCalledTimes(1)
    await act(async () => { land({ ok: true }) })
    expect(button(view, 'Approve').disabled).toBe(false)
  })

  it.each([
    ['own-pull', 'your own pull request'],
    ['forbidden', 'write access'],
    ['throttled', 'throttling'],
    ['signed-out', 'sign in'],
    ['not-approved', 'approve'],
    ['validation', 'refused'],
    ['network', 'could not be reached']
  ] as const)('says what a %s refusal means and keeps the draft', async (reason, words) => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.reviewPull.mockResolvedValue({ ok: false, reason })
    const onWritten = vi.fn()
    const view = await renderSeen(api, onWritten)
    await act(async () => { type(view.querySelector('textarea')!, 'Ship it') })
    await act(async () => { button(view, 'Approve').click() })
    expect(view.querySelector('[role="alert"]')?.textContent?.toLowerCase()).toContain(words)
    expect(view.querySelector('textarea')!.value).toBe('Ship it')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('keeps the draft across a tab switch', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await render(api, 'o/r', 'conversation')
    await act(async () => { type(host.querySelector('textarea')!, 'half a thought') })
    for (const tab of ['files', 'conversation'] as const) {
      await act(async () => {
        root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab }}
          refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} />)
      })
    }
    expect(host.querySelector('textarea')!.value).toBe('half a thought')
  })
})

describe('PullNodeView merge', () => {
  const dialog = () => host.querySelector('[role="dialog"]')
  const openMerge = async (api: PullNodeApi, onWritten = vi.fn()) => {
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Merge…').click() })
    return view
  }

  it.each([
    ['draft', { lifecycle: 'draft' }, 'draft'],
    ['closed', { lifecycle: 'closed', merge: undefined }, 'closed'],
    ['merged', { lifecycle: 'merged', merge: undefined }, 'already merged'],
    ['conflicting', { merge: 'conflict' }, 'conflict'],
    ['blocked', { merge: 'blocked' }, 'blocked']
  ] as const)('is disabled with a reason for a %s PR', async (_name, change, words) => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, ...change }, observedAt: 1 })
    const view = await render(api)
    expect(button(view, 'Merge…').disabled).toBe(true)
    expect(view.querySelector('.pull-merge__reason')?.textContent?.toLowerCase()).toContain(words)
  })

  it('opens a confirmation naming the PR, its title and the target branch, with only the allowed methods', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    await openMerge(api)
    expect(dialog()?.textContent).toContain('#7')
    expect(dialog()?.textContent).toContain('Add the pull node')
    expect(dialog()?.textContent).toContain('main')
    const methods = [...dialog()!.querySelectorAll('input[type="radio"]')].map((el) => (el as HTMLInputElement).value)
    expect(methods).toEqual(['squash', 'rebase'])
    expect(api.repoMergeMethods).toHaveBeenCalledWith('p', 'o/r')
    expect(api.mergePull).not.toHaveBeenCalled()
  })

  it('merges only on Confirm, with the picked method and the head the Overview showed, then reloads', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const onWritten = vi.fn()
    await openMerge(api, onWritten)
    const rebase = dialog()!.querySelector('input[value="rebase"]') as HTMLInputElement
    await act(async () => { rebase.click() })
    await act(async () => { button(host, 'Confirm merge').click() })
    expect(api.mergePull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, method: 'rebase', headSha: 'c'.repeat(40)
    })
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })

  it('Cancel closes the confirmation and merges nothing; the methods are read once per node', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await openMerge(api)
    await act(async () => { button(host, 'Cancel').click() })
    expect(dialog()).toBeNull()
    await act(async () => { button(view, 'Merge…').click() })
    expect(api.mergePull).not.toHaveBeenCalled()
    expect(api.repoMergeMethods).toHaveBeenCalledTimes(1)
  })

  it('says the head moved and reloads', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.mergePull.mockResolvedValue({ ok: false, reason: 'head-moved' })
    const onWritten = vi.fn()
    await openMerge(api, onWritten)
    await act(async () => { button(host, 'Confirm merge').click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed since you loaded it')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('says GitHub would not merge it, and does not reload', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.mergePull.mockResolvedValue({ ok: false, reason: 'not-mergeable' })
    const onWritten = vi.fn()
    await openMerge(api, onWritten)
    await act(async () => { button(host, 'Confirm merge').click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be merged')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('offers no Confirm when the repository allows no method for this token', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.repoMergeMethods.mockResolvedValue({ status: 'ok', methods: [] })
    await openMerge(api)
    expect(button(host, 'Confirm merge')).toBeUndefined()
    expect(dialog()?.textContent).toContain('allows no merge method')
  })
})

describe('PullNodeView merge blockers', () => {
  it('says why a protected branch blocks the merge: the review decision and the head\'s checks', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked' }, observedAt: 1 }, {
      status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [{ name: 'test', state: 'failed' }], review: 'required'
    })
    const view = await render(api)
    expect(view.querySelector('.pull-merge__reason')?.textContent)
      .toBe('Branch protection needs an approving review. Checks are failing.')
    expect(button(view, 'Update branch')).toBeUndefined()
  })

  it('a branch behind its base offers Update branch, tied to the head the Overview showed, then reloads', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'behind' }, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    expect(view.querySelector('.pull-merge__reason')?.textContent).toContain('behind main')
    expect(api.updatePullBranch).not.toHaveBeenCalled()
    await act(async () => { button(view, 'Update branch').click() })
    expect(api.updatePullBranch).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, headSha: 'c'.repeat(40) })
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(view.querySelector('.pull-merge')?.textContent).toContain('GitHub is updating the branch')
    expect(button(view, 'Update branch').disabled).toBe(true)
  })

  it('a moved head says so and reloads', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'behind' }, observedAt: 1 })
    api.updatePullBranch.mockResolvedValue({ ok: false, reason: 'head-moved' })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Update branch').click() })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('the branch was not updated')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('reads the checks again on Refresh, so a new review decision shows without a push', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked' }, observedAt: 1 })
    await render(api)
    expect(api.pullChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={1} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()} />)
    })
    expect(api.pullChecks).toHaveBeenCalledTimes(2)
  })

  it('names a refused update and does not reload', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'behind' }, observedAt: 1 })
    api.updatePullBranch.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Update branch').click() })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('may not write')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('a conflict offers Resolve conflicts with agent under the conflict sentence, which takes the Work on this PR path', async () => {
    const onWork = vi.fn()
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, merge: 'conflict' }, observedAt: 1 }),
      'o/r', 'conversation', vi.fn(), vi.fn(), vi.fn(), undefined, vi.fn(), onWork)
    expect(button(view, 'Update branch')).toBeUndefined()
    expect(view.querySelector('.pull-merge__reason')?.textContent).toContain('conflicts with main')
    await act(async () => { button(view, 'Resolve conflicts with agent').click() })
    expect(onWork).toHaveBeenCalledWith({ ...detail, merge: 'conflict' }, true)
  })

  it('a conflict whose base is not a plain ref name refuses the button with a reason', async () => {
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, merge: 'conflict', base: { ...detail.base, ref: 'x;rm -rf ~' } }, observedAt: 1 }))
    expect(button(view, 'Resolve conflicts with agent')).toBeUndefined()
    expect(view.textContent).toContain('cannot be given to an agent')
  })
})

describe('PullNodeView Work on this PR', () => {
  it('an open or draft PR offers Work on this PR, which hands the detail the Overview showed to the canvas', async () => {
    const onWork = vi.fn()
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, lifecycle: 'draft' }, observedAt: 1 }),
      'o/r', 'conversation', vi.fn(), vi.fn(), vi.fn(), undefined, vi.fn(), onWork)
    await act(async () => { button(view, 'Work on this PR').click() })
    expect(onWork).toHaveBeenCalledWith({ ...detail, lifecycle: 'draft' })
  })

  it('a merged or closed PR offers nothing to work on', async () => {
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, lifecycle: 'merged' }, observedAt: 1 }))
    expect(button(view, 'Work on this PR')).toBeUndefined()
  })
})

describe('PullNodeView auto-merge', () => {
  const dialog = () => host.querySelector('[role="dialog"]')

  it('a blocked PR offers Merge when ready: the confirmation arms auto-merge with the method and the head shown', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked' }, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Merge when ready…').click() })
    expect(dialog()?.textContent).toContain('when ready')
    expect(api.enablePullAutoMerge).not.toHaveBeenCalled()
    const rebase = dialog()!.querySelector('input[value="rebase"]') as HTMLInputElement
    await act(async () => { rebase.click() })
    await act(async () => { button(host, 'Enable auto-merge').click() })
    expect(api.enablePullAutoMerge).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, method: 'rebase', headSha: 'c'.repeat(40)
    })
    expect(api.mergePull).not.toHaveBeenCalled()
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ready', {}], ['draft', { lifecycle: 'draft' }], ['conflicting', { merge: 'conflict' }], ['merged', { lifecycle: 'merged', merge: undefined }],
    // Auto-merge does not update a branch: behind under strict protection, it would wait for Update branch.
    ['behind', { merge: 'behind' }]
  ] as const)('a %s PR offers no Merge when ready', async (_name, change) => {
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, ...change }, observedAt: 1 }))
    expect(button(view, 'Merge when ready…')).toBeUndefined()
  })

  it('shows the armed state with its method, and Cancel turns it off', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked', autoMerge: { method: 'squash' } }, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    expect(view.querySelector('.pull-merge')?.textContent).toContain('Auto-merge is on (Squash and merge)')
    expect(button(view, 'Merge when ready…')).toBeUndefined()
    await act(async () => { button(view, 'Cancel auto-merge').click() })
    expect(api.disablePullAutoMerge).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7 })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('a repository that does not allow auto-merge says so and offers no Enable', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked' }, observedAt: 1 })
    api.repoMergeMethods.mockResolvedValue({ status: 'ok', methods: ['squash'] })
    const view = await render(api)
    await act(async () => { button(view, 'Merge when ready…').click() })
    expect(dialog()?.textContent).toContain('does not allow auto-merge')
    expect(button(host, 'Enable auto-merge')).toBeUndefined()
  })

  it('a moved head (or a PR that can merge now) says so in its own words and reloads', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, merge: 'blocked' }, observedAt: 1 })
    api.enablePullAutoMerge.mockResolvedValue({ ok: false, reason: 'head-moved' })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Merge when ready…').click() })
    await act(async () => { button(host, 'Enable auto-merge').click() })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('did not turn on auto-merge')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })
})

describe('PullNodeView files', () => {
  const files: GitHubPullFilesResult = {
    status: 'ok', truncated: false, observedAt: 1, files: [
      { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0 },
      { path: 'gone.md', status: 'removed', additions: 0, deletions: 9 }
    ]
  }
  const withFiles = (contents?: GitHubPullFileContentsResult) => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.pullFiles.mockResolvedValue(files)
    if (contents) api.pullFileContents.mockResolvedValue(contents)
    return api
  }

  it('lists changed files with status and line counts', async () => {
    const api = withFiles()
    const view = await render(api, 'o/r', 'files')
    expect(api.pullFiles).toHaveBeenCalledWith('p', 'o/r', 7)
    const rows = [...view.querySelectorAll('.pull-files__file')].map((row) => row.textContent)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('Modified')
    expect(rows[0]).toContain('a.ts')
    expect(view.querySelector('.pull-files__file')?.getAttribute('title')).toBe('src/a.ts')
    expect(rows[0]).toContain('+3')
    expect(rows[0]).toContain('−1')
    expect(rows[1]).toContain('Renamed')
    expect(rows[1]).toContain('src/old.ts')
    expect(rows[2]).toContain('Added')
    expect(rows[3]).toContain('Removed')
    expect(view.querySelector('.text-diff')).toBeNull()
  })

  it('selects a file through onSelectFile, and shows the selected file as a diff', async () => {
    const onSelect = vi.fn()
    const api = withFiles({
      status: 'ok', observedAt: 1,
      contents: { kind: 'diff', base: { kind: 'text', text: 'old text' }, head: { kind: 'text', text: 'new text' } }
    })
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), undefined, onSelect)
    const row = [...view.querySelectorAll<HTMLButtonElement>('.pull-files__file')][0]
    await act(async () => { row.click() })
    expect(onSelect).toHaveBeenCalledWith('src/a.ts')
    act(() => root.unmount()); host.remove()

    const shown = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    expect(api.pullFileContents).toHaveBeenCalledWith('p', 'o/r', 7, 'src/a.ts')
    const diff = shown.querySelector('.text-diff')!
    expect(diff.getAttribute('data-path')).toBe('src/a.ts')
    expect(diff.getAttribute('data-original')).toBe('old text')
    expect(diff.getAttribute('data-modified')).toBe('new text')
    expect(shown.querySelector('.pull-files__file[aria-current="true"]')?.getAttribute('title')).toBe('src/a.ts')
  })

  it('diffs an added file against empty', async () => {
    const api = withFiles({
      status: 'ok', observedAt: 1, contents: { kind: 'diff', base: { kind: 'empty' }, head: { kind: 'text', text: 'hello' } }
    })
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'logo.png')
    expect(view.querySelector('.text-diff')?.getAttribute('data-original')).toBe('')
    expect(view.querySelector('.text-diff')?.getAttribute('data-modified')).toBe('hello')
  })

  it('says it cannot show a binary file, with a GitHub link', async () => {
    const onOpen = vi.fn()
    const api = withFiles({ status: 'ok', observedAt: 1, contents: { kind: 'unavailable', reason: 'binary' } })
    const view = await render(api, 'o/r', 'files', vi.fn(), onOpen, vi.fn(), 'logo.png')
    expect(view.querySelector('.text-diff')).toBeNull()
    expect(view.querySelector('.pull-files__unavailable')?.textContent).toContain('Cannot show this file')
    const link = [...view.querySelectorAll('.pull-files__unavailable button')][0] as HTMLButtonElement
    await act(async () => { link.click() })
    expect(onOpen).toHaveBeenCalledWith('https://github.com/o/r/pull/7/files')
  })

  it('shows the files as a tree with +/- per folder, and the filter narrows it', async () => {
    const view = await render(withFiles(), 'o/r', 'files')
    expect(view.querySelector('.pull-files__folder')?.textContent).toBe('src/+3−1')
    const filter = view.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!
    await act(async () => { typeInput(filter, 'GONE') })
    expect([...view.querySelectorAll('.pull-files__file')].map((row) => row.getAttribute('title'))).toEqual(['gone.md'])
    await act(async () => { typeInput(filter, 'zzz') })
    expect(view.textContent).toContain('No file matches the filter.')
  })

  it('ticks a file Viewed on GitHub, counts it, and collapses its diff', async () => {
    const api = withFiles({
      status: 'ok', observedAt: 1,
      contents: { kind: 'diff', base: { kind: 'text', text: 'old' }, head: { kind: 'text', text: 'new' } }
    })
    api.pullFiles.mockResolvedValue({ ...files, files: files.files.map((f, i) => i === 1 ? { ...f, viewerViewedState: 'VIEWED' as const } : f) })
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    expect(view.querySelector('.pull-files__count')?.textContent).toBe('1 of 4 viewed')
    expect(view.querySelector('.text-diff')).not.toBeNull()
    const box = view.querySelector<HTMLInputElement>('input[aria-label="Viewed src/a.ts"]')!
    await act(async () => { box.click() })
    expect(api.setFileViewed).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, path: 'src/a.ts', viewed: true })
    expect(view.querySelector('.pull-files__count')?.textContent).toBe('2 of 4 viewed')
    expect(view.querySelector('.text-diff')).toBeNull()
    await act(async () => { button(view, 'Show the diff').click() })
    expect(view.querySelector('.text-diff')).not.toBeNull()
  })

  it('unticks the box again and says why when GitHub refuses the mark', async () => {
    const api = withFiles()
    api.setFileViewed.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const view = await render(api, 'o/r', 'files')
    const box = view.querySelector<HTMLInputElement>('input[aria-label="Viewed gone.md"]')!
    await act(async () => { box.click() })
    expect(box.checked).toBe(false)
    expect(view.querySelector('.pull-files__count')?.textContent).toBe('0 of 4 viewed')
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Pull requests write access')
  })

  it('the Review changes panel sends the summary and the pending line comments as one review', async () => {
    const api = withFiles({
      status: 'ok', observedAt: 1,
      contents: { kind: 'diff', base: { kind: 'text', text: 'old' }, head: { kind: 'text', text: 'new' } }
    })
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    await act(async () => { button(view, 'line modified 3').click() })
    await act(async () => { type(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!, 'Nit.') })
    await act(async () => { button(view, 'Add to review').click() })
    await act(async () => { button(view, 'Review changes').click() })
    const panel = view.querySelector<HTMLElement>('.pull-files__review')!
    await act(async () => { type(panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review summary"]')!, 'Two nits.') })
    await act(async () => { button(panel, 'Request changes').click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'REQUEST_CHANGES', body: 'Two nits.', headSha: 'c'.repeat(40),
      comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 3, body: 'Nit.' }]
    })
    expect(view.textContent).not.toContain('Pending')
  })

  it('the Review changes panel keeps Approve and Request changes off on the viewer\'s own PR, with the reason', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1, ownPull: true })
    api.pullFiles.mockResolvedValue(files)
    const view = await render(api, 'o/r', 'files')
    await act(async () => { button(view, 'Review changes').click() })
    const panel = view.querySelector<HTMLElement>('.pull-files__review')!
    expect(button(panel, 'Approve').disabled).toBe(true)
    expect(button(panel, 'Request changes').disabled).toBe(true)
    expect(button(panel, 'Approve').title).toContain('your own pull request')
    expect(panel.textContent).toContain('your own pull request')
  })

  it('shows the first 300 files and a GitHub link when the list is truncated', async () => {
    const api = withFiles()
    api.pullFiles.mockResolvedValue({ ...files, truncated: true })
    const view = await render(api, 'o/r', 'files')
    expect(view.querySelector('.pull-files__truncated')?.textContent).toContain('first 300 files')
  })
})

describe('PullNodeView line comments', () => {
  const line = (id: number, over: Partial<PullLineComment> = {}): PullLineComment => ({
    id, reviewId: 40, author, body: `line comment ${id}`, at: at(10 + id), url: `${url}#discussion_r${id}`,
    path: 'src/a.ts', side: 'RIGHT', line: 2, outdated: false, ...over
  })
  const lineComments = [
    line(1), line(2, { inReplyTo: 1 }), line(3, { side: 'LEFT', line: 5 }),
    line(4, { line: null, outdated: true, body: 'old **news**' }), line(5, { path: 'src/b.ts' })
  ]
  const setup = () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, undefined, {
      status: 'ok', truncated: false, observedAt: 1, lineComments,
      items: [{ kind: 'review', id: 40, author, body: '', at: at(10), url, verdict: 'commented' }]
    })
    api.pullFiles.mockResolvedValue({
      status: 'ok', truncated: false, observedAt: 1, files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }]
    })
    api.pullFileContents.mockResolvedValue({
      status: 'ok', observedAt: 1, contents: { kind: 'diff', base: { kind: 'text', text: 'a' }, head: { kind: 'text', text: 'b' } }
    })
    return api
  }
  const showTab = async (api: PullNodeApi, tab: PullNodeTab, onWritten = vi.fn()) => {
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab, selectedFile: 'src/a.ts' }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={onWritten} onSelectFile={vi.fn()} />)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  }

  it('shows each thread under its side and line, and an outdated one below the diff', async () => {
    const view = await render(setup(), 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    const zones = [...view.querySelectorAll('.zone')]
    expect(zones.map((zone) => zone.getAttribute('data-at'))).toEqual(['modified:2', 'original:5'])
    expect(zones[0].textContent).toContain('line comment 1')
    expect(zones[0].textContent).toContain('line comment 2')
    expect(zones[0].textContent).not.toContain('line comment 5')
    const off = view.querySelector('.pull-line__off')!
    expect(off.textContent).toContain('Outdated')
    expect(off.textContent).toContain('old news')
  })

  it('replies to a thread by its first comment and refreshes the node', async () => {
    const api = setup()
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), onWritten, 'src/a.ts')
    const thread = view.querySelector('.zone')!
    await act(async () => { type(thread.querySelector('textarea')!, 'Done.') })
    await act(async () => { button(thread as HTMLElement, 'Reply').click() })
    expect(api.commentOnPullLine).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, inReplyTo: 1, body: 'Done.' })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('posts a new line comment on the clicked line, tied to the head the node read', async () => {
    const api = setup()
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    await act(async () => { button(view, 'line original 3').click() })
    const box = view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!
    expect(box.closest('.zone')?.getAttribute('data-at')).toBe('original:3')
    await act(async () => { type(box, 'Why remove this?') })
    await act(async () => { button(box.closest('.zone') as HTMLElement, 'Comment').click() })
    expect(api.commentOnPullLine).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, headSha: 'c'.repeat(40),
      comment: { path: 'src/a.ts', side: 'LEFT', line: 3, body: 'Why remove this?' }
    })
    expect(view.querySelector('textarea[aria-label="Line comment"]')).toBeNull()
  })

  it('keeps a line comment for the review, then sends it with Approve', async () => {
    const api = setup()
    await render(api, 'o/r', 'conversation')
    await showTab(api, 'files')
    await act(async () => { button(host, 'line modified 3').click() })
    await act(async () => { type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!, 'Rename.') })
    await act(async () => { button(host, 'Add to review').click() })
    expect(api.commentOnPullLine).not.toHaveBeenCalled()
    expect(host.querySelector('.zone[data-at="modified:3"]')?.textContent).toContain('Pending')
    await showTab(api, 'conversation')
    expect(host.textContent).toContain('1 line comment waits for your review')
    await act(async () => { button(host, 'Approve').click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'APPROVE', body: '', headSha: 'c'.repeat(40),
      comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 3, body: 'Rename.' }]
    })
    expect(host.textContent).not.toContain('waits for your review')
  })

  it('sends pending line comments alone as a comment review', async () => {
    const api = setup()
    await render(api, 'o/r', 'conversation')
    await showTab(api, 'files')
    await act(async () => { button(host, 'line modified 3').click() })
    await act(async () => { type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!, 'Nit.') })
    await act(async () => { button(host, 'Add to review').click() })
    await showTab(api, 'conversation')
    await act(async () => { button(host, 'Comment').click() })
    expect(api.commentOnPull).not.toHaveBeenCalled()
    expect(api.reviewPull).toHaveBeenCalledWith(expect.objectContaining({
      event: 'COMMENT', body: '', comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 3, body: 'Nit.' }]
    }))
  })

  it('lists line comments under their review in the Conversation tab', async () => {
    const view = await render(setup(), 'o/r', 'conversation')
    const review = view.querySelector('.pull-convo__item')!
    expect(review.textContent).toContain('src/a.ts:2')
    expect(review.textContent).toContain('line comment 1')
    expect(review.textContent).toContain('Outdated')
  })

  it('never runs script from a line comment', async () => {
    const api = setup()
    api.pullConversation.mockResolvedValue({
      status: 'ok', truncated: false, observedAt: 1, items: [],
      lineComments: [line(1, { body: '<img src=x onerror="alert(1)"><script>alert(2)</script>' })]
    })
    const view = await render(api, 'o/r', 'files', vi.fn(), vi.fn(), vi.fn(), 'src/a.ts')
    expect(view.querySelector('.zone script')).toBeNull()
    expect(view.querySelector('.zone img')?.getAttribute('onerror')).toBeNull()
  })
})

describe('PullNodeView reviewers', () => {
  const ana = { id: 1, login: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }

  it('lists the requested reviewers, or says there are none', async () => {
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, requestedReviewers: [ana] }, observedAt: 1 }))
    expect(view.querySelector('.pull-reviewers')?.textContent).toContain('ana')
    act(() => root.unmount()); host.remove()
    const none = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }))
    expect(none.querySelector('.pull-reviewers')?.textContent).toContain('No reviewers requested')
  })

  it('offers the collaborators who are neither the author nor already asked, and requests one on click', async () => {
    const api = fakeApi({ status: 'ok', detail: { ...detail, requestedReviewers: [ana] }, observedAt: 1 })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    expect(api.repoCollaborators).not.toHaveBeenCalled()
    await act(async () => { button(view, 'Request review…').click() })
    expect(api.repoCollaborators).toHaveBeenCalledWith('p', 'o/r')
    const select = view.querySelector('select[aria-label="Reviewer"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['bo'])
    expect(api.requestPullReviewer).not.toHaveBeenCalled()
    await act(async () => { button(view, 'Request').click() })
    expect(api.requestPullReviewer).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, reviewer: 'bo' })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('names a refused request and does not reload', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.requestPullReviewer.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const onWritten = vi.fn()
    const view = await render(api, 'o/r', 'conversation', vi.fn(), vi.fn(), onWritten)
    await act(async () => { button(view, 'Request review…').click() })
    await act(async () => { button(view, 'Request').click() })
    expect(view.querySelector('.pull-reviewers [role="alert"]')?.textContent).toContain('may not write')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('offers no request on a closed or merged pull request', async () => {
    const view = await render(fakeApi({ status: 'ok', detail: { ...detail, lifecycle: 'merged', merge: undefined }, observedAt: 1 }))
    expect([...view.querySelectorAll('button')].some((el) => el.textContent === 'Request review…')).toBe(false)
  })
})

describe('PullNodeView agent proposal', () => {
  const bar = () => host.querySelector('.pull-proposal')
  const confirmButton = () => button(host, 'Confirm') as HTMLButtonElement
  // Real time keeps running (lazy chunks, resolved reads); `arm` jumps past the Confirm delay.
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })
  const arm = () => act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  const view = (api: PullNodeApi, proposal: ShownProposal, tab: PullNodeTab, onWritten = vi.fn(), onDismiss = vi.fn()) => (
    <PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab }}
      refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={onWritten} onSelectFile={vi.fn()}
      proposal={proposal} onDismiss={onDismiss} />
  )
  async function renderProposal(proposal: PullProposal, api = fakeApi({ status: 'ok', detail, observedAt: 1 }), tab: PullNodeTab = 'conversation') {
    const onWritten = vi.fn()
    const onDismiss = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root.render(view(api, { ...proposal, seq: 1 }, tab, onWritten, onDismiss)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    return { api, onWritten, onDismiss }
  }

  it('shows the exact action and sends nothing until Confirm', async () => {
    const { api, onWritten, onDismiss } = await renderProposal({ action: 'approve', message: 'LGTM' })
    expect(bar()?.textContent).toContain('Approve')
    expect(bar()?.textContent).toContain('LGTM')
    expect(api.reviewPull).not.toHaveBeenCalled()
    await arm()
    await act(async () => { confirmButton().click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'APPROVE', body: 'LGTM', headSha: 'c'.repeat(40)
    })
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('arms Confirm only a second after a proposal is shown or replaced', async () => {
    const { api } = await renderProposal({ action: 'comment', message: 'Nice' })
    expect(confirmButton().disabled).toBe(true)
    await act(async () => { confirmButton().click() })
    expect(api.commentOnPull).not.toHaveBeenCalled()
    await arm()
    expect(confirmButton().disabled).toBe(false)
    // The agent swaps the proposal right before the click: the new one starts disarmed.
    await act(async () => { root.render(view(api, { action: 'merge', seq: 2 }, 'conversation')) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(bar()?.textContent).toContain('Merge')
    expect(confirmButton().disabled).toBe(true)
    await act(async () => { confirmButton().click() })
    expect(api.mergePull).not.toHaveBeenCalled()
    await arm()
    expect(confirmButton().disabled).toBe(false)
  })

  it('Dismiss sends nothing', async () => {
    const { api, onDismiss } = await renderProposal({ action: 'comment', message: 'Nice' })
    await act(async () => { button(host, 'Dismiss').click() })
    expect(api.commentOnPull).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a comment needs no head: it is sent before the detail read landed', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.pullDetail.mockImplementation(() => new Promise(() => {}))
    await renderProposal({ action: 'comment', message: 'Nice' }, api, 'files')
    await arm()
    await act(async () => { confirmButton().click() })
    expect(api.commentOnPull).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, body: 'Nice' })
  })

  it('merges with the proposed method, or the first one the repository allows, at the head the node shows', async () => {
    const squash = await renderProposal({ action: 'merge', method: 'rebase' })
    expect(bar()?.textContent).toContain('Rebase and merge')
    await arm()
    await act(async () => { confirmButton().click() })
    expect(squash.api.mergePull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, method: 'rebase', headSha: 'c'.repeat(40)
    })
    act(() => root.unmount()); host.remove()
    const first = await renderProposal({ action: 'merge' })
    expect(bar()?.textContent).toContain('Squash and merge')
    await arm()
    await act(async () => { confirmButton().click() })
    expect(first.api.mergePull).toHaveBeenCalledWith(expect.objectContaining({ method: 'squash' }))
    expect(first.api.repoMergeMethods).toHaveBeenCalledTimes(1)
  })

  it('names the PR number, title and target branch of a merge', async () => {
    await renderProposal({ action: 'merge' })
    expect(bar()?.textContent).toContain('#7 Add the pull node')
    expect(bar()?.querySelector('code')?.textContent).toBe('main')
  })

  it('refuses a merge method the repository does not allow, with no Confirm', async () => {
    const { api } = await renderProposal({ action: 'merge', method: 'merge' })
    expect(bar()?.textContent).toContain('does not allow Create a merge commit')
    await arm()
    expect([...host.querySelectorAll('button')].some((el) => el.textContent === 'Confirm')).toBe(false)
    expect(api.mergePull).not.toHaveBeenCalled()
  })

  it.each([
    [{ lifecycle: 'draft' as const }, 'draft pull request cannot be merged'],
    [{ lifecycle: 'merged' as const }, 'already merged'],
    [{ merge: 'conflict' as const }, 'conflicts with main'],
    [{ merge: 'behind' as const }, 'behind main'],
    [{ merge: 'blocked' as const }, 'Branch protection blocked']
  ])('disables a merge proposal the node would not merge (%o)', async (change, why) => {
    const { api } = await renderProposal({ action: 'merge' }, fakeApi({ status: 'ok', detail: { ...detail, ...change }, observedAt: 1 }))
    await arm()
    expect(bar()?.textContent).toContain(why)
    expect(confirmButton().disabled).toBe(true)
    expect(api.mergePull).not.toHaveBeenCalled()
  })

  it.each(['approve', 'request-changes'] as const)('blocks %s on your own pull request, as the node does', async (action) => {
    const { api } = await renderProposal({ action, message: 'x' }, fakeApi({ status: 'ok', detail, observedAt: 1, ownPull: true }))
    await arm()
    expect(bar()?.textContent).toContain('your own pull request')
    expect(confirmButton().disabled).toBe(true)
    expect(api.reviewPull).not.toHaveBeenCalled()
  })

  it('names a refused write, keeps the proposal and does not reload', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.commentOnPull.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const { onWritten, onDismiss } = await renderProposal({ action: 'comment', message: 'x' }, api)
    await arm()
    await act(async () => { confirmButton().click() })
    expect(bar()?.querySelector('[role="alert"]')?.textContent).toContain('may not write')
    expect(onWritten).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('PullNodeView agent highlight', () => {
  it('passes the highlighted lines to the diff of that file only', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    api.pullFiles.mockResolvedValue({ status: 'ok', files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }], truncated: false, observedAt: 1 })
    api.pullFileContents.mockResolvedValue({ status: 'ok', contents: { kind: 'diff', base: { kind: 'text', text: 'a' }, head: { kind: 'text', text: 'b' } }, observedAt: 1 })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'files', selectedFile: 'src/a.ts' }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()}
        highlight={{ file: 'src/a.ts', start: 12, end: 30, seq: 1 }} />)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(host.querySelector('.text-diff')?.getAttribute('data-highlight')).toBe('12-30')
  })
})

describe('PullNodeView Send to agent', () => {
  const line = (id: number, over: Partial<PullLineComment> = {}): PullLineComment => ({
    id, reviewId: 1, author: { id, login: `u${id}`, avatarUrl: 'https://avatars.githubusercontent.com/u/1' }, body: `body ${id}`,
    at: `2026-10-01T10:00:0${id}Z`, url: `https://github.com/o/r/pull/7#discussion_r${id}`, path: 'src/a.ts', side: 'RIGHT',
    line: id, outdated: false, ...over
  })
  const conversation: GitHubPullConversationResult = {
    status: 'ok', items: [], truncated: false, observedAt: 1, resolvedThreads: [3],
    lineComments: [line(1), line(2, { line: null, outdated: true }), line(3)]
  }
  const failing: GitHubPullChecksResult = {
    status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [{ name: 'build', state: 'failed' }, { name: 'lint', state: 'passed' }]
  }

  async function renderSend(
    agents: { id: string; title: string }[],
    onSendToAgent = vi.fn(async (_id: string, _message: string): Promise<string | null> => null),
    sendUnavailable?: string
  ) {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 }, failing, conversation)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
        refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={vi.fn()}
        agents={agents} onSendToAgent={onSendToAgent} sendUnavailable={sendUnavailable} />)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    return { view: host, onSendToAgent }
  }

  it('lists unresolved threads and failing checks, outdated unticked, and sends only the ticked ones', async () => {
    const { view, onSendToAgent } = await renderSend([{ id: 'a1', title: 'Fixer' }])
    await act(async () => { button(view, 'Send to agent…').click() })
    const boxes = [...view.querySelectorAll('.pull-send__item input')] as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([true, false, true])
    expect(view.textContent).not.toContain('body 3')
    await act(async () => { boxes[2].click() })
    await act(async () => { button(view, 'Send to Fixer').click() })
    expect(onSendToAgent).toHaveBeenCalledTimes(1)
    const [target, message] = onSendToAgent.mock.calls[0]
    expect(target).toBe('a1')
    expect(message).toContain('[BEGIN REVIEW TEXT] src/a.ts:1 u1: body 1 [END REVIEW TEXT]')
    expect(message).not.toContain('body 2')
    expect(message).not.toContain('build')
    expect(view.textContent).toContain('Sent to Fixer.')
    // Sent: every item is unticked, so Send cannot repeat it.
    expect((button(view, 'Send to Fixer') as HTMLButtonElement).disabled).toBe(true)
  })

  it('with several linked agents, the user picks one before Send', async () => {
    const { view, onSendToAgent } = await renderSend([{ id: 'a1', title: 'Fixer' }, { id: 'a2', title: 'Other' }])
    await act(async () => { button(view, 'Send to agent…').click() })
    expect((button(view, 'Send') as HTMLButtonElement).disabled).toBe(true)
    const select = view.querySelector('select[aria-label="Agent"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'a2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { button(view, 'Send').click() })
    expect(onSendToAgent.mock.calls[0]?.[0]).toBe('a2')
  })

  it('says why when no agent is linked, or on a relay tab, and shows a refusal', async () => {
    const none = await renderSend([])
    expect((button(none.view, 'Send to agent…') as HTMLButtonElement).disabled).toBe(true)
    expect(none.view.textContent).toContain('No agent is linked to this node')
    act(() => root.unmount()); host.remove()
    const relay = await renderSend([{ id: 'a1', title: 'Fixer' }], undefined, 'Send to agent is not available in a relay tab.')
    expect(relay.view.textContent).toContain('relay tab')
    act(() => root.unmount()); host.remove()
    const refused = await renderSend([{ id: 'a1', title: 'Fixer' }], vi.fn(async (): Promise<string | null> => 'Fixer cannot take a message right now.'))
    await act(async () => { button(refused.view, 'Send to agent…').click() })
    await act(async () => { button(refused.view, 'Send to Fixer').click() })
    expect(refused.view.querySelector('[role="alert"]')?.textContent).toContain('cannot take a message')
  })
})

describe('PullNodeView avatars', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  it('shows the read\'s avatar data URL, and a lettered circle for a user with none', async () => {
    const reviewer = { id: 5, login: 'bo', avatarUrl: 'https://avatars.githubusercontent.com/u/5' }
    const api = fakeApi(
      { status: 'ok', detail: { ...detail, requestedReviewers: [reviewer] }, observedAt: 1, avatarDataUrls: { 2: png } },
      undefined,
      { status: 'ok', truncated: false, observedAt: 1, lineComments: [], avatarDataUrls: { 2: png }, items: [
        { kind: 'comment', id: 1, author, body: 'Hi', at: at(10), url },
        { kind: 'comment', id: 2, author: null, body: 'Gone', at: at(11), url }
      ] }
    )
    const view = await render(api)
    const images = [...view.querySelectorAll('img')]
    expect(images.length).toBeGreaterThan(0)
    expect(images.every((image) => image.getAttribute('src') === png && image.alt === 'octocat')).toBe(true)
    expect(view.querySelector('[role="img"][aria-label="bo"]')?.textContent).toBe('B')
    expect(view.querySelector('[role="img"][aria-label="ghost"]')?.textContent).toBe('G')
  })

  it('falls back to the letter when the image fails to load, and never renders a remote URL', async () => {
    const api = fakeApi({
      status: 'ok', detail, observedAt: 1, avatarDataUrls: { 2: 'https://avatars.githubusercontent.com/u/2' }
    })
    const view = await render(api)
    expect(view.querySelector('img')).toBeNull()
    expect(view.querySelector('.pull-head [role="img"][aria-label="octocat"]')?.textContent).toBe('O')

    act(() => root.unmount()); host.remove()
    const broken = await render(fakeApi({ status: 'ok', detail, observedAt: 1, avatarDataUrls: { 2: png } }))
    const image = broken.querySelector('.pull-head img')!
    await act(async () => { image.dispatchEvent(new Event('error')) })
    expect(broken.querySelector('.pull-head img')).toBeNull()
    expect(broken.querySelector('.pull-head [role="img"][aria-label="octocat"]')?.textContent).toBe('O')
  })
})
