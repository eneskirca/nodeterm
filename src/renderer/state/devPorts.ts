// Transient per-project record of the last dev-port scan (CLAUDE.md → Dev-server ports). Never
// persisted: a listening port is a fact about a process that may be gone by the next launch.
import { create } from 'zustand'
import type { DevPortForward, DevPortsReport } from '@shared/dev-ports'
import { shouldScan, type ScanReason } from '../lib/devPorts'
import { sessionForProject } from '../session/session'
import { isBrowserRuntime } from '../bridge/runtime'

export interface ProjectPorts {
  ok: boolean
  nodes: DevPortsReport['nodes']
  forwards: DevPortForward[]
}

interface DevPortsState {
  byProject: Record<string, ProjectPorts>
  apply(projectId: string, report: DevPortsReport): void
  noteForward(projectId: string, fwd: DevPortForward): void
  dropForward(projectId: string, localPort: number): void
}

const EMPTY: DevPortForward[] = []

export const useDevPorts = create<DevPortsState>((set) => ({
  byProject: {},
  apply: (projectId, report) =>
    set((s) => {
      const prev = s.byProject[projectId]
      // A FAILED scan keeps the last good nodes: a dead master for a moment is not "the servers
      // stopped". It is still recorded as not-ok so nothing new is offered on its strength.
      const next: ProjectPorts = report.ok
        ? { ok: true, nodes: report.nodes, forwards: report.forwards ?? EMPTY }
        : { ok: false, nodes: prev?.nodes ?? {}, forwards: prev?.forwards ?? EMPTY }
      return { byProject: { ...s.byProject, [projectId]: next } }
    }),
  noteForward: (projectId, fwd) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? { ok: true, nodes: {}, forwards: EMPTY }
      const forwards = [...prev.forwards.filter((f) => f.localPort !== fwd.localPort), fwd]
      return { byProject: { ...s.byProject, [projectId]: { ...prev, forwards } } }
    }),
  dropForward: (projectId, localPort) =>
    set((s) => {
      const prev = s.byProject[projectId]
      if (!prev) return s
      const forwards = prev.forwards.filter((f) => f.localPort !== localPort)
      return { byProject: { ...s.byProject, [projectId]: { ...prev, forwards } } }
    })
}))

/** Can this project's ports be shown at all from this window? Desktop, local session only. */
export function devPortsAvailable(projectId: string): boolean {
  if (!projectId || isBrowserRuntime()) return false
  return sessionForProject(projectId).source === 'local'
}

const lastStarted = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()
/** Projects whose core answered `unsupported` (a Windows core): not asked again this run. */
const unsupported = new Set<string>()

/** Scan one project, subject to the cadence rules (`shouldScan`). Never rejects. */
export function scanDevPorts(projectId: string, remote: boolean, reason: ScanReason): Promise<void> {
  if (!devPortsAvailable(projectId) || unsupported.has(projectId)) return Promise.resolve()
  const pending = inFlight.get(projectId)
  if (pending) return pending
  const now = Date.now()
  if (!shouldScan(reason, now, lastStarted.get(projectId))) return Promise.resolve()
  lastStarted.set(projectId, now)
  const api = sessionForProject(projectId).api
  const p = api.devPorts
    .scan({ projectId, remote })
    .then((report) => {
      // `unsupported` is a property of the surface, not news: leave nothing behind for it.
      if (report.reason === 'unsupported') {
        unsupported.add(projectId)
        return
      }
      useDevPorts.getState().apply(projectId, report)
    })
    .catch(() => {
      useDevPorts.getState().apply(projectId, { ok: false, reason: 'unreachable', nodes: {} })
    })
    .finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, p)
  return p
}

/** Test seam. */
export function resetDevPortScans(): void {
  lastStarted.clear()
  inFlight.clear()
  unsupported.clear()
  useDevPorts.setState({ byProject: {} })
}
