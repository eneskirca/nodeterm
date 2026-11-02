// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubPullConversationResult, GitHubPullDetail, GitHubPullDetailResult, GitHubPullFileContentsResult, GitHubPullFilesResult
} from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import type { PullNodeTab } from '@shared/pull-node'
import { PullNodeView, type PullNodeApi } from './PullNodeView'

// Monaco does not run in jsdom: the diff shows its two texts and its path instead.
vi.mock('../editor/TextDiff', () => ({
  TextDiff: ({ path, original, modified }: { path: string; original: string; modified: string }) => (
    <div className="text-diff" data-path={path} data-original={original} data-modified={modified} />
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
}, conversation: GitHubPullConversationResult = { status: 'ok', items: [], truncated: false, observedAt: 1 }):
  PullNodeApi & {
    pullDetail: ReturnType<typeof vi.fn>; pullChecks: ReturnType<typeof vi.fn>; pullConversation: ReturnType<typeof vi.fn>
    pullFiles: ReturnType<typeof vi.fn>; pullFileContents: ReturnType<typeof vi.fn>
    commentOnPull: ReturnType<typeof vi.fn>; reviewPull: ReturnType<typeof vi.fn>
    mergePull: ReturnType<typeof vi.fn>; repoMergeMethods: ReturnType<typeof vi.fn>
    repoCollaborators: ReturnType<typeof vi.fn>; requestPullReviewer: ReturnType<typeof vi.fn>
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
    repoMergeMethods: vi.fn(async () => ({ status: 'ok' as const, methods: ['squash' as const, 'rebase' as const] })),
    repoCollaborators: vi.fn(async () => ({
      status: 'ok' as const,
      users: ['octocat', 'ana', 'bo'].map((login, id) => ({ id, login, avatarUrl: 'https://avatars.githubusercontent.com/u/1' }))
    })),
    requestPullReviewer: vi.fn(async () => ({ ok: true as const }))
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(
  api: PullNodeApi, repository = 'o/r', tab: PullNodeTab = 'overview', onTab = vi.fn(), onOpenExternal = vi.fn(),
  onWritten = vi.fn(), selectedFile?: string, onSelectFile = vi.fn()
): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository, pullNumber: 7, tab, selectedFile }}
      refreshTick={0} onTab={onTab} onOpenExternal={onOpenExternal} onWritten={onWritten} onSelectFile={onSelectFile} />)
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
      status: 'ok', truncated: false, observedAt: 1, items: [
        { kind: 'comment', id: 1, author, body: 'First **comment**', at: at(10), url },
        { kind: 'review', id: 2, author, body: '', at: at(11), url, verdict: 'approved' },
        { kind: 'review', id: 3, author: null, body: 'Fix the test', at: at(12), url, verdict: 'changes-requested' },
        { kind: 'review', id: 4, author, body: 'Note', at: at(13), url, verdict: 'commented' }
      ]
    })
    const view = await render(api, 'o/r', 'conversation')
    expect(api.pullConversation).toHaveBeenCalledWith('p', 'o/r', 7)
    expect(api.pullDetail).not.toHaveBeenCalled()
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
      status: 'ok', truncated: false, observedAt: 1,
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

  it('switches tab through onTab and opens the PR on GitHub from every tab', async () => {
    const onTab = vi.fn()
    const onOpen = vi.fn()
    const view = await render(fakeApi({ status: 'ok', detail, observedAt: 1 }), 'o/r', 'overview', onTab, onOpen)
    const tab = [...view.querySelectorAll('[role="tab"]')].find((el) => el.textContent === 'Conversation')!
    await act(async () => { (tab as HTMLElement).click() })
    expect(onTab).toHaveBeenCalledWith('conversation')
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
    await show('conversation')
    await show('overview')
    await show('conversation')
    expect(api.pullDetail).toHaveBeenCalledTimes(1)
    expect(api.pullConversation).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.pull-node__overview')?.closest('[hidden]')).not.toBeNull()
  })
})

function type(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (view: HTMLElement, label: string) =>
  [...view.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement

/** Shows the Overview first (the head a review is tied to), then the Conversation tab. */
async function renderSeen(api: PullNodeApi, onWritten = vi.fn()): Promise<HTMLDivElement> {
  const view = await render(api, 'o/r', 'overview', vi.fn(), vi.fn(), onWritten)
  await act(async () => {
    root.render(<PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab: 'conversation' }}
      refreshTick={0} onTab={vi.fn()} onOpenExternal={vi.fn()} onWritten={onWritten} onSelectFile={vi.fn()} />)
  })
  return view
}

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

  it('offers no review before the Overview showed a head commit, and reads none for it', async () => {
    const api = fakeApi({ status: 'ok', detail, observedAt: 1 })
    const view = await render(api, 'o/r', 'conversation')
    await act(async () => { type(view.querySelector('textarea')!, 'x') })
    expect(button(view, 'Approve').disabled).toBe(true)
    expect(button(view, 'Request changes').disabled).toBe(true)
    expect(button(view, 'Comment').disabled).toBe(false)
    expect(view.textContent).toContain('Open the Overview tab to review')
    expect(api.pullDetail).not.toHaveBeenCalled()
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
    for (const tab of ['overview', 'conversation'] as const) {
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
    const view = await render(api, 'o/r', 'overview', vi.fn(), vi.fn(), onWritten)
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
    expect(rows[0]).toContain('src/a.ts')
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
    expect(shown.querySelector('.pull-files__file[aria-current="true"]')?.textContent).toContain('src/a.ts')
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

  it('shows the first 300 files and a GitHub link when the list is truncated', async () => {
    const api = withFiles()
    api.pullFiles.mockResolvedValue({ ...files, truncated: true })
    const view = await render(api, 'o/r', 'files')
    expect(view.querySelector('.pull-files__truncated')?.textContent).toContain('first 300 files')
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
    const view = await render(api, 'o/r', 'overview', vi.fn(), vi.fn(), onWritten)
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
    const view = await render(api, 'o/r', 'overview', vi.fn(), vi.fn(), onWritten)
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
