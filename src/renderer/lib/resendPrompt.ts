import { isShellCommand } from '@shared/agents/pane'
import type { AgentState } from '@shared/agents/normalize'
import { TEXT_NOT_SUBMITTED, type TextDeliveryResult } from '@shared/text-delivery'
import { resendText, type NodePrompt } from '@shared/node-prompts'

export interface ResendDeps {
  /** The agent's last hook-reported state, or undefined when nothing has reported this run. */
  agentState(nodeId: string): AgentState | undefined
  /** The foreground command of the node's pane; null = not observed. */
  paneCommand(nodeId: string): Promise<string | null>
  /** Types the text into the node's session and submits it. `'pasted-not-submitted'` means the text
   *  may already be in the pane with no confirmation it was submitted — never retried, never "sent". */
  sendText(nodeId: string, text: string): Promise<TextDeliveryResult>
}

export type ResendOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Send a prompt the person already typed into this node again. Typing into a session is the one
 * thing here that can do damage if aimed wrong, so each refusal is a case where the same keystrokes
 * would land somewhere other than the agent's input:
 *  - `blocked`: a permission prompt is up and typed text would ANSWER it (the same reason an
 *    in-place agent restart refuses a blocked node);
 *  - a shell owns the pane: the agent has quit, and the prompt would run as a shell command;
 *  - the pane could not be read: unknown is never read as "safe to type".
 * A refusal says why, so the click is never silent.
 */
export async function resendPrompt(
  nodeId: string,
  prompt: NodePrompt,
  deps: ResendDeps
): Promise<ResendOutcome> {
  const text = resendText(prompt)
  if (text === null) {
    return { ok: false, reason: 'That prompt was too long to keep, so it cannot be sent again.' }
  }
  if (deps.agentState(nodeId) === 'blocked') {
    return { ok: false, reason: 'This session is waiting on a permission prompt — answer that first.' }
  }
  const command = await deps.paneCommand(nodeId)
  if (command === null) {
    return { ok: false, reason: 'Could not tell what is running in this node, so nothing was sent.' }
  }
  if (isShellCommand(command)) {
    return { ok: false, reason: 'The agent is not running in this node (a shell is) — restart it first.' }
  }
  const delivered = await deps.sendText(nodeId, text)
  if (delivered === true) return { ok: true }
  if (delivered === 'pasted-not-submitted') return { ok: false, reason: TEXT_NOT_SUBMITTED }
  return { ok: false, reason: 'Could not send the prompt to this node.' }
}
