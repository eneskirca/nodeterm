// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubIssueCard } from './GitHubIssueCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const issue: GitHubIssueCardView = {
  id: 42, number: 42, title: 'Fix polling', body: '', state: 'open', stateReason: null,
  htmlUrl: 'https://github.com/o/r/issues/42', apiUrl: 'https://api.github.com/repos/o/r/issues/42',
  labels: [{ id: 1, name: 'bug', color: 'ff0000' }], assignees: [],
  createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', locked: false,
  columnId: 'todo', conflict: null
}

describe('GitHubIssueCard', () => {
  it('renders its source and exposes an accessible non-drag move action', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const move = vi.fn()
    act(() => root.render(
      <GitHubIssueCard
        issue={issue}
        columns={[
          { id: 'todo', title: 'Todo', color: '#2563eb' },
          { id: 'done', title: 'Done', color: '#16a34a' }
        ]}
        moving={false}
        onOpen={vi.fn()}
        onMove={move}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />
    ))
    expect(host.textContent).toContain('#42')
    expect(host.textContent).toContain('Fix polling')
    expect(host.textContent).toContain('GH')
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Move issue #42"]')!
    act(() => {
      select.value = 'done'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(move).toHaveBeenCalledWith(issue, 'done')
    act(() => root.unmount())
  })
})
