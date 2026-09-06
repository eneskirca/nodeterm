// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubPullCard } from './GitHubPullCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pull = (over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: 7, number: 7, title: 'Harvest pull requests', body: '', state: 'open', stateReason: null,
  htmlUrl: 'https://github.com/o/r/pull/7', apiUrl: 'https://api.github.com/repos/o/r/issues/7',
  labels: [{ id: 1, name: 'kanban', color: 'ff0000' }], assignees: [],
  createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', locked: false,
  columnId: 'todo', conflict: null, pull: { draft: false, mergedAt: null },
  ...over
})

function render(item: GitHubIssueCardView, onOpen = vi.fn()): { host: HTMLElement; onOpen: typeof onOpen } {
  const host = document.createElement('div')
  act(() => createRoot(host).render(<GitHubPullCard pull={item} onOpen={onOpen} />))
  return { host, onOpen }
}

describe('GitHubPullCard', () => {
  it('names the state a reader is looking for, merged included', () => {
    expect(render(pull()).host.textContent).toContain('Open')
    expect(render(pull({ pull: { draft: true, mergedAt: null } })).host.textContent).toContain('Draft')
    expect(render(pull({
      state: 'closed', pull: { draft: false, mergedAt: '2026-08-30T20:35:03Z' }
    })).host.textContent).toContain('Merged')
    expect(render(pull({ state: 'closed', pull: { draft: false, mergedAt: null } })).host.textContent)
      .toContain('Closed')
  })

  it('carries no write affordance: no drag, no move control', () => {
    const { host } = render(pull())
    const card = host.querySelector<HTMLElement>('[role="button"]')!
    expect(card.draggable).toBe(false)
    expect(host.querySelector('select')).toBeNull()
  })

  it('opens on click and on Enter', () => {
    const item = pull()
    const { host, onOpen } = render(item)
    const card = host.querySelector<HTMLElement>('[role="button"]')!
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenCalledWith(item)
  })
})
