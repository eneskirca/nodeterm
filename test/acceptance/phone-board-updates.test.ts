// @vitest-environment jsdom
// Real WorkspaceStore writes + renderer store + mounted production Board. The small event
// harness follows Canvas's two existing consumers: outside edits may conflict while dirty;
// this core's server-change is adopted without reloading the canvas. No PTY/device is started.
import { createElement, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { WorkspaceStore, type RemoteWorkspaceIO } from '../../src/core/workspace-store'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, NodeTerminalApi, Project, ProjectKanban } from '../../src/shared/types'
import { useProjects } from '../../src/renderer/state/projects'
import { KanbanView } from '../../src/renderer/components/kanban/KanbanView'
import { defaultKanban } from '../../src/renderer/lib/kanban'
import { decideExternalChange } from '../../src/renderer/lib/externalChange'
import { buildRealApi } from '../../src/renderer/bridge/ws-bridge'
import { planServerChange } from '../../src/renderer/lib/serverChange'

const desktop = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    exposed: {} as Record<string, unknown>, listeners,
    on: (channel: string, fn: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set(); set.add(fn); listeners.set(channel, set)
    },
    off: (channel: string, fn: (...args: unknown[]) => void) => listeners.get(channel)?.delete(fn),
    emit: (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach(fn => fn({ sender: 'fixture' }, ...args))
  }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { desktop.exposed[key] = api } },
  ipcRenderer: { on: desktop.on, removeListener: desktop.off, invoke: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))
import '../../src/preload/index'

