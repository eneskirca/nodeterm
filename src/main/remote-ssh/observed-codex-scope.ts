import { createHash } from 'node:crypto'
import type { CanvasNodeState, Project } from '../../shared/types'
import type { CodexAccount } from '../../shared/codex-account'
import type { SshConnection } from '../../shared/ssh'
import { sshHostKey } from '../../shared/ssh'
import type { PaneAdoptionRequest } from '../../shared/agents/pane-adoption'
import type { PaneOperationContext } from '../../core/agents/pane-operation-proof'
import type { SshAdoptionScope } from '../../core/agents/ssh-pane-adoption'
import { remoteCodexHome } from '../../core/codex-accounts-core'
import { isKnownRemoteCodexAccount } from '../../core/remote-ssh/codex-home'
import { isSafeThreadId } from '../../core/codex-identity-proxy'
import { remoteCodexIdentityRoot } from '../../core/codex-thread-identity-sh'

export interface ObservedCodexRuntimeRef {
  conn: SshConnection
  remoteHome: string
  cli: string
  hookEndpoint: string
}
interface ScopeDeps {
  projects(): readonly { id: string; nodes: readonly CanvasNodeState[] }[]
  privateProject(projectId: string): { ssh?: Project['ssh'] } | null
  runtime(projectId: string): ObservedCodexRuntimeRef | undefined
  accounts(): readonly CodexAccount[]
  enabled(projectId: string): boolean
  recorded(nodeId: string): PaneOperationContext | undefined
  threadCandidate(nodeId: string): string | undefined
}
const endpoint = (c: SshConnection): string => JSON.stringify([c.host,c.user,c.port ?? 22,c.identityFile ?? '',c.extraArgs ?? '',c.execTrusted === true])

/** Select an intention from the private index and actual manager setup. Shared node/thread data
 * only selects what the native dialog asks to resume; it never proves a running process/owner.
 */
export function createObservedCodexScope(deps: ScopeDeps): (request: PaneAdoptionRequest) => SshAdoptionScope | null {
  return ({ nodeId, projectId }) => {
    try {
      const target = deps.privateProject(projectId)?.ssh
      if (!target || !deps.enabled(projectId)) return null
      const matches = deps.projects().flatMap(p => p.nodes.filter(n => n.id === nodeId).map(node => ({ projectId: p.id, node })))
      if (matches.length !== 1 || matches[0].projectId !== projectId) return null
      const node = matches[0].node
      if (node.kind !== 'terminal' || node.agentId !== 'codex' || node.sshRemoteTmux !== true) return null
      const runtime = deps.runtime(projectId)
      if (!runtime || endpoint(runtime.conn) !== endpoint(target.server)) return null
      remoteCodexIdentityRoot(runtime.remoteHome) // validates only the target-host path
      if (!runtime.cli.startsWith('/') || !runtime.hookEndpoint.startsWith('/') || !target.remoteCwd.startsWith('/')) return null
      const accountId = node.accountId
      if (accountId === 'system') return null // reserved observer scope, not a managed account id
      if (accountId && !isKnownRemoteCodexAccount([...deps.accounts()], accountId, sshHostKey(target.server))) return null
      const saved = deps.recorded(nodeId)
      if (saved && (saved.nodeId !== nodeId || saved.projectId !== projectId || saved.agentId !== 'codex')) return null
      const thread = saved?.sessionId ?? deps.threadCandidate(nodeId)
      if (!thread || !isSafeThreadId(thread)) return null
      return {
        context: { nodeId, projectId, agentId: 'codex', sessionId: thread },
        accountId: accountId || 'system', cwd: target.remoteCwd,
        codeHome: remoteCodexHome(runtime.remoteHome, accountId), remoteHome: runtime.remoteHome,
        cli: runtime.cli, hookEndpoint: runtime.hookEndpoint,
        endpointReference: createHash('sha256').update(endpoint(target.server)).digest('hex')
      }
    } catch { return null }
  }
}
