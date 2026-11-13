// opencode's conversation as the ⌘M panel's structured messages — and the bounded read behind it.
//
// Separate from `transcript-reader.ts`'s claude parser and from `grok-chat.ts`: opencode has no
// transcript FILE. Since 1.18 it keeps sessions in SQLite (a database that also holds its account
// tokens, so it is never opened here), and `opencode export <id>` is the contract — the same one
// Context Link reads (`linesFromOpencodeExport`). One export is ONE JSON document, so there are no
// byte offsets to page by: a read returns one page (`olderCursor: null`), exactly as grok does.
//
// MEASURED on opencode 1.18.25 (2026-09-28) — every shape below comes from its schema (the Effect
// structs `UserMessage` / `AssistantMessage` / `Part` in the shipped binary) and was checked against
// the 10 sessions, 25 messages and 65 parts on the measuring host:
//
//   document   {info: Session, messages: [{info: Message, parts: Part[]}]}; `info.id` is the session
//   user       info {id, sessionID, role:"user", time:{created}, agent, model:{providerID, modelID,
//              variant?}, summary?, system?, tools?}
//   assistant  info {id, sessionID, role:"assistant", parentID, modelID, providerID, mode, agent,
//              path, cost, tokens, time:{created, completed?}, finish?, variant?, summary?:true
//              (a compaction summary), error?: {name, data:{message?, …}}}
//   parts      text {text, synthetic?, ignored?, time?} · reasoning {text, time} · tool {callID,
//              tool, state} · file {mime, url, filename?} · agent {name} · subtask {prompt,
//              description, agent, command?} · compaction {auto, overflow?} · retry {attempt, error}
//              · step-start · step-finish · snapshot · patch
//   tool state pending {input, raw} · running {input, title?, time} · completed {input, output,
//              title, metadata, time} · error {input, error, time}
//   errors     ProviderAuthError · UnknownError · MessageOutputLengthError (data {}) ·
//              MessageAbortedError · StructuredOutputError · ContextOverflowError ·
//              ContentFilterError · APIError — all `{name, data}`
//
// Every mapping rule is written down in `src/shared/chat-fixtures/opencode/README.md` for the iOS
// port, and pinned by the golden fixtures there.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { CHAT_PAGE_MAX_BYTES, type ChatTranscriptPage } from '../shared/chat-page'
import { findInLoginPath } from './exec-path'
import { isSafeOpencodeSessionId, runOpencodeExportAt, type OpencodeExportOutcome } from './opencode-export'
import { isRecord } from '../shared/is-record'

/** Same bounds as claude's reader (`summarizeResult` / `metaString`). */
const TOOL_RESULT_LINES = 3
const TOOL_RESULT_MAX = 500
const CHAT_META_MAX_CHARS = 100

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

export interface OpencodeChatParse {
  messages: ChatMessage[]
  /** Records that could not be mapped (not an object, no `info`, an unknown role or part type, a
   *  message filed under another session, a malformed field). Skipped, never rendered raw. */
  skipped: number
  /** The newest assistant message's `modelID` — absent when it states none (never carried). */
  model?: string
  /** The newest assistant message's `variant` (opencode's reasoning-effort variant). */
  effort?: string
}

function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= CHAT_META_MAX_CHARS ? v : undefined
}

function summarize(text: string): string {
  return text.split('\n').slice(0, TOOL_RESULT_LINES).join(' ').slice(0, TOOL_RESULT_MAX)
}

/**
 * The one input worth showing on a collapsed tool chip, for opencode's builtin tools (bash
 * `command`, read/write/edit `filePath`, grep/glob `pattern`, list `path`, webfetch `url`,
 * websearch/codesearch `query`, task `description`/`prompt`, skill `name`, question
 * `questions[0].question`). The key ORDER is the rule: `pattern` before `path`, because a grep's
 * meaning is its pattern. Else the `title` opencode wrote for the call, else nothing. Capped like
 * every tool arg (`CHAT_TOOL_ARG_MAX` UTF-16 units).
 */
