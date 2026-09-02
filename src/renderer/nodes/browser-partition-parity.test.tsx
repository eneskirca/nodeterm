// @vitest-environment jsdom
//
// One node, two mounts: the canvas BrowserNode and the kanban CardModal both render the SHARED
// BrowserSurface. This pins that they hand it the SAME `partition`, so the two mounts share one
// session jar. A mismatch is not cosmetic — it is the modal being a different, logged-out browser,
// which a user reads as "my login vanished".
//
// The shared leaf BrowserSurface is replaced by a spy that renders a real <webview partition>, so
// the assertion is against the actual attribute each wrapper's real data->prop plumbing produces
// (the bug surface lives in the wrappers, never in the identical leaf).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import type { KanbanSession } from '../components/kanban/KanbanView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shared surface both mounts use: render the partition straight onto a real <webview> so the
// test reads the same attribute a real guest would attach on.
vi.mock('./BrowserSurface', () => ({
  BrowserSurface: ({ partition }: { partition?: string }) => (
    // eslint-disable-next-line react/no-unknown-property
    <webview partition={partition || undefined} data-testid="surface" />
  )
}))
// CardModal's non-browser children are irrelevant to partition parity — stub them so the modal
// renders without their store/context burden.
vi.mock('../session/session', () => ({ useSession: () => ({ api: { pty: { generateName: vi.fn() } } }) }))
vi.mock('../components/kanban/BoardLogPanel', () => ({ BoardLogPanel: () => null }))
vi.mock('../components/kanban/CardMetaBar', () => ({ CardMetaBar: () => null }))
vi.mock('../components/kanban/ModalTerminal', () => ({ ModalTerminal: () => null }))
vi.mock('../components/ContextMeter', () => ({ ContextMeter: () => null }))

import BrowserNode from './BrowserNode'
import { CardModal } from '../components/kanban/CardModal'

function partitionFromCanvas(nodePartition: string | undefined): string | null {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const data = { title: 'B', color: '#0a84ff', group: null, url: 'https://x.test/', partition: nodePartition }
  act(() =>
    root.render(
      <ReactFlowProvider>
        <BrowserNode {...({ id: 'browser-1', data, selected: false } as unknown as NodeProps<CanvasNode>)} />
      </ReactFlowProvider>
    )
  )
  const wv = host.querySelector('webview')!
  const p = wv.getAttribute('partition')
  act(() => root.unmount())
  host.remove()
  return p
}

function partitionFromModal(sessionPartition: string | undefined): string | null {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const session: KanbanSession = {
    id: 'browser-1',
    title: 'B',
    color: '#0a84ff',
    kind: 'browser',
    url: 'https://x.test/',
    partition: sessionPartition,
    spawn: {}
  }
  act(() =>
    root.render(
      <CardModal
        session={session}
        columnTitle={null}
        board={{ columns: [], assignments: {} } as never}
        onChangeBoard={vi.fn()}
        onClose={vi.fn()}
        onOpenCanvas={vi.fn()}
        onRename={vi.fn()}
        onEditSticky={vi.fn()}
        onBrowserNav={vi.fn()}
          onChangeNodeLinks={vi.fn()}
          onAttachLink={vi.fn()}
      />
    )
  )
  const wv = document.body.querySelector('webview')!
  const p = wv.getAttribute('partition')
  act(() => root.unmount())
  host.remove()
  return p
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('canvas + modal webviews for one node share one partition', () => {
  it('an agent-opened node: both mounts carry the identical named partition', () => {
    const part = 'persist:nt-agent-browser-p1'
    const canvas = partitionFromCanvas(part)
    const modal = partitionFromModal(part)
    expect(canvas).toBe(part)
    expect(modal).toBe(part)
    expect(canvas).toBe(modal)
  })

  it('a user-opened node: BOTH mounts omit the attribute (default session, not two jars)', () => {
    // The undefined case is the one a naive fix breaks: passing '' on one side and nothing on the
    // other makes the modal a fresh default-session browser while the canvas node is on its own.
    expect(partitionFromCanvas(undefined)).toBe(null)
    expect(partitionFromModal(undefined)).toBe(null)
  })
})
