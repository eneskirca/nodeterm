/**
 * Shared "Transfer conversation to" menu builder.
 *
 * Previously the transfer-target list was built inline inside `selectionItems` in Canvas.tsx (the
 * canvas node right-click menu). The sessions-sidebar row right-click wanted the SAME submenu, so
 * the list-building is extracted here and consumed by both — one definition, two surfaces.
 *
 * Each transfer target that is **model-discovery-capable** (`canSwitchModel`, base-resolved — so a
 * claude-base custom agent qualifies) becomes a NESTED submenu: the agent's default model, plus one
 * row per discovered gateway model, mirroring the "Switch model" submenu's children. A non-capable
 * target (e.g. gemini, grok) stays a flat row — it has no model grammar, so there is nothing to
 * pick. `transferTargets` and the nesting are pure (no React, no stores) so they unit-test cleanly;
 * the caller reads the live settings/agent-status/gateway stores and passes the values in.
 */
import type { AgentId } from '@shared/agents/config'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  canTransferFrom,
  MODEL_SWITCH_CAPABLE
} from '@shared/agents/config'
import type { GatewayModel } from '@shared/agents/model-gateway'
import type { CustomAgent } from '@shared/types'
import { resolveAgentBase } from '@shared/agents/custom-agent'
import type { MenuItem } from '../components/ContextMenu'
import { AgentIcon } from './agentIcons'

/**
 * Resolve an agent's base harness from the records passed in, WITHOUT the runtime's injected
 * capability resolver (which reads the live settings store and so is unavailable in a pure test).
 * A builtin is its own base; a custom agent's base is its declared `baseAgent`. `undefined` for a
 * baseless custom or an unknown id. Mirrors `reopenVariants.baseOf`.
 */
function baseOf(id: AgentId, customAgents: readonly CustomAgent[]): string | undefined {
  return resolveAgentBase(id, customAgents.find((c) => c.id === id))
}

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
  /** Discovered gateway models, for the nested model submenus on switch-capable targets. Empty when
   *  the gateway is unconfigured/still loading — those targets then render as flat rows (transfer
   *  with the agent's default model), since transfer-without-model is still useful. */
  gatewayModels: readonly GatewayModel[]
  /** True when the source is a relay session — its gateway lives on another machine, so the local
   *  model list does not apply. Switch-capable targets render as flat rows (no model submenu). */
  relaySession?: boolean
}

/** Canvas's `transferConversation(sourceNodeId, targetAgentId, at?, model?)`. */
export type TransferConversationHandler = (
  sourceNodeId: string,
  targetAgentId: AgentId,
  at?: { x: number; y: number },
  model?: string
) => void

/**
 * Build the "Transfer conversation to" menu block (a label + one entry per target), or `[]` when
 * the node can't be a transfer source (not a transfer-capable agent, or no session id yet).
 *
 * A switch-capable target with discovered models becomes a submenu: a "Default model" row (transfer
 * with no `--model`) plus one row per gateway model. A non-capable target, a relay source, or a
 * target with no discovered models yet stays a flat row — there is nothing to pick.
 *
 * @param nodeId   the source node — passed to `handler` as the first arg.
 * @param at       cursor position (passed through to the handler, which places the new node).
 * @param args     the resolved gate values (see {@link TransferConversationArgs}).
 * @param handler  Canvas's `transferConversation`.
 */
export function transferConversationItems(
  nodeId: string,
  at: { x: number; y: number } | undefined,
  args: TransferConversationArgs,
  handler: TransferConversationHandler
): MenuItem[] {
  const { sourceAgentId, sessionId, disabledAgents, customAgents, gatewayModels, relaySession } = args
  // Gate: single node, a transfer-capable agent, and a live session id (the handoff reads the
  // transcript by session id — no id means the conversation isn't ready to hand off yet).
  if (!sourceAgentId || !sessionId || !canTransferFrom(sourceAgentId)) return []
  const targets = transferTargets(sourceAgentId, disabledAgents, customAgents)
  if (targets.length === 0) return []
  return [
    { type: 'label', label: 'Transfer conversation to' },
    ...targets.map((tg): MenuItem => {
      // A model submenu only for a switch-capable target with discovered models, and never for a
      // relay source (its gateway is on another machine). Capability is resolved from the passed-in
      // `customAgents` (base-resolved, so a claude-base custom agent qualifies) rather than the
      // runtime's injected resolver, so this stays pure and testable. gemini/grok and baseless
      // customs stay flat — no model grammar. The gateway is shared across harnesses, so the full
      // model list applies to any capable target.
      const base = baseOf(tg.id, customAgents)
      const capable = !!base && (MODEL_SWITCH_CAPABLE as readonly string[]).includes(base)
      const models = capable && !relaySession ? (gatewayModels as GatewayModel[]) : []
      if (models.length === 0) {
        return {
          label: tg.label,
          icon: <AgentIcon agentId={tg.id} />,
          onClick: () => void handler(nodeId, tg.id, at)
        }
      }
      return {
        type: 'submenu',
        label: tg.label,
        icon: <AgentIcon agentId={tg.id} />,
        children: [
          // The agent's own default model — transfer with no `--model` flag.
          {
            label: 'Default model',
            onClick: () => void handler(nodeId, tg.id, at)
          },
          ...models.map(
            (m): MenuItem => ({
              label: m.id,
              onClick: () => void handler(nodeId, tg.id, at, m.id)
            })
          )
        ]
      }
    })
  ]
}
