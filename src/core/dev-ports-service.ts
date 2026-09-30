// RPC surface for dev-server ports. The shape follows session-memory-service.ts: core owns the
// probe and the parsing, the shell injects the ControlMaster, and the ONE decision made here is
// which machine answers.
//
// Registered by the DESKTOP only. The Server Edition deliberately does not serve it: the browser
// node is an Electron `<webview>`, which a browser tab does not have, and a page the viewer opened
// would load on the VIEWER's machine, where the server's port is not. Its bridge answers
// `unsupported` and the chip is not drawn (docs in CLAUDE.md → Dev-server ports).

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import type {
  DevPortForwardRequest,
  DevPortForwardResult,
  DevPortsQuery,
  DevPortsReport
} from '../shared/dev-ports'
import { collectLocalDevPorts, fetchRemoteDevPorts, type RemoteDevPortsRunner } from './dev-ports'
import {
  defaultLocalPortState,
  defaultLocalPortHeld,
  PortForwardRegistry,
  type PortForwardDeps
} from './remote-ssh/port-forward'

export interface DevPortsServiceOptions {
  /** The app's tmux binary for the LOCAL scan — the same resolver session memory is given. */
  tmuxBin: () => string | null
  /** This machine's scan. Injectable for tests. */
  local?: () => Promise<DevPortsReport>
  remote?: {
    /** Identity, not liveness — see `sshScopePredicate` (session-memory-service.ts). */
    isRemoteProject: (projectId: string) => boolean
    run?: RemoteDevPortsRunner
    /** Present ⇒ same-port forwarding is offered for SSH projects. */
    forward?: Pick<PortForwardDeps, 'refForProject' | 'run'> &
      Partial<Pick<PortForwardDeps, 'localPortState' | 'localPortHeld'>>
  }
}

const unsupported = (): DevPortsReport => ({ ok: false, reason: 'unsupported', nodes: {} })

export function startDevPortsService(opts: DevPortsServiceOptions): {
  registry: PortForwardRegistry | null
  dispose(): void
} {
  const isRemote = (q: DevPortsQuery): boolean =>
    q.remote === true || (!!q.projectId && !!opts.remote?.isRemoteProject(q.projectId))

  // One in-flight remote scan per project — the renderer's timer, a click's re-scan and a hook
  // event can land together, and each is an exec on somebody else's machine. Never a cache.
  const inFlight = new Map<string, Promise<DevPortsReport>>()
  const scanRemote = (projectId: string): Promise<DevPortsReport> => {
    const run = opts.remote?.run
    if (!run) return Promise.resolve(unsupported())
    const pending = inFlight.get(projectId)
    if (pending) return pending
    const p = fetchRemoteDevPorts(projectId, run).finally(() => inFlight.delete(projectId))
    inFlight.set(projectId, p)
    return p
  }

  const fwd = opts.remote?.forward
  const registry = fwd
    ? new PortForwardRegistry({
        refForProject: fwd.refForProject,
        run: fwd.run,
        scan: scanRemote,
        localPortState: fwd.localPortState ?? defaultLocalPortState,
        localPortHeld: fwd.localPortHeld ?? defaultLocalPortHeld
      })
    : null

  platform().handle(IPC.devPortsScan, async (q: DevPortsQuery = {}): Promise<DevPortsReport> => {
    const query = q && typeof q === 'object' ? q : {}
    if (isRemote(query)) {
      // Never fall back to this machine: its ports would be published under the host's name.
      if (!query.projectId || typeof query.projectId !== 'string') return unsupported()
      const report = await scanRemote(query.projectId)
      if (!registry) return report
      await registry.reconcile(query.projectId, report)
      return { ...report, forwards: registry.list(query.projectId) }
    }
    return (opts.local ?? (() => collectLocalDevPorts({ tmuxBin: opts.tmuxBin })))()
  })

  platform().handle(
    IPC.devPortsForward,
    async (req: DevPortForwardRequest): Promise<DevPortForwardResult> => {
      if (!registry || !req || typeof req !== 'object' || typeof req.projectId !== 'string') {
        return { ok: false, reason: 'unsupported', message: 'Port forwarding is not available here.' }
      }
      // Forwarding only exists for a project that is somebody else's machine. A local project's
      // port is already on this machine — there is nothing to forward.
      if (!opts.remote?.isRemoteProject(req.projectId)) {
        return { ok: false, reason: 'unsupported', message: 'Only an SSH project needs its ports forwarded.' }
      }
      return registry.forward({
        projectId: req.projectId,
        nodeId: String(req.nodeId ?? ''),
        port: Number(req.port),
        ...(req.localPort !== undefined ? { localPort: Number(req.localPort) } : {}),
        ...(req.allowPrivileged === true ? { allowPrivileged: true } : {})
      })
    }
  )

  platform().handle(
    IPC.devPortsUnforward,
    async (req: { projectId: string; localPort: number }): Promise<boolean> => {
      if (!registry || !req || typeof req.projectId !== 'string') return false
      return registry.unforward(req.projectId, Number(req.localPort))
    }
  )

  return { registry, dispose: (): void => registry?.dispose() }
}
