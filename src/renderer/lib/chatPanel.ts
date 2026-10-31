import { agentConfig, type AgentId } from '@shared/agents/config'
import type { ChatMessage, CustomAgent } from '@shared/types'

/**
 * Pure decisions behind the ⌘M chat panel (`nodes/ChatPanel.tsx`), kept out of the component so
 * each is unit-tested without a DOM.
 */

export type ChatKeyAction = 'send' | 'newline' | 'none'

/**
 * What a keydown in the composer means. Enter sends; Shift+Enter is left to the textarea's own
 * default (a newline) — it used to SEND, because every Enter was swallowed. An Enter that commits
 * an IME composition (Japanese, Chinese, Korean input) is the user picking a candidate, not
 * submitting: sending there would ship a half-typed message. The glue passes
 * `nativeEvent.isComposing || keyCode === 229` (Safari reports the commit keydown only by 229).
 */
export function chatKeyAction(e: { key: string; shiftKey: boolean; isComposing: boolean }): ChatKeyAction {
  if (e.key !== 'Enter' || e.isComposing) return 'none'
  return e.shiftKey ? 'newline' : 'send'
}

/** How close to the bottom (px) still counts as "following" the conversation. */
export const CHAT_FOLLOW_THRESHOLD_PX = 48

/**
 * How many messages came in after `lastSeen`, the newest message on screen when the view stopped
 * following. A keyed message is found by its key (a tail reload re-creates the objects), an unkeyed
 * one by identity. Not found — the thread was replaced — counts as nothing new rather than a guess.
 */
export function unseenAfter(messages: readonly ChatMessage[], lastSeen: ChatMessage | null): number {
  if (lastSeen === null) return 0
  const at =
    lastSeen.key !== undefined
      ? messages.findIndex((m) => m.key === lastSeen.key)
      : messages.indexOf(lastSeen)
  return at === -1 ? 0 : messages.length - 1 - at
}

export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = CHAT_FOLLOW_THRESHOLD_PX
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * Pin to the newest message after a load only when the user was already following it, or has
 * just sent one (they expect to see it land). A user scrolled up reading an earlier answer keeps
 * their place — every turn-finish reload used to yank them to the bottom.
 */
export function shouldFollowOnLoad(s: { wasNearBottom: boolean; justSent: boolean }): boolean {
  return s.wasNearBottom || s.justSent
}

/**
 * The word the composer uses for this node's agent: the builtin label, else the custom agent's
 * own label (a custom agent with `baseAgent: 'claude'` reaches this panel too), else a neutral
 * 'Agent' — never "Claude" by default, which is how a grok node came to say "Message Claude…".
 */
export function chatAgentLabel(
  agentId: AgentId,
  customAgents: readonly Pick<CustomAgent, 'id' | 'label'>[]
): string {
  const builtin = agentConfig(agentId)?.label
  if (builtin) return builtin
  const custom = customAgents.find((c) => c.id === agentId)?.label?.trim()
  return custom || 'Agent'
}

/**
 * The caption of an expanded tool card (a tool part that carries a readable `body` — see
 * `core/chat-tool-body.ts`). Named for what the user is reading, not for the plumbing that carried
 * it; an unknown tool with a body falls back to its own name.
 */
export function toolCardTitle(name: string): string {
  if (name === 'ExitPlanMode') return 'Plan'
  if (name === 'AskUserQuestion') return 'Question'
  return name
}
