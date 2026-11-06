// Messages from an agent team's teammates, as Claude Code records them in the LEAD's transcript.
//
// MEASURED on Claude Code 2.1.291 and 2.1.316 (32 records in one real session), and read from the
// 2.1.318 binary: a plain `type:"user"` record with STRING content and no `origin`, `promptSource` or
// `isMeta`, shaped
//
//   Another Claude session sent a message:\n
//   <teammate-message teammate_id="pc-02" color="green" summary="…">\n
//   <body>\n
//   </teammate-message>\n
//   \n
//   <teammate-message …>…</teammate-message>      (one or more elements)
//   \n\n
//   This came from another Claude session — not typed by your user, … (a fixed trailer)
//
// A body is either plain markdown or one `idle_notification` JSON object (`{"type":
// "idle_notification","from","timestamp","idleReason?","summary?","completedTaskId?",
// "completedStatus?","failureReason?","result?"}`): the teammate reporting that its turn ended.
// Attribute values are escaped (`&quot;`, `&apos;`, `&amp;`, `&lt;`, `&gt;`); `verified="false"`
// marks a message whose sender could not be proven. The TUI draws an idle notification as a status
// line ("✓ Teammate @pc-02 finished") and a plain message as a collapsed "Message from @pc-02" row;
// it never draws either as the user's words.
//
// Every scan is `indexOf`-based (see the system-record rules in transcript-reader.ts: these records
// are parsed on the main process, and a backtracking regex over many unclosed tags is quadratic).
import type { ChatTeammateIdle } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { idleOutcome } from '../shared/chat-teammate'

/** The line Claude Code puts before the elements (the 2.1.318 binary has these three). */
export const TEAMMATE_PREFIXES: readonly string[] = [
  'Another Claude session sent a message:\n',
  'Another Claude session sent a message while you were working:\n',
  'A peer session sent a message while you were working:\n'
]
const OPEN = '<teammate-message'
const CLOSE = '</teammate-message>'
/** Cap on a teammate message's body or an idle notification's result, UTF-16 units — the same cap a
 *  system record's result has (`SYSTEM_RESULT_MAX`; not imported, that module imports this one). */
export const TEAMMATE_TEXT_MAX = 16384

export interface TeammateElement {
  from: string
  color?: string
  summary?: string
  unverified?: boolean
  /** A plain message's body (trimmed, capped). Absent for an idle notification or an empty body. */
  text?: string
  idle?: ChatTeammateIdle
}

const isJsSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const capLine = (v: string): string => v.trim().split('\n')[0].trim().slice(0, CHAT_TOOL_ARG_MAX)
const capText = (v: string): string => v.trim().slice(0, TEAMMATE_TEXT_MAX)

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>'
}
/** One pass, so `&amp;quot;` stays `&quot;` (the TUI's own unescape works the same way). */
const unescapeAttr = (v: string): string => v.replace(/&(?:quot|apos|amp|lt|gt);/g, (e) => ENTITIES[e] ?? e)

/** `name="value"` pairs of an opening tag, in linear time. Values never hold a raw `"` (escaped). */
function readAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  while (i < attrs.length) {
    while (isJsSpace(attrs[i])) i++
    const eq = attrs.indexOf('="', i)
    if (eq < 0) break
    const name = attrs.slice(i, eq)
    const end = attrs.indexOf('"', eq + 2)
    if (end < 0) break
    if (!out.has(name)) out.set(name, unescapeAttr(attrs.slice(eq + 2, end)))
    i = end + 1
  }
  return out
}

