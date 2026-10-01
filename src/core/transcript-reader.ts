// Reads a Claude session's transcript .jsonl into flat, searchable lines. Read-only and
// local. Mirrors subagent-tail.ts's extraction shape but returns {role, text} per content
// block (instead of a single formatted string) so the renderer can tag matches by role.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TranscriptLine, ChatMessage, ChatPart, ChatCarriedToolResult } from '../shared/types'
import { transcriptRootFor } from './claude-accounts-core'
import { linkedClaudeConfigDirFor } from './claude-config-dir'
import { platform } from './platform'
import { toolBody } from './chat-tool-body'
import { ASK_USER_QUESTION_TOOL, readQuestions } from '../shared/agents/permission-answer'
import { BASH_COMMAND_TOOL, CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import {
  AGENT_MESSAGE_TOOL,
  BACKGROUND_TASK_TOOL,
  SYSTEM_TOOL,
  expandPastedContent
} from '../shared/chat-system-records'

// Transcript root for a managed account (its `projects` dir) or the system default
// (`~/.claude/projects` when accountId is undefined — bit-for-bit the old behavior). Impure
// wrapper over the pure `transcriptRootFor`: the userData dir comes from the CorePlatform seam
// (and only for the account branch) so this module — and its vitest test — stays electron-free.
export function transcriptRoot(accountId?: string): string {
  const userData = accountId ? platform().userDataDir : null
  // A LINKED account's transcripts live in the dir the USER owns (`~/.claude-2/projects`), not
  // under `{userData}`. Resolved through the registry so this — and with it `resolveTranscriptPath`,
  // `readSessionName`, `transcriptPathForCwd`, and therefore handoff/locate, agent-session-name,
  // context-link and the session-name sweep — is the ONE place the answer moved.
  const linked = accountId ? linkedClaudeConfigDirFor(accountId) : null
  return transcriptRootFor(os.homedir(), userData, accountId, linked ?? undefined)
}

// Only read the last ~5 MB of a transcript so a very large session can't block the main
// process. The older head is dropped silently (search is most useful on recent context).
const READ_CAP_BYTES = 5 * 1024 * 1024

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .map((c) => (c?.type === 'text' ? c.text ?? '' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function summarizeResult(content: unknown): string {
  return textOf(content).split('\n').slice(0, 3).join(' ').slice(0, 500)
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.description ?? o.prompt
  return typeof v === 'string' ? v.slice(0, CHAT_TOOL_ARG_MAX) : ''
}

// ── Local-command records ────────────────────────────────────────────────────────────────────────
// A slash command (`/model`) and a `!` bash-mode line are written by claude as `type:"user"` records
// whose content is a STRING of tags — measured on real transcripts (2026-09):
//   <command-name>/model</command-name>\n   <command-message>model</command-message>\n   <command-args></command-args>
//   <local-command-stdout>Set model to \x1b[1m…\x1b[22m</local-command-stdout>
//   <bash-input>ls</bash-input>
//   <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>        (ONE record, either may be empty)
// preceded by an `isMeta:true` `<local-command-caveat>` record. A skill invocation writes
// `<command-message>` BEFORE `<command-name>` (no args), so order is free. Only a record that is
// EXACTLY such a tag sequence (whitespace between tags) is one; a record that merely mentions a tag
// inside prose is a normal user message. Never seen as an array text part, so only string content
// is matched.
export type LocalCommandRecord =
  | { kind: 'command'; family: 'slash' | 'bash'; name: string; arg: string }
  | { kind: 'output'; family: 'slash' | 'bash'; text: string }

const TAG_RE = /<([a-z-]+)>([\s\S]*?)<\/\1>/y
const SLASH_TAGS = new Set(['command-name', 'command-message', 'command-args'])
const BASH_INPUT_TAGS = new Set(['bash-input'])
const SLASH_OUT_TAGS = new Set(['local-command-stdout', 'local-command-stderr'])
const BASH_OUT_TAGS = new Set(['bash-stdout', 'bash-stderr'])

/** The record as a sequence of whole tags, each at most once; null if anything else is in it. */
function tagSequence(content: string): Map<string, string> | null {
  const tags = new Map<string, string>()
  let i = 0
  for (;;) {
    while (i < content.length && /\s/.test(content[i])) i++
    if (i >= content.length) break
    TAG_RE.lastIndex = i
    const m = TAG_RE.exec(content)
    if (!m || tags.has(m[1])) return null
    tags.set(m[1], m[2])
    i = TAG_RE.lastIndex
  }
  return tags.size ? tags : null
}

const onlyFrom = (tags: Map<string, string>, allowed: Set<string>): boolean =>
  [...tags.keys()].every((k) => allowed.has(k))

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ESC \\`) and two-byte `ESC x` escapes. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '')
}

/** Output tags → one text: each non-empty part ANSI-stripped + trimmed, joined by `\n`. */
function outputText(tags: Map<string, string>): string {
  return [...tags.values()]
    .map((v) => stripAnsi(v).trim())
    .filter(Boolean)
    .join('\n')
}

/** A command's arg: trimmed, then capped like `toolArg` (the composer's `sentCommand` agrees). */
const capArg = (v: string | undefined): string => (v ?? '').trim().slice(0, CHAT_TOOL_ARG_MAX)

/**
 * claude's own meta records — the local-command caveat, skill bodies, injected reminders — are not
 * something the user said, and are skipped. But an `isMeta` record that STARTS a turn (a peer
 * hand-back, a scheduled / loop wakeup, an auto-continuation) says where that turn's prompt came
 * from, and hiding it leaves replies with no prompt between them. Measured: those carry
 * `promptSource` and/or `origin` / `turnOrigin` (present and not null); the hidden kinds carry none.
 * Measured too: no `isMeta` record carries a tool_result, so skipping one loses nothing.
 */
export function isHiddenMetaRecord(o: {
  type?: string
  isMeta?: unknown
  promptSource?: unknown
  origin?: unknown
  turnOrigin?: unknown
}): boolean {
  return o.type === 'user' && o.isMeta === true && o.promptSource == null && o.origin == null && o.turnOrigin == null
}

export function classifyLocalCommand(content: string): LocalCommandRecord | null {
  const tags = tagSequence(content)
  if (!tags) return null
  if (onlyFrom(tags, SLASH_TAGS)) {
    const name = (tags.get('command-name') ?? '').trim()
    if (!name) return null
    return { kind: 'command', family: 'slash', name, arg: capArg(tags.get('command-args')) }
  }
  if (onlyFrom(tags, BASH_INPUT_TAGS)) {
    return { kind: 'command', family: 'bash', name: BASH_COMMAND_TOOL, arg: capArg(tags.get('bash-input')) }
  }
  if (onlyFrom(tags, SLASH_OUT_TAGS)) return { kind: 'output', family: 'slash', text: outputText(tags) }
  if (onlyFrom(tags, BASH_OUT_TAGS)) return { kind: 'output', family: 'bash', text: outputText(tags) }
  return null
}

/** The name an output record's tool part gets when there is no command to attach it to. */
export const COMMAND_OUTPUT_TOOL = 'command output'

// ── System-injected user records ─────────────────────────────────────────────────────────────────
// Claude Code writes several things that are NOT the user's words as `type:"user"` records. Measured
// on 200 real transcripts (2026-09), user records without a tool_result, by `origin.kind`:
//   task-notification  (promptSource "system")  `<task-notification>…</task-notification>` string —
//                      a background task / agent / monitor finished. Child tags seen: task-id (0..n),
//                      tool-use-id, output-file, status, summary, note, result, event, task-type,
//                      usage (nested), worktree; each optional.
//   peer               (isMeta, "system")  "Another Claude session sent a message:\n" + ONE
//                      `<agent-message from="…">` (a subagent hand-back) or `<cross-session-message
//                      from="…" from-name="…" from-mode="…">` element + a fixed instruction trailer.
//   auto-continuation / coordinator  (isMeta)  plain text.
// Each renders as ONE assistant tool part — the #991 local-command pattern: no new role, part kind
// or field, so a v1 decoder (the phone) reads it as an ordinary tool chip. A human paste
// (`<pasted_content id="…">…</pasted_content id="…">` inside typed text) stays the user's bubble.
// Only STRING content is classified: none of these kinds was ever measured with array content.
//
// Every scan below is `indexOf`-based, never a backtracking regex: the records are parsed on the
// main process, and a regex over many unclosed tags is quadratic (1 MB ≈ 20 s, measured).
export { BACKGROUND_TASK_TOOL, AGENT_MESSAGE_TOOL, SYSTEM_TOOL, expandPastedContent }
/** Cap on a system record's full-text `result` (an agent report is long and useful), UTF-16 units. */
export const SYSTEM_RESULT_MAX = 16384
/**
 * The `result` of a task-notification with a summary but neither a status nor a body. Without one the
 * part has no `result` and renders as a tool still running (the phone shows a pending icon and "No
 * result yet"). Neutral on purpose, not "done": such a notification is often a START
 * ("Background agent … started").
 */
export const TASK_NOTIFIED_RESULT = 'notified'

export interface SystemRecord {
  name: string
  arg: string
  /** '' = no result (the part carries no `result` key). */
  result: string
}

const originKind = (origin: unknown): string | undefined => {
  if (!origin || typeof origin !== 'object') return undefined
  const k = (origin as { kind?: unknown }).kind
  return typeof k === 'string' ? k : undefined
}

/** The only `promptSource` values a content-only (origin-less) task-notification may carry: none, or
 *  `system`. An ALLOWLIST, not a list of human sources — a human source added later (`sdk` already
 *  exists, 132 records measured) must never turn a human's pasted element into a chip. Every real
 *  notification measured (1,693, CLI 2.1.209–2.1.286) carries `origin.kind` AND `promptSource:"system"`. */
const systemOrUnsetSource = (source: unknown): boolean => source === undefined || source === 'system'

/** The first line of the trimmed text, trimmed, capped like a tool arg. */
const firstLine = (text: string): string => capArg(text.trim().split('\n')[0])
const capResult = (text: string): string => text.trim().slice(0, SYSTEM_RESULT_MAX)
const fallback = (name: string, content: string): SystemRecord => ({
  name,
  arg: firstLine(content),
  result: capResult(content)
})

const TN_OPEN = '<task-notification>'
const TN_CLOSE = '</task-notification>'
/** The whole string is exactly ONE `<task-notification>` element (JS whitespace around it only). */
export function isWholeTaskNotification(content: string): boolean {
  // `trim` strips exactly JS `\s`, so this is `^\s*<task-notification>(…)</task-notification>\s*$`.
  const t = content.trim()
  if (t.length < TN_OPEN.length + TN_CLOSE.length || !t.startsWith(TN_OPEN) || !t.endsWith(TN_CLOSE)) return false
  const inner = t.slice(TN_OPEN.length, t.length - TN_CLOSE.length)
  return !inner.includes(TN_OPEN) && !inner.includes(TN_CLOSE)
}

/** The first `<name>…</name>` in `text` (the first close after the first open), trimmed; '' when
 *  absent. If the first open has no close after it, no later open can have one either. */
function tagText(text: string, name: string): string {
  const open = `<${name}>`
  const o = text.indexOf(open)
  if (o < 0) return ''
  const c = text.indexOf(`</${name}>`, o + open.length)
  return c < 0 ? '' : text.slice(o + open.length, c).trim()
}

function taskNotification(content: string): SystemRecord {
  const summary = tagText(content, 'summary')
  const status = tagText(content, 'status')
  const body = tagText(content, 'result') || tagText(content, 'event')
  if (!summary && !status && !body) return fallback(BACKGROUND_TASK_TOOL, content)
  // Neither a status nor a body: the neutral marker, so the chip reads as finished, not running.
  const text = status && body ? `${status}: ${body}` : status || body || TASK_NOTIFIED_RESULT
  return { name: BACKGROUND_TASK_TOOL, arg: summary.slice(0, CHAT_TOOL_ARG_MAX), result: summarizeResult(text) }
}

const isJsSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)

interface PeerElement {
  start: number
  /** Everything between the name and the first `>` (leading whitespace included); '' when none. */
  attrs: string
  body: string
}

/**
 * The regex `<name(\s[^>]*)?>([\s\S]*)</name>` for one name, in linear time: the first open that is
 * followed by `>` or JS whitespace, its first `>`, and the LAST `</name>` after that `>`. Only the
 * first such open can match — a later one's `>` is no earlier, so the last close cannot follow it
 * if it did not follow the first.
 */
function findElement(content: string, name: string): PeerElement | null {
  const open = `<${name}`
  const last = content.lastIndexOf(`</${name}>`)
  if (last < 0) return null
  for (let o = content.indexOf(open); o >= 0; o = content.indexOf(open, o + 1)) {
    const after = o + open.length
    if (content[after] !== '>' && !isJsSpace(content[after])) continue
    const gt = content.indexOf('>', after)
    if (gt < 0 || last < gt + 1) return null
    return { start: o, attrs: content.slice(after, gt), body: content.slice(gt + 1, last) }
  }
  return null
}

/** `(?:^|\s)from-name="([^"]*)"` over the attributes, in linear time; '' when absent. */
function fromNameAttr(attrs: string): string {
  const key = 'from-name="'
  for (let i = attrs.indexOf(key); i >= 0; i = attrs.indexOf(key, i + 1)) {
    if (i > 0 && !isJsSpace(attrs[i - 1])) continue
    const end = attrs.indexOf('"', i + key.length)
    return end < 0 ? '' : attrs.slice(i + key.length, end)
  }
  return ''
}

function peerMessage(content: string): SystemRecord {
  // The earliest of the two element kinds (they cannot start at the same offset).
  const a = findElement(content, 'agent-message')
  const x = findElement(content, 'cross-session-message')
  const m = a && x ? (a.start < x.start ? a : x) : a ?? x
  if (!m) return fallback(AGENT_MESSAGE_TOOL, content)
  const body = m.body.trim()
  const fromName = fromNameAttr(m.attrs).trim()
  return { name: AGENT_MESSAGE_TOOL, arg: fromName ? capArg(fromName) : firstLine(body), result: capResult(body) }
}

/**
 * A system-injected user record (see above) as the tool part it renders as, or null for anything
 * else (which keeps its current treatment). `content` is the record's string content.
 *
 * The content-only match (no `origin.kind` at all) never applies to a record a human sent: a user
 * who types or pastes one `<task-notification>` element is recorded exactly like that (measured on
 * CLI 2.1.285: an unwrapped bracketed paste, `origin.kind:"human"`, `promptSource:"typed"`).
 */
export function classifySystemRecord(
  rec: { origin?: unknown; promptSource?: unknown },
  content: string
): SystemRecord | null {
  const kind = originKind(rec.origin)
  if (
    kind === 'task-notification' ||
    (kind === undefined && systemOrUnsetSource(rec.promptSource) && isWholeTaskNotification(content))
  ) {
    return taskNotification(content)
  }
  if (kind === 'peer') return peerMessage(content)
  if (kind === 'auto-continuation' || kind === 'coordinator') return fallback(SYSTEM_TOOL, content)
  return null
}

/** A system record's tool part (`result` only when non-empty). */
function systemPart(r: SystemRecord): Extract<ChatPart, { kind: 'tool' }> {
  const part: Extract<ChatPart, { kind: 'tool' }> = { kind: 'tool', name: r.name, arg: r.arg }
  if (r.result) part.result = r.result
  return part
}

/** How user text is shown. `expandPastes:false` keeps `<pasted_content>` markup as recorded — for
 *  a TITLE (recent conversations, the transcript index), where a code fence has no place. */
export interface ChatParseOptions {
  expandPastes?: boolean
}
const userTextOf = (text: string, opts: ChatParseOptions | undefined): string =>
  opts?.expandPastes === false ? text : expandPastedContent(text)

/** A tool part as find-bar lines: `$ name arg`, then its result when it has one. */
function toolLines(name: string, arg: string, result: string): TranscriptLine[] {
  const out: TranscriptLine[] = [{ role: 'tool', text: `$ ${name}${arg ? ` ${arg}` : ''}` }]
  if (result) out.push({ role: 'tool', text: result })
  return out
}

// Extract 0..n searchable lines from one raw transcript JSONL line.
function linesFrom(raw: string, opts?: ChatParseOptions): TranscriptLine[] {
  let o: Parameters<typeof isHiddenMetaRecord>[0] & { message?: { content?: unknown } }
  try {
    o = JSON.parse(raw)
  } catch {
    return []
  }
  // Same rule as the chat parser: a `null` / scalar line is one skipped line, never a failed read.
  if (!o || typeof o !== 'object' || Array.isArray(o)) return []
  // Same rule as the chat parser (see `isHiddenMetaRecord`).
  if (isHiddenMetaRecord(o)) return []
  const content = o.message?.content
  const out: TranscriptLine[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'text' && c.text) out.push({ role: 'assistant', text: c.text })
      else if (c.type === 'tool_use') {
        const arg = toolArg(c.input)
        out.push({ role: 'tool', text: `$ ${c.name ?? 'tool'}${arg ? ` ${arg}` : ''}` })
        // A plan / question is prose the user reads in full in the ⌘M view, so it is indexed in
        // full too — the same treatment an assistant text block gets (the find bar splits lines).
        const body = toolBody(c.name ?? '', c.input)
        if (body) out.push({ role: 'tool', text: body })
      }
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; content?: unknown }>) {
      if (!c || typeof c !== 'object') continue
      // A non-string `text` is passed through as before; only a string is a paste to expand.
      if (c.type === 'text' && c.text) out.push({ role: 'user', text: typeof c.text === 'string' ? userTextOf(c.text, opts) : c.text })
      else if (c.type === 'tool_result') {
        const s = summarizeResult(c.content)
        if (s) out.push({ role: 'tool', text: s })
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    // A system-injected record indexes as the tool part the chat view shows (its body stays
    // searchable — an agent's report is worth finding), never as the user's own text.
    const sys = content.trim() ? classifySystemRecord(o, content) : null
    if (sys) return toolLines(sys.name, sys.arg, sys.result)
    const cmd = classifyLocalCommand(content)
    if (cmd?.kind === 'command') out.push({ role: 'tool', text: `$ ${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''}` })
    else if (cmd?.kind === 'output') {
      const s = summarizeResult(cmd.text)
      if (s) out.push({ role: 'tool', text: s })
    } else out.push({ role: 'user', text: userTextOf(content, opts) })
  }
  return out
}

// Read the last `cap` bytes (default and ceiling READ_CAP_BYTES) of the file as UTF-8 (dropping the
// partial leading line on a capped read), or the whole file when it's small. Returns undefined if
// it can't be read.
export async function readCappedTail(filePath: string, cap: number = READ_CAP_BYTES): Promise<string | undefined> {
  const limit = Math.min(READ_CAP_BYTES, Math.max(1, Math.floor(cap)))
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > limit) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        // One LOOKBEHIND byte before the window: when it is a `\n`, the window's first line is
        // whole and survives the drop below (the remote page reader's rule).
        const start = stat.size - limit - 1
        const { buffer, bytesRead } = await fd.read({
          position: start,
          length: limit + 1,
          buffer: Buffer.alloc(limit + 1)
        })
        const data = buffer.subarray(0, bytesRead)
        const nl = data.indexOf(0x0a) // drop the first (partial) line
        return nl >= 0 ? data.subarray(nl + 1).toString('utf8') : ''
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

// Parse transcript text into flat searchable lines. Pure — splits on newlines and maps each
// non-blank line via linesFrom. Reused by the remote reader (which fetches the text over SSH).
export function parseTranscriptLines(text: string, opts?: ChatParseOptions): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim()) lines.push(...linesFrom(raw, opts))
  }
  return lines
}

