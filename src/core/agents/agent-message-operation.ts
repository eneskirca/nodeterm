import type { MirrorEntry } from '../agent-status-mirror'
import type { PaneOperationContext, PaneOperationProof, PaneOperationPurpose, AcquirePaneOwnership } from './pane-operation-proof'
import { canControlCanvas, type AgentId } from '../../shared/agents/config'
import { isSafeNodeId } from '../../shared/safe-id'
import { isSafeThreadId } from '../codex-identity-proxy'

export interface PaneOperationEnvironment {
  projects(): readonly { id: string; nodes: readonly { id: string }[] }[]
  mirrorEntry(nodeId: string): MirrorEntry | undefined
  messagingEnabled(projectId: string): boolean
  isRemoteNode(nodeId: string): boolean
  acquirePaneOwnership?: AcquirePaneOwnership
  /** Candidate from main's approved SSH-origin registry, never a synchronous owner permit. */
  remoteIdentity?(nodeId: string): PaneOperationContext | undefined
}
export interface EnvelopeWriteAccess {
  readonly beforeWrite: () => Promise<boolean>
  /** Synchronous scope/provider/Grant comparison can only DENY; it is never SSH ownership proof. */
  readonly contextCurrent?: () => boolean
  /** Target's operation only. A remote source never selects the target's execution transport. */
  readonly remoteProof?: PaneOperationProof
}
export function sameOperationContext(a: PaneOperationContext | undefined, b: PaneOperationContext | undefined): boolean {
  return !!a && !!b && a.nodeId === b.nodeId && a.projectId === b.projectId && a.agentId === b.agentId && a.sessionId === b.sessionId
}
/** Candidate only, NOT ownership authority. Consumers must use their local rule or acquire SSH proof. */
export function operationContext(env: PaneOperationEnvironment, nodeId: string, projectId?: string): PaneOperationContext | undefined {
  if (!isSafeNodeId(nodeId)) return undefined
  const projects = env.projects().filter(p => p.nodes.some(n => n.id === nodeId))
  if (projects.length !== 1 || (projectId !== undefined && projects[0].id !== projectId)) return undefined
  if (env.isRemoteNode(nodeId) && env.remoteIdentity) {
    const candidate = env.remoteIdentity(nodeId)
    return candidate?.nodeId === nodeId && candidate.projectId === projects[0].id && candidate.agentId === 'codex' &&
      isSafeThreadId(candidate.sessionId) && env.messagingEnabled(candidate.projectId) ? { ...candidate } : undefined
  }
  const m = env.mirrorEntry(nodeId), attested = m?.stateIdentity
  if (!m?.sessionId || !m.agentId || !m.stateVerified || !attested || attested.sessionId !== m.sessionId ||
      attested.agentId !== m.agentId || !canControlCanvas(m.agentId as AgentId) || !env.messagingEnabled(projects[0].id)) return undefined
  return { nodeId, projectId: projects[0].id, agentId: m.agentId, sessionId: m.sessionId }
}
/** One operation, one immutable context/remote identity/transport. Never cache as a sync owner. */
export async function acquireRemoteOperation(env: PaneOperationEnvironment, input: PaneOperationContext,
  purpose: PaneOperationPurpose, contextCurrent: () => boolean = () => true): Promise<PaneOperationProof | null> {
  const expected = Object.freeze({ ...input })
  try {
    const current = (): boolean => contextCurrent() && env.isRemoteNode(expected.nodeId) && sameOperationContext(operationContext(env, expected.nodeId), expected)
    if (!current() || !env.acquirePaneOwnership) return null
    const raw = await env.acquirePaneOwnership(Object.freeze({ ...expected }), purpose)
    if (!raw || !current() || !sameOperationContext(raw.context, expected) || typeof raw.evidenceKey !== 'string' || !raw.evidenceKey ||
        typeof raw.transportKey !== 'string' || !raw.transportKey ||
        typeof raw.revalidate !== 'function' || typeof raw.runExisting !== 'function') return null
    const evidenceKey = raw.evidenceKey, transportKey = raw.transportKey, check = raw.revalidate, run = raw.runExisting
    const stable = (): boolean => current() && sameOperationContext(raw.context, expected) &&
      raw.evidenceKey === evidenceKey && raw.transportKey === transportKey && raw.revalidate === check && raw.runExisting === run
    const revalidate = async (): Promise<boolean> => {
      try { return stable() && await check.call(raw) === true && stable() } catch { return false }
    }
    if (!await revalidate()) return null
    return Object.freeze({ context: Object.freeze({ ...expected }), evidenceKey, transportKey, revalidate,
      runExisting: async (command: string, stdin?: string) => {
        if (!await revalidate()) throw new Error('SSH operation ownership refused')
        const result = await run.call(raw, command, stdin)
        if (!stable() || !result || !Number.isInteger(result.code) || typeof result.stdout !== 'string')
          throw new Error('SSH operation context changed')
        return result
      } })
  } catch { return null }
}
