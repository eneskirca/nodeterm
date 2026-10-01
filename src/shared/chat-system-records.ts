// The parts of the claude chat reader's system-record rules that the RENDERER needs too: the names
// of the tool parts a system-injected user record renders as (the thread's turn grouping treats
// them as boundaries), and the paste expansion (the composer's unconfirmed-send match compares a
// send against its expanded form). The reader itself is `src/core/transcript-reader.ts`; the exact
// rules, for the iOS port, are in `src/shared/chat-fixtures/README.md`.
import type { ChatMessage } from './types'

export const BACKGROUND_TASK_TOOL = 'Background task'
export const AGENT_MESSAGE_TOOL = 'Agent message'
export const SYSTEM_TOOL = 'System'
const SYSTEM_RECORD_TOOLS: ReadonlySet<string> = new Set([BACKGROUND_TASK_TOOL, AGENT_MESSAGE_TOOL, SYSTEM_TOOL])

/** A message the reader made from a system-injected record: an assistant message holding exactly
 *  ONE tool part named Background task / Agent message / System. */
export function isSystemRecordMessage(m: ChatMessage): boolean {
  if (m.role !== 'assistant' || m.parts.length !== 1) return false
  const p = m.parts[0]
  return p.kind === 'tool' && SYSTEM_RECORD_TOOLS.has(p.name)
}

// ── Pasted content ───────────────────────────────────────────────────────────────────────────────
// claude (2.1.285, `rht` in the binary) records a paste inside typed text as
//   <pasted_content id="XXXX">\n<body>\n</pasted_content id="XXXX">
// with XXXX exactly four lowercase hex digits. Only that grammar is a span; anything else is typed
// text and stays as is. Scanned with indexOf, never a backtracking regex: the text is the user's and
// is parsed on the main process, and a regex over many unclosed opens is quadratic.
const OPEN = '<pasted_content id="'
const CLOSE = '\n</pasted_content id="'
const ID_LEN = 4
const OPEN_TAIL = '">\n'
const CLOSE_TAIL = '">'

function isHex4(s: string, at: number): boolean {
  // Past the end `charCodeAt` is NaN, which fails the range test: no bounds check needed.
  for (let i = at; i < at + ID_LEN; i++) {
    const c = s.charCodeAt(i)
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) return false
  }
  return true
}

/**
 * One paste's body as a fenced code block: `\n` + fence + `\n` + body + `\n` + fence + `\n`, the
 * fence being backticks, one longer than the longest run of backticks in the body (at least three).
 */
export function fencePasted(body: string): string {
  let longest = 0
  let run = 0
  for (let i = 0; i < body.length; i++) {
    run = body.charCodeAt(i) === 0x60 ? run + 1 : 0
    if (run > longest) longest = run
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `\n${fence}\n${body}\n${fence}\n`
}

/**
 * Every paste span in typed text → `fencePasted(body)`, left to right. A span's body ends at the
 * FIRST close marker with the same id at or after the body's start (close to, but deliberately not exactly, the CLI's `o_t`: an empty body and an unclosed open stay as typed here — the CLI's writer never emits either, so ports must NOT "correct" toward the CLI). Text
 * outside the spans is kept as typed; an open with no matching close is left alone.
 */
export function expandPastedContent(text: string): string {
  if (!text.includes(OPEN)) return text
  // Every well-formed close marker, grouped by id, in text order: one linear pass.
  const closes = new Map<string, number[]>()
  for (let i = text.indexOf(CLOSE); i >= 0; i = text.indexOf(CLOSE, i + 1)) {
    const idAt = i + CLOSE.length
    if (!isHex4(text, idAt) || !text.startsWith(CLOSE_TAIL, idAt + ID_LEN)) continue
    const id = text.slice(idAt, idAt + ID_LEN)
    const list = closes.get(id)
    if (list) list.push(i)
    else closes.set(id, [i])
  }
  // Per id, the first close not yet passed. Opens are visited in text order, so each pointer only
  // moves forward: the whole scan stays linear however many opens are never closed.
  const next = new Map<string, number>()
  let out = ''
  let copied = 0
  let from = 0
  for (;;) {
    const o = text.indexOf(OPEN, from)
    if (o < 0) break
    const idAt = o + OPEN.length
    if (!isHex4(text, idAt) || !text.startsWith(OPEN_TAIL, idAt + ID_LEN)) {
      from = o + 1
      continue
    }
    const id = text.slice(idAt, idAt + ID_LEN)
    const bodyStart = idAt + ID_LEN + OPEN_TAIL.length
    const list = closes.get(id)
    let k = next.get(id) ?? 0
    while (list && k < list.length && list[k] < bodyStart) k++
    next.set(id, k)
    if (!list || k >= list.length) {
      from = o + 1
      continue
    }
    const c = list[k]
    out += text.slice(copied, o) + fencePasted(text.slice(bodyStart, c))
    copied = from = c + CLOSE.length + ID_LEN + CLOSE_TAIL.length
  }
  return copied === 0 ? text : out + text.slice(copied)
}
