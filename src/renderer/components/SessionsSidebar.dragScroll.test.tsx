// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { useProjects } from '../state/projects'
import { createSession, setActiveSession, SessionProvider, resetSessionsForTest } from '../session/session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}
const props: SessionsSidebarProps = {
  open: true, pinned: true, liveActiveNodes: null, onTogglePin: noop, onClose: noop,
  onFocusNode: noop, onCloseSession: noop, onRenameSession: noop, onAiNameSession: noop,
  onRowContextMenu: noop, onProjectContextMenu: noop, onSwitchProject: noop, onAddToProject: noop,
  onMoveToGroup: noop, onAiNameGroup: noop, onReorder: noop, onReorderGroup: noop,
  onReorderProject: noop, onReopenProject: noop, onDeleteProject: noop,
  onReopenClosedSession: noop, onDiscardClosedSession: noop, onOpenClosedTranscript: noop
}
const project = (id: string): Project =>
  ({ id, cwd: `/repo/${id}`, name: id, color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }) as Project

let root: Root
let host: HTMLDivElement
let frames: FrameRequestCallback[]
let clock = 0
const flush = (): void => {
  const due = frames
  frames = []
  due.forEach((f) => f((clock += 1000 / 60)))
}
const dragEvent = async (el: EventTarget, type: string, clientY = 0): Promise<void> => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(e, {
    dataTransfer: { value: { effectAllowed: '', setData: noop } },
    clientX: { value: 100 },
    clientY: { value: clientY }
  })
  await act(async () => {
    el.dispatchEvent(e)
  })
}

beforeEach(() => {
  resetSessionsForTest()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  window.nodeTerminal = { sshFs: {} } as NodeTerminalApi
  useProjects.setState({ projects: [project('a'), project('b'), project('c')], activeProjectId: 'a' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetSessionsForTest()
  vi.unstubAllGlobals()
})

it('scrolls the sidebar body while a project is dragged below it, and stops when the drag ends', async () => {
  const api = { git: { status: vi.fn(async () => ({ hasRepo: false })) }, fs: {} } as unknown as NodeTerminalApi
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  await act(async () => {
    root.render(
      <SessionProvider session={session}>
        <SessionsSidebar {...props} />
      </SessionProvider>
    )
  })
  const body = host.querySelector<HTMLElement>('.sessions-sidebar__body')!
  body.getBoundingClientRect = () =>
    ({ left: 0, right: 300, top: 100, bottom: 500, width: 300, height: 400 }) as DOMRect
  const head = host.querySelector('.ss-group__head')!
  await dragEvent(head, 'dragstart')
  await dragEvent(document.body, 'dragover', 900)
  flush()
  flush()
  expect(body.scrollTop).toBeGreaterThan(0)
  const afterDrag = body.scrollTop
  await dragEvent(head, 'dragend')
  flush()
  expect(body.scrollTop).toBe(afterDrag)
})

it('stops scrolling when the sidebar closes mid-drag', async () => {
  const api = { git: { status: vi.fn(async () => ({ hasRepo: false })) }, fs: {} } as unknown as NodeTerminalApi
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  const render = (open: boolean): Promise<void> =>
    act(async () => {
      root.render(
        <SessionProvider session={session}>
          <SessionsSidebar {...props} open={open} />
        </SessionProvider>
      )
    })
  await render(true)
  const head = host.querySelector('.ss-group__head')!
  await dragEvent(head, 'dragstart')
  expect(frames.length).toBeGreaterThan(0)
  await render(false)
  expect(frames).toHaveLength(0)
})
