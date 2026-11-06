// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullFilesResult, PullLineComment, PullLineDraft } from '@shared/github-pull-detail'
import type { SendToPayload } from '../../lib/sendTo'
import { PullFilesTab, type FilesTabProps, type PullCompareOption } from './PullFilesTab'
import type { PullNodeApi } from './shared'

// Monaco does not run in jsdom: the diff shows its texts, its layout and its zones, plus one button
// that stands for a click on line 3's number of the modified side.
vi.mock('../../editor/TextDiff', () => ({
  TextDiff: ({ path, original, modified, zones = [], onLineClick, sideBySide = true }: {
    path: string; original: string; modified: string; sideBySide?: boolean
    zones?: Array<{ key: string; side: string; line: number; content: React.ReactNode }>
    onLineClick?: (side: 'original' | 'modified', line: number) => void
  }) => (
    <div className="text-diff" data-path={path} data-original={original} data-modified={modified} data-layout={sideBySide ? 'split' : 'unified'}>
      {zones.map((zone) => <div key={zone.key} className="zone" data-at={`${zone.side}:${zone.line}`}>{zone.content}</div>)}
      {onLineClick && <button onClick={() => onLineClick('modified', 3)}>line modified 3</button>}
    </div>
  )
}))

const send = vi.hoisted(() => ({ sendTo: undefined as undefined | ((p: SendToPayload) => void), why: undefined as string | undefined }))
vi.mock('./SendTo', () => ({ useSendTo: () => send }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const author = { id: 2, login: 'octocat', avatarUrl: '' }
const files: GitHubPullFilesResult = {
  status: 'ok', truncated: false, observedAt: 1, files: [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, viewerViewedState: 'VIEWED' },
    { path: 'c.md', status: 'added', additions: 2, deletions: 0, viewerViewedState: 'VIEWED' }
  ]
}
const comment = (id: number, over: Partial<PullLineComment> = {}): PullLineComment => ({
  id, reviewId: 40, author, body: `line comment ${id}`, at: `2026-10-01T1${id}:00:00Z`, url: '',
  path: 'src/a.ts', side: 'RIGHT', line: 2, outdated: false, ...over
})
const ok = <T,>(value: T) => vi.fn(async () => value)

function fakeApi(lineComments: PullLineComment[] = [], resolvedThreads: number[] | undefined = []) {
  return {
    pullFiles: ok(files),
    pullFileContents: vi.fn(async (_p: string, _r: string, _n: number, path: string) => ({
      status: 'ok' as const, observedAt: 1, contents: { kind: 'diff' as const, base: { kind: 'text' as const, text: `old ${path}` }, head: { kind: 'text' as const, text: `new ${path}` } }
    })),
    pullConversation: ok({ status: 'ok' as const, items: [], lineComments, resolvedThreads, truncated: false, observedAt: 1 }),
    pullCommits: ok({
      status: 'ok' as const, truncated: false, observedAt: 1, commits: [
        { oid: 'a'.repeat(40), headline: 'First', committedAt: '2026-10-01T09:00:00Z', authorName: 'x', verified: false },
        { oid: 'd'.repeat(40), headline: 'Second', committedAt: '2026-10-01T10:00:00Z', authorName: 'x', verified: false }
      ]
    }),
    pullCommitFiles: vi.fn(async () => ({
      status: 'ok' as const, truncated: false, observedAt: 1, files: [{ path: 'only/in-commit.ts', status: 'added' as const, additions: 5, deletions: 0 }]
    })),
    pullCommitFileContents: vi.fn(async () => ({
      status: 'ok' as const, observedAt: 1, contents: { kind: 'diff' as const, base: { kind: 'empty' as const }, head: { kind: 'text' as const, text: 'commit text' } }
    })),
    setFileViewed: ok({ ok: true as const }),
    commentOnPullLine: ok({ ok: true as const }),
    reviewPull: ok({ ok: true as const }),
    applySuggestion: ok({ ok: true as const }),
    setReviewThreadResolved: ok({ ok: true as const })
  }
}

let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove(); send.sendTo = undefined; send.why = undefined })