export async function readTranscriptLines(filePath: string): Promise<TranscriptLine[]> {
  const buf = await readCappedTail(filePath)
  if (buf === undefined) return []
  return parseTranscriptLines(buf)
}

/** A queued prompt is a string, or content blocks (a prompt with a pasted image) — keep the text. */
function queuedPromptText(prompt: unknown, opts: ChatParseOptions | undefined): string {
  if (typeof prompt === 'string') return userTextOf(prompt, opts)
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .map((t) => userTextOf(t, opts))
    .join('\n')
}

// Reconstruct structured chat messages from raw transcript JSONL lines. An assistant line's
// text + tool_use blocks become one message's ordered parts; a later user-line tool_result is
// correlated back onto its tool part by tool_use_id. User lines that carry only tool_results
// (no prose) are NOT rendered as bubbles — they're tool output, attached to the tool instead.
//
// `paged` switches on the three things only a paged read needs (the legacy result grows only by
// the optional `at` both paths carry): a `key` per message (its line's absolute byte offset), the `tool_use` id on
// each tool part, and the list of results whose tool was not among these lines.
export interface ChatRecordsOut {
  messages: ChatMessage[]
  unmatched: Map<string, string>
  /** PAGED only: `message.model` / `effort` of the newest non-synthetic assistant record (one record). */
  model?: string
  effort?: string
}

