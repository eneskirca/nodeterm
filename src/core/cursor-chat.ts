// Cursor Agent CLI's conversation as the ⌘M panel's structured messages, plus the locator and the
// read-only store reader behind it.
//
// Where it lives (MEASURED on cursor-agent 2026.09.23 and 2026.09.28, macOS): the CLI keeps each
// chat in `<config>/chats/<md5(cwd)>/<chatId>/store.db`, where `<config>` is `$CURSOR_CONFIG_DIR`,
// else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor` (the CLI's own `cursor-config` paths module), and
// `md5(cwd)` hashes the PHYSICAL cwd. `<chatId>` is a UUID and is the id `cursor-agent --resume` takes
// and the stream-json `session_id`. It is a SQLite database (WAL mode), read here with the built-in
// `node:sqlite` (Electron 42 ships Node 24; the repo's `engines` floor already has it), READ-ONLY:
//   meta   (key '0') = hex(utf8 JSON) {agentId, latestRootBlobId (hex), name, mode, createdAt, …}
//   blobs  (id = sha256 hex, data) content-addressed. The ROOT blob (`latestRootBlobId`) is protobuf
//          (`ConversationStateStructure`); its field 1, repeated, is the ordered list of 32-byte ids of
//          the model-context MESSAGES, each a JSON blob in the AI-SDK shape:
//   system     {role, content: string}
//   user       {role, content: string}  harness context (`<user_info>`, rules, skills), never typed; or
//              {role, content: [{type:'text', text}]} whose typed prompt is `<user_query>…</user_query>`
//              beside `<timestamp>` / `<system_reminder>` parts
//   assistant  {role, content: [reasoning | redacted-reasoning | text | tool-call {toolCallId,
//              toolName, args}], id}; `providerOptions.cursor.modelName` rides its reasoning parts
//   tool       {role, content: [{type:'tool-result', toolCallId, toolName, result, experimental_content}]}
// The `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` file the CLI ALSO writes is NOT
// used: measured, its text parts read `[REDACTED]`, it has no tool results, and it lost the user line
// of a failed turn. The store is the whole conversation.
//
// Never a cwd fallback: a chat is found ONLY by its whole-UUID id. The cwd merely picks the bucket to
// look in first. Compaction replaces the model's context, so older turns are not in the root's message
// list; they are not shown (grok has the same limit).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { CHAT_PAGE_MAX_BYTES, type ChatTranscriptPage } from '../shared/chat-page'
import { metaString, summarizeResult } from './transcript-reader'
import { opencodePageMessages } from './opencode-chat'
import { isCursorBackgroundEvent, isCursorChildToolEvent } from '../shared/agents/normalize'
import { recordRawToolEvent } from './agent-status-mirror'

type ToolPart = Extract<ChatPart, { kind: 'tool' }>
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Pure parsing ────────────────────────────────────────────────────────────────────────────────

/** The text a person typed in one user-message part, or undefined when the part is not a prompt
 *  (`<timestamp>`, `<system_reminder>`, injected context). Exactly one wrapper newline is dropped. */
export function cursorUserText(text: string): string | undefined {
  const open = text.indexOf('<user_query>')
  if (open < 0) return undefined
  const start = open + '<user_query>'.length
  const end = text.lastIndexOf('</user_query>')
  if (end < start) return undefined
  const t = text.slice(start, end).replace(/^\n/, '').replace(/\n$/, '')
  return t.trim() ? t : undefined
}

/** Salient argument keys, in priority order (`pattern` before `path`: a grep's meaning is its pattern). */
const ARG_KEYS = ['command', 'pattern', 'glob_pattern', 'path', 'target_directory', 'target_notebook', 'query', 'search_term', 'url', 'description', 'prompt']

export function cursorToolArg(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, CHAT_TOOL_ARG_MAX)
  if (!isObj(args)) return ''
  for (const k of ARG_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v) return v.slice(0, CHAT_TOOL_ARG_MAX)
  }
  const raw = JSON.stringify(args)
  return raw === '{}' ? '' : raw.slice(0, CHAT_TOOL_ARG_MAX)
}

function resultText(p: Obj): string {
  if (typeof p.result === 'string') return p.result
  if (Array.isArray(p.experimental_content)) {
    return p.experimental_content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
  }
  return p.result === undefined ? '' : JSON.stringify(p.result)
}

