// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { GitHubIssueSummaryModal } from './GitHubIssueSummaryModal'
import { popDialog, pushDialog } from '../dialog-stack'

vi.mock('../../session/session', () => ({
  useSession: () => ({
    api: {
      shell: { openExternal: vi.fn(async () => {}) },
      boardLog: { read: async () => ({ entries: [] }), onChanged: () => () => {}, append: async () => true }
    }
  })
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

  it('offers "Start with agent" with the canvas picker rows, and shows the read-only run history', () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const pick = vi.fn()
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={vi.fn()} showRunHistory
        startMenu={() => [{ label: 'Codex', onClick: pick }]} />
    ))
    expect(host.textContent).toContain('Agent runs')
    // Read-only: a comment box under a GitHub issue would read as "post to GitHub".
    expect(host.querySelector('.board-log__composer')).toBeNull()
    expect(host.textContent).toContain('never posted to GitHub')
    const start = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Start with agent'))!
    act(() => start.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const row = [...document.body.querySelectorAll<HTMLElement>('.ctx-item')].find((el) => el.textContent?.includes('Codex'))!
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(pick).toHaveBeenCalled()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('Escape closes the modal, but not while a dialog stacked over it owns the key', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onClose = vi.fn()
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={onClose} />
    ))
    pushDialog('stacked-confirm')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).not.toHaveBeenCalled()
    popDialog('stacked-confirm')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    host.remove()
  })

  it('offers "Start in a new worktree" beside it, with the same picker rows', () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const pick = vi.fn()
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={vi.fn()} startMenu={() => []}
        worktreeMenu={() => ({ items: [{ label: 'Codex', onClick: pick }] })} />
    ))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Start in a new worktree'))!
    expect(button.disabled).toBe(false)
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const row = [...document.body.querySelectorAll<HTMLElement>('.ctx-item')].find((el) => el.textContent?.includes('Codex'))!
    act(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(pick).toHaveBeenCalled()
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('a project that cannot take a worktree gets the button DISABLED with its reason', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={vi.fn()}
        worktreeMenu={() => ({ refusal: 'Not supported in SSH projects yet' })} />
    ))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Start in a new worktree'))!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Not supported in SSH projects yet')
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.querySelector('.ctx-menu')).toBeNull()
    act(() => root.unmount())
    host.remove()
  })

  it('a pull request offers no "Start with agent" and no run history', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(
      <GitHubIssueSummaryModal issue={issue} kind="pull" columns={[]} moving={false} readOnly={false}
        onMove={vi.fn()} onClose={vi.fn()} showRunHistory startMenu={() => []}
        worktreeMenu={() => ({ items: [] })} />
    ))
    expect(host.textContent).not.toContain('Start with agent')
    expect(host.textContent).not.toContain('new worktree')
    expect(host.textContent).not.toContain('Agent runs')
    act(() => root.unmount())
    host.remove()
  })
})