/** Longest `model` / `effort` value a paged read reports, in UTF-16 code units (JS `.length`; Swift
 *  `utf16.count`); anything longer is not a model name. */
export const CHAT_META_MAX_CHARS = 100
/** The model claude stamps on a line it wrote itself (an API error, an interrupt) — not a model. */
const SYNTHETIC_MODEL = '<synthetic>'

/** A string field worth reporting as chat metadata, else undefined. */
export function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= CHAT_META_MAX_CHARS ? v : undefined
}
/** A transcript line's ISO `timestamp` as epoch ms; undefined when absent or not a date string. */
export function lineTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function parseChatRecords(
  records: Iterable<{ raw: string; offset: number }>,
  paged: boolean,
  opts?: ChatParseOptions
): ChatRecordsOut {
  const messages: ChatMessage[] = []
  const unmatched = new Map<string, string>()
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  let at: number | undefined
  // A snapshot of ONE record (paged only): the newest non-synthetic assistant record answers BOTH
  // fields, and a field it does not state (or states invalidly) is absent — never carried forward
  // from an older record, which may describe a different model or CLI. Same rule as
  // `parseLatestUsage` (context-tail.ts). `<synthetic>` lines (API errors, interrupts — measured
  // with no `effort`) are claude's own, not a model turn, so they are skipped entirely.
  let model: string | undefined
  let effort: string | undefined
  // The tool part of the LAST pushed message when that message is a local command still waiting for
  // its output record (cleared by any other push, so output attaches only to the record right
  // before it).
  let awaitingOutput: { family: 'slash' | 'bash'; part: Extract<ChatPart, { kind: 'tool' }> } | null = null
  const push = (m: ChatMessage, offset: number): void => {
    awaitingOutput = null
    // `at` rides BOTH paths (additive): the time the line was written, for the thread's relative
    // timestamp. Absent when the line states none — never a made-up time.
    const withAt = at === undefined ? m : { ...m, at }
    messages.push(paged ? { ...withAt, key: offset } : withAt)
  }
  for (const { raw, offset } of records) {
    if (!raw.trim()) continue
    let o: Parameters<typeof isHiddenMetaRecord>[0] & {
      timestamp?: unknown
      effort?: unknown
      message?: { content?: unknown; model?: unknown }
      attachment?: { type?: unknown; prompt?: unknown }
    }
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    // `null` / a number / a string parse fine and would throw on the reads below, failing the whole
    // page over one line another program wrote. One bad line costs one line (the Swift port agrees).
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue
    if (isHiddenMetaRecord(o)) continue
    at = lineTime(o.timestamp)
    const content = o.message?.content
    if (paged && o.type === 'assistant' && o.message?.model !== SYNTHETIC_MODEL) {
      model = metaString(o.message?.model)
      effort = metaString(o.effort)
    }
    if (o.type === 'assistant' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        name?: string
        id?: string
        input?: unknown
      }>) {
        if (!c || typeof c !== 'object') continue
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text })
        else if (c.type === 'tool_use') {
          const part: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: c.name ?? 'tool',
            arg: toolArg(c.input)
          }
          const body = toolBody(part.name, c.input)
          if (body) part.body = body
          if (part.name === ASK_USER_QUESTION_TOOL) {
            const questions = readQuestions(c.input)
            if (questions) part.questions = questions
          }
          if (paged && typeof c.id === 'string' && c.id) part.id = c.id
          parts.push(part)
          if (c.id) toolById.set(c.id, part)
        }
      }
      if (parts.length) push({ role: 'assistant', parts }, offset)
    } else if (o.type === 'user' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        tool_use_id?: string
        content?: unknown
      }>) {
        if (!c || typeof c !== 'object') continue
        // A non-string `text` is passed through as before; only a string is a paste to expand.
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: typeof c.text === 'string' ? userTextOf(c.text, opts) : c.text })
        else if (c.type === 'tool_result') {
          const tool = c.tool_use_id ? toolById.get(c.tool_use_id) : undefined
          const s = summarizeResult(c.content)
          if (tool) {
            if (s) tool.result = s
          } else if (paged && s && typeof c.tool_use_id === 'string' && c.tool_use_id) {
            // Its tool_use is in an OLDER window (claude writes the call before its result, so it
            // can never be in a newer one). Carried so the renderer can attach it later.
            unmatched.set(c.tool_use_id, s)
          }
        }
      }
      if (parts.length) push({ role: 'user', parts }, offset)
    } else if (o.type === 'user' && typeof content === 'string' && content.trim()) {
      // Not the user's words (a background task's completion, another session's message, an
      // auto-continuation): one assistant tool part, like a local command.
      const sys = classifySystemRecord(o, content)
      if (sys) {
        push({ role: 'assistant', parts: [systemPart(sys)] }, offset)
        continue
      }
      const cmd = classifyLocalCommand(content)
      if (cmd?.kind === 'command') {
        // The user running a command reads like a tool call — no new role or part kind on the wire.
        const part: Extract<ChatPart, { kind: 'tool' }> = { kind: 'tool', name: cmd.name, arg: cmd.arg }
        push({ role: 'assistant', parts: [part] }, offset)
        awaitingOutput = { family: cmd.family, part }
      } else if (cmd?.kind === 'output') {
        const s = summarizeResult(cmd.text)
        if (!s) continue
        if (awaitingOutput && awaitingOutput.family === cmd.family) {
          awaitingOutput.part.result = s
          awaitingOutput = null
        } else {
          push({ role: 'assistant', parts: [{ kind: 'tool', name: COMMAND_OUTPUT_TOOL, arg: '', result: s }] }, offset)
        }
      } else {
        push({ role: 'user', parts: [{ kind: 'text', text: userTextOf(content, opts) }] }, offset)
      }
    } else if (o.type === 'attachment' && o.attachment?.type === 'queued_command') {
      // A prompt submitted while a turn was running. Claude Code never records it as a `user`
      // entry: it delivers it at the next tool boundary of the SAME turn as this attachment
      // (measured, 2.1.281). Without this branch the prompt vanished from the chat history.
      const text = queuedPromptText(o.attachment.prompt, opts)
      if (text.trim()) push({ role: 'user', parts: [{ kind: 'text', text }] }, offset)
    }
  }
  const out: ChatRecordsOut = { messages, unmatched }
  // Keys only when stated: an absent key, never `model: undefined`, keeps the output deterministic
  // (and JSON-identical) for the ports locked to it.
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  return out
}