export function opencodeToolArg(input: unknown, title?: unknown): string {
  let v: unknown
  if (isRecord(input)) {
    for (const k of ['command', 'filePath', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'name']) {
      if (typeof input[k] === 'string') {
        v = input[k]
        break
      }
    }
    if (v === undefined && Array.isArray(input.questions) && isRecord(input.questions[0])) {
      const q = input.questions[0].question
      if (typeof q === 'string') v = q
    }
  }
  if (v === undefined && typeof title === 'string') v = title
  return typeof v === 'string' ? v.slice(0, CHAT_TOOL_ARG_MAX) : ''
}

/** A tool part's chip. `null` = not a mappable tool part. */
function toolPart(p: Record<string, unknown>): ToolPart | null {
  const state = p.state
  if (!isRecord(state)) return null
  const part: ToolPart = {
    kind: 'tool',
    name: typeof p.tool === 'string' && p.tool ? p.tool : 'tool',
    arg: opencodeToolArg(state.input, state.title)
  }
  // Claude-only card fields (`body`, `questions`) and the paged `id` are never set: opencode's
  // `question` tool looks like AskUserQuestion, but answer cards are claude's, and this reader does
  // not page.
  if (state.status === 'completed' && typeof state.output === 'string') {
    const s = summarize(state.output)
    if (s) part.result = s
  } else if (state.status === 'error' && typeof state.error === 'string') {
    part.result = summarize(`Error: ${state.error}`)
  }
  return part
}

/** The sentence an errored assistant message ends with. `null` = malformed (counted as skipped). */
function errorText(e: unknown): string | null {
  if (!isRecord(e)) return null
  const name = typeof e.name === 'string' && e.name ? e.name : 'Error'
  const message = isRecord(e.data) && typeof e.data.message === 'string' ? e.data.message.trim() : ''
  return message ? `[${name}] ${message}` : `[${name}]`
}

/** Parts dropped ON PURPOSE (not counted as skipped): model reasoning (the same product decision
 *  claude's and grok's readers make) and bookkeeping that is not conversation. `file` and `agent`
 *  are attachments and @-mentions; their text is already in the prompt, and claude's reader drops
 *  non-text user content the same way. */