async function render(api: ReturnType<typeof fakeApi>, over: Partial<FilesTabProps> = {}) {
  const props: FilesTabProps = {
    api: api as unknown as PullNodeApi, projectId: 'p', pull: { repository: 'o/r', pullNumber: 7, tab: 'files', selectedFile: 'src/a.ts' },
    refreshTick: 0, onOpenExternal: vi.fn(), onWritten: vi.fn(), onSelectFile: vi.fn(), head: HEAD, ownPull: false,
    pending: [], onAddPending: vi.fn(), onDropPending: vi.fn(),
    // The shell's conversation read, which the tab takes from props.
    conversation: await api.pullConversation(), ...over
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<PullFilesTab {...props} />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  return props
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
const buttons = (el: Element = host) => [...el.querySelectorAll('button')]
const button = (label: string, el: Element = host) => buttons(el).find((b) => b.textContent === label) as HTMLButtonElement
const tree = () => [...host.querySelectorAll('.pf-file')].map((row) => row.getAttribute('title'))
/** Compare: a commit through the select inside the segmented control, else a segment by its label. */
const pick = async (value: string) => {
  if (value.startsWith('commit:')) {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Compare"] select')!
    await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
  } else await act(async () => { button(value).click() })
  await settle()
}
const segments = () => [...host.querySelectorAll('[aria-label="Compare"] > button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])
function type(ta: HTMLTextAreaElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PullFilesTab compare', () => {
  it('offers All changes and each commit; a commit shows its own files and diff, read-only, then All changes again', async () => {
    const api = fakeApi()
    await render(api)
    // F2: a segmented control; the commits sit in a small select inside it.
    expect(segments()).toEqual([['All changes', 'true']])
    expect([...host.querySelectorAll('[aria-label="Compare"] select option')].map((o) => o.textContent)).toEqual(['Commit…', 'aaaaaaa First', 'ddddddd Second'])
    await pick(`commit:${'d'.repeat(40)}`)
    expect(segments()).toEqual([['All changes', 'false']])
    expect(host.querySelector('[aria-label="Compare"] select')?.classList.contains('pf-seg__select--on')).toBe(true)
    expect(api.pullCommitFiles).toHaveBeenCalledWith('p', 'o/r', 7, 'd'.repeat(40))
    expect(tree()).toEqual(['only/in-commit.ts'])
    expect(api.pullCommitFileContents).toHaveBeenCalledWith('p', 'o/r', 7, 'd'.repeat(40), 'only/in-commit.ts')
    expect(host.querySelector('.text-diff')?.getAttribute('data-modified')).toBe('commit text')
    expect(host.querySelector('input[aria-label^="Viewed"]')).toBeNull()
    expect(button('line modified 3')).toBeUndefined()
    expect(host.textContent).toContain('read-only')
    await pick('All changes')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Compare"] select')?.value).toBe('')
    expect(tree()).toEqual(['src/a.ts', 'src/b.ts', 'c.md'])
    expect(host.querySelector('input[aria-label="Viewed src/a.ts"]')).not.toBeNull()
  })

  it('takes extra Compare choices after All changes and reads through them (the F-10 seam)', async () => {
    const api = fakeApi()
    const since: PullCompareOption = {
      value: 'since-review', label: 'Since my last review (1 file)',
      files: vi.fn(async () => ({ status: 'ok' as const, truncated: false, observedAt: 1, files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0 }] })),
      contents: vi.fn(async () => ({ status: 'ok' as const, observedAt: 1, contents: { kind: 'diff' as const, base: { kind: 'text' as const, text: 'x' }, head: { kind: 'text' as const, text: 'since text' } } }))
    }
    await render(api, { compareExtra: [since] })
    expect(segments()).toEqual([['All changes', 'true'], ['Since my last review (1 file)', 'false']])
    await pick('Since my last review (1 file)')
    expect(segments()).toEqual([['All changes', 'false'], ['Since my last review (1 file)', 'true']])
    expect(since.files).toHaveBeenCalledWith('p', 'o/r', 7)
    expect(since.contents).toHaveBeenCalledWith('p', 'o/r', 7, 'src/a.ts')
    expect(host.querySelector('.text-diff')?.getAttribute('data-modified')).toBe('since text')
  })

  it('switches the diff between Split and Unified', async () => {
    await render(fakeApi())
    expect(host.querySelector('.text-diff')?.getAttribute('data-layout')).toBe('split')
    await act(async () => { button('Unified').click() })
    expect(host.querySelector('.text-diff')?.getAttribute('data-layout')).toBe('unified')
    expect(button('Unified').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('PullFilesTab tree', () => {
  it('counts viewed files, hides them on request (the selected one stays), and shows open threads per file', async () => {
    await render(fakeApi([comment(1), comment(2, { inReplyTo: 1 }), comment(3, { line: 9 })], [3]))
    expect(host.querySelector('.pf-progress__count')?.textContent).toBe('2 of 3 viewed')
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('2')
    const rowA = host.querySelector('.pf-file[title="src/a.ts"]')!
    expect(rowA.querySelector('.pf-file__threads')?.textContent).toBe('1')
    expect(host.querySelector('.pf-file[title="src/b.ts"] [aria-label="Viewed"]')).not.toBeNull()
    const hide = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Hide viewed files'))!.querySelector('input')!
    await act(async () => { hide.click() })
    expect(tree()).toEqual(['src/a.ts'])
  })

  it('shows +/- counts on folder rows, summed from their files, the way file rows show theirs', async () => {
    await render(fakeApi())
    const dir = [...host.querySelectorAll('.pf-dir')].find((d) => d.textContent?.startsWith('src'))!
    expect(dir.querySelector('.pf-file__end.pf-mono')?.textContent).toBe('+4 −1')
  })
})

describe('PullFilesTab threads', () => {
  const suggestion = 'Try:\n```suggestion\nconst b = 2\n```'

  it('Ask agent sends the suggestion, or the thread, through Send to…; off with the reason when unavailable', async () => {
    send.why = 'Send to agent is not available in a relay tab.'
    await render(fakeApi([comment(1)]))
    expect(button('Ask agent').disabled).toBe(true)
    expect(button('Ask agent').title).toBe('Send to agent is not available in a relay tab.')
    act(() => root.unmount()); host.remove()

    const sendTo = vi.fn()
    send.sendTo = sendTo
    send.why = undefined
    await render(fakeApi([comment(1), comment(4, { line: 5, body: suggestion })]))
    const [plain, withSuggestion] = [...host.querySelectorAll<HTMLElement>('.zone')]
    await act(async () => { button('Ask agent', plain).click() })
    await act(async () => { button('Ask agent', withSuggestion).click() })
    expect(sendTo.mock.calls).toEqual([
      [{ kind: 'threads', threads: [{ id: 1, path: 'src/a.ts', line: 2 }] }],
      [{ kind: 'suggestion', thread: { id: 4, path: 'src/a.ts', line: 5 } }]
    ])
  })

  it('Commit suggestion applies the latest suggestion at the head; Reply opens a box and posts to the thread; Resolve resolves', async () => {
    const api = fakeApi([comment(1, { body: suggestion })])
    const props = await render(api)
    const card = host.querySelector<HTMLElement>('.zone')!
    await act(async () => { button('Commit suggestion', card).click() })
    expect(api.applySuggestion).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, headSha: HEAD, commentId: 1 })
    expect(card.querySelector('textarea')).toBeNull()
    await act(async () => { button('Reply', card).click() })
    await act(async () => { type(card.querySelector('textarea')!, 'Done.') })
    await act(async () => { button('Reply', card).click() })
    expect(api.commentOnPullLine).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, inReplyTo: 1, body: 'Done.' })
    await act(async () => { button('Resolve', card).click() })
    expect(api.setReviewThreadResolved).toHaveBeenCalledWith({ projectId: 'p', repository: 'o/r', pullNumber: 7, threadId: 1, resolved: true })
    expect(props.onWritten).toHaveBeenCalledTimes(3)
  })
})

describe('PullFilesTab line composer', () => {
  it('has Cancel, Note for agent (off until F-07 wires it), Comment now and Add to review', async () => {
    const props = await render(fakeApi())
    await act(async () => { button('line modified 3').click() })
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!
    await act(async () => { type(box, 'Rename.') })
    const zone = box.closest('.zone')!
    expect(buttons(zone).map((b) => b.textContent)).toEqual(['Cancel', 'Note for agent', 'Comment now', 'Add to review'])
    expect(button('Note for agent', zone).disabled).toBe(true)
    await act(async () => { button('Add to review', zone).click() })
    expect(props.onAddPending).toHaveBeenCalledWith({ path: 'src/a.ts', side: 'RIGHT', line: 3, body: 'Rename.' })
  })

  it('hands a note to onNoteForAgent and closes the box', async () => {
    const onNoteForAgent = vi.fn()
    await render(fakeApi(), { onNoteForAgent })
    await act(async () => { button('line modified 3').click() })
    await act(async () => { type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!, 'Check this.') })
    await act(async () => { button('Note for agent').click() })
    expect(onNoteForAgent).toHaveBeenCalledWith({ path: 'src/a.ts', side: 'RIGHT', line: 3, text: 'Check this.' })
    expect(host.querySelector('textarea[aria-label="Line comment"]')).toBeNull()
  })
})

describe('PullFilesTab Finish review', () => {
  const pending: PullLineDraft[] = [{ path: 'src/a.ts', side: 'RIGHT', line: 3, body: 'Nit.' }]
  const finish = () => buttons().find((b) => b.textContent?.startsWith('Finish review'))!
  const radio = (label: string) => [...host.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!

  it('shows the pending count and opens the panel; a Comment with only line comments sends them as one review', async () => {
    const api = fakeApi()
    const props = await render(api, { pending })
    expect(finish().textContent).toBe('Finish review 1')
    await act(async () => { finish().click() })
    const panel = host.querySelector('[role="dialog"][aria-label="Finish your review"]')!
    expect(panel.textContent).toContain('1 line comment included')
    expect(panel.textContent).toContain('Blocks the merge until resolved.')
    await act(async () => { button('Submit review', panel).click() })
    expect(api.reviewPull).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, event: 'COMMENT', body: '', headSha: HEAD, comments: pending
    })
    expect(props.onDropPending).toHaveBeenCalledWith(pending)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('needs a summary for Request changes or an empty Comment; Approve needs none; a refusal keeps the panel', async () => {
    const api = fakeApi()
    api.reviewPull.mockResolvedValue({ ok: false, reason: 'head-moved' } as never)
    const props = await render(api)
    await act(async () => { finish().click() })
    expect(button('Submit review').disabled).toBe(true)
    await act(async () => { radio('Request changes').click() })
    expect(button('Submit review').disabled).toBe(true)
    await act(async () => { radio('Approve').click() })
    expect(button('Submit review').disabled).toBe(false)
    await act(async () => { button('Submit review').click() })
    expect(api.reviewPull).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', headSha: HEAD }))
    expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('changed since you loaded it')
    expect(props.onDropPending).not.toHaveBeenCalled()
  })

  it('keeps Approve and Request changes off on the viewer\'s own PR, with the reason; no Finish review before a head', async () => {
    await render(fakeApi(), { ownPull: true })
    await act(async () => { finish().click() })
    expect(radio('Approve').disabled).toBe(true)
    expect(radio('Request changes').disabled).toBe(true)
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('your own pull request')
    act(() => root.unmount()); host.remove()
    await render(fakeApi(), { head: undefined })
    expect(finish()).toBeUndefined()
  })
})