export function parseChatMessages(rawLines: string[], opts?: ChatParseOptions): ChatMessage[] {
  return parseChatRecords(
    rawLines.map((raw) => ({ raw, offset: 0 })),
    false,
    opts
  ).messages
}

/** A paged chat read's answer, minus `found` (the caller knows whether anything resolved). */
export interface ChatWindowParse {
  messages: ChatMessage[]
  olderCursor: number | null
  unmatchedResults: ChatCarriedToolResult[]
  /** The newest assistant record's model / effort among this window's complete lines. Absent (the
   *  key, not just the value) when no such record states one. */
  model?: string
  effort?: string
  /**
   * The window (not starting at 0) held no complete line: one record is bigger than the whole
   * window. Explicit rather than inferred from "no messages", because a window of complete lines
   * can legitimately yield no messages (metadata-only records). The reader (`readChatPage`) GROWS
   * the window on this flag — a pasted screenshot is routinely bigger than a page — and only past
   * the 5 MB cap takes the `olderCursor` below and skips the record. Never sent over the wire.
   */
  noCompleteLine: boolean
}

/**
 * Parse one byte window of a transcript. PURE — the local reader and the remote (SSH) leg hand it
 * the same kind of buffer, so both sides page identically.
 *
 * `buf` holds the file's bytes from absolute offset `bufStart` to the window end. When `bufStart`
 * is not 0, everything up to and including the first `\n` is dropped as a partial line, and
 * `olderCursor` is the offset right after that newline — where the first COMPLETE line starts,
 * i.e. the `before` of the next older page. Callers should start `buf` ONE BYTE before the window
 * they want (`readChatWindow` / `transcriptPageCommand` do): that lookbehind byte is the only way
 * to recognize a line that begins exactly on the window edge; without it such a line would be
 * dropped as partial.
 *
 * Working in bytes, not a decoded string, is what keeps the offsets exact: a line's key is the
 * absolute byte offset of its first byte, which a prepend or an append can never change, and a
 * multi-byte character cut by the window edge only ever lands in the dropped partial line (each
 * kept line is decoded on its own, from newline to newline).
 *
 * A line longer than the whole window leaves no complete line in it: `noCompleteLine` is set, and
 * `olderCursor` is `bufStart` — strictly older than the window end, so a caller that gives up
 * (`readChatPage`, only once the window is already at the 5 MB cap) keeps paging and skips that one
 * record. Answering the window end instead would ask for the identical window forever.
 */