const DROPPED_PARTS = new Set(['reasoning', 'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'file', 'agent'])

// ── opencode 2.x messages ───────────────────────────────────────────────────────────────────────
//
// MEASURED on @opencode/cli 2.2.7 (2026-11-13, issue #1438): one real export (a prompt, a `read`
// tool call, the answer) plus the Effect structs `Session.Message.*` in the shipped binary. The
// document is still `{info: Session, messages}` with `info.id` the session — but a message has NO
// `info` / `parts`. It is a flat record discriminated by `type`, all carrying `{id, time:{created}}`:
//
//   user        {text, files?, agents?, skills?}
//   assistant   {agent, model:{id, providerID, variant}, content: Content[], finish?, error?, retry?}
//   content     text {text} · reasoning {text} · tool {id, name, executed?, state}
//   tool state  streaming {input: STRING} · running {input, metadata} · completed {input, content:
//               (text {text} | file {uri, mime, name?})[]} · error {input, error, content?}
//   shell       {command, status, exit?, output?: {output, truncated, …}} — the user's own `!cmd`
//   compaction  {status: running|completed|failed, reason: auto|manual, summary}
//   synthetic · system · skill      harness text the human did not type
//   agent-switched · model-switched · location-switched · idle      bookkeeping
//   error       {type, message, status?, …} (`Session.StructuredError`) wherever one appears
//
// Only the user / assistant-text / completed-tool path was seen in a real export; every other
// mapping is composed from the schema. A wrong guess costs a missing chip, never wrong text.

/** Entries dropped ON PURPOSE (not counted): text the human did not write, and bookkeeping. */
const V2_DROPPED_ENTRIES = new Set([
  'synthetic',
  'system',
  'skill',
  'agent-switched',
  'model-switched',
  'location-switched',
  'idle'
])

/** A 2.x structured error as the `[name] message` sentence 1.x errors end with. */
function v2ErrorText(e: unknown): string | null {
  if (!isRecord(e)) return null
  const name = typeof e.type === 'string' && e.type ? e.type : 'Error'
  const message = typeof e.message === 'string' ? e.message.trim() : ''
  return message ? `[${name}] ${message}` : `[${name}]`
}

/** A 2.x tool content block's chip. `null` = not a mappable tool block. */
function v2ToolPart(p: Record<string, unknown>): ToolPart | null {
  const state = p.state
  if (!isRecord(state)) return null
  const part: ToolPart = {
    kind: 'tool',
    name: typeof p.name === 'string' && p.name ? p.name : 'tool',
    // `streaming` carries the raw argument STRING, which `opencodeToolArg` reads as nothing.
    arg: opencodeToolArg(state.input)
  }
  if (state.status === 'completed' && Array.isArray(state.content)) {
    const text = state.content
      .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
    const s = summarize(text)
    if (s) part.result = s
  } else if (state.status === 'error' && isRecord(state.error) && typeof state.error.message === 'string') {
    part.result = summarize(`Error: ${state.error.message}`)
  }
  return part
}

/** One 2.x entry (`type` is a string). `meta` is set for every assistant entry, message or not. */
function v2Entry(entry: Record<string, unknown>): {
  messages: ChatMessage[]
  skipped: number
  meta?: { model: unknown; effort: unknown }
} {
  const created = isRecord(entry.time) ? entry.time.created : undefined
  const at = typeof created === 'number' && Number.isFinite(created) ? created : undefined
  const stamp = (m: ChatMessage): ChatMessage => (at === undefined ? m : { ...m, at })
  const one = (m: ChatMessage | null, skipped = 0) => ({ messages: m ? [stamp(m)] : [], skipped })

  switch (entry.type) {
    case 'user':
      if (typeof entry.text !== 'string') return one(null, 1)
      return one(entry.text ? { role: 'user', parts: [{ kind: 'text', text: entry.text }] } : null)
    case 'assistant': {
      // `variant: "default"` is what 2.x writes when no variant was chosen — not an effort.
      const model = isRecord(entry.model) ? entry.model : {}
      const meta = { model: model.id, effort: model.variant === 'default' ? undefined : model.variant }
      if (!Array.isArray(entry.content)) return { messages: [], skipped: 1, meta }
      let skipped = 0
      const parts: ChatPart[] = []
      for (const p of entry.content) {
        if (!isRecord(p) || typeof p.type !== 'string') {
          skipped++
        } else if (p.type === 'text') {
          if (typeof p.text !== 'string') skipped++
          else if (p.text) parts.push({ kind: 'text', text: p.text })
        } else if (p.type === 'tool') {
          const t = v2ToolPart(p)
          if (t) parts.push(t)
          else skipped++
        } else if (p.type !== 'reasoning') {
          skipped++
        }
      }
      if (entry.error !== undefined) {
        const t = v2ErrorText(entry.error)
        if (t === null) skipped++
        else parts.push({ kind: 'text', text: t })
      }
      return { ...one(parts.length ? { role: 'assistant', parts } : null, skipped), meta }
    }
    case 'shell': {
      if (typeof entry.command !== 'string') return one(null, 1)
      const chip: ToolPart = { kind: 'tool', name: 'shell', arg: entry.command.slice(0, CHAT_TOOL_ARG_MAX) }
      const output = isRecord(entry.output) ? entry.output.output : undefined
      const s = typeof output === 'string' ? summarize(output) : ''
      if (s) chip.result = s
      return one({ role: 'assistant', parts: [chip] })
    }
    case 'compaction': {
      const parts: ChatPart[] = [{ kind: 'tool', name: 'compaction', arg: entry.reason === 'auto' ? 'auto' : '' }]
      // The summary is the conversation from here on, exactly as 1.x's `summary: true` message is.
      if (entry.status === 'completed' && typeof entry.summary === 'string' && entry.summary) {
        parts.push({ kind: 'text', text: entry.summary })
      }
      return one({ role: 'assistant', parts })
    }
    default:
      return one(null, V2_DROPPED_ENTRIES.has(entry.type as string) ? 0 : 1)
  }
}

/**
 * One `opencode export` document → ordered bubbles. `null` when the text is not an export of
 * `sessionId` — not JSON, not an object, or `info.id` names another session. That check is what
 * makes "never another session's transcript" a property of the parser rather than of the caller.
 */
export function parseOpencodeExport(raw: string, sessionId: string): OpencodeChatParse | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(doc) || !isRecord(doc.info) || doc.info.id !== sessionId) return null

  const messages: ChatMessage[] = []
  let skipped = 0
  let lastMeta: { model: unknown; effort: unknown } | undefined
  const entries = Array.isArray(doc.messages) ? doc.messages : []
  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped++
      continue
    }
    if (!isRecord(entry.info)) {
      // No per-message `info`: an opencode 2.x entry, which states its kind in `type` instead.
      if (typeof entry.type !== 'string') {
        skipped++
        continue
      }
      const v2 = v2Entry(entry)
      skipped += v2.skipped
      messages.push(...v2.messages)
      if (v2.meta) lastMeta = v2.meta
      continue
    }
    const info = entry.info
    // A message filed under another session is never shown, even inside this session's export.
    if (info.sessionID !== undefined && info.sessionID !== sessionId) {
      skipped++
      continue
    }
    const role = info.role
    if ((role !== 'user' && role !== 'assistant') || !Array.isArray(entry.parts)) {
      skipped++
      continue
    }
    const created = isRecord(info.time) ? info.time.created : undefined
    const at = typeof created === 'number' && Number.isFinite(created) ? created : undefined
    const stamp = (m: ChatMessage): ChatMessage => (at === undefined ? m : { ...m, at })

    // `own` = the speaker's parts; `chips` = what a USER message carries that the human did not
    // type (a compaction, a subtask): an assistant-side tool chip right after, never a user bubble.
    const own: ChatPart[] = []
    const chips: ChatPart[] = []
    for (const p of entry.parts) {
      if (!isRecord(p) || typeof p.type !== 'string') {
        skipped++
        continue
      }
      switch (p.type) {
        case 'text':
          if (typeof p.text !== 'string') {
            skipped++
            break
          }
          // Harness text (`synthetic`: an @-mentioned file read in full, "the following tool was
          // executed by the user") and `ignored` text were not written by the speaker.
          if (p.synthetic === true || p.ignored === true || !p.text) break
          own.push({ kind: 'text', text: p.text })
          break
        case 'tool': {
          const t = toolPart(p)
          if (t) (role === 'user' ? chips : own).push(t)
          else skipped++
          break
        }
        case 'compaction':
          chips.push({ kind: 'tool', name: 'compaction', arg: p.auto === true ? 'auto' : '' })
          break
        case 'subtask':
          chips.push({ kind: 'tool', name: 'task', arg: opencodeToolArg({ description: p.description, prompt: p.prompt }) })
          break
        default:
          if (!DROPPED_PARTS.has(p.type)) skipped++
      }
    }

    if (role === 'assistant') {
      lastMeta = { model: info.modelID, effort: info.variant }
      if (info.error !== undefined) {
        const t = errorText(info.error)
        if (t === null) skipped++
        else own.push({ kind: 'text', text: t })
      }
      const parts = [...own, ...chips]
      if (parts.length) messages.push(stamp({ role: 'assistant', parts }))
    } else {
      if (own.length) messages.push(stamp({ role: 'user', parts: own }))
      if (chips.length) messages.push(stamp({ role: 'assistant', parts: chips }))
    }
  }

  const out: OpencodeChatParse = { messages, skipped }
  // ONE message answers both fields; an absent field is absent, never carried from an older one.
  const model = metaString(lastMeta?.model)
  const effort = metaString(lastMeta?.effort)
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  return out
}