/** Shell results wrap their output in an envelope ("Exit code: 0 / Command output: / ```…```"), and
 *  search results in `<workspace_result>`; a chip wants the payload, not the envelope. */
function unwrapResult(text: string): string {
  const sh = /^Exit code: (-?\d+)\n\nCommand output:\n\n```\n([\s\S]*?)\n*```/.exec(text)
  if (sh) return sh[1] === '0' ? sh[2] : `Exit code ${sh[1]}\n${sh[2]}`
  const ws = /^<workspace_result[^>]*>\n?([\s\S]*?)\n?<\/workspace_result>\s*$/.exec(text)
  return ws ? ws[1] : text
}

export interface CursorChatParse {
  messages: ChatMessage[]
  /** The newest assistant message's `providerOptions.cursor.modelName` (absent when it states none). */
  model?: string
  /** Messages/parts this reader could not map. Diagnostic only, never on the wire. */
  skipped: number
}

/** Ordered message objects (from the store, in order) → bubbles. */
export function parseCursorChat(raw: readonly unknown[]): CursorChatParse {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, ToolPart>()
  let skipped = 0
  let lastAssistant: Obj | undefined
  for (const m of raw) {
    if (!isObj(m)) {
      skipped++
      continue
    }
    const parts: unknown[] = Array.isArray(m.content) ? m.content : []
    switch (m.role) {
      case 'system':
        break
      case 'user': {
        // A string user message is harness context, never typed. Typed text is a `<user_query>`.
        const texts: ChatPart[] = []
        for (const p of parts) {
          const t = isObj(p) && p.type === 'text' && typeof p.text === 'string' ? cursorUserText(p.text) : undefined
          if (t !== undefined) texts.push({ kind: 'text', text: t })
        }
        if (texts.length) messages.push({ role: 'user', parts: texts })
        break
      }
      case 'assistant': {
        lastAssistant = m
        const out: ChatPart[] = []
        if (typeof m.content === 'string' && m.content.trim()) out.push({ kind: 'text', text: m.content })
        for (const p of parts) {
          if (!isObj(p)) {
            skipped++
            continue
          }
          if (p.type === 'text') {
            if (typeof p.text === 'string' && p.text.trim()) out.push({ kind: 'text', text: p.text })
          } else if (p.type === 'tool-call') {
            const tool: ToolPart = { kind: 'tool', name: typeof p.toolName === 'string' && p.toolName ? p.toolName : 'tool', arg: cursorToolArg(p.args) }
            out.push(tool)
            if (typeof p.toolCallId === 'string') toolById.set(p.toolCallId, tool)
          } else if (p.type !== 'reasoning' && p.type !== 'redacted-reasoning') {
            skipped++
          }
        }
        if (out.length) messages.push({ role: 'assistant', parts: out })
        break
      }
      case 'tool':
        for (const p of parts) {
          if (!isObj(p) || p.type !== 'tool-result') {
            skipped++
            continue
          }
          // An orphan result (its call is outside the window) is dropped, like every other reader.
          const tool = typeof p.toolCallId === 'string' ? toolById.get(p.toolCallId) : undefined
          const s = tool ? summarizeResult(unwrapResult(resultText(p))) : ''
          if (tool && s) tool.result = s
        }
        break
      default:
        skipped++
    }
  }
  const out: CursorChatParse = { messages, skipped }
  const modelOf = (a: Obj | undefined): string | undefined => {
    for (const p of Array.isArray(a?.content) ? (a.content as unknown[]) : []) {
      const cur = isObj(p) && isObj(p.providerOptions) ? p.providerOptions.cursor : undefined
      const name = isObj(cur) ? metaString(cur.modelName) : undefined
      if (name) return name
    }
    return undefined
  }
  const model = modelOf(lastAssistant)
  if (model !== undefined) out.model = model
  return out
}

/** Newline-delimited JSON of message objects: the raw transcript text Context Link and the handoff
 *  exchange, so cursor fits the same "text in, lines out" shape as every other agent. */
export function parseCursorNdjson(raw: string): unknown[] {
  const out: unknown[] = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* a partial line: dropped */
    }
  }
  return out
}

