import { readsScreenDialogs, typesChatInput } from '@shared/agents/config'
import type { ChatDraftCarryRefusal, ChatDraftPutResult, ChatDraftTakeResult } from '@shared/text-delivery'
import { useChatDraft } from '../state/chatDraft'

// Carrying a half-typed draft across a ⌘M flip, so it is in front of the user on the side they
// switched to. The draft MOVES (core empties the side it leaves), so it is never sent twice.
// - chat → terminal: the chat draft is typed into the agent's EMPTY input box, unsent.
// - terminal → chat: a terminal draft that can be read back exactly (one row, no collapsed paste)
//   comes into the EMPTY chat composer; anything else stays in the terminal and the composer says why.
// Only on the user's own flip (⌘M, the header toggle). A flip the composer makes itself (a `/model`
// label, an interactive built-in) carries nothing: a picker has just opened there.
// Claude only, as the core side is (its composer is measured).

export type DraftCarryPty = {
  putChatDraft(nodeId: string, agentId: string, text: string): Promise<ChatDraftPutResult>
  takeChatDraft(nodeId: string, agentId: string): Promise<ChatDraftTakeResult>
}

/** How long a flip to the terminal waits for the draft to be typed before flipping anyway. */
export const CARRY_TO_TERMINAL_WAIT_MS = 1500

export function carriesDraft(agentId: string | undefined | null): agentId is string {
  return typeof agentId === 'string' && readsScreenDialogs(agentId) && typesChatInput(agentId)
}

const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

/** What the composer says when a terminal draft stayed where it was. null = say nothing. */
export function stayedInTerminalNote(reason: ChatDraftCarryRefusal): string | null {
  const stillThere = 'Your draft is still available in the terminal.'
  switch (reason) {
    case 'multi-line':
      return `Multiline draft messages can't be copied from the terminal to chat view. ${stillThere}`
    case 'placeholder':
      return `Drafts with pasted text or images can't be copied from the terminal to chat view. ${stillThere}`
    case 'not-prompt':
      return `Shell-mode drafts can't be copied from the terminal to chat view. ${stillThere}`
    case 'not-cleared':
      return "Your draft couldn't be copied from the terminal to chat view. Check the terminal before sending: part of it may have been cleared."
    default:
      return null
  }
}

/** What the toast says when a chat draft did not move to the terminal. null = say nothing. */
export function stayedInChatMessage(reason: ChatDraftCarryRefusal): string | null {
  switch (reason) {
    case 'has-draft':
      return 'Your chat draft is still in the chat view: the terminal already has a draft.'
    case 'unconfirmed':
      return 'Your chat draft may not have reached the terminal. It is still in the chat view; check the terminal before sending either.'
    case 'empty':
    case 'unsupported':
      return null
    default:
      return "Your chat draft couldn't be moved to the terminal. It is still in the chat view."
  }
}

/**
 * Chat → terminal, run BEFORE the view flips: the draft is being typed into the pane, and typing in
 * the terminal at the same time would interleave with it. Waits at most CARRY_TO_TERMINAL_WAIT_MS;
 * a put still running after that keeps going, and its result is applied when it lands.
 */
export async function carryDraftToTerminal(pty: DraftCarryPty, nodeId: string, agentId: string | undefined): Promise<void> {
  if (!carriesDraft(agentId)) return
  const draft = useChatDraft.getState().drafts[nodeId] ?? ''
  if (draft.trim() === '') return
  const put = pty.putChatDraft(nodeId, agentId, draft).catch((): ChatDraftPutResult => ({ put: false, reason: 'failed' }))
  const settled = put.then((r) => {
    if (r.put) {
      // Only the draft that was typed: a draft changed meanwhile is the user's newer text.
      useChatDraft.getState().setDraft(nodeId, (cur) => (cur === draft ? '' : cur))
      return
    }
    const message = stayedInChatMessage(r.reason)
    if (message !== null) toast(message)
  })
  await Promise.race([settled, new Promise<void>((r) => setTimeout(r, CARRY_TO_TERMINAL_WAIT_MS))])
}

/** Terminal → chat, run AFTER the view flips: the chat composer fills in when the take lands. */
export async function carryDraftToChat(pty: DraftCarryPty, nodeId: string, agentId: string | undefined): Promise<void> {
  if (!carriesDraft(agentId)) return
  // Two drafts are never merged: a chat draft already waiting wins, and the terminal keeps its own.
  if ((useChatDraft.getState().drafts[nodeId] ?? '') !== '') return
  const r = await pty.takeChatDraft(nodeId, agentId).catch((): ChatDraftTakeResult => ({ taken: false, reason: 'failed' }))
  const store = useChatDraft.getState()
  if (r.taken) {
    // Typed into the composer while the take ran: the taken text goes first, as it was older.
    store.setDraft(nodeId, (cur) => (cur === '' ? r.text : `${r.text}\n${cur}`))
    return
  }
  const note = stayedInTerminalNote(r.reason)
  if (note !== null) store.setNote(nodeId, note)
}
