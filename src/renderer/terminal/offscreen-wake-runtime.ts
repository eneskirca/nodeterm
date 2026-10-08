import { assembleResumeCommand } from '@shared/agents/launch'
import { agentConfig, createdAgentId } from '@shared/agents/config'
import { wakeRefusalReason, type WakeVerdict } from '@shared/agents/wake-identity'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { ensureClaudeCliCaps, projectPermissionMode } from '../state/permissionMode'
import { ensureCodexCliCaps, codexApprovalCaps } from '../state/codexCli'
import { ensureProjectLaunchInfo } from '../state/projectLaunchInfo'
import { agentLaunchOverride } from '../state/workspace'
import { agentEnvSnapshot } from '../lib/agentEnv'
import { wakeOffscreen, type OffscreenWakeTarget } from './offscreen-wake'

/** Renderer-private resolver: an ambiguous saved id is not proof of a project or a pane. */
export function wakeOffscreenNode(nodeId: string, automatic = false): Promise<void> {
  const matches = useProjects.getState().projects.flatMap((project) =>
    project.nodes.filter((node) => node.id === nodeId && node.kind === 'terminal').map((node) => ({ project, node })))
  if (matches.length !== 1) return Promise.resolve()
  const { project, node } = matches[0]
  const status = useAgentStatus.getState().byId[nodeId]
  const settings = useSettings.getState().settings
  const agentId = createdAgentId(node)
  const sessionId = status?.sessionId || node.agentSessionId
  if (!agentId || !sessionId) return Promise.resolve()
  const target: OffscreenWakeTarget = { projectId: project.id, nodeId, agentId, sessionId,
    hibernated: !!status?.hibernated, paused: !!status?.paused, recorded: status?.hibernatedContext }
  return wakeOffscreen(nodeId, automatic, {
    resolve: () => target,
    current: () => useProjects.getState().getProject(project.id) === project &&
      useAgentStatus.getState().byId[nodeId] === status && useSettings.getState().settings === settings,
    command: async () => {
      await ensureProjectLaunchInfo(project.id)
      const remote = project.ssh || node.ssh || node.sshRemoteTmux
      // A local capability never gates an agent running on a remote SSH host.
      if (!remote && agentId === 'claude') await ensureClaudeCliCaps()
      if (!remote && agentId === 'codex') await ensureCodexCliCaps()
      const assembled = assembleResumeCommand({ agentId, sessionId,
        customAgent: agentConfig(agentId) ? undefined : settings.customAgents.find((c) => c.id === agentId),
        permissionMode: projectPermissionMode(project, agentId), approvalCaps: codexApprovalCaps(remote),
        sharedIdentity: false, launchCmdOverride: agentLaunchOverride(agentId, project.id)
      }, agentEnvSnapshot())
      return assembled.missingEnv.length ? null : assembled.command || null
    },
    deliver: (request) => window.nodeTerminal.pty.wakeSleeping(request),
    completed: () => {
      const store = useAgentStatus.getState()
      store.setHibernated(nodeId, false)
      store.setPaused(nodeId, false)
      store.setDropped(nodeId, false)
      store.setWakeBlocked(nodeId, null)
    },
    refused: (_id, result) => {
      const reason = result.verdict === 'delivery-failed' ? 'Resume could not be delivered. Open the session and try again.'
        : result.verdict === 'invalid-request' ? 'This session has no usable resume command.'
        : wakeRefusalReason(result.verdict as WakeVerdict)
      useAgentStatus.getState().setWakeBlocked(nodeId, reason)
    }
  }).catch(() => {})
}
