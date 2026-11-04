// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullSinceReviewResult, PullSinceReview } from '@shared/github-pull-since-review'
import type { PullNodeTab } from '@shared/pull-node'
import { PullNodeView } from '../PullNodeView'
import type { PullNodeApi } from './shared'

vi.mock('../../editor/TextDiff', () => ({
  TextDiff: ({ path, original, modified }: { path: string; original: string; modified: string }) =>
    <div className="text-diff" data-path={path} data-original={original} data-modified={modified} />
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REVIEWED = 'e'.repeat(40)
const HEAD = 'c'.repeat(40)
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: HEAD },
  merge: 'ready', additions: 1, deletions: 0, changedFiles: 3, url: 'https://github.com/o/r/pull/7'
}
const moved: PullSinceReview = {
  kind: 'moved', submittedAt: '2026-11-01T10:00:00Z', commitOid: REVIEWED, head: HEAD, commits: 2, truncated: false,
  files: [{ path: 'src/new-since.ts', status: 'modified', additions: 2, deletions: 1 }]
}

/** The shell's reads: the ones named here, and a refusal for every other one. */
function fakeApi(since: PullSinceReview) {
  const reads = {
    pullDetail: vi.fn(async () => ({ status: 'ok' as const, detail, observedAt: 1 })),
    pullFiles: vi.fn(async () => ({
      status: 'ok' as const, truncated: false, observedAt: 1,
      files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0 }]
    })),
    pullSinceReview: vi.fn(async (): Promise<GitHubPullSinceReviewResult> => ({ status: 'ok', since, observedAt: 1 })),
    pullSinceReviewFileContents: vi.fn(async () => ({
      status: 'ok' as const, observedAt: 1,
      contents: { kind: 'diff' as const, base: { kind: 'text' as const, text: 'at review' }, head: { kind: 'text' as const, text: 'at head' } }
    }))
  }
  const refused = async () => ({ status: 'refused', reason: 'not-approved' })
  return new Proxy(reads, { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? refused }) as typeof reads & PullNodeApi
}

let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove() })

function Shell({ api }: { api: PullNodeApi }): React.JSX.Element {
  const [tab, setTab] = useState<PullNodeTab>('conversation')
  const [selectedFile, setSelectedFile] = useState<string>()
  return <PullNodeView api={api} projectId="p" pull={{ repository: 'o/r', pullNumber: 7, tab, selectedFile }} refreshTick={0}
    onTab={setTab} onOpenExternal={vi.fn()} onWritten={vi.fn()} onSelectFile={setSelectedFile} />
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
async function render(api: PullNodeApi): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<Shell api={api} />) })
  await settle()
}
const banner = () => host.querySelector('.pr-since')
const options = () => [...host.querySelectorAll('.pf-toolbar select option')].map((o) => o.textContent)

describe('Since my last review', () => {
  it('shows the new commits above the timeline; Diff since review opens Files changed on that comparison', async () => {
    const api = fakeApi(moved)
    await render(api)
    expect(api.pullSinceReview).toHaveBeenCalledWith('p', 'o/r', 7)
    expect(banner()?.textContent).toContain('2 new commits since your last review on ')
    const diff = [...banner()!.querySelectorAll('button')].find((b) => b.textContent === 'Diff since review')!
    await act(async () => { diff.click() })
    await settle()
    expect(host.querySelector<HTMLSelectElement>('.pf-toolbar select')?.value).toBe('since-review')
    expect(options()).toEqual(['All changes', 'Since my last review (1 file)'])
    expect([...host.querySelectorAll('.pf-file')].map((row) => row.getAttribute('title'))).toEqual(['src/new-since.ts'])
    expect(api.pullSinceReviewFileContents).toHaveBeenCalledWith('p', 'o/r', 7, 'src/new-since.ts')
    expect(host.querySelector('.text-diff')?.getAttribute('data-modified')).toBe('at head')
  })

  it('switches an already open Files changed tab to the comparison', async () => {
    await render(fakeApi(moved))
    const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent?.startsWith(name))!
    await act(async () => { tab('Files changed').click() })
    await settle()
    expect(host.querySelector<HTMLSelectElement>('.pf-toolbar select')?.value).toBe('all')
    await act(async () => { tab('Conversation').click() })
    await act(async () => { [...banner()!.querySelectorAll('button')].find((b) => b.textContent === 'Diff since review')!.click() })
    await settle()
    expect(host.querySelector<HTMLSelectElement>('.pf-toolbar select')?.value).toBe('since-review')
  })

  it.each<[string, PullSinceReview]>([
    ['no review by the viewer', { kind: 'none' }],
    ['a head that has not moved', { kind: 'current', submittedAt: '2026-11-01T10:00:00Z', commitOid: HEAD }]
  ])('shows no banner and no Compare choice for %s', async (_name, since) => {
    await render(fakeApi(since))
    expect(banner()).toBeNull()
  })

  it('says a force-push hides the changes since the review, with no button', async () => {
    await render(fakeApi({ kind: 'unavailable', reason: 'commit-gone', submittedAt: '2026-11-01T10:00:00Z', commitOid: REVIEWED }))
    expect(banner()?.textContent).toContain('the branch was force-pushed')
    expect(banner()?.querySelector('button')).toBeNull()
  })
})