/** Context Link's display lines (`user: …`, `assistant: …`, `  $ tool arg`, `  = result`). */
export function linesFromCursor(raw: string): string[] {
  const res: string[] = []
  for (const m of parseCursorChat(parseCursorNdjson(raw)).messages) {
    for (const p of m.parts) {
      if (p.kind === 'text') res.push(`${m.role}: ${p.text}`)
      else if (p.kind === 'tool') {
        res.push(`  $ ${p.name}${p.arg ? ` ${p.arg}` : ''}`)
        if (p.result) res.push(`  = ${p.result}`)
      }
    }
  }
  return res
}

// ── Locating the store ──────────────────────────────────────────────────────────────────────────

/** A whole UUID: cursor's chat ids. A suffix or prefix of one must never match another chat. */
export const CURSOR_CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The CLI's own config-dir rule (`cursor-config` paths): CURSOR_CONFIG_DIR, XDG_CONFIG_HOME/cursor, ~/.cursor. */
export function cursorConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR
  if (env.XDG_CONFIG_HOME?.trim()) return path.join(env.XDG_CONFIG_HOME, 'cursor')
  return path.join(home, '.cursor')
}

const md5 = (s: string): string => crypto.createHash('md5').update(s).digest('hex')

// A hit is cached per id (a store never moves); a miss is not, since the chat may not exist yet.
const storeCache = new Map<string, string>()

/**
 * `<chats>/<bucket>/<chatId>/store.db` for ONE chat id, or undefined. `cwd` only orders the search
 * (its md5 bucket, physical and as written, first); every bucket is then tried, because the id alone
 * is the identity and the phone path carries no cwd. No id, or one that is not a whole UUID, is a miss.
 */
export async function locateCursorChat(chatId: string | undefined, cwd?: string): Promise<string | undefined> {
  if (!chatId || !CURSOR_CHAT_ID_RE.test(chatId)) return undefined
  const cached = storeCache.get(chatId)
  if (cached) {
    try {
      if ((await fs.promises.stat(cached)).isFile()) return cached
    } catch {
      storeCache.delete(chatId)
    }
  }
  const chats = path.join(cursorConfigDir(), 'chats')
  const buckets: string[] = []
  if (cwd) {
    buckets.push(md5(path.resolve(cwd)))
    try {
      buckets.push(md5(await fs.promises.realpath(cwd)))
    } catch {
      /* no such cwd */
    }
  }
  try {
    buckets.push(...(await fs.promises.readdir(chats)))
  } catch {
    return undefined
  }
  for (const b of new Set(buckets)) {
    const p = path.join(chats, b, chatId, 'store.db')
    try {
      if ((await fs.promises.stat(p)).isFile()) {
        storeCache.set(chatId, p)
        return p
      }
    } catch {
      /* not in this bucket */
    }
  }
  return undefined
}

// ── Reading the store (read-only) ───────────────────────────────────────────────────────────────

/** Raw JSON bytes of message blobs read per call, newest first. note: a chat past this shows only
 *  its newest part; a ranged/paged store read if anyone needs deeper history. */
export const CURSOR_READ_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_TITLE = 'New Agent'

/** One protobuf field: varint value `v`, or length-delimited bytes `b`. Fixed32/64 are skipped. */
type PbField = { f: number; v?: number; b?: Uint8Array }

/** The fields of one protobuf message, in order, or null when it is malformed/truncated. */
function pbFields(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = []
  let i = 0
  const varint = (): number | null => {
    let r = 0
    // up to 10 bytes: the root carries a 41-bit ms timestamp
    for (let s = 0; s < 70; s += 7) {
      if (i >= buf.length) return null
      const c = buf[i++]
      r += (c & 0x7f) * 2 ** s
      if (c < 0x80) return r
    }
    return null
  }
  while (i < buf.length) {
    const tag = varint()
    if (tag === null) return null
    const wire = tag & 7
    const f = tag >>> 3
    if (wire === 0) {
      const v = varint()
      if (v === null) return null
      out.push({ f, v })
    } else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4
    else if (wire === 2) {
      const len = varint()
      if (len === null || i + len > buf.length) return null
      out.push({ f, b: buf.subarray(i, i + len) })
      i += len
    } else return null
  }
  return out
}

/** The ids in the root blob's field 1 (`root_prompt_messages_json`, repeated bytes), in order. */
export function rootMessageIds(buf: Uint8Array): string[] | null {
  const fields = pbFields(buf)
  if (!fields) return null
  return fields.filter((x) => x.f === 1 && x.b?.length === 32).map((x) => Buffer.from(x.b as Uint8Array).toString('hex'))
}

