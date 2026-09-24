// @vitest-environment jsdom
//
// The worktree frame's setup chip. A FAILED setup is the one state that must be actionable from
// here: the settings panel's Run executes at the project ROOT and claims the PROJECT lane, so it can
// never re-attach this group's run — clicking it would leave the chip failed and the nodes it armed
// waiting forever. So the chip itself is the re-run, and it must refuse to fire a second launch
// while one is already in flight (the service would answer `busy`, and a `busy` ack knows nothing
// about the run that is actually going).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { SessionProvider, type WorkspaceSession } from '../session/session'
import type { ProjectSetupEvent } from '@shared/project-settings'
import { useProjectSetup } from '../state/projectSetup'
import { useWorktrees } from '../state/worktrees'

// React Flow instantiates custom nodes itself; the chip needs none of that machinery.
vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  useReactFlow: () => ({ updateNodeData: vi.fn(), setNodes: vi.fn() })
}))

import { GroupNode, setWorktreeActionHandler, type WorktreeAction } from './GroupNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GROUP_ID = 'group-1'
const RUN_KEY = 'rk'

const ev = (over: Partial<ProjectSetupEvent> = {}): ProjectSetupEvent => ({
  runKey: RUN_KEY,
  runId: 'run-a',
  kind: 'setup',
  seq: 1,
  state: 'running',
  ...over
})

function renderGroup(): { chip: () => HTMLButtonElement | HTMLElement | null; host: HTMLDivElement } {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  // Only the fields the chip path reads — NodeProps' full shape is React Flow's business, and this
  // test mocks React Flow away entirely.
  const props = {
    id: GROUP_ID,
    data: {
      title: 'wt',
      color: '#888',
      worktree: { repoPath: '/repo', path: '/repo/wt', branch: 'feat', baseRef: 'main' }
    },
    selected: false
  } as unknown as Parameters<typeof GroupNode>[0]
  act(() => {
    const session: WorkspaceSession = {
      id: 'fixture', source: 'local', label: 'fixture', status: 'connected',
      api: { git: {} } as NodeTerminalApi
    }
    root.render(<SessionProvider session={session}><GroupNode {...props} /></SessionProvider>)
  })
  return { chip: () => host.querySelector('.group-node__setup'), host }
}

beforeEach(() => {
  document.body.innerHTML = ''
  // The frame's own git-status poll wants a live session api; it has nothing to do with the chip.
  useWorktrees.setState({ refreshStatus: async () => {} })
  useProjectSetup.setState({ byRunKey: {}, projectRunKey: {}, groupRunKey: {}, pendingByGroup: {} })
  setWorktreeActionHandler(null)
})

describe('the worktree frame’s setup chip', () => {
  it('a failed setup is a BUTTON that asks Canvas to re-run it for THIS group', () => {
    const seen: Array<[string, WorktreeAction]> = []
    setWorktreeActionHandler((groupId, action) => seen.push([groupId, action]))
    useProjectSetup.getState().attachGroup(GROUP_ID, RUN_KEY)
    useProjectSetup.getState().applyEvent(ev({ state: 'failed', exitCode: 1 }))
    const { chip } = renderGroup()
    const button = chip() as HTMLButtonElement
    expect(button.tagName).toBe('BUTTON')
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(seen).toEqual([[GROUP_ID, 'rerun-setup']])
  })

  it('and is DISABLED while a launch for the group is already in flight', () => {
    setWorktreeActionHandler(() => expect.unreachable('a second launch must not be dispatched'))
    useProjectSetup.getState().attachGroup(GROUP_ID, RUN_KEY)
    useProjectSetup.getState().applyEvent(ev({ state: 'failed', exitCode: 1 }))
    // The click has been made; `projectSetup.run` has not answered yet (a consent dialog may be up).
    useProjectSetup.getState().markGroupPending(GROUP_ID)
    const { chip } = renderGroup()
    const button = chip() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('…')
    act(() => button.click()) // a disabled button dispatches nothing — the handler above proves it
  })

  it('a running run is a plain label, not an affordance', () => {
    useProjectSetup.getState().attachGroup(GROUP_ID, RUN_KEY)
    useProjectSetup.getState().applyEvent(ev({ state: 'running' }))
    const { chip } = renderGroup()
    expect(chip()!.tagName).toBe('SPAN')
    expect(chip()!.textContent).toContain('setup')
  })

  it('shows nothing at all for a group with no run of its own', () => {
    const { chip } = renderGroup()
    expect(chip()).toBeNull()
  })
})
