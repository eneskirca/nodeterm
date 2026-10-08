// Where a session the PHONE starts is created, and who owns its pane (audits A33 + A72).
//
// The relay `pty.attach` of a fresh node id creates that node's tmux session. The phone names the
// project it is starting the session in (plus the account and agent it chose); everything the
// session is created WITH is resolved here, from this machine's own index and settings — never
// taken off the wire as-is:
//
//  - `cwd`: the project's folder, from the index entry. Only a local folder project qualifies (the
//    same set `projects.registerNode` accepts); an unknown, SSH or cwd-less project resolves to
//    null and the attach creates exactly the bare session it created before this existed.
//  - `accountId`: only a local, logged-in managed Claude account, and only for a Claude session.
//  - `agentId`: only a builtin agent. It is what makes the spawn's hook env agent-aware
//    (`hookServer.buildPtyEnv`: `NODETERM_AGENT_ID`, the hook-reply wait for Claude, the
//    canvas-control grant `canControlCanvas` decides) — a session created without it keeps its
//    bare env for life, because tmux reads `-e` only when a session is created.
//  - `ownerProjectId` (A72): the pane-ownership ledger's owner (`agents/pane-ownership.ts`). It is
//    the index ENTRY id the lookup just matched — the machine-local id the canvas passes as its own
//    `ownerProjectId`, and the id agent messaging compares against — so a phone-started pane is
//    provably owned by the project it was created in, exactly like a canvas-started one. A cloned
//    project gets a fresh entry id, so this can never name a git-shared file id.
//
// Every value applies only when the attach CREATES the session (the relay host decides that from
// this machine's own `sessionExists` probe); a join changes nothing.

import { BUILTIN_AGENT_IDS, type AgentId, type BuiltinAgentId } from '../../shared/agents/config'
import type { CanvasNodeState } from '../../shared/types'
import type { HostNewSessions } from './host-service'

export interface HostNewSessionsDeps {
  /** This machine's index, keyed by the machine-local entry id (`WorkspaceStore.projectTargetInfo`). */
  projectTargetInfo(projectId: string): { cwd?: string; ssh?: unknown } | null
  /** This machine's managed Claude accounts (settings.json — hand-editable, so re-checked here). */
  claudeAccounts(): ReadonlyArray<{ id: string; pending?: boolean; host?: string }>
  /** Saved host canvases, with portable node cwds resolved by WorkspaceStore. */
  persistedCanvases?(): ReadonlyArray<{ id: string; nodes: ReadonlyArray<CanvasNodeState> }>
  /** Only saved custom agents may use this host's already configured custom-agent environment. */
  customAgents?(): ReadonlyArray<{ id: string; baseAgent?: string }>
}

export function createHostNewSessions(deps: HostNewSessionsDeps): HostNewSessions {
  const launch = (projectId: string, accountId?: string, agentId?: string, saved = false) => {
    const info = deps.projectTargetInfo(projectId)
    if (!info || info.ssh || !info.cwd) return null
    const custom = saved && agentId?.startsWith('custom:')
      ? deps.customAgents?.().find((a) => a.id === agentId)
      : undefined
    const agent = agentId && (BUILTIN_AGENT_IDS as readonly string[]).includes(agentId)
      ? (agentId as BuiltinAgentId)
      : custom ? (custom.id as AgentId) : undefined
    const account = accountId && (agent === 'claude' || custom?.baseAgent === 'claude') &&
      deps.claudeAccounts().some((a) => a.id === accountId && !a.pending && !a.host)
      ? accountId : undefined
    return { cwd: info.cwd, ownerProjectId: projectId,
      ...(account ? { accountId: account } : {}), ...(agent ? { agentId: agent } : {}) }
  }
  return {
    resolve: ({ projectId, accountId, agentId }) => launch(projectId, accountId, agentId),
    resolveNode: (nodeId) => {
      const matches = deps.persistedCanvases?.().flatMap((p) =>
        p.nodes.filter((n) => n.id === nodeId).map((node) => ({ projectId: p.id, node }))) ?? []
      if (!matches.length) return undefined
      // Ambiguous clones, nonterminals and standalone remote terminals cannot claim a local pane.
      if (matches.length !== 1) return null
      const { projectId, node } = matches[0]
      if (node.kind !== 'terminal' || node.ssh || node.sshRemoteTmux) return null
      const resolved = launch(projectId, node.accountId, node.agentId, true)
      return resolved ? { ...resolved, cwd: node.cwd || resolved.cwd } : null
    }
  }
}
