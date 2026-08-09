// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubIssueSummaryModal } from './GitHubIssueSummaryModal'

vi.mock('../../session/session', () => ({
  useSession: () => ({ api: { shell: { openExternal: vi.fn(async () => {}) } } })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const issue: GitHubIssueCardView = {
  id: 1, number: 1, title: 'Keyboard access', body: '', state: 'open', stateReason: null,
  htmlUrl: 'https://github.com/o/r/issues/1', apiUrl: 'https://api.github.com/repos/o/r/issues/1',
  labels: [], assignees: [], createdAt: '2026-08-09T00:00:00Z',
  updatedAt: '2026-08-09T00:00:00Z', locked: false, columnId: null, conflict: null
}

describe('GitHubIssueSummaryModal', () => {
  it('contains keyboard focus and restores it when closed', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={vi.fn()} />
    ))
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!
    const buttons = host.querySelectorAll<HTMLButtonElement>('button')
    const last = buttons[buttons.length - 1]
    expect(document.activeElement).toBe(close)
    last.focus()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })))
    expect(document.activeElement).toBe(close)
    act(() => root.unmount())
    expect(document.activeElement).toBe(opener)
    host.remove()
    opener.remove()
  })
})