/**
 * The agent's own context numbers: root field 5 (`token_details`) = {1 used_tokens, 2 max_tokens}.
 * MEASURED (cursor-agent 2026.09.28): matches the TUI's `/context`; `max` varies per session
 * (200000 / 256000 / 300000 / 1000000), so it is read, never inferred from the model. Null unless
 * BOTH are present and usable (no trustworthy denominator, no meter: CLAUDE.md rule 6).
 */
export function rootTokenDetails(buf: Uint8Array): { used: number; max: number } | null {
  const td = pbFields(buf)?.find((x) => x.f === 5 && x.b)?.b
  const inner = td && pbFields(td)
  if (!inner) return null
  const used = inner.find((x) => x.f === 1 && x.v !== undefined)?.v
  const max = inner.find((x) => x.f === 2 && x.v !== undefined)?.v
  return used !== undefined && used > 0 && max !== undefined && max > 0 ? { used, max } : null
}

export interface CursorStore {
  /** Message objects, oldest first. */
  messages: unknown[]
  /** The chat's own name; undefined until cursor names it (its default is "New Agent"). */
  title?: string
  /** The root's `token_details` (see `rootTokenDetails`); absent when it states none. */
  tokens?: { used: number; max: number }
}

const asText = (d: unknown): string => (typeof d === 'string' ? d : Buffer.from(d as Uint8Array).toString('utf8'))

/** One consistent read of a store; null when it cannot be read (no node:sqlite, locked, corrupt). */
export async function readCursorStore(dbPath: string, maxBytes: number = CURSOR_READ_MAX_BYTES): Promise<CursorStore | null> {
  let db: import('node:sqlite').DatabaseSync | undefined
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
    db.exec('BEGIN')
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | undefined
    const meta: unknown = row?.value ? JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) : {}
    const m = isObj(meta) ? meta : {}
    const name = typeof m.name === 'string' ? m.name.trim() : ''
    const store: CursorStore = { messages: [] }
    if (name && name !== DEFAULT_TITLE) store.title = name.slice(0, 200)
    const rootId = typeof m.latestRootBlobId === 'string' ? m.latestRootBlobId : ''
    if (!rootId) return store
    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?')
    const size = db.prepare('SELECT length(data) AS n FROM blobs WHERE id = ?')
    const root = blob.get(rootId) as { data?: Uint8Array } | undefined
    const tokens = root?.data ? rootTokenDetails(root.data) : null
    if (tokens) store.tokens = tokens
    if (maxBytes <= 0) return store // maxBytes 0 = the name and the token numbers, no messages
    const ids = root?.data ? rootMessageIds(root.data) : null
    if (!ids) return null
    let total = 0
    const newestFirst: unknown[] = []
    for (let k = ids.length - 1; k >= 0; k--) {
      const n = (size.get(ids[k]) as { n?: number } | undefined)?.n
      if (n === undefined) continue // a message this machine does not hold
      if (total + n > maxBytes && newestFirst.length) break
      if (n > maxBytes) continue // over the cap on its own: never parsed, even as the newest
      total += n
      try {
        newestFirst.push(JSON.parse(asText((blob.get(ids[k]) as { data: unknown }).data)))
      } catch {
        /* not a JSON message blob */
      }
    }
    store.messages = newestFirst.reverse()
    return store
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/** The transcript text Context Link and the handoff read: one message per line, without the fields
 *  that only bloat it (`providerOptions` carries encrypted reasoning, `experimental_content` repeats `result`). */
export async function cursorTranscriptText(dbPath: string): Promise<string | null> {
  const s = await readCursorStore(dbPath)
  if (!s) return null
  return s.messages
    .map((m) => {
      if (!isObj(m)) return ''
      const { providerOptions: _p, ...rest } = m
      if (Array.isArray(rest.content)) {
        rest.content = rest.content
          .filter((c) => !(isObj(c) && (c.type === 'reasoning' || c.type === 'redacted-reasoning')))
          .map((c) => {
            if (!isObj(c)) return c
            const { providerOptions: _q, experimental_content: _e, ...keep } = c
            return keep
          })
      }
      return JSON.stringify(rest)
    })
    .filter(Boolean)
    .join('\n')
}