/** The newest messages whose JSON fits in `maxBytes` (UTF-8), in order. Like grok's capped tail,
 *  the cut is not announced (`olderCursor` stays null). */
export function newestWithinBytes(messages: ChatMessage[], maxBytes: number): ChatMessage[] {
  let total = 0
  let i = messages.length
  while (i > 0) {
    const size = Buffer.byteLength(JSON.stringify(messages[i - 1]))
    if (total + size > maxBytes) break
    total += size
    i--
  }
  return messages.slice(i)
}

/** Same growth as claude's paged reader (`parseGrowingWindow`): a page that holds no whole message
 *  is re-evaluated at ×4 the size, up to the legacy 5 MB cap. */
const PAGE_GROWTH = 4

const TRUNCATED_NOTE = (droppedBytes: number) =>
  `\n\n[… truncated: ${Math.ceil(droppedBytes / 1024)} KB more of this message is only in opencode]`

/** `text` cut to at most `maxBytes` UTF-8 bytes, never splitting a surrogate pair. */
function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text) <= maxBytes) return text
  let lo = 0
  let hi = Math.min(text.length, maxBytes)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let out = text.slice(0, lo)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/**
 * One message too big for the largest page: its text parts cut (largest first) until its JSON fits
 * `maxBytes`, each cut announced in the text itself. Better than the alternative the byte budget
 * leaves — `messages: []` with `found: true`, which reads as an empty conversation. Tool chips are
 * already bounded (arg 200, result 500 units), so text is the only thing that can be this big.
 */
