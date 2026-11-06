/**
 * The two texts Claude Code writes as a USER record when the user interrupts a turn (Esc, or
 * Ctrl+C once). A CLOSED set: measured on 2.1.285 (`__fixtures__/claude/interrupt-capture.json`) —
 * `[Request interrupted by user]` after streamed text, `… for tool use]` when a tool call or its
 * permission dialog was cancelled. Any other wording is ignored, so a future CLI that words it
 * differently degrades to what happened before this existed, never to a guess.
 *
 * Read by the context tail (an interrupt ends the turn: core/context-tail.ts) and by the ⌘M chat
 * parser (drawn as Claude's own "Interrupted" line, not as a message the user typed).
 */
export const CLAUDE_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]'
])

/** The marker for an interrupt that cancelled a tool call (or its permission dialog). */
export const CLAUDE_TOOL_INTERRUPT_MARKER = '[Request interrupted by user for tool use]'

/** A record's `message.content` is exactly one interrupt marker. */
export function claudeInterruptMarkerOf(content: unknown): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null
  const part = content[0] as { type?: unknown; text?: unknown } | null
  if (part?.type !== 'text' || typeof part.text !== 'string') return null
  return CLAUDE_INTERRUPT_MARKERS.has(part.text) ? part.text : null
}
