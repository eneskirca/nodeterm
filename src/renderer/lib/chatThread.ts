// Pure decisions behind the ⌘M thread's claude.ai look (ChatPanel): where an assistant turn's
// action row goes, what its Copy copies, how its time reads, and where a day divider goes. No
// React — see ChatPanel.tsx for the glue and chatThread.test.ts for the pins.
import type { ChatMessage } from '@shared/types'
import { isSystemRecordMessage } from '@shared/chat-system-records'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/**
 * "just now" / "2 min ago" / "5 hours ago" / "2 days ago", then a short date past a month (where a
 * count of days stops meaning anything). A stamp in the future — this machine's clock behind the
 * one that wrote the transcript, e.g. an SSH host — reads "just now", never a negative age.
 */
export function chatRelativeTime(at: number, now: number): string {
  const diff = now - at
  if (diff < MIN) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour')
  if (diff < 30 * DAY) return plural(Math.floor(diff / DAY), 'day')
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The tooltip: the absolute time, in the viewer's locale. */
export function chatAbsoluteTime(at: number): string {
  return new Date(at).toLocaleString()
}

// One formatter for the whole module: `toLocaleTimeString` builds a fresh Intl.DateTimeFormat per
// call, and the thread formats every stamped user message on every render (each composer keystroke
// is one). With hour + minute given, the output is the same as `toLocaleTimeString`'s.
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/** The clock time under a user message ("09:41"), in the viewer's locale. */
export function chatClockTime(at: number): string {
  return CLOCK.format(at)
}

const localDay = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * Where the thread draws a day divider: message index → its label, on the FIRST stamped message of
 * each LOCAL calendar day (the viewer's, not the transcript writer's — an SSH host's midnight is not
 * the reader's). Unstamped messages never start a day; they sit under whichever day came before.
 * "Today" / "Yesterday" by the viewer's clock `now`, else a short date, with the year only when it
 * is not `now`'s.
 */
export function dayDividers(messages: readonly ChatMessage[], now: number): Map<number, string> {
  const dividers = new Map<number, string>()
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  let last: string | undefined
  messages.forEach((m, i) => {
    if (typeof m.at !== 'number') return
    const d = new Date(m.at)
    const day = localDay(d)
    if (day === last) return
    last = day
    if (day === localDay(today)) dividers.set(i, 'Today')
    else if (day === localDay(yesterday)) dividers.set(i, 'Yesterday')
    else
      dividers.set(
        i,
        d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {})
        })
      )
  })
  return dividers
}

export interface TurnEnd {
  /** The turn's text parts as markdown source, joined by a blank line; '' = nothing to copy. */
  copyText: string
  /** The last stamped message's time in the turn; undefined = no line stated one. */
  at?: number
}

/**
 * One action row per assistant TURN, keyed by the index of the turn's last message. A transcript
 * writes an assistant turn as many lines (text, each tool call, more text), and the thread renders
 * one message per line — a row under every one of them would be a row per tool call. A turn is a
 * maximal run of consecutive assistant messages. Copy takes only its TEXT parts (the answer as
 * markdown source), never thinking or tool plumbing.
 *
 * A system-record chip (a background task's completion, another agent's message, an
 * auto-continuation — `isSystemRecordMessage`) is assistant-role only because the wire has no other
 * role for it; it is not the agent talking, so it is a boundary like a user message: no row of its
 * own, and the answers before and after it stay two turns. A local-command chip is not a boundary.
 */
export function assistantTurnEnds(messages: readonly ChatMessage[]): Map<number, TurnEnd> {
  const ends = new Map<number, TurnEnd>()
  let texts: string[] = []
  let at: number | undefined
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || isSystemRecordMessage(m)) {
      texts = []
      at = undefined
      return
    }
    for (const p of m.parts) if (p.kind === 'text' && p.text) texts.push(p.text)
    if (typeof m.at === 'number') at = m.at
    const next = messages[i + 1]
    if (!next || next.role !== 'assistant' || isSystemRecordMessage(next)) {
      ends.set(i, { copyText: texts.join('\n\n'), at })
      texts = []
      at = undefined
    }
  })
  return ends
}
