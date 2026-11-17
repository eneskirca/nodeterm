import type { AgentState } from '@shared/agents/normalize'
import { sanitizeChatText } from '@shared/mobile-chat'
import { stripTerminalControls } from './terminalControls'

/**
 * "Add to chat": the pure half. Turns a selection into a markdown quote, appends it to a draft, and
 * decides where it may go. The effects (writing the draft, typing into the pane, the toasts) and the
 * dialog check on the agent's screen belong to the caller.
 *
 * Nothing here sends anything: a quote lands in the ⌘M composer's draft or, unsent, at the agent's
 * prompt, and the person presses Enter.
 */

/** Longest quote, in code points of the cleaned selection (before the `> ` prefixes). */
export const QUOTE_MAX_CHARS = 4000

/**
 * The selection as a markdown quote: terminal sequences and control characters removed (tab and
 * newline kept — the chat text rule, `sanitizeChatText`), leading and trailing blank lines and
 * trailing whitespace dropped, cut at `QUOTE_MAX_CHARS`, every line prefixed `> `, ending in one
 * blank line so what the person types next is not part of it. `null` when nothing is left — the
 * caller adds nothing.
 *
 * Not a full `trim`: the first line keeps its leading indentation, so quoted code keeps its
 * relative indent.
 *
 * Escape SEQUENCES are removed whole before the control-character rule runs: that rule drops only
 * the ESC byte, so a colour change would otherwise be quoted as `[31m`.
 */
export function buildQuote(raw: string): { quote: string; truncated: boolean } | null {
  const text = sanitizeChatText(stripTerminalControls(raw))
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()
  if (!text) return null
  const cut = cutCodePoints(text, QUOTE_MAX_CHARS)
  // A cut that lands just after a line break would end the quote on an empty `> ` line.
  const body = cut.truncated ? cut.text.trimEnd() : cut.text
  const quote = `${body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`
  return { quote, truncated: cut.truncated }
}

/** The first `max` code points of `text`; walks no further than the cut. */
function cutCodePoints(text: string, max: number): { text: string; truncated: boolean } {
  let count = 0
  let end = 0
  for (const ch of text) {
    if (count === max) return { text: text.slice(0, end), truncated: true }
    count++
    end += ch.length
  }
  return { text, truncated: false }
}

/** The draft with the quote after it: the quote alone for an empty draft, else one blank line between. */
export function appendQuoteToDraft(draft: string, quote: string): string {
  const kept = draft.trimEnd()
  return kept ? `${kept}\n\n${quote}` : quote
}

/** Where a quote goes: the node's ⌘M chat draft, or typed unsent at the agent's prompt. */
export type QuoteLeg = 'draft' | 'pane'

/** Why a quote went nowhere. `dialog` and `no-prompt` are decided by the caller from the agent's
 *  screen: a dialog owns the keyboard, or no input box is on screen at all. */
export type QuoteRefusal = 'not-agent' | 'agent-gone' | 'needs-answer' | 'dialog' | 'no-prompt'

export const QUOTE_REFUSAL_TEXT: Record<QuoteRefusal, string> = {
  'not-agent': 'This terminal has no agent to quote to.',
  'agent-gone': 'The agent is not running in this terminal.',
  'needs-answer': 'The agent is waiting for an answer. Answer it first.',
  dialog: 'A dialog is open in the terminal. Close it first.',
  'no-prompt': "The agent's input box is not on screen."
}

/**
 * Follow what the person is looking at. With the ⌘M chat view open the quote joins the draft,
 * whatever the agent is doing — a draft types nothing. With the terminal showing it is typed at the
 * prompt, which needs the agent's CLI in the pane and no question or approval waiting: text typed
 * into a dialog would answer it. `working` is allowed (typing into the box while a turn runs is
 * what a person does), and so is an unknown state. A refused pane leg is never redirected to the
 * hidden draft.
 */
export function planQuote(input: {
  chatOpen: boolean
  isAgent: boolean
  agentInPane: boolean
  state: AgentState | undefined
  held: boolean
}): { leg: QuoteLeg } | { refuse: QuoteRefusal } {
  if (!input.isAgent) return { refuse: 'not-agent' }
  if (input.chatOpen) return { leg: 'draft' }
  if (!input.agentInPane) return { refuse: 'agent-gone' }
  if (input.held || input.state === 'blocked' || input.state === 'waiting') return { refuse: 'needs-answer' }
  return { leg: 'pane' }
}