const IDLE_REASONS: ReadonlySet<string> = new Set(['available', 'interrupted', 'failed'])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** A body that is exactly one `idle_notification` object, read; null for anything else. */
export function readIdleNotification(body: string): ChatTeammateIdle | null {
  if (!body.startsWith('{')) return null
  let o: unknown
  try {
    o = JSON.parse(body)
  } catch {
    return null
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (r.type !== 'idle_notification' || typeof r.from !== 'string') return null
  const idle: ChatTeammateIdle = {}
  // A reason this version does not know is dropped; the line then reads "finished", as the TUI's does
  // for a notification that names no reason.
  if (typeof r.idleReason === 'string' && IDLE_REASONS.has(r.idleReason)) {
    idle.reason = r.idleReason as ChatTeammateIdle['reason']
  }
  const summary = str(r.summary)
  if (summary !== undefined) idle.summary = capLine(summary)
  const failure = str(r.failureReason)
  if (failure !== undefined) idle.failureReason = capLine(failure)
  const task = str(r.completedTaskId)
  if (task !== undefined) idle.taskId = capLine(task)
  const result = str(r.result)
  if (result !== undefined) idle.result = capText(result)
  return idle
}

/**
 * The teammate elements of a record, or null when the record is not a teammate record (it then
 * keeps its current treatment). Only a record with NO `origin` and an unset or `"system"`
 * `promptSource` qualifies: a human who types or pastes this text is recorded with
 * `origin.kind:"human"` / `promptSource:"typed"` (the system-record rule, measured on 2.1.285), so
 * their words stay theirs.
 *
 * An element ends at the first `</teammate-message>` that is followed (after whitespace) by the end
 * of the string or by the next element — the TUI's own rule, so a body that quotes the close tag is
 * not cut short. When no close qualifies, the LAST close ends it and the rest is the trailer.
 */
export function teammateElements(
  rec: { origin?: unknown; promptSource?: unknown },
  content: string
): TeammateElement[] | null {
  if (rec.origin !== undefined) return null
  if (rec.promptSource !== undefined && rec.promptSource !== 'system') return null
  const prefix = TEAMMATE_PREFIXES.find((p) => content.startsWith(p))
  if (prefix === undefined) return null
  const out: TeammateElement[] = []
  let at = prefix.length
  for (;;) {
    while (isJsSpace(content[at])) at++
    if (!content.startsWith(OPEN, at) || !isJsSpace(content[at + OPEN.length])) break
    const gt = content.indexOf('>', at + OPEN.length)
    if (gt < 0) break
    const attrs = readAttrs(content.slice(at + OPEN.length, gt))
    const from = attrs.get('teammate_id')?.trim()
    if (from === undefined || from === '') break
    const bodyStart = content[gt + 1] === '\n' ? gt + 2 : gt + 1
    let close = -1
    let next = -1
    for (let c = content.indexOf(CLOSE, bodyStart); c >= 0; c = content.indexOf(CLOSE, c + 1)) {
      let i = c + CLOSE.length
      while (isJsSpace(content[i])) i++
      if (i === content.length || content.startsWith(OPEN, i)) {
        close = c
        next = i
        break
      }
    }
    const last = close < 0 ? content.lastIndexOf(CLOSE) : -1
    if (close < 0 && last < bodyStart) break
    const end = close >= 0 ? close : last
    const body = content.slice(bodyStart, end).trim()
    const el: TeammateElement = { from: capLine(from) }
    const color = capLine(attrs.get('color') ?? '')
    if (color !== '') el.color = color
    const summary = capLine(attrs.get('summary') ?? '')
    if (summary !== '') el.summary = summary
    if (attrs.get('verified') === 'false') el.unverified = true
    const idle = readIdleNotification(body)
    if (idle !== null) el.idle = idle
    else if (body !== '') el.text = capText(body)
    out.push(el)
    // The last close was the fallback, or the string ends: what follows is the trailer.
    if (close < 0 || next === content.length) break
    at = next
  }
  return out.length > 0 ? out : null
}

/** One element as plain text, for the tool chip a non-rich read emits and for the search index. */
export function teammateElementText(el: TeammateElement): string {
  if (el.idle !== undefined) {
    const reason = el.idle.failureReason !== undefined ? `: ${el.idle.failureReason}` : ''
    const head = `${el.from} ${idleOutcome(el.idle.reason)}${reason}`
    return el.idle.result !== undefined ? `${head}\n${el.idle.result}` : head
  }
  if (el.summary !== undefined && el.text !== undefined) return `${el.summary}\n${el.text}`
  return el.text ?? el.summary ?? ''
}
