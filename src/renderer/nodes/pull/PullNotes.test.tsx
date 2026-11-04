// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullFilesResult } from '@shared/github-pull-detail'
import type { PullNote } from '@shared/pull-notes'
import type { SendToPayload } from '../../lib/sendTo'
import { PullFilesTab, type FilesTabProps } from './PullFilesTab'
import { PullNotesButton, usePullNotes, type PullNotesApi } from './PullNotes'
import type { PullNodeApi } from './shared'

vi.mock('../../editor/TextDiff', () => ({
  TextDiff: ({ zones = [], onLineClick }: {
    zones?: Array<{ key: string; side: string; line: number; content: React.ReactNode }>
    onLineClick?: (side: 'original' | 'modified', line: number) => void
  }) => (
    <div className="text-diff">
      {zones.map((zone) => <div key={zone.key} className="zone" data-at={`${zone.side}:${zone.line}`}>{zone.content}</div>)}
      {onLineClick && <button onClick={() => onLineClick('modified', 3)}>line modified 3</button>}
    </div>
  )
}))

type Sent = { payload: SendToPayload; onSent?: () => void }
const send = vi.hoisted(() => ({
  sendTo: undefined as undefined | ((p: SendToPayload, onSent?: () => void) => void), why: undefined as string | undefined
}))
vi.mock('./SendTo', () => ({ useSendTo: () => send }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'c'.repeat(40)
const files: GitHubPullFilesResult = {
  status: 'ok', truncated: false, observedAt: 1, files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }]
}
const note = (id: string, over: Partial<PullNote> = {}): PullNote => ({
  id, path: 'src/a.ts', side: 'RIGHT', line: 2, text: `note ${id}`, createdAt: 1, ...over
})
const ok = <T,>(value: T) => vi.fn(async () => value)

function fakeApi() {
  return {
    pullFiles: ok(files),
    pullFileContents: ok({
      status: 'ok' as const, observedAt: 1, contents: { kind: 'diff' as const, base: { kind: 'text' as const, text: 'a' }, head: { kind: 'text' as const, text: 'b' } }
    }),
    pullConversation: ok({ status: 'ok' as const, items: [], lineComments: [], resolvedThreads: [], truncated: false, observedAt: 1 }),
    pullCommits: ok({ status: 'ok' as const, truncated: false, observedAt: 1, commits: [] }),
    commentOnPullLine: ok({ ok: true as const })
  }
}

let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove(); send.sendTo = undefined; send.why = undefined })

