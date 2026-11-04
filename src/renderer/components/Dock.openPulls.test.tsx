// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import type { OpenPullSection } from '../lib/addMenuSpec'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const noop = (): void => {}
function render(openPulls: OpenPullSection | undefined, onOpenPull = vi.fn(), onAddMenuOpen = vi.fn()) {
  act(() => root.render(
    <Dock
      dirty={false} zoomPct={100} canUndo={false} canRedo={false} canGoBack={false} canGoForward={false}
      onAddTerminal={noop} onAddSticky={noop} onSpawnTeam={noop} onAddDino={noop} onAddWhiteboard={noop}
      onAddTrigger={noop} onAddPull={noop} openPulls={openPulls} onOpenPull={onOpenPull}
      onAddMenuOpen={onAddMenuOpen} onAddNewPull={noop} onAddIssues={noop} onAddFiles={noop} onAddRun={noop}
      onAddSimulator={noop} onAddAgent={noop} onOpenFile={noop} onAddRemote={noop} onConnectRemote={noop}
      onAddBrowser={noop} onAddWeb={noop} onNewFile={noop} onAddWorktree={noop} onUndo={noop} onRedo={noop}
      onGoBack={noop} onGoForward={noop} onSave={noop} onFitView={noop} onSaveLayout={noop}
      onRestoreLayout={noop} onUpdateLayout={noop} onRenameLayout={noop} onDeleteLayout={noop}
      onZoomIn={noop} onZoomOut={noop} onZoomTo={noop} onDictate={noop} dictateActive={false}
    />
  ))
  act(() => (host.querySelector('[aria-label="Add node"]') as HTMLButtonElement).click())
  return [...host.querySelectorAll('.dock-add-menu button')] as HTMLButtonElement[]
}

describe('Dock open pull requests', () => {
  it('lists the open PRs first with their avatar letter, then Pull request, New pull request from <branch> and Issues', () => {
    const onOpenPull = vi.fn()
    const onAddMenuOpen = vi.fn()
    const buttons = render({
      branch: 'feat/x',
      rows: [{ number: 12, title: 'Fix login', headRefName: 'feat/login', draft: false, author: { id: 7, login: 'ann', avatarUrl: '' } }]
    }, onOpenPull, onAddMenuOpen)
    expect(onAddMenuOpen).toHaveBeenCalledTimes(1)
    expect(buttons.slice(0, 5).map((b) => b.textContent)).toEqual([
      'A#12 Fix login · feat/login', 'Pull request…', 'New pull request from feat/x', 'Issues…', 'Terminal'
    ])
    act(() => buttons[0].click())
    expect(onOpenPull).toHaveBeenCalledWith(12)
  })

  it('shows the reason as a disabled row, not an empty list', () => {
    const [first] = render({ reason: 'You are not signed in to GitHub.' })
    expect(first.textContent).toBe('You are not signed in to GitHub.')
    expect(first.disabled).toBe(true)
  })

  it('without a section the PR rows stay in the content list', () => {
    const buttons = render(undefined)
    expect(buttons[0].textContent).toBe('Terminal')
    expect(buttons.some((b) => b.textContent === 'Pull request…')).toBe(true)
  })
})