export function truncateMessage(m: ChatMessage, maxBytes: number): ChatMessage {
  const parts = m.parts.map((p) => ({ ...p }))
  const size = () => Buffer.byteLength(JSON.stringify({ ...m, parts }))
  // JSON escaping can make a text's serialized form larger than its UTF-8 bytes, so iterate.
  for (let guard = 0; guard < 8 && size() > maxBytes; guard++) {
    let idx = -1
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (p.kind === 'text' && (idx < 0 || p.text.length > (parts[idx] as { text: string }).text.length)) idx = i
    }
    if (idx < 0) break
    const p = parts[idx] as Extract<ChatPart, { kind: 'text' }>
    const over = size() - maxBytes
    const full = Buffer.byteLength(p.text)
    const note = TRUNCATED_NOTE(full)
    const keep = Math.max(0, full - over - Buffer.byteLength(JSON.stringify(note)) - 64 * (guard + 1))
    const kept = cutToBytes(p.text, keep)
    p.text = kept + TRUNCATED_NOTE(full - Buffer.byteLength(kept))
  }
  return { ...m, parts }
}

/**
 * The messages a page answers with. `maxBytes` is the caller's own window (the panel's tail read,
 * the phone's 256 KB) and is honoured; when it holds no whole message the window grows exactly as
 * claude's does (×4, up to 5 MB); a newest message bigger even than that is shown truncated.
 */
export function opencodePageMessages(messages: ChatMessage[], maxBytes: number): ChatMessage[] {
  if (!messages.length) return []
  let bytes = Math.min(maxBytes, CHAT_PAGE_MAX_BYTES)
  for (;;) {
    const out = newestWithinBytes(messages, bytes)
    if (out.length) return out
    if (bytes >= CHAT_PAGE_MAX_BYTES) break
    bytes = Math.min(CHAT_PAGE_MAX_BYTES, bytes * PAGE_GROWTH)
  }
  return [truncateMessage(messages[messages.length - 1], CHAT_PAGE_MAX_BYTES)]
}

// ── The change gate: stat opencode's database, never open it ─────────────────────────────────

/** opencode's data directory, resolved the way opencode resolves it (xdg-basedir's `xdgData`:
 *  `$XDG_DATA_HOME`, else `~/.local/share` — on every platform) plus `opencode`. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const base = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return path.join(base, 'opencode')
}

/** `opencode.db`, a channel build's `opencode-<channel>.db`, and their WALs. */
const OPENCODE_DB_FILE = /^opencode(-[A-Za-z0-9._-]+)?\.db(-wal)?$/

/**
 * A fingerprint of opencode's session store: size, mtime (ns), ctime and inode of every database
 * and WAL file in `dir`, from `readdir` + `stat` — the database itself is never opened (it also
 * holds opencode's account tokens). `null` = we cannot vouch for the store, so nothing is cached:
 * no database file found (a relocated store we would otherwise see as "never changes"), the
 * directory unreadable, or `OPENCODE_DB` pointing opencode somewhere else.
 */
export async function opencodeDbFingerprint(
  dir: string = opencodeDataDir(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (env.OPENCODE_DB) return null
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => OPENCODE_DB_FILE.test(n)).sort()
    if (!names.some((n) => n.endsWith('.db'))) return null
    const rows = await Promise.all(
      names.map(async (n) => {
        const st = await fs.promises.stat(path.join(dir, n), { bigint: true })
        return `${n}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`
      })
    )
    return rows.join('|')
  } catch {
    return null
  }
}

export interface OpencodeChatCache {
  fingerprint(): Promise<string | null>
  get(sessionId: string, fingerprint: string): OpencodeChatParse | undefined
  set(sessionId: string, fingerprint: string, parsed: OpencodeChatParse): void
}