/** The session's own name for `TITLE_READ_CAPABLE`, or null. By id only, local only: a remote node's
 *  chat is on its host, and a whole-UUID id cannot name a chat on this machine by accident. */
export async function readCursorSessionName(sessionId: string): Promise<string | null> {
  const p = await locateCursorChat(sessionId)
  if (!p) return null
  return (await readCursorStore(p, 0))?.title ?? null
}

/**
 * `chat:read-transcript` for a cursor node. Refusals: a REMOTE node is refused before anything is
 * read (its chat is in the HOST's store; there is no remote leg yet), and a local failure is a
 * plain not-found like copilot's, so `unreadable` can only mean "remote" (`CHAT_LOCAL_ONLY`). One
 * page always (`olderCursor: null`): a store has no byte offsets to page by.
 */
export async function readCursorChat(
  q: { sessionId?: string; cwd?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  const notFound = (): ChatTranscriptResult =>
    page ? { messages: [], found: false, olderCursor: null, unmatchedResults: [] } : { messages: [], found: false }
  if (q.remoteOnly) return page ? { ...notFound(), unreadable: true } : notFound()
  if (page && page.before !== null) return { messages: [], found: true, olderCursor: null, unmatchedResults: [] }
  const p = await locateCursorChat(q.sessionId, q.cwd)
  if (!p) return notFound()
  // note: no change gate/cache (opencode's export needs one at 1.5 s; this read is milliseconds).
  const store = await readCursorStore(p)
  if (!store) return notFound()
  const parsed = parseCursorChat(store.messages)
  const messages = opencodePageMessages(parsed.messages, page ? page.maxBytes : CHAT_PAGE_MAX_BYTES)
  if (!page) return { messages, found: true }
  return { messages, found: true, olderCursor: null, unmatchedResults: [], ...(parsed.model !== undefined ? { model: parsed.model } : {}) }
}

// ── Context meter (`USAGE_CAPABLE`) ─────────────────────────────────────────────────────────────

/**
 * `ContextTail.readSource` for a cursor `store.db`: the numbers via the ONE store reader
 * (`readCursorStore`, messages skipped), handed to `cursorContextParse` as a one-line JSON. The
 * change gate is the db + `-wal` (mtime, size): WAL mode leaves `store.db` itself untouched between
 * checkpoints, and the tail polls at 1 Hz, so an unchanged store costs two stats, not an open.
 * note: polled by the shared tail rather than a bespoke hook-triggered reader; hook events only
 * (re)track the store path. A stat-gated poll is cheap enough, and the meter needs no new timer.
 */
export async function readCursorContextSource(dbPath: string, lastKey: string | undefined): Promise<{ text: string; key: string } | null> {
  let key = ''
  for (const f of [dbPath, `${dbPath}-wal`]) {
    try {
      const st = await fs.promises.stat(f)
      key += `${st.mtimeMs}:${st.size};`
    } catch {
      key += '-;' // no WAL file: a checkpointed store
    }
  }
  if (key === lastKey) return null
  const tokens = (await readCursorStore(dbPath, 0))?.tokens
  return tokens ? { text: JSON.stringify(tokens), key } : null
}

/** `ContextTail` parse for cursor: the last `{used,max}` line. `window` is the store's own `max`. */
export function cursorContextParse(text: string | string[]): { used: number; window: number; model: null } | null {
  const lines = Array.isArray(text) ? text : text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o: unknown = JSON.parse(lines[i])
      if (isObj(o) && typeof o.used === 'number' && typeof o.max === 'number' && o.used > 0 && o.max > 0) {
        return { used: o.used, window: o.max, model: null }
      }
    } catch {
      /* not a JSON line */
    }
  }
  return null
}

/**
 * One hook event of a cursor node → its context tail. The store is found STRICTLY by the event's
 * `conversation_id` (`locateCursorChat`, under the chats root only); the payload's `transcript_path`
 * names the redacted agent-transcripts jsonl and is never read, so there is no payload path to jail
 * and a forged POST cannot aim a read anywhere. Shared by both shells (invariant 11). A repeat event
 * for a tracked session is a no-op, and a chat cursor has not written yet is retried by the next one.
 * Returns the session id (the shells record it for tail release), undefined when the payload has none.
 */