async function mount(el: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
function type(ta: HTMLTextAreaElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderFiles(api: ReturnType<typeof fakeApi>, over: Partial<FilesTabProps> = {}) {
  const props: FilesTabProps = {
    api: api as unknown as PullNodeApi, projectId: 'p', pull: { repository: 'o/r', pullNumber: 7, tab: 'files', selectedFile: 'src/a.ts' },
    refreshTick: 0, onOpenExternal: vi.fn(), onWritten: vi.fn(), onSelectFile: vi.fn(), head: HEAD, ownPull: false,
    pending: [], onAddPending: vi.fn(), onDropPending: vi.fn(),
    // The shell's conversation read, which the tab takes from props.
    conversation: await api.pullConversation(), ...over
  }
  await mount(<PullFilesTab {...props} />)
  return props
}

describe('notes in Files changed', () => {
  it('shows each note under its line as a dashed card that is not on GitHub', async () => {
    await renderFiles(fakeApi(), { notes: [note('n1'), note('n2', { path: 'other.ts' })], onDeleteNote: vi.fn() })
    const cards = [...host.querySelectorAll('.pf-card--note')]
    expect(cards).toHaveLength(1)
    expect(cards[0].closest('.zone')?.getAttribute('data-at')).toBe('modified:2')
    expect(cards[0].textContent).toContain('Your note(not on GitHub)')
    expect(cards[0].textContent).toContain('note n1')
  })

  it('Post to GitHub writes the line comment at the head, then deletes the note', async () => {
    const api = fakeApi()
    const onDeleteNote = vi.fn()
    const props = await renderFiles(api, { notes: [note('n1', { side: 'LEFT', line: 4 })], onDeleteNote })
    await act(async () => { button('Post to GitHub').click() })
    expect(api.commentOnPullLine).toHaveBeenCalledWith({
      projectId: 'p', repository: 'o/r', pullNumber: 7, headSha: HEAD,
      comment: { path: 'src/a.ts', side: 'LEFT', line: 4, body: 'note n1' }
    })
    expect(onDeleteNote).toHaveBeenCalledWith('n1')
    expect(props.onWritten).toHaveBeenCalled()
  })

  it('keeps the note when GitHub refuses the comment', async () => {
    const api = fakeApi()
    api.commentOnPullLine.mockResolvedValue({ ok: false, reason: 'forbidden' } as never)
    const onDeleteNote = vi.fn()
    await renderFiles(api, { notes: [note('n1')], onDeleteNote })
    await act(async () => { button('Post to GitHub').click() })
    expect(onDeleteNote).not.toHaveBeenCalled()
    expect(host.querySelector('.pf-card--note [role="alert"]')).not.toBeNull()
  })

  it('Delete removes the note without a GitHub call', async () => {
    const api = fakeApi()
    const onDeleteNote = vi.fn()
    await renderFiles(api, { notes: [note('n1')], onDeleteNote })
    await act(async () => { button('Delete').click() })
    expect(onDeleteNote).toHaveBeenCalledWith('n1')
    expect(api.commentOnPullLine).not.toHaveBeenCalled()
  })

  it('the line composer\'s Note for agent adds a note for the clicked line', async () => {
    const onNoteForAgent = vi.fn()
    await renderFiles(fakeApi(), { onNoteForAgent })
    await act(async () => { button('line modified 3').click() })
    await act(async () => { type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Line comment"]')!, 'check this') })
    await act(async () => { button('Note for agent').click() })
    expect(onNoteForAgent).toHaveBeenCalledWith({ path: 'src/a.ts', side: 'RIGHT', line: 3, text: 'check this' })
  })
})

describe('PullNotesButton', () => {
  it('is hidden with no notes', async () => {
    await mount(<PullNotesButton notes={[]} error={false} onClear={vi.fn()} />)
    expect(host.textContent).toBe('')
  })

  it('sends the notes, then asks to clear the sent ones (Clear first)', async () => {
    const sent: Sent[] = []
    send.sendTo = (payload, onSent) => { sent.push({ payload, onSent }) }
    const onClear = vi.fn()
    await mount(<PullNotesButton notes={[note('n1'), note('n2', { line: 9 })]} error={false} onClear={onClear} />)
    await act(async () => { button('2 notes for agent').click() })
    expect(sent[0].payload).toEqual({ kind: 'notes', notes: [
      { path: 'src/a.ts', line: 2, text: 'note n1' }, { path: 'src/a.ts', line: 9, text: 'note n2' }
    ] })
    await act(async () => { sent[0].onSent?.() })
    expect(host.textContent).toContain('Clear the 2 notes you sent?')
    expect(document.activeElement).toBe(button('Clear'))
    await act(async () => { button('Clear').click() })
    expect(onClear).toHaveBeenCalledWith(['n1', 'n2'])
  })

  it('Keep leaves the notes', async () => {
    send.sendTo = (_payload, onSent) => onSent?.()
    const onClear = vi.fn()
    await mount(<PullNotesButton notes={[note('n1')]} error={false} onClear={onClear} />)
    await act(async () => { button('1 note for agent').click() })
    await act(async () => { button('Keep').click() })
    expect(onClear).not.toHaveBeenCalled()
    expect(button('1 note for agent')).toBeDefined()
  })

  it('is off with the reason where Send to is unavailable', async () => {
    send.why = 'Send to agent is not available in a relay tab.'
    await mount(<PullNotesButton notes={[note('n1')]} error={false} onClear={vi.fn()} />)
    expect(button('1 note for agent').disabled).toBe(true)
    expect(button('1 note for agent').title).toBe(send.why)
  })
})

describe('usePullNotes', () => {
  function Harness({ api }: { api: PullNotesApi }) {
    const notes = usePullNotes(api, { repository: 'o/r', pullNumber: 7, tab: 'files' })
    return (
      <>
        <output>{notes.notes.map((n) => n.id).join(',')}{notes.error ? ' error' : ''}</output>
        <button onClick={() => notes.add({ path: 'a.ts', side: 'RIGHT', line: 1, text: 't' })}>add</button>
        <button onClick={() => notes.remove('n1')}>remove</button>
        <button onClick={() => notes.clear(['n1', 'n2'])}>clear</button>
      </>
    )
  }
  const fakeNotes = () => ({
    pullNotes: vi.fn(async () => [note('n1')]),
    addPullNote: vi.fn(async () => [note('n1'), note('n2')]),
    deletePullNote: vi.fn(async () => [note('n2')]),
    clearPullNotes: vi.fn(async (): Promise<PullNote[]> => { throw new Error('refused') })
  })
  const shown = () => host.querySelector('output')!.textContent

  it('reads the PR\'s notes and takes each write\'s answer', async () => {
    const api = fakeNotes()
    await mount(<Harness api={api} />)
    expect(api.pullNotes).toHaveBeenCalledWith('o/r', 7)
    expect(shown()).toBe('n1')
    await act(async () => { button('add').click() })
    expect(api.addPullNote).toHaveBeenCalledWith({ repository: 'o/r', pullNumber: 7, path: 'a.ts', side: 'RIGHT', line: 1, text: 't' })
    expect(shown()).toBe('n1,n2')
    await act(async () => { button('remove').click() })
    expect(api.deletePullNote).toHaveBeenCalledWith({ repository: 'o/r', pullNumber: 7, id: 'n1' })
    expect(shown()).toBe('n2')
  })

  it('keeps the list and flags an error when a write fails', async () => {
    const api = fakeNotes()
    await mount(<Harness api={api} />)
    await act(async () => { button('clear').click() })
    expect(api.clearPullNotes).toHaveBeenCalledWith({ repository: 'o/r', pullNumber: 7, ids: ['n1', 'n2'] })
    expect(shown()).toBe('n1 error')
  })
})
