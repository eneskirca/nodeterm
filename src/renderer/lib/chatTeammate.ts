// How the ⌘M thread lays out a message of `teammate` parts (core/chat-teammate.ts), following
// Claude Code's TUI: an idle notification is a status line of its own; consecutive plain messages
// from the same teammate fold into one "N messages from @x" row.
import type { ChatMessage, ChatPart } from '@shared/types'

export type TeammatePart = Extract<ChatPart, { kind: 'teammate' }>

/** A message the reader made of teammate parts only (it never mixes them with other parts). */
export function isTeammateMessage(m: ChatMessage): m is ChatMessage & { parts: TeammatePart[] } {
  return m.parts.length > 0 && m.parts.every((p) => p.kind === 'teammate')
}

export type TeammateRow =
  | { kind: 'idle'; part: TeammatePart }
  | {
      kind: 'messages'
      from: string
      color?: string
      unverified: boolean
      parts: TeammatePart[]
    }

export function teammateRows(parts: readonly TeammatePart[]): TeammateRow[] {
  const rows: TeammateRow[] = []
  for (const p of parts) {
    if (p.idle) {
      rows.push({ kind: 'idle', part: p })
      continue
    }
    const unverified = p.unverified === true
    const last = rows.at(-1)
    if (last?.kind === 'messages' && last.from === p.from && last.unverified === unverified) {
      last.parts.push(p)
      continue
    }
    rows.push({
      kind: 'messages',
      from: p.from,
      color: p.color,
      unverified,
      parts: [p]
    })
  }
  return rows
}

/** The TUI's teammate color names, mapped to the app's system colors. The name comes from the
 *  transcript, so anything else draws no color rather than reaching CSS. */
const TEAMMATE_COLORS: Readonly<Record<string, string>> = {
  red: 'var(--sys-red)',
  orange: 'var(--sys-orange)',
  yellow: 'var(--sys-yellow)',
  green: 'var(--sys-green)',
  blue: 'var(--sys-blue)',
  purple: 'var(--sys-purple)',
  pink: 'var(--sys-pink)',
  cyan: 'var(--sys-cyan)'
}

export function teammateColor(color: string | undefined): string | undefined {
  return color !== undefined && Object.hasOwn(TEAMMATE_COLORS, color) ? TEAMMATE_COLORS[color] : undefined
}

/** "Message from" / "3 messages from". */
export function messagesLabel(count: number): string {
  return count === 1 ? 'Message from' : `${count} messages from`
}
