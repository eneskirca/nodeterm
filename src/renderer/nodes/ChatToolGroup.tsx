import type { ChatMessage, ChatPart } from '@shared/types'
import { memberKey, toolGroupSummary, type ToolGroup } from '../lib/chatToolGroups'

export interface ChatToolGroupProps {
  messages: readonly ChatMessage[]
  group: ToolGroup
  /** ChatPanel's own part renderer, so a call inside the block is the same chip it is outside. */
  renderPart(p: ChatPart, message: number, part: number, key: string): JSX.Element
}

/**
 * A run of consecutive tool calls in the ⌘M thread, folded into one block that is closed by
 * default and opens to the individual chips (lib/chatToolGroups.ts decides the runs).
 *
 * A native `<details>`, uncontrolled: ChatPanel keys it by the run's first line, so it stays the
 * same element while the run grows and keeps whatever the user opened or closed.
 */
export function ChatToolGroup({ messages, group, renderPart }: ChatToolGroupProps): JSX.Element {
  const { count, names } = toolGroupSummary(messages, group)
  return (
    <details className="term-chat__tool-group">
      <summary>
        <span className="term-chat__tool-group-count">{count}</span>
        <span className="term-chat__tool-group-names">{names}</span>
      </summary>
      <div className="term-chat__tool-group-body">
        {group.members.map((member) => {
          const p = messages[member.message]?.parts[member.part]
          // Keyed by the source line, like the thread's bubbles: a prepended page shifts every
          // position, and a position key would remount each chip and close whatever was open.
          return p ? renderPart(p, member.message, member.part, memberKey(messages, member)) : null
        })}
      </div>
    </details>
  )
}
