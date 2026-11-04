// "Send to agent": the pull node's message reaches the picked agent through the ⌘M chat view's own
// send path (the same gates, in the same order: the agent's state, the pane owner, then core's
// screen-checked `pty.sendChatPrompt`, held under the per-node restart lock). A user click is the
// only caller; nothing here writes to GitHub.

import { TEXT_NOT_SUBMITTED, isChatPromptBlocked, type ChatPromptResult } from '@shared/text-delivery'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'
import { chatSendMode, canQueue, type ChatGateStatus } from './chatSendGate'
import { chatPaneRefusal, chatPaneRefusalToast } from './chatPaneGate'
import { linkedAgents } from '../state/pullAgent'

type FlowNode = { id: string; type?: string; data: { title?: unknown; agentId?: unknown } }

export interface PullFeedbackSendDeps {
  /** The canvas as it is at the click: the target must still be joined to the pull node. */
  edges(): readonly { source: string; target: string }[]
  nodes(): readonly FlowNode[]
  /** A relay tab: the pane is another person's machine. */
  relay: boolean
  status(nodeId: string): ChatGateStatus
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  /** The settings' custom agents, so a custom agent's pane can be recognized (as in the chat view). */
  customAgents: readonly { id: string; launchCmd: string; baseAgent?: string }[]
  sendChatPrompt(nodeId: string, text: string, agentId: string): Promise<ChatPromptResult>
  /** `guardConcurrentRestart`: 'not-eligible' while a restart or wake holds the node. */
  guard(nodeId: string, run: () => Promise<'done'>): Promise<'done' | 'not-eligible'>
}

/** Why "Send to agent" is off in a relay tab: the pane is another person's machine. */
export const SEND_TO_RELAY_TEXT = 'Send to agent is not available in a relay tab.'

/** Null = sent; else the sentence the node shows. */
export async function sendPullFeedback(
  deps: PullFeedbackSendDeps,
  req: { pullId: string; targetId: string; message: string }
): Promise<string | null> {
  if (deps.relay) return SEND_TO_RELAY_TEXT
  const target = linkedAgents(deps.edges(), deps.nodes(), req.pullId).find((agent) => agent.id === req.targetId)
  const agentId = deps.nodes().find((n) => n.id === req.targetId)?.data.agentId
  if (!target || typeof agentId !== 'string') return 'That agent is no longer linked to this pull node. Nothing was sent.'
  return sendToAgentNode(deps, { id: target.id, title: target.title, agentId }, req.message)
}

/** Everything a single send needs besides the pull node's links. */
export type AgentSendDeps = Omit<PullFeedbackSendDeps, 'edges' | 'nodes' | 'relay'>

/** One message to one agent node through the chat view's gates. Null = sent; else the sentence to show. */
export async function sendToAgentNode(
  deps: AgentSendDeps,
  target: { id: string; title: string; agentId: string },
  message: string
): Promise<string | null> {
  const { agentId } = target
  const mode = chatSendMode(agentId, deps.status(target.id))
  if (mode === null || (mode === 'queue' && !canQueue(message))) {
    return `${target.title} cannot take a message right now (busy, asking you something, or not running). Nothing was sent.`
  }
  const pane = await chatPaneRefusal(agentId, target.id, { paneOwner: deps.paneOwner, customAgents: deps.customAgents })
  if (pane) return chatPaneRefusalToast(pane, target.title)
  // The guard's outcome is a word, so the delivery result rides out beside it.
  let result = false as ChatPromptResult
  const held = await deps.guard(target.id, async () => {
    result = await deps.sendChatPrompt(target.id, message, agentId)
    return 'done' as const
  })
  if (held === 'not-eligible') return `${target.title} is restarting or waking. Nothing was sent. Try again in a moment.`
  if (isChatPromptBlocked(result)) return `${target.title} has a dialog or no input box on screen. Nothing was sent.`
  if (result === 'pasted-not-submitted') return TEXT_NOT_SUBMITTED
  return result === true ? null : `The message could not be written to ${target.title}.`
}
