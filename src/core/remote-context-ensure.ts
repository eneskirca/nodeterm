import type { ContextEnsureQuery, RemoteEnsureOutcome } from './context-ensure'

/** The shell supplies transports; agent selection and the no-local-fallback boundary are shared
 * executable code. Codex and Claude must never share their locator or token parser. */
export function createRemoteContextEnsure<Ref>(deps: {
  isRemoteNode(nodeId: string): boolean
  codex(q: ContextEnsureQuery): Promise<RemoteEnsureOutcome | null>
  claude: { pathFor(sessionId: string): string | undefined; replay(sessionId: string): void; track(sessionId: string, ref: Ref): void }
  locateClaude(q: ContextEnsureQuery): Promise<Ref | undefined>
}): (q: ContextEnsureQuery) => Promise<RemoteEnsureOutcome | null> {
  return async q => {
    if (!q.nodeId || !deps.isRemoteNode(q.nodeId)) return null
    if (q.agentId === 'codex') return await deps.codex(q) ?? 'unresolved'
    if (q.agentId && q.agentId !== 'claude') return 'unresolved'
    if (deps.claude.pathFor(q.sessionId)) {
      deps.claude.replay(q.sessionId)
      return 'tracked'
    }
    const ref = await deps.locateClaude(q)
    if (!ref) return 'unresolved'
    deps.claude.track(q.sessionId, ref)
    return 'tracked'
  }
}
