// The ⌘M thread's todo-list rule: only the LATEST `TodoWrite` list is a card, every older one is
// drawn as its plain chip (a dozen full lists in one turn is a wall). No React — see ChatPanel.tsx
// and lib/chatToolGroups.ts for the glue and chatTodo.test.ts for the pins.
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
 *  draws as the plain chip. */
export function staleTodo(p: ChatPart, messageIndex: number, latestTodo: number): boolean {
  return p.kind === 'tool' && p.name === TODO_WRITE_TOOL && messageIndex !== latestTodo
}
