// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubLinkPicker } from './GitHubLinkPicker'

const lookup = vi.fn()
const search = vi.fn()
vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { githubIssues: { lookup, search } } })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const card = (number: number, over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: number,
  number,
  title: `Item ${number}`,
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`,
  apiUrl: `https://api.github.com/repos/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  locked: false,
  columnId: null,
  conflict: null,
  ...over
})

let host: HTMLDivElement
let root: Root
const onPick = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  lookup.mockReset()
  search.mockReset()
  onPick.mockReset()
  search.mockResolvedValue({ items: [], partial: false })
  lookup.mockResolvedValue({ ok: false, reason: 'not-found' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const render = (props: Partial<Parameters<typeof GitHubLinkPicker>[0]> = {}): void => {
  act(() => root.render(
    <GitHubLinkPicker
      projectId="p1"
      repository="o/r"
      existing={[]}
      anchor={{ x: 10, y: 10 }}
      onPick={onPick}
      onClose={vi.fn()}
      {...props}
    />
  ))
}

/** Let the 150 ms debounce fire and the resolved promise land. */
const settle = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
}

const type = async (value: string): Promise<void> => {
  const input = document.querySelector('.github-link-picker__filter') as HTMLInputElement
  act(() => {
    // React tracks the previous value on the node itself; assigning `.value` directly makes it
    // think nothing changed, so the native setter has to be used.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
      .set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

describe('GitHubLinkPicker', () => {
  it('sends a number to lookup, not to search', async () => {
    lookup.mockResolvedValue({ ok: true, source: 'cache', item: card(12) })
    render()
    await settle()
    search.mockClear()
    await type('#12')
    expect(lookup).toHaveBeenCalledWith({ projectId: 'p1', number: 12 })
    expect(search).not.toHaveBeenCalled()
    expect(document.querySelector('.github-link-picker__title')?.textContent).toBe('Item 12')
  })

  it('sends free text to search, which never hits the network', async () => {
    search.mockResolvedValue({ items: [card(4)], partial: false })
    render()
    await type('board')
    expect(search).toHaveBeenLastCalledWith({ projectId: 'p1', search: 'board', limit: 20 })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('treats a URL for another repository as free text, so no number is resolved', async () => {
    render()
    await type('https://github.com/other/repo/issues/12')
    expect(lookup).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalled()
  })

  it('renders a refusal as one disabled row instead of an empty list', async () => {
    lookup.mockResolvedValue({ ok: false, reason: 'not-approved' })
    render()
    await type('12')
    const note = document.querySelector('.github-link-picker__note') as HTMLButtonElement
    expect(note.disabled).toBe(true)
    expect(note.textContent).toContain('not approved')
  })

  it('disables a row for a link the node already carries', async () => {
    search.mockResolvedValue({ items: [card(4)], partial: false })
    render({ existing: [{ kind: 'issue', number: 4 }] })
    await type('item')
    const row = [...document.querySelectorAll('.github-link-picker__list button')]
      .find((b) => b.textContent?.includes('#4')) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Enter picks the first row that is not already attached, with the item’s own kind', async () => {
    search.mockResolvedValue({
      items: [card(4), card(5, { pull: { draft: false, mergedAt: null } })],
      partial: false
    })
    render({ existing: [{ kind: 'issue', number: 4 }] })
    await type('item')
    const input = document.querySelector('.github-link-picker__filter') as HTMLInputElement
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onPick).toHaveBeenCalledWith({ kind: 'pull', number: 5, title: 'Item 5' })
  })

  it('offers the preset candidates before anything is typed', () => {
    render({ preset: [card(9)] })
    expect(document.querySelector('.github-link-picker__title')?.textContent).toBe('Item 9')
  })
})