vi.mock('../../src/renderer/session/session', () => ({ useSession: () => ({ api: {} }) }))
// These modal-only panels are closed throughout this regression; avoid loading terminal/browser
// runtime dependencies. The Board, columns, cards and label chips are all real components.
vi.mock('../../src/renderer/components/kanban/ModalTerminal', () => ({ ModalTerminal: () => null }))
vi.mock('../../src/renderer/nodes/BrowserSurface', () => ({ BrowserSurface: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node: CanvasNodeState = {
  id: 'term-phone-1', kind: 'terminal', title: 'QA relay shell', color: '#10a37f', group: null,
  position: { x: 10, y: 20 }, size: { width: 800, height: 600 }
}
const board = (): ProjectKanban => ({
  columns: [{ id: 'kcol-progress', title: 'In Progress', color: '#10a37f' }], assignments: [],
  labels: [{ id: 'klbl-hike', name: 'Hike QA', color: 'blue' }]
})
const noop = (): void => {}
let userData: string, cwd: string, host: HTMLDivElement, root: Root
let mounts: number, conflicts: number, reloads: number
let unsubscribers: Array<() => void>

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-phone-board-user-'))
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-phone-board-project-'))
  mounts = 0; conflicts = 0; reloads = 0; unsubscribers = []; desktop.listeners.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  unsubscribers.forEach(off => off())
  act(() => root.unmount())
  useProjects.setState({ projects: [], activeProjectId: '' })
  host.remove(); resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(cwd, { recursive: true, force: true })
})

async function fixture(surface: 'desktop' | 'server', kind: 'local' | 'ssh', initialBoard: ProjectKanban | null = board()) {
  const project: Project = {
    id: 'phone-board-project', name: 'QA project', color: '#10a37f', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [node], ...(initialBoard ? { kanban: initialBoard } : {}),
    ...(kind === 'local' ? { cwd } : { ssh: { server: { host: 'owned.invalid', user: 'qa' }, remoteCwd: '/owned/qa' } as Project['ssh'] })
  }
  let remoteContent: string | null = null
  const remoteIO: RemoteWorkspaceIO = {
    read: async () => remoteContent === null ? { status: 'absent' } : { status: 'ok', content: remoteContent },
    write: async (_id, _ssh, content) => { remoteContent = content; return true }
  }
  const platform = fakePlatform({ userDataDir: userData }); initPlatform(platform)
  const store = new WorkspaceStore(kind === 'ssh' ? remoteIO : undefined)
  await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  useProjects.getState().hydrate(await store.load())
  // An unsaved local drag is precisely why an outside-file kanban edit would conflict.
  const liveNodes = [{ ...node, position: { x: 900, y: 700 } }]
  const serverListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const serverClient = {
    subscribe: (channel: string, fn: (...args: unknown[]) => void) => {
      const set = serverListeners.get(channel) ?? new Set(); set.add(fn); serverListeners.set(channel, set)
      return () => { set.delete(fn) }
    }
  }
  // The production Desktop preload or Server WebSocket adapter receives the real core broadcast.
  const workspace = surface === 'desktop'
    ? (desktop.exposed.nodeTerminal as NodeTerminalApi).workspace
    : buildRealApi(serverClient as never).workspace
  unsubscribers.push(workspace.onExternalChange(incoming => {
    const decision = decideExternalChange({ dirty: true, base: useProjects.getState().getProject(project.id), incoming, liveNodeIds: liveNodes.map(n => n.id) })
    if (decision.kind === 'conflict') conflicts++
    if (decision.kind === 'reload') reloads++
    if (decision.kind === 'merge' || decision.kind === 'reload') useProjects.getState().replaceProject(incoming)
  }))
  unsubscribers.push(workspace.onServerChange(incoming => {
    const plan = planServerChange({ base: useProjects.getState().getProject(project.id), incoming,
      liveNodeIds: liveNodes.map(n => n.id), liveRopes: [], liveBridges: [] })
    liveNodes.push(...plan.added)
    useProjects.getState().replaceProject(incoming)
  }))
  const broadcast = platform.broadcast
  platform.broadcast = (channel, ...args) => {
    broadcast(channel, ...args)
    if (surface === 'desktop') desktop.emit(channel, ...args)
    else serverListeners.get(channel)?.forEach(fn => fn(...args))
  }
  const seed = defaultKanban()
  function MountedBoard() {
    const p = useProjects(s => s.projects.find(p => p.id === project.id))!
    useEffect(() => { mounts++ }, [])
    return createElement(KanbanView, {
      board: p.kanban ?? seed,
      sessions: liveNodes.map(n => ({ id: n.id, title: n.title, color: n.color, kind: 'terminal' as const, spawn: {} })),
      onChange: noop, onOpenNode: noop, onCreateNode: noop, onRenameNode: noop, onEditSticky: noop,
      onDeleteNode: noop, onModalNodeChange: noop, onBrowserNav: noop, onSetIcon: noop
    })
  }
  act(() => root.render(createElement(MountedBoard)))
  function card() {
    const title = Array.from(host.querySelectorAll('.kanban-card__title')).find(el => el.textContent === node.title)
    expect(title).toBeTruthy()
    return title!.closest('.kanban-card--session')!
  }
  return { store, platform, project, liveNodes, card }
}

for (const surface of ['desktop', 'server'] as const) for (const kind of ['local', 'ssh'] as const) describe(`phone Board updates on a dirty mounted ${surface} ${kind} project`, () => {
  it('moves and labels the mounted card without a conflict, reload, or lost local drag', async () => {
    const f = await fixture(surface, kind)
    expect(f.card().closest('.kanban-col')?.querySelector('.kanban-col__title')?.textContent).toBe('Ungrouped')
    await act(async () => { expect(await f.store.setRemoteCardColumn(f.project.id, node.id, 'kcol-progress')).toBe(true) })
    expect(f.card().closest('.kanban-col')?.querySelector('.kanban-col__title')?.textContent).toBe('In Progress')
    await act(async () => { expect(await f.store.editRemoteCardLabels(f.project.id, node.id, { add: ['klbl-hike'] })).toMatchObject({ edited: true }) })
    expect(f.card().querySelector('.kanban-label-chip')?.textContent).toBe('Hike QA')
    expect({ mounts, conflicts, reloads }).toEqual({ mounts: 1, conflicts: 0, reloads: 0 })
    expect(f.platform.sent.filter(s => s.channel === IPC.workspaceExternalChange)).toEqual([])
    // The renderer's next ordinary save uses the adopted Board and its still-live canvas nodes.
    useProjects.getState().commitCanvas(f.project.id, f.liveNodes, f.project.viewport)
    await f.store.save(useProjects.getState().toWorkspace())
    const persisted = (await f.store.load()).projects[0]!
    expect(persisted.kanban?.assignments).toEqual([{ nodeId: node.id, columnId: 'kcol-progress' }])
    expect(persisted.kanban?.meta?.[0]?.labels).toEqual(['klbl-hike'])
    expect(persisted.nodes[0]?.position).toEqual({ x: 900, y: 700 })
  })

  it('adopts phone-seeded default columns into the already mounted Board', async () => {
    const f = await fixture(surface, kind, null)
    await act(async () => { expect(await f.store.ensureRemoteBoard(f.project.id)).toHaveLength(3) })
    const adopted = useProjects.getState().getProject(f.project.id)?.kanban
    expect(adopted?.columns.map(c => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(host.querySelectorAll('.kanban-col')).toHaveLength(4)
    expect({ mounts, conflicts, reloads }).toEqual({ mounts: 1, conflicts: 0, reloads: 0 })
  })
})
