// omp's session transcript (`~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<session-id>.jsonl`)
// as the ⌘M panel's structured messages, and the locator behind the ⌘-context-link read.
//
// MEASURED on 2026-11-02 against two real sessions (omp 18.14/18.15). One JSON object per line:
//   session                {version, id, timestamp, cwd, title}                    — header, first line
//   title                  {v, title, source, updatedAt}                           — CURRENT title, rewritten
//                                                                                  in place at line 1 as the
//                                                                                  title changes (title_change
//                                                                                  lines are appended below it)
//   thinking_level_change / service_tier_change / title_change / custom           — meta, no conversation
//   message                {id, parentId, timestamp(ISO), message:{role, content, model?, ...}}
//     roles: user | assistant | developer | toolResult
//     content parts: {type:'text',text} | {type:'thinking',thinking} |
//                    {type:'toolCall',id,name,arguments(object)} | toolResult rows carry text content
//
// The file is NOT an append-only log: the `title` line at position 1 is rewritten in place, which
// shifts every byte offset below it. A byte cursor would re-serve or lose records across reads
// (the same finding that took grok's reader off paging — grok-chat.ts), so this reader does not
// page either: every read is the newest capped tail, `olderCursor: null`.
//
// Located STRICTLY by the session id in the file name (`_<id>.jsonl` under any cwd slug). No cwd
// fallback and nothing claude-shaped: claude's resolver would answer an omp id with the newest
// CLAUDE transcript for the directory (transcriptGates.ts).
import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'path'
import os from 'os'
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import type { ChatTranscriptPage } from '../shared/chat-page'
import { ompAgentDir } from './agents/hooks/omp'
import { metaString, summarizeResult, readCappedTail, SESSION_ID_RE } from './transcript-reader'
import { ompParse } from './context-link-render'

/** omp's session root, PI_CODING_AGENT_DIR-aware exactly like ompHookDir (hooks/omp.ts): a
 *  relative value is cwd-dependent and would read a different tree per project — refuse it. */
export function ompSessionsRoot(): string {
  return path.join(ompAgentDir(), 'sessions')
}

/**
 * The newest session file whose name carries this exact session id, under any cwd slug.
 * `undefined` when the id is absent/unsafe (never a command line or path segment) or nothing
 * matches. omp UUIDs (`01a19d62-…`) pass the shared SESSION_ID_RE alphabet.
 */
export async function locateOmpTranscript(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return undefined
  const root = ompSessionsRoot()
  let slugs: Dirent[]
  try {
    slugs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  let best: { path: string; mtime: number } | undefined
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const dir = path.join(root, slug.name)
    let files: string[]
    try {
      files = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(`_${sessionId}.jsonl`)) continue
      const p = path.join(dir, f)
      try {
        const mtime = (await fsp.stat(p)).mtimeMs
        if (!best || mtime > best.mtime) best = { path: p, mtime }
      } catch {
        /* raced a delete — the next match or nothing */
      }
    }
  }
  return best?.path
}

/** What an omp conversation reads as. `model` is the newest assistant record's `model`. */
export interface OmpChatParse {
  messages: ChatMessage[]
  model?: string
  /** Unparsable or unknown lines. Expected meta lines (session/title/…) are NOT counted. */
  skipped: number
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const c of content) {
    if (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' && c.text) out.push(c.text)
  }
  return out.join('\n')
}

function isTextPart(p: object): p is { type: 'text'; text: string } {
  return 'type' in p && p.type === 'text' && 'text' in p && typeof p.text === 'string'
}
function isThinkingPart(p: object): p is { type: 'thinking'; thinking: string } {
  return 'type' in p && p.type === 'thinking' && 'thinking' in p && typeof p.thinking === 'string'
}
function isToolCallPart(p: object): p is { type: 'toolCall'; id?: unknown; name?: unknown; arguments?: unknown } {
  return 'type' in p && p.type === 'toolCall'
}

/** Tool args arrive as a measured OBJECT (`arguments:{op,command,…}`); cap like grok's. */
function toolArgOf(args: unknown): string {
  if (args && typeof args === 'object') return JSON.stringify(args).slice(0, 200)
  if (typeof args === 'string' && args) return args.slice(0, 200)
  return ''
}