export function parseChatWindow(
  buf: Buffer,
  bufStart: number,
  // The record parser for the window's complete lines. Claude's by default; another agent whose
  // transcript is also append-only JSONL (copilot's `events.jsonl`) passes its own, so the byte
  // window, the lookbehind and the cursor rules exist exactly once.
  parseRecords: (records: Iterable<{ raw: string; offset: number }>, paged: true) => ChatRecordsOut = parseChatRecords
): ChatWindowParse {
  const end = bufStart + buf.length
  let from = 0
  let olderCursor: number | null = null
  if (bufStart > 0) {
    const nl = buf.indexOf(0x0a)
    if (nl < 0 || bufStart + nl + 1 >= end) {
      return { messages: [], olderCursor: bufStart, unmatchedResults: [], noCompleteLine: true }
    }
    from = nl + 1
    olderCursor = bufStart + from
  }
  const records: Array<{ raw: string; offset: number }> = []
  while (from < buf.length) {
    const nl = buf.indexOf(0x0a, from)
    const to = nl < 0 ? buf.length : nl
    if (to > from) records.push({ raw: buf.toString('utf8', from, to), offset: bufStart + from })
    from = to + 1
  }
  const { messages, unmatched, model, effort } = parseRecords(records, true)
  return {
    messages,
    olderCursor,
    unmatchedResults: [...unmatched].map(([id, result]) => ({ id, result })),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    noCompleteLine: false
  }
}