/** A few sessions' parsed exports, keyed by the store fingerprint taken BEFORE their export, LRU. */
export function createOpencodeChatCache(opts: {
  fingerprint: () => Promise<string | null>
  maxSessions: number
}): OpencodeChatCache {
  const entries = new Map<string, { fingerprint: string; parsed: OpencodeChatParse }>()
  return {
    fingerprint: opts.fingerprint,
    get(sessionId, fingerprint) {
      const e = entries.get(sessionId)
      if (!e || e.fingerprint !== fingerprint) return undefined
      entries.delete(sessionId)
      entries.set(sessionId, e)
      return e.parsed
    },
    set(sessionId, fingerprint, parsed) {
      entries.delete(sessionId)
      entries.set(sessionId, { fingerprint, parsed })
      while (entries.size > opts.maxSessions) entries.delete(entries.keys().next().value as string)
    }
  }
}

let defaultCache: OpencodeChatCache | undefined
export function defaultOpencodeChatCache(): OpencodeChatCache {
  defaultCache ??= createOpencodeChatCache({ fingerprint: () => opencodeDbFingerprint(), maxSessions: 4 })
  return defaultCache
}

// ── The export gate ─────────────────────────────────────────────────────────────────────────────

export type OpencodeExportRun = (sessionId: string, opts?: { background?: boolean }) => Promise<OpencodeExportOutcome>

export interface OpencodeExportGateOptions {
  /** Minimum time between two export STARTS for one session, for a read the user asked for. */
  minSpacingMs: number
  /** The same, for a BACKGROUND live refresh (hook-driven, while the agent works). Defaults to
   *  `minSpacingMs`. An explicit read joining a background refresh still sleeping wakes it. */
  backgroundSpacingMs?: number
  /** Most exports running at once, across sessions. */
  maxConcurrent: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * One export costs 1.0–1.7 s and ~320 MB (measured), and the ⌘M panel re-reads on every hook event
 * while the agent works — from the canvas node, the card modal and the phone at once. The gate:
 *
 *  - joins a caller to an export that has not STARTED yet (its answer is still fresh for them);
 *  - gives a caller arriving while one RUNS a new export started after it — never a stale answer,
 *    which would leave the panel's final turn-end read one turn behind — shared by every such caller;
 *  - spaces starts for one session by `minSpacingMs` (an explicit read) or `backgroundSpacingMs`
 *    (a live refresh), and caps exports running at once;
 *  - caches nothing itself: a failure is answered once and the next call runs again. Answering an
 *    UNCHANGED store without exporting is the change gate's job (`opencodeDbFingerprint`).
 */
export function createOpencodeExportGate(run: OpencodeExportRun, opts: OpencodeExportGateOptions): OpencodeExportRun {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const bgSpacing = opts.backgroundSpacingMs ?? opts.minSpacingMs
  const longest = Math.max(opts.minSpacingMs, bgSpacing)
  interface Waiting {
    job: Promise<OpencodeExportOutcome>
    background: boolean
    wake: () => void
  }
  interface Session {
    waiting?: Waiting
    running?: Promise<OpencodeExportOutcome>
    lastStart: number
  }
  const sessions = new Map<string, Session>()
  let active = 0
  const queue: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < opts.maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise((r) => queue.push(r))
  }
  const release = (): void => {
    const next = queue.shift()
    if (next) next()
    else active--
  }
  const prune = (): void => {
    const t = now()
    for (const [id, s] of sessions) {
      if (!s.waiting && !s.running && t - s.lastStart > longest) sessions.delete(id)
    }
  }

  return (sessionId, callOpts) => {
    prune()
    let s = sessions.get(sessionId)
    if (!s) {
      s = { lastStart: -Infinity }
      sessions.set(sessionId, s)
    }
    const st = s
    const background = callOpts?.background === true
    if (st.waiting) {
      // An open or Retry the user asked for is not held behind a background refresh's spacing.
      if (!background && st.waiting.background) {
        st.waiting.background = false
        st.waiting.wake()
      }
      return st.waiting.job
    }
    let wake!: () => void
    const woken = new Promise<void>((r) => (wake = r))
    const w = { background, wake } as Waiting
    // Assigned before its body's first `await` returns, so the body can recognise itself.
    w.job = (async () => {
      if (st.running) await st.running
      const wait = st.lastStart + (w.background ? bgSpacing : opts.minSpacingMs) - now()
      if (wait > 0) await Promise.race([sleep(wait), woken])
      await acquire()
      // Started: later callers get the NEXT export, not this one.
      if (st.waiting === w) st.waiting = undefined
      st.lastStart = now()
      const running = (async (): Promise<OpencodeExportOutcome> => {
        try {
          return await run(sessionId)
        } catch {
          return { ok: false }
        } finally {
          release()
        }
      })()
      st.running = running
      const out = await running
      if (st.running === running) st.running = undefined
      return out
    })()
    st.waiting = w
    return w.job
  }
}