/**
 * Ordered bubbles for an omp session file.
 *
 * Rules carried over from the grok reader, because both views (⌘M and context-link) must agree:
 *  - a `developer` role line was injected by the harness (plans, instruction blocks), not typed by
 *    a person. It is rendered as an ASSISTANT-side `[developer]` note — the panel has only two
 *    roles, and tooling text must never wear the shape of something the human said.
 *  - `thinking` parts are plaintext in omp but shown only on the opt-in `thinking` read, like
 *    claude's; the context-link parser never emits them (the product decision documented beside
 *    grok's `reasoning` skip).
 *  - a toolResult attaches to the toolCall it answers (`toolCallId`); an orphan is dropped rather
 *    than shown speaker-less.
 */
export function parseOmpChat(buf: string, opts?: { thinking?: boolean }): OmpChatParse {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  const parsed = ompParse(buf)
  let model: string | undefined
  for (const o of parsed.lines) {
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const stamped = Number.isFinite(at) ? { at } : {}
    const msg = o.message
    if (!msg || typeof msg !== 'object') continue
    if ('role' in msg && msg.role === 'user') {
      const t = textOf(msg.content)
      if (t) messages.push({ role: 'user', parts: [{ kind: 'text', text: t }], ...stamped })
    } else if ('role' in msg && msg.role === 'developer') {
      const t = textOf(msg.content)
      if (t) messages.push({ role: 'assistant', parts: [{ kind: 'text', text: `[developer] ${t}` }], ...stamped })
    } else if ('role' in msg && msg.role === 'assistant') {
      if ('model' in msg) {
        const m = metaString(msg.model)
        if (m !== undefined) model = m
      }
      const parts: ChatPart[] = []
      const content = Array.isArray(msg.content) ? msg.content : []
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        if (isTextPart(raw)) parts.push({ kind: 'text', text: raw.text })
        if (isThinkingPart(raw) && opts?.thinking) parts.push({ kind: 'thinking', text: raw.thinking })
        if (isToolCallPart(raw)) {
          const tool: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: typeof raw.name === 'string' && raw.name ? raw.name : 'tool',
            arg: toolArgOf(raw.arguments)
          }
          parts.push(tool)
          if (typeof raw.id === 'string' && raw.id) toolById.set(raw.id, tool)
        }
      }
      if (parts.length) messages.push({ role: 'assistant', parts, ...stamped })
    } else if ('role' in msg && msg.role === 'toolResult') {
      // An orphan result — its call sits above the capped-tail window (or mid-write). Skipping it
      // must never end the parse: the tail of a long session can BEGIN with one, and stopping
      // there would hand the panel a found-but-empty conversation.
      const tool = 'toolCallId' in msg && typeof msg.toolCallId === 'string' ? toolById.get(msg.toolCallId) : undefined
      if (!tool) continue
      const s = summarizeResult(textOf(msg.content))
      if (s) tool.result = s
    }
  }
  const out: OmpChatParse = { messages, skipped: parsed.skipped }
  if (model !== undefined) out.model = model
  return out
}

/**
 * An omp node's chat read. No paging (the in-place `title` rewrite above); a paged request gets
 * the whole capped read with `olderCursor: null`, plus the newest assistant record's `model`.
 * Remote first and TERMINAL: an SSH-project omp session lives on its host and no remote leg
 * exists, so `unreadable` (paged) / not found (legacy) — never this machine's disk. A LOCAL
 * failed read maps to not-found, so `unreadable` keeps meaning "remote, unsupported" (the same
 * convention as copilot, CHAT_LOCAL_ONLY).
 */
export async function readOmpChat(
  q: { sessionId?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  if (q.remoteOnly) return page ? { messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true } : { messages: [], found: false }
  const p = await locateOmpTranscript(q.sessionId)
  const paging = page ? { olderCursor: null as null, unmatchedResults: [] as never[] } : {}
  const notFound = (): ChatTranscriptResult => ({ messages: [], found: false, ...paging })
  if (!p) return notFound()
  const buf = await readCappedTail(p, page ? page.maxBytes : undefined)
  if (buf === undefined) return notFound()
  const out = parseOmpChat(buf, { thinking: page?.thinking === true })
  return {
    messages: out.messages,
    found: true,
    ...paging,
    ...(page && out.model !== undefined ? { model: out.model } : {})
  }
}

/** The messages alone — callers that predate the paged shape. */
export function chatMessagesFromOmp(buf: string): ChatMessage[] {
  return parseOmpChat(buf).messages
}