/**
 * Read one window of a transcript for `parseChatWindow`: at most `maxBytes` ending at `before`
 * (`null`, or past EOF = the file size), plus one byte of lookbehind when the window does not start
 * at 0. `start` is the absolute offset of `data[0]` (the lookbehind byte, when there is one); `end`
 * the window end actually used. Undefined when the file cannot be read.
 */
export async function readChatWindow(
  filePath: string,
  page: { before: number | null; maxBytes: number }
): Promise<{ data: Buffer; start: number; end: number } | undefined> {
  try {
    const fd = await fs.promises.open(filePath, 'r')
    try {
      const { size } = await fd.stat()
      const end = page.before === null || page.before > size ? size : page.before
      const windowStart = Math.max(0, end - page.maxBytes)
      const start = windowStart > 0 ? windowStart - 1 : 0
      const length = end - start
      if (length <= 0) return { data: Buffer.alloc(0), start, end }
      const { buffer, bytesRead } = await fd.read({
        position: start,
        length,
        buffer: Buffer.alloc(length)
      })
      return { data: buffer.subarray(0, bytesRead), start, end: start + bytesRead }
    } finally {
      await fd.close()
    }
  } catch {
    return undefined
  }
}

export async function readChatMessages(filePath: string): Promise<ChatMessage[]> {
  const buf = await readCappedTail(filePath)
  if (buf === undefined) return []
  return parseChatMessages(buf.split('\n'))
}

