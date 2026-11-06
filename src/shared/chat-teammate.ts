// What both the reader (core/chat-teammate.ts) and the ⌘M panel need to say about a teammate's
// idle notification.
import type { ChatTeammateIdle } from './types'

/** How an idle notification's outcome reads, as Claude Code's TUI words it ("Teammate @x finished").
 *  A notification that names no reason reads "finished", as it does in the TUI. */
export function idleOutcome(reason: ChatTeammateIdle['reason']): string {
  return reason === 'failed' ? 'failed' : reason === 'interrupted' ? 'was interrupted' : 'finished'
}
