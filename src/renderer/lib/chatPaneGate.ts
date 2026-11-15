// The chat send's KERNEL gate — the second half of "may the ⌘M composer / the phone type into this
// pane?", after `chatSendRefusal` (chatSendGate.ts).
//
// `chatSendRefusal` reads the agent-status store. A CLI that quits cleanly may announce it
// (SessionEnd → `sessionEnded`), but the store cannot be the proof:
//  - Codex and opencode announce NO session end (see SESSION_END_CAPABLE in shared/agents/config.ts):
//    after a deliberate `/quit` their last hook state is still `done`, and the store reads "at its
//    prompt".
//  - Agents that DO announce one only do so on a clean exit. Observed 2026-11-13: a Claude pane
//    was back at its shell (likely after its project was closed on the desktop; the store's exact
//    state then was not captured), yet a phone chat message passed the gate and was pasted into the
//    SHELL with an Enter — it ran as a command.
// So for EVERY agent the pane's foreground process group is asked (`isAgentPane`, the same
// positive, three-valued predicate the wake and delivery gates use) right before the send. The hook
// is a hint; the kernel is the proof. An unreadable pane refuses (`unverified`), never sends.
import { binariesFor, isAgentPane, type PaneOwner } from '@shared/agents/pane-owner-predicate'
import type { ChatSendReason } from '@shared/mobile-chat'

/** `exited` = the kernel answered and the agent is not in the pane; `unverified` = the pane could not
 *  be read (unknown is a refusal, never a licence). `null` = send. */
export type ChatPaneRefusal = 'exited' | 'unverified' | null

export async function chatPaneRefusal(
  agentId: string,
  nodeId: string,
  deps: {
    paneOwner(nodeId: string): Promise<PaneOwner | null>
    /** The settings' custom agents, so a `custom:<id>` on the codex harness can be named. */
    customAgents?: readonly { id: string; launchCmd: string; baseAgent?: string }[]
  }
): Promise<ChatPaneRefusal> {
  let owner: PaneOwner | null
  try {
    owner = await deps.paneOwner(nodeId)
  } catch {
    return 'unverified'
  }
  const verdict = isAgentPane(owner, agentId, binariesFor(agentId, deps.customAgents))
  return verdict === 'agent' ? null : verdict === 'not-agent' ? 'exited' : 'unverified'
}

/** The phone's reason (its union is locked — `mobile-chat.ts`): an unreadable pane is `unavailable`. */
export function chatPaneRefusalReason(r: Exclude<ChatPaneRefusal, null>): ChatSendReason {
  return r === 'exited' ? 'exited' : 'unavailable'
}

/** The desktop's toast for a refused send. It states what was measured, nothing more. */
export function chatPaneRefusalToast(r: Exclude<ChatPaneRefusal, null>, agentLabel: string): string {
  return r === 'exited'
    ? `${agentLabel} is no longer running in this terminal — the message was not sent.`
    : `Could not confirm ${agentLabel} is running in this terminal — the message was not sent.`
}
