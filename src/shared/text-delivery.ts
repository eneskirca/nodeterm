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

/**
 * Why Esc from the ⌘M chat view (`pty.interruptChat`) did not reach the agent. Every refusal is decided
 * before the Esc is written.
 * - `unsupported` — not an agent whose interrupt and screen we have measured (claude only).
 * - `dialog` — the agent's own dialog owns the keyboard (Esc would cancel it), or no input box is on
 *   screen. `dialog` carries its text when one was recognized.
 * - the rest are `sendPaneKeys`'s: the pane could not be reached or typed into.
 */
export type ChatInterruptRefusal = 'unsupported' | 'dialog' | 'not-connected' | 'unsupported-backend' | 'no-ssh' | 'failed'
/**
 * `restored` is the prompt Claude put back into its own input box when the Esc landed before the
 * reply started, taken back out of it (the box is cleared) so the chat view can put it in its own
 * composer. null when nothing was put back, or when it could not be taken out cleanly.
 */
export type ChatInterruptResult =
  | { sent: true; restored: string | null }
  | { sent: false; reason: ChatInterruptRefusal; dialog?: string | null }
