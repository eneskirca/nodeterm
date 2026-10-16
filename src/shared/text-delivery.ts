/** A partial or transport-uncertain paste must never be retried or represented as submitted. */
export type TextDeliveryResult = boolean | 'pasted-not-submitted'
export const TEXT_NOT_SUBMITTED = 'Text may already be pasted, but submission could not be confirmed. Do not resend it. Inspect the terminal before taking further action.'

/**
 * The ⌘M chat view's send was refused BEFORE anything was written: the agent's own UI owns the
 * keyboard (shared/agents/claude-screen.ts). `dialog` is the dialog's text when one was recognized,
 * `null` when the input box is simply not on screen. The draft is untouched — nothing reached the pane.
 */
export interface ChatPromptBlocked {
  blocked: 'screen'
  dialog: string | null
}
/** What a chat-view send answers: a text delivery, or a refusal before writing. */
export type ChatPromptResult = TextDeliveryResult | ChatPromptBlocked
export const isChatPromptBlocked = (r: ChatPromptResult): r is ChatPromptBlocked =>
  typeof r === 'object' && r !== null && r.blocked === 'screen'

/**
 * Why a write that must land only in an EMPTY composer (`pty.sendToEmptyPrompt` — the context-link
 * and note-link pushes, issue #1144) was not made. Every refusal is decided before a byte is written,
 * except `not-submitted` (typed, but the Enter was withheld) and `failed` (the transport refused).
 * - `unsupported` — no measured reader for this agent's composer, so emptiness cannot be proven.
 * - `draft` — the composer already holds the user's text.
 * - `no-prompt` — a dialog owns the keyboard, or no input box is on screen (a shell, a starting CLI).
 * - `unknown` — the screen could not be read.
 */
export type EmptyPromptRefusal = 'unsupported' | 'draft' | 'no-prompt' | 'unknown' | 'not-submitted' | 'failed'
export type EmptyPromptResult = { sent: true } | { sent: false; reason: EmptyPromptRefusal }
