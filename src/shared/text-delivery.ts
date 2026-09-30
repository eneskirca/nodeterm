/** A partial or transport-uncertain paste must never be retried or represented as submitted. */
export type TextDeliveryResult = boolean | 'pasted-not-submitted'
export const TEXT_NOT_SUBMITTED = 'Text may already be pasted, but submission could not be confirmed. Do not resend it. Inspect the terminal before taking further action.'

/**
 * The ⌘M chat view's send was refused BEFORE anything was typed: the agent's own UI owns the
 * keyboard (shared/agents/claude-screen.ts). `dialog` is the dialog's text when one was recognized,
 * `null` when the input box is simply not on screen. The draft is untouched — nothing reached the pane.
 */
export interface ChatPromptBlocked {
  blocked: 'screen'
  dialog: string | null
}
/**
 * Another typed delivery into the same pane is still in flight (a second view of the node — the
 * canvas panel and the kanban card modal, or a relay peer — sent at the same moment). Nothing was
 * typed; the draft stays for a resend. Distinct from `false` so the view does not read a moment's
 * contention as "this session cannot be written to" and go read-only.
 */
export interface ChatPromptBusy {
  blocked: 'busy'
}
export const CHAT_PROMPT_BUSY = 'Another message is still being typed into this session. Send again in a moment.'
/** What a chat-view send answers: a text delivery, or a refusal before typing. */
export type ChatPromptResult = TextDeliveryResult | ChatPromptBlocked | ChatPromptBusy
export const isChatPromptBlocked = (r: ChatPromptResult): r is ChatPromptBlocked =>
  typeof r === 'object' && r !== null && r.blocked === 'screen'
export const isChatPromptBusy = (r: ChatPromptResult): r is ChatPromptBusy =>
  typeof r === 'object' && r !== null && r.blocked === 'busy'
