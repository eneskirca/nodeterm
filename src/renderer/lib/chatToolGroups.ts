// Which tool calls the ⌘M thread folds into one collapsed block (ChatPanel). No React — see
// ChatPanel.tsx for the glue and chatToolGroups.test.ts for the pins.
//
// The agent's TUI collapses a run of tool calls into one line ("ran 3 shell commands") and prints
// its thinking-out-loud lines between those runs. The thread used to show every call as its own
// chip, so a busy turn read as a wall of `Bash` / `Read` with the text that explains it buried in
// between. A run is folded into one block, closed by default, that opens to the same chips.
import type { ChatMessage, ChatPart } from '@shared/types'
import { isSystemRecordMessage } from '@shared/chat-system-records'
import { isLocalCommandTool } from '@shared/chat-command'

/** Fewer calls than this stay as plain chips: a block holding one chip only adds a click. */
export const TOOL_GROUP_MIN = 2

/** How many tool names the closed block lists before "+N more". */
export const TOOL_GROUP_NAMES_SHOWN = 3

export interface ToolGroupMember {
  message: number
  part: number
}

export interface ToolGroup {
  /** Stable while the run grows: the first member's line offset (paged reads) or position. */
  key: string
  members: ToolGroupMember[]
}

export interface ToolGroupLayout {
  /** `${message}:${part}` of a group's FIRST member → the group, drawn in that member's place. */
  groupAt: Map<string, ToolGroup>
  /** Every other member: drawn inside its group, not at its own place. */
  absorbed: Set<string>
}

export const partPosition = (message: number, part: number): string => `${message}:${part}`

/**
 * A tool call the agent made, shown as a chip. Not one:
 * - a plan / question card (`body`): that IS the content, never folded away;
 * - the user's own `/command`, `!` line or command output: the person did that, not the agent;
 * - a system record (a background task finishing, another agent's message): it is not the agent's
 *   work either, and the thread already treats it as a turn boundary.
 */
function isFoldableTool(p: ChatPart): boolean {
  return p.kind === 'tool' && p.body === undefined && !isLocalCommandTool(p.name)
}

/**
 * The runs of consecutive tool calls, across message boundaries: a transcript writes each call as
 * its own line, so the thread holds one message per call. A run ends at anything else in the thread
 * — text, a thinking summary, a card, a user message, a system record — exactly where the TUI starts
 * a new line. Runs shorter than `TOOL_GROUP_MIN` stay as chips.
 */
export function groupToolCalls(messages: readonly ChatMessage[]): ToolGroupLayout {
  const groupAt = new Map<string, ToolGroup>()
  const absorbed = new Set<string>()
  let run: ToolGroupMember[] = []
  const flush = (): void => {
    if (run.length >= TOOL_GROUP_MIN) {
      const first = run[0]
      const key = messages[first.message].key
      groupAt.set(partPosition(first.message, first.part), {
        key: key !== undefined ? `k${key}:${first.part}` : `i${first.message}:${first.part}`,
        members: run
      })
      for (const m of run.slice(1)) absorbed.add(partPosition(m.message, m.part))
    }
    run = []
  }
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || isSystemRecordMessage(m)) {
      flush()
      return
    }
    m.parts.forEach((p, j) => {
      if (isFoldableTool(p)) run.push({ message: i, part: j })
      else flush()
    })
  })
  flush()
  return { groupAt, absorbed }
}

/**
 * The closed block's one line: how many calls, then which tools, most-used first (ties in the order
 * they ran), e.g. `5 tool calls` / `Bash ×3, Read, Edit`. The names are the agent's own tool names,
 * not verbs, so the line reads the same for every agent.
 */
export function toolGroupSummary(
  messages: readonly ChatMessage[],
  group: ToolGroup
): { count: string; names: string } {
  const counts = new Map<string, number>()
  for (const { message, part } of group.members) {
    const p = messages[message]?.parts[part]
    if (p?.kind !== 'tool') continue
    counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  }
  // `Map` keeps first-run order, and `sort` is stable, so ties keep it.
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const shown = ranked.slice(0, TOOL_GROUP_NAMES_SHOWN).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  const hidden = ranked.length - shown.length
  const n = group.members.length
  return {
    count: `${n} tool call${n === 1 ? '' : 's'}`,
    names: hidden > 0 ? `${shown.join(', ')} +${hidden} more` : shown.join(', ')
  }
}