// Claude session ids are UUID-like (hex + dashes). Reject anything else before it
// touches the filesystem — this alone prevents path traversal (no '/' or '.' possible).
export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/

// Fallback when context-tail isn't tracking the session (e.g. resumed after restart):
// find <sessionId>.jsonl anywhere under ~/.claude/projects/*.
//
// The hit is cached: session ids are immutable and a transcript never moves once created,
// and the renderer polls readSessionName every few seconds PER agent node — without the
// cache each poll re-scanned every project dir under ~/.claude/projects (heavy Claude users
// have hundreds). readSessionName drops the entry if the cached path stops being readable.
// Cache key includes the account: a session id is globally unique in practice, but keying by
// id alone would let a wrong-account hit return a still-existing path and silently read the
// wrong root after an account remove/re-add. Undefined account → `:` prefix (system default).
const transcriptPathCache = new Map<string, string>()
export async function resolveTranscriptPath(
  sessionId: string,
  accountId?: string
): Promise<string | undefined> {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  const cacheKey = `${accountId ?? ''}:${sessionId}`
  const cached = transcriptPathCache.get(cacheKey)
  if (cached) {
    // One cheap access() per hit (vs the O(project-dirs) scan below): heals a stale entry for
    // EVERY caller (chat/search/context-ensure too, not just the title poll) if the transcript
    // was deleted — otherwise they'd keep getting a dead path and skip their cwd fallbacks.
    try {
      await fs.promises.access(cached)
      return cached
    } catch {
      transcriptPathCache.delete(cacheKey)
    }
  }
  const root = transcriptRoot(accountId)
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(root)
  } catch {
    return undefined
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    try {
      await fs.promises.access(p)
      transcriptPathCache.set(cacheKey, p)
      return p
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/**
 * Does a transcript for this session id exist under the account's root — `present`, `absent`, or
 * `unknown` because we could not look?
 *
 * `resolveTranscriptPath` above answers `undefined` for BOTH "there is no such transcript" and
 * "the root could not be read", which is fine for every reader (they all fall back to a cwd scan
 * or return nothing) and fatal for the one caller that acts on absence: cold restore drops a dead
 * `--resume <id>` on `absent`, and a `$HOME` that is momentarily unreadable must never be allowed
 * to look like a deleted conversation. So this is the resolver plus exactly one more question —
 * NOT a second way of finding a transcript.
 *
 * Deliberately sessionId-ONLY: there is no cwd fallback here. `resolveTranscript`'s fallback
 * answers with the newest transcript in a project directory, which is a different session's file
 * and would report `present` for an id that is genuinely gone.
 */
export async function transcriptPresence(
  sessionId: string,
  accountId?: string
): Promise<'present' | 'absent' | 'unknown'> {
  if (!SESSION_ID_RE.test(sessionId)) return 'unknown'
  if (await resolveTranscriptPath(sessionId, accountId)) return 'present'
  // The miss is only meaningful if the root was readable. Probed with `readdir`, the same call
  // the scan above makes — an `access` can succeed on a directory a `readdir` is refused.
  try {
    await fs.promises.readdir(transcriptRoot(accountId))
  } catch {
    return 'unknown'
  }
  return 'absent'
}

// Read only the last `cap` bytes of a file as UTF-8 (whole file if smaller). Drops the partial
// leading line on a capped read. Cheaper than readCappedTail for tiny scans (session title).
//
// Exported for the OTHER title readers routed by core/agent-session-name.ts (gemini's), which need
// the identical bounded read of a different agent's transcript. It is a byte-level file helper and
// knows nothing about claude's layout — the storage-specific parsing stays in each agent's module.
export async function readSmallTail(filePath: string, cap: number): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size <= cap) return await fs.promises.readFile(filePath, 'utf8')
    const fd = await fs.promises.open(filePath, 'r')
    try {
      const { buffer } = await fd.read({
        position: stat.size - cap,
        length: cap,
        buffer: Buffer.alloc(cap)
      })
      const s = buffer.toString('utf8')
      const nl = s.indexOf('\n')
      return nl >= 0 ? s.slice(nl + 1) : s
    } finally {
      await fd.close()
    }
  } catch {
    return undefined
  }
}

