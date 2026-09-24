// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as linkMaps from '@shared/context-link-map'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useContextLinkSync, type LiveContextLinks } from './useContextLinkSync'
import type { CanvasNodeState, Project } from '@shared/types'

vi.mock('../session/session', () => ({
  sessionForProject: (id: string) => ({ api: id === 'relay' ? {} : window.nodeTerminal })
}))
const setLinks = vi.fn(async (_map: unknown) => {})
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const node = (id: string): LiveContextLinks['nodes'][number] => ({ id, type: 'terminal', data: { title: id, agentId: 'codex' } })
const project = (id: string, ids: string[], bridges = ids.length > 1 ? [edge(ids[0], ids[1])] : []): Project => ({
  id, nodes: ids.map((id) => ({ id, kind: 'terminal', title: id, agentId: 'codex' } as CanvasNodeState)), bridges
} as Project)
let root: Root
function Harness(props: LiveContextLinks) { useContextLinkSync(props); return null }
function render(props: LiveContextLinks) { act(() => root.render(<Harness {...props} />)); flush() }
function flush() { act(() => vi.runOnlyPendingTimers()) }
function lastMap() { flush(); return setLinks.mock.calls.at(-1)?.[0] as unknown as Record<string, Array<Record<string, unknown>>> }

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { nodeTerminal: { contextLink: { setLinks } } })
  useProjects.setState({ projects: [project('p', ['a', 'b'])], activeProjectId: 'p' })
  useAgentStatus.setState({ byId: {} })
  setLinks.mockClear()
  root = createRoot(document.createElement('div'))
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks() })

it('publishes a newly drawn/auto-created link during continuous node renders, then removes it', () => {
  const live = { projectId: 'p', nodes: [node('a'), node('b')], edges: [] as LiveContextLinks['edges'] }
  render(live)
  expect(lastMap()).toEqual({})
  render({ ...live, edges: [edge('a', 'b')] })
  expect(lastMap().a[0].id).toBe('b')
  const calls = setLinks.mock.calls.length
  for (let i = 0; i < 30; i++) render({ ...live, nodes: live.nodes.map((n) => ({ ...n, data: { ...n.data, width: i } })), edges: [edge('a', 'b')] })
  expect(setLinks).toHaveBeenCalledTimes(calls)
  render(live)
  expect(lastMap()).toEqual({})
})

it('updates background edges and session identities without a canvas render', () => {
  render({ projectId: 'p', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] })
  act(() => useProjects.setState({ projects: [project('p', ['a', 'b']), project('q', ['c', 'd'])] }))
  expect(lastMap().c[0].id).toBe('d')
  act(() => useAgentStatus.setState({ byId: { d: { agentId: 'codex', sessionId: 'new-session', unread: false } } }))
  expect(lastMap().c[0].sessionId).toBe('new-session')
  act(() => useProjects.setState({ projects: [project('p', ['a', 'b']), project('q', ['c', 'd'], [])] }))
  expect(lastMap().c).toBeUndefined()
  expect(lastMap().a[0].id).toBe('b')
})

it('uses persisted maps while the active id and rendered canvas epoch disagree', () => {
  act(() => useProjects.setState({ projects: [project('p', ['a', 'b']), project('q', ['c', 'd'])] }))
  const old = { projectId: 'p', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }
  render(old)
  act(() => useProjects.setState({ activeProjectId: 'q' }))
  render(old)
  expect(Object.keys(lastMap()).sort()).toEqual(['a', 'b', 'c', 'd'])
  render({ projectId: 'q', nodes: [node('c'), node('d')], edges: [] })
  expect(Object.keys(lastMap()).sort()).toEqual(['a', 'b'])
})

it('excludes relay projects and refuses edges to a node in another project', () => {
  act(() => useProjects.setState({ projects: [project('p', ['a', 'b']), project('relay', ['secret', 'foreign'])] }))
  render({ projectId: 'p', nodes: [node('a'), node('b')], edges: [edge('a', 'secret')] })
  expect(lastMap()).toEqual({})
  act(() => useProjects.setState({ activeProjectId: 'relay' }))
  render({ projectId: 'relay', nodes: [node('secret'), node('foreign')], edges: [edge('secret', 'foreign')] })
  expect(Object.keys(lastMap()).sort()).toEqual(['a', 'b'])
})

it('refreshes linked notes and titles, and stops subscribing after unmount', () => {
  const nodes = [node('a'), { id: 'note', type: 'sticky', data: { title: 'Brief', text: 'old' } }]
  render({ projectId: 'p', nodes, edges: [edge('a', 'note')] })
  render({ projectId: 'p', nodes: [nodes[0], { ...nodes[1], data: { title: 'New brief', text: 'new' } }], edges: [edge('a', 'note')] })
  expect(lastMap().a).toEqual([{ id: 'note', title: 'New brief', note: 'new' }])
  act(() => root.unmount())
  const count = setLinks.mock.calls.length
  act(() => useProjects.setState({ projects: [] }))
  expect(setLinks).toHaveBeenCalledTimes(count)
})

it('coalesces workspace rebuilds before serialization and cancels pending work on unmount', () => {
  const build = vi.spyOn(linkMaps, 'buildBackgroundLinkMaps')
  const live = { projectId: 'p', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }
  render(live)
  build.mockClear()
  for (let i = 0; i < 30; i++) {
    act(() => root.render(<Harness {...live} nodes={live.nodes.map(n => ({ ...n }))} />))
    act(() => useAgentStatus.setState({ byId: { b: { agentId: 'codex', sessionId: `s-${i}`, unread: false } } }))
  }
  expect(build).not.toHaveBeenCalled()
  flush()
  expect(build).toHaveBeenCalledTimes(1)
  expect(lastMap().a[0].sessionId).toBe('s-29')
  act(() => useProjects.setState({ projects: [] }))
  act(() => root.unmount())
  flush()
  expect(build).toHaveBeenCalledTimes(1)
})
