// The ⌘M thread's Focus view (`settings.chatFocusView`) and its todo-list rule. No React — see
// ChatPanel.tsx for the glue and chatFocus.test.ts for the pins.
//
// Focus view keeps what a person reads — the prompts, the answers, the images, the cards that ask
// something of them — and drops the agent's plumbing: tool chips (diff chips included) and thinking.
// A plan / question card is never plumbing: it carries the answer controls of a held request, and
// hiding it would leave the composer pointing at a card that is not there.
import type { ChatMessage, ChatPart } from '@shared/types'

/** The agent's todo-list tool (claude's `TodoWrite`). */
export const TODO_WRITE_TOOL = 'TodoWrite'

/** The index of the LAST message holding a `TodoWrite` card (a part with a `body` — the opt-in
 *  `rich` read), else -1. Only that list is current: each call rewrites the whole list. */
export function latestTodoIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].parts.some((p) => p.kind === 'tool' && p.name === TODO_WRITE_TOOL && p.body !== undefined)) return i
  }
  return -1
}

/** A `TodoWrite` part that is not in the latest todo message: a superseded list, which the thread
 *  draws as the plain chip in both views (a dozen full lists in one turn is the wall Focus removes). */
export function staleTodo(p: ChatPart, messageIndex: number, latestTodo: number): boolean {
  return p.kind === 'tool' && p.name === TODO_WRITE_TOOL && messageIndex !== latestTodo
}

/** Whether Focus view leaves this part out: thinking, a tool call without a `body` (the chip), and a
 *  superseded todo list. Text, an image and every other card stay. */
export function focusHides(p: ChatPart, messageIndex: number, latestTodo: number): boolean {
  if (p.kind === 'thinking') return true
  if (p.kind !== 'tool') return false
  return p.body === undefined || staleTodo(p, messageIndex, latestTodo)
}