// Pure: pick a session's display name from transcript text. Prefers the user's `/rename` name
// (latest `custom-title` record's `customTitle`), else Claude's auto name (latest `ai-title`'s
// `aiTitle`) — mirroring what `/resume` shows. Returns null if neither is present.
export function pickSessionName(text: string): string | null {
  let custom: string | null = null
  let ai: string | null = null
  for (const raw of text.split('\n')) {
    if (!raw.includes('title')) continue
    try {
      const o = JSON.parse(raw) as { type?: string; customTitle?: unknown; aiTitle?: unknown }
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle
      else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle
    } catch {
      /* skip non-JSON line */
    }
  }
  const name = (custom ?? ai)?.trim()
  return name ? name : null
}

// The current display name of a Claude session, read from its transcript. This is the name shown
// in `/resume` — the authoritative source, since `/rename` does NOT push to the OSC terminal
// title. Resolved STRICTLY by sessionId: the cwd is intentionally not a fallback here, because
// multiple Claude nodes in one folder would all resolve to the same newest transcript and adopt
// each other's names. Returns null until the node's own sessionId is known.
export const TITLE_TAIL_BYTES = 128 * 1024

// An SSH project's agent runs on the REMOTE host, so its transcript lives on the remote
// filesystem — `transcriptRoot()` is this machine's `$HOME` and can never resolve it. Main
// registers a reader here (backed by the hook-fed remote transcript path + the project's
// ControlMaster), mirroring the `setGitRemoteResolver` registry in remote-git.ts, so the reader
// stays electron-free and this module keeps its signature. Returns null when `sessionId` is not
// a live remote session, which is the signal to use the local path.
export interface RemoteTranscriptTail {
  text: string
}
let remoteReader: ((sessionId: string) => Promise<RemoteTranscriptTail | null>) | null = null
export function setRemoteTranscriptReader(
  fn: ((sessionId: string) => Promise<RemoteTranscriptTail | null>) | null
): void {
  remoteReader = fn
}

// Title polls hit this every 4–15 s per agent node. The name can only change when the transcript
// does, so (size, mtime) gates the 128 KB tail read. Keyed by the RESOLVED path (the account is
// already folded into it). Bounded: oldest entries go first. A failed tail read is not cached — a
// transient error must not pin a null title until the file next changes.
const TITLE_CACHE_MAX = 500
const titleCache = new Map<string, { size: number; mtimeMs: number; name: string | null }>()

export async function readSessionName(
  sessionId: string,
  accountId?: string
): Promise<string | null> {
  if (!sessionId) return null
  // Remote first: a remote session is never present under the local transcript root, so falling
  // through to the local scan would be pure waste (the title poll runs every 4s per agent node).
  if (remoteReader) {
    const remote = await remoteReader(sessionId)
    if (remote) return remote.text ? pickSessionName(remote.text) : null
  }
  // Stale cache entries are healed inside resolveTranscriptPath (access-checked per hit).
  const p = await resolveTranscriptPath(sessionId, accountId)
  if (!p) return null
  const st = await fs.promises.stat(p).catch(() => null)
  const hit = st ? titleCache.get(p) : undefined
  if (st && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.name
  const tail = await readSmallTail(p, TITLE_TAIL_BYTES)
  const name = tail ? pickSessionName(tail) : null
  if (st && tail !== undefined) {
    titleCache.delete(p)
    titleCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, name })
    if (titleCache.size > TITLE_CACHE_MAX) titleCache.delete(titleCache.keys().next().value!)
  }
  return name
}

// Durable resolver by working directory: Claude stores a project's transcripts under
// ~/.claude/projects/<cwd with every '/' and '.' replaced by '-'>/. We pick the most
// recently modified .jsonl there — the node's active session. Unlike the sessionId path
// this needs no live hook event, so the find-bar works even after a reload/restart or when
// reattaching to a session this app instance didn't spawn. (Encoding leaves no '/', so it
// can't traverse.) Limitation: multiple Claude nodes in the SAME cwd resolve to the same
// newest transcript — the sessionId path above is preferred when known for that reason.

/** The per-cwd directory name Claude uses under a transcript root. Exported because the REMOTE
 *  locator (remote-transcript-locate.ts) must encode a host path the identical way — a second
 *  copy that drifted would make the exact-path probe silently never hit. */
export function encodeTranscriptDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

export async function transcriptPathForCwd(
  cwd: string,
  accountId?: string
): Promise<string | undefined> {
  if (!cwd) return undefined
  const dir = path.join(transcriptRoot(accountId), encodeTranscriptDir(cwd))
  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return undefined
  }
  let newest: { path: string; mtime: number } | undefined
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue
    const p = path.join(dir, e)
    try {
      const st = await fs.promises.stat(p)
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs }
    } catch {
      /* skip */
    }
  }
  return newest?.path
}
