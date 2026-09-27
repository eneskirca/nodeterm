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
/** What a chat-view send answers: a text delivery, or a refusal before typing. */
export type ChatPromptResult = TextDeliveryResult | ChatPromptBlocked
export const isChatPromptBlocked = (r: ChatPromptResult): r is ChatPromptBlocked =>
  typeof r === 'object' && r !== null && r.blocked === 'screen'
