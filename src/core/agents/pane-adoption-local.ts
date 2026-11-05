import { readFileSync } from 'node:fs'
import type { LocalPaneIdentity, PaneAdoptionRequest, ProcessBirth } from '../../shared/agents/pane-adoption'
import type { PaneOwner } from '../../shared/agents/pane-owner-predicate'
import type { SessionHostListing } from '../session-host-client'

export interface AdoptionKernel { bootId(): string | null; process(pid: number): ProcessBirth | null; parent(pid: number): number | null }
/** Reuses the session host's authoritative /proc parser, injected by main. No argv/env reads. */
export function linuxAdoptionKernel(parse: (text: string) => ProcessBirth | null, read = (file: string): string => readFileSync(file, 'utf8')): AdoptionKernel {
  return {
    bootId: () => { try { const id = read('/proc/sys/kernel/random/boot_id').trim(); return /^[a-f0-9-]{36}$/.test(id) ? id : null } catch { return null } },
    process: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null
      try { const value = parse(read(`/proc/${pid}/stat`)); return value?.pid === pid && /^[1-9]\d*$/.test(value.birth) ? { pid, birth: value.birth } : null } catch { return null }
    },
    parent: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null
      try { const match = /^PPid:\s+([1-9]\d*)$/m.exec(read(`/proc/${pid}/status`)); const value = Number(match?.[1]); return Number.isSafeInteger(value) && value > 0 ? value : null } catch { return null }
    }
  }
}
export interface LocalPaneCaptureDeps {
  platform: string
  kernel: AdoptionKernel
  /** Only an actual private-index ID, unique node and known local folder may resolve. */
  scope(request: PaneAdoptionRequest): { projectCwd: string } | null
  provider(nodeId: string): { agentId: string; sessionId: string } | null
  listing(): Promise<SessionHostListing | null> | undefined
  paneOwner(nodeId: string, session: { pid: number; generation: string }): Promise<PaneOwner | null>
  isAgent(owner: PaneOwner, agentId: string): boolean
}
const sameBirth = (a: ProcessBirth | null, b: ProcessBirth): boolean => !!a && a.pid === b.pid && a.birth === b.birth

export function createLocalPaneEvidence(deps: LocalPaneCaptureDeps): {
  capture(request: PaneAdoptionRequest): Promise<LocalPaneIdentity | null>
  stillCurrent(identity: LocalPaneIdentity): boolean
} {
  const stillCurrent = (i: LocalPaneIdentity): boolean => {
    if (deps.platform !== 'linux') return false
    const scope = deps.scope({ nodeId: i.nodeId, projectId: i.projectId }), provider = deps.provider(i.nodeId)
    return !!scope && scope.projectCwd === i.projectCwd && !!provider && provider.agentId === i.agentId && provider.sessionId === i.providerSessionId &&
      deps.kernel.bootId() === i.bootId && sameBirth(deps.kernel.process(i.host.pid), i.host) && sameBirth(deps.kernel.process(i.pane.pid), i.pane) && deps.kernel.parent(i.pane.pid) === i.host.pid &&
      i.foreground.every(p => sameBirth(deps.kernel.process(p.pid), p))
  }
  return {
    stillCurrent,
    async capture(request) {
      try {
        if (deps.platform !== 'linux') return null
        const scope = deps.scope(request), provider = deps.provider(request.nodeId), bootId = deps.kernel.bootId()
        if (!scope || !provider || !bootId) return null
        const listing = await deps.listing()
        if (!listing?.running || !listing.sessions || !listing.hostPid) return null
        const name = `nt-${request.nodeId}`, rows = listing.sessions.filter(row => row.name === name)
        if (rows.length !== 1 || !listing.names.includes(name)) return null
        const row = rows[0], host = deps.kernel.process(listing.hostPid), pane = deps.kernel.process(row.pid)
        if (!host || !pane || host.pid === pane.pid || deps.kernel.parent(pane.pid) !== host.pid || !/^[A-Za-z0-9_-]{8,128}$/.test(row.generation)) return null
        const owner = await deps.paneOwner(request.nodeId, { pid: row.pid, generation: row.generation })
        if (!owner || owner.panePid !== row.pid || owner.paneId !== `host-linux:${row.generation}:${pane.birth}` || !deps.isAgent(owner, provider.agentId) ||
          !owner.pids?.length || owner.pids.length > 32 || owner.pids.length !== owner.processBirths?.length) return null
        const foreground: ProcessBirth[] = []
        for (let n = 0; n < owner.pids.length; n++) {
          const actual = deps.kernel.process(owner.pids[n])
          if (!actual || actual.birth !== owner.processBirths[n]) return null
          foreground.push(actual)
        }
        const identity: LocalPaneIdentity = { backend: 'local-session-host-linux', ...request, projectCwd: scope.projectCwd, bootId,
          host, pane, generation: row.generation, foreground, agentId: provider.agentId, providerSessionId: provider.sessionId }
        const after = await deps.listing()
        const afterRows = after?.sessions?.filter(candidate => candidate.name === name)
        if (!after?.running || after.hostPid !== host.pid || !after.names.includes(name) || afterRows?.length !== 1 || afterRows[0].generation !== row.generation || afterRows[0].pid !== pane.pid || !stillCurrent(identity)) return null
        return identity
      } catch { return null }
    }
  }
}