/** A chat export is interactive: 20 s is ~10× the measured cost, and a wedged CLI must not hold the
 *  panel's single-flight read for Context Link's full minute. */
export const OPENCODE_CHAT_EXPORT_TIMEOUT_MS = 20_000

let defaultExport: OpencodeExportRun | undefined
/** The real, gated `opencode export` — resolved through the login PATH like Context Link's. */
export function defaultOpencodeExport(): OpencodeExportRun {
  defaultExport ??= createOpencodeExportGate(
    async (sessionId) => {
      const bin = await findInLoginPath('opencode')
      return bin ? runOpencodeExportAt(bin, sessionId, OPENCODE_CHAT_EXPORT_TIMEOUT_MS) : { ok: false }
    },
    // A read the user asked for (open, ↻, Retry) is immediate; the panel's hook-driven refreshes
    // during a turn are spaced to one export per 5 s per session.
    { minSpacingMs: 0, backgroundSpacingMs: 5000, maxConcurrent: 2 }
  )
  return defaultExport
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

/**
 * `chat:read-transcript` for an opencode node. Rules, each a refusal:
 *
 *  - A REMOTE node (`remoteOnly`) is refused before anything runs: its sessions live in the HOST's
 *    database, and an export here would answer from the wrong machine (or find a same-id session
 *    that is not this one). There is no remote leg yet — see CLAUDE.md.
 *  - No session id, or one we would not put on argv, is not found and runs nothing: a bare
 *    `opencode export` opens a picker over the NEWEST sessions — someone else's.
 *  - `absent` (opencode looked) is a clean miss; any other export failure is `unreadable`.
 *  - An export whose `info.id` is not this session is `unreadable`, and none of it is shown.
 *  - An OLDER-page request has nothing to give (this reader never hands out a cursor).
 */
export async function readOpencodeChat(
  q: { sessionId?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null,
  run?: OpencodeExportRun,
  cache?: OpencodeChatCache | null
): Promise<ChatTranscriptResult> {
  // An injected runner (a test seam) gets no cache unless one is passed with it.
  const exportRun = run ?? defaultOpencodeExport()
  const store = cache === undefined ? (run ? null : defaultOpencodeChatCache()) : cache
  const notFound = (): ChatTranscriptResult =>
    page ? { messages: [], found: false, olderCursor: null, unmatchedResults: [] } : { messages: [], found: false }
  const unreadable = (): ChatTranscriptResult => (page ? { ...notFound(), unreadable: true } : notFound())
  if (q.remoteOnly) return unreadable()
  if (page && page.before !== null) return { messages: [], found: true, olderCursor: null, unmatchedResults: [] }
  const sessionId = q.sessionId
  if (!sessionId || !isSafeOpencodeSessionId(sessionId)) return notFound()
  // Taken BEFORE the export: a write that lands while it runs changes the next fingerprint, so the
  // next read exports again rather than serving this (possibly older) answer.
  const fingerprint = store ? await store.fingerprint() : null
  let parsed = fingerprint !== null && store ? store.get(sessionId, fingerprint) : undefined
  if (!parsed) {
    const out = await exportRun(sessionId, { background: page?.background === true })
    if (!out.ok) return out.absent ? notFound() : unreadable()
    const fresh = parseOpencodeExport(out.stdout, sessionId)
    if (!fresh) return unreadable()
    parsed = fresh
    if (fingerprint !== null && store) store.set(sessionId, fingerprint, fresh)
  }
  const messages = opencodePageMessages(parsed.messages, page ? page.maxBytes : CHAT_PAGE_MAX_BYTES)
  if (!page) return { messages, found: true }
  return {
    messages,
    found: true,
    olderCursor: null,
    unmatchedResults: [],
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.effort !== undefined ? { effort: parsed.effort } : {})
  }
}
