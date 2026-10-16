// @vitest-environment jsdom
//
// Issue #1113: Settings → Appearance → Sticky note / Group frame background reaches the node
// bodies, and at the default (0) the inline background is the original tint, unchanged.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { SessionProvider, type WorkspaceSession } from '../session/session'
import { useSettings } from '../state/settings'

vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({ updateNodeData: vi.fn(), setNodes: vi.fn(), deleteElements: vi.fn() })
}))

import { GroupNode } from './GroupNode'
import { StickyNode } from './StickyNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: WorkspaceSession = {
  id: 'fixture', source: 'local', label: 'fixture', status: 'connected',
  api: { git: {} } as NodeTerminalApi
}

function render(el: JSX.Element): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<SessionProvider session={session}>{el}</SessionProvider>))
  return { host, unmount: () => act(() => root.unmount()) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React Flow is mocked away
const props = (data: Record<string, unknown>): any =>
  ({ id: 'n1', data: { title: 't', color: '#336699', ...data }, selected: false })

afterEach(() => {
  useSettings.setState((s) => ({ settings: { ...s.settings, stickyNoteBacking: 0, groupFrameBacking: 0 } }))
})

describe('canvas backing wiring', () => {
  it('sticky note: old tint at 0, canvas backing under the tint when set', () => {
    const { host, unmount } = render(<StickyNode {...props({ text: 'hi' })} />)
    const el = host.querySelector<HTMLElement>('.sticky-node')!
    expect(el.style.background).toContain('rgba(51, 102, 153, 0.133')
    expect(el.style.backgroundColor).not.toContain('color-mix')
    act(() => useSettings.setState((s) => ({ settings: { ...s.settings, stickyNoteBacking: 80 } })))
    expect(el.style.backgroundColor).toContain('var(--canvas-bg) 80%')
    expect(el.style.backgroundImage).toContain('linear-gradient')
    unmount()
  })

  it('group frame: old tint at 0, canvas backing under the tint when set', () => {
    const { host, unmount } = render(<GroupNode {...props({})} />)
    const el = host.querySelector<HTMLElement>('.group-node')!
    expect(el.style.background).toContain('rgba(51, 102, 153, 0.06)')
    act(() => useSettings.setState((s) => ({ settings: { ...s.settings, groupFrameBacking: 50 } })))
    expect(el.style.backgroundColor).toContain('var(--canvas-bg) 50%')
    unmount()
  })
})
