import { useEffect } from 'react'
import { capabilityAgentId, hasUsage, type AgentId } from '@shared/agents/config'
import type { ContextApi } from '@shared/types'

/** Canvas and board co-attach share the same account/agent-aware mount-time read. The backend
 * resolves on the owning host; this capability gate must never enable Claude's search resolver. */
export function useContextEnsure(
  api: ContextApi, nodeId: string, agentId: AgentId | undefined, sessionId: string | null | undefined,
  cwd: string | undefined, accountId: string | undefined
): void {
  useEffect(() => {
    if (agentId && hasUsage(agentId) && sessionId) {
      api.ensure(sessionId, cwd, accountId, nodeId, capabilityAgentId(agentId))
    }
  }, [api, nodeId, agentId, sessionId, cwd, accountId])
}
