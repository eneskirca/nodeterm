/**
 * Shared "Transfer conversation to" menu builder.
 *
 * Previously the transfer-target list was built inline inside `selectionItems` in Canvas.tsx (the
 * canvas node right-click menu). The sessions-sidebar row right-click wanted the SAME submenu, so
 * the list-building is extracted here and consumed by both — one definition, two surfaces.
 *
 * `transferTargets` is pure (no React, no stores) so it unit-tests cleanly; the caller reads the
 * live settings/agent-status stores and passes the values in.
 */
import type { AgentId } from '@shared/agents/config'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, canTransferFrom } from '@shared/agents/config'
import type { CustomAgent } from '@shared/types'
import type { MenuItem } from '../components/ContextMenu'
import { AgentIcon } from './agentIcons'

/** A transfer target: every enabled agent EXCEPT the source (you can't transfer a session to its
 *  own agent kind — the handoff is cross-agent). */
export interface TransferTarget {
  id: AgentId
  label: string
}

/**
 * The list of agents a conversation from `sourceAgentId` can be transferred to: every enabled
 * builtin except the source, plus every enabled custom agent except the source. Pure — the caller
 * supplies the live `disabledAgents` list and `customAgents` from settings.
 */
export function transferTargets(
  sourceAgentId: AgentId,
  disabledAgents: readonly AgentId[],
  customAgents: readonly CustomAgent[]
): TransferTarget[] {
  return [
    ...BUILTIN_AGENT_IDS.filter((aid) => aid !== sourceAgentId && !disabledAgents.includes(aid)).map(
      (aid) => ({ id: aid as AgentId, label: AGENT_CONFIG[aid].label })
    ),
    ...customAgents
      .filter((c) => c.id !== sourceAgentId && !disabledAgents.includes(c.id))
      .map((c) => ({ id: c.id, label: c.label }))
  ]
}

/** The args a caller has already resolved for a node; the builder does no store reads itself. */
export interface TransferConversationArgs {
  /** The node's agent (`agentIdOf(nodeId)`), or `undefined` if it isn't an agent node. */
  sourceAgentId: AgentId | undefined
  /** The node's live session id from the agent-status store, or `undefined` if not yet known. */
  sessionId: string | undefined
  /** Live settings lists. */
  disabledAgents: readonly AgentId[]
  customAgents: readonly CustomAgent[]
}

/**
 * Build the "Transfer conversation to" menu block (a label + one item per target), or `[]` when
 * the node can't be a transfer source (not a transfer-capable agent, or no session id yet).
 *
 * @param nodeId   the source node — passed to `handler` as the first arg.
 * @param at       cursor position (passed through to the handler, which places the new node).
 * @param args     the resolved gate values (see {@link TransferConversationArgs}).
 * @param handler  Canvas's `transferConversation(sourceNodeId, targetAgentId, at?)`.
 */
export function transferConversationItems(
  nodeId: string,
  at: { x: number; y: number } | undefined,
  args: TransferConversationArgs,
  handler: (sourceNodeId: string, targetAgentId: AgentId, at?: { x: number; y: number }) => void
): MenuItem[] {
  const { sourceAgentId, sessionId, disabledAgents, customAgents } = args
  // Gate: single node, a transfer-capable agent, and a live session id (the handoff reads the
  // transcript by session id — no id means the conversation isn't ready to hand off yet).
  if (!sourceAgentId || !sessionId || !canTransferFrom(sourceAgentId)) return []
  const targets = transferTargets(sourceAgentId, disabledAgents, customAgents)
  if (targets.length === 0) return []
  return [
    { type: 'label', label: 'Transfer conversation to' },
    ...targets.map(
      (tg): MenuItem => ({
        label: tg.label,
        icon: <AgentIcon agentId={tg.id} />,
        onClick: () => void handler(nodeId, tg.id, at)
      })
    )
  ]
}