export async function trackCursorContext(
  tail: { track(id: string, path: string): void; pathFor(id: string): string | undefined },
  payload: unknown,
  live: () => boolean = () => true
): Promise<string | undefined> {
  const p = isObj(payload) ? payload : {}
  const id = typeof p.conversation_id === 'string' ? p.conversation_id : typeof p.session_id === 'string' ? p.session_id : undefined
  if (!id || tail.pathFor(id)) return id
  const cwd = Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === 'string' ? p.workspace_roots[0] : undefined
  const path = await locateCursorChat(id, cwd)
  if (path && live()) tail.track(id, path)
  return id
}

/** nodeId -> a token for its current life. `releaseCursorRaw` drops it, so a store lookup that was
 *  already in flight when the node was destroyed or recycled finds a different token when it lands
 *  and tracks nothing (it used to restart a 1 Hz poll on the old store, review 2026-10-03). */
const nodeEpoch = new Map<string, object>()

/** Both shells' `releaseNodeTails` (pty:destroy / pty:recycle): fence `applyCursorRaw`'s pending lookups. */
export function releaseCursorRaw(nodeId: string): void {
  nodeEpoch.delete(nodeId)
}

/**
 * The ONE cursor step both shells' raw hook listeners run (`src/main/index.ts`,
 * `src/server/agent-status.ts`), so the two cannot drift (CLAUDE.md rules 10 and 11). It used to be
 * written inline in each shell as two `agentId === 'cursor'` branches, and the first one returned,
 * so the second (the subagent tracker) never ran in either shell: a subagent card started from the
 * normalizer but never ended (review 2026-10-02).
 *
 * Order matters:
 * 1. The subagent tracker sees EVERY event, child ones included (they feed its live tail) and remote
 *    ones (its end emit reads no local file).
 * 2. A remote node is not metered from this machine's disk.
 * 3. A child's tool event (`isCursorChildToolEvent`: generation_id === conversation_id) never
 *    re-points the node at the child's chat once the node has a session of its own. Before this it
 *    replaced the node's session id (the resume id) and leaked a 1 Hz tail on the child store.
 *    A node with no session yet still tracks it, so a headless run whose own tool events look like
 *    a child's keeps its meter.
 */
export function applyCursorRaw(
  deps: {
    tail: { track(id: string, path: string): void; pathFor(id: string): string | undefined }
    subagents: { onRaw(agentId: 'cursor', nodeId: string | undefined, payload: unknown): void }
    nodeSession: Map<string, string>
    isRemote: (nodeId: string) => boolean
  },
  nodeId: string | undefined,
  payload: unknown
): void {
  deps.subagents.onRaw('cursor', nodeId, payload)
  // A background agent's lifecycle event is not this node's: no Stop activity, no meter re-point.
  if (isCursorBackgroundEvent(payload)) return
  // The phone's "what it is doing now" line, remote nodes included (it needs no file). Translated to
  // the claude-shaped names `recordRawToolEvent` gates on, as grok's branch does; a child's tool
  // call is not the parent's activity.
  if (nodeId && isObj(payload)) {
    const ev = payload.hook_event_name
    if (ev === 'preToolUse' && typeof payload.tool_name === 'string' && !isCursorChildToolEvent(payload)) {
      recordRawToolEvent(nodeId, { hook_event_name: 'PreToolUse', tool_name: payload.tool_name, tool_input: payload.tool_input })
    } else if (ev === 'stop' || ev === 'sessionEnd') {
      recordRawToolEvent(nodeId, { hook_event_name: 'Stop' })
    }
  }
  if (!nodeId || deps.isRemote(nodeId)) return
  const current = deps.nodeSession.get(nodeId)
  if (current && isCursorChildToolEvent(payload)) return
  let epoch = nodeEpoch.get(nodeId)
  if (!epoch) nodeEpoch.set(nodeId, (epoch = {}))
  const live = (): boolean => nodeEpoch.get(nodeId) === epoch
  void trackCursorContext(deps.tail, payload, live).then((id) => {
    if (!id || !live()) return
    // A slower scan for an older event must not overwrite a newer association.
    const now = deps.nodeSession.get(nodeId)
    if (now && now !== id && isCursorChildToolEvent(payload)) return
    deps.nodeSession.set(nodeId, id)
  })
}
