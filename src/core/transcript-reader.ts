// Reads a Claude session's transcript .jsonl into flat, searchable lines. Read-only and
// local. Mirrors subagent-tail.ts's extraction shape but returns {role, text} per content
// block (instead of a single formatted string) so the renderer can tag matches by role.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TranscriptLine, ChatMessage, ChatPart } from '../shared/types'
import { transcriptRootFor } from './claude-accounts-core'
import { linkedClaudeConfigDirFor } from './claude-config-dir'
import { platform } from './platform'

// Transcript root for a managed account (its `projects` dir) or the system default
// (`~/.claude/projects` when accountId is undefined — bit-for-bit the old behavior). Impure
// wrapper over the pure `transcriptRootFor`: the userData dir comes from the CorePlatform seam
// (and only for the account branch) so this module — and its vitest test — stays electron-free.
function transcriptRoot(accountId?: string): string {
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

function summarizeResult(content: unknown): string {
  return textOf(content).split('\n').slice(0, 3).join(' ').slice(0, 500)
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.description ?? o.prompt
  return typeof v === 'string' ? v.slice(0, 200) : ''
}

// Extract 0..n searchable lines from one raw transcript JSONL line.
function linesFrom(raw: string): TranscriptLine[] {
  let o: { type?: string; message?: { content?: unknown } }
  try {
    o = JSON.parse(raw)
  } catch {
    return []
  }
  const content = o.message?.content
  const out: TranscriptLine[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
      if (c.type === 'text' && c.text) out.push({ role: 'assistant', text: c.text })
      else if (c.type === 'tool_use') {
        const arg = toolArg(c.input)
        out.push({ role: 'tool', text: `$ ${c.name ?? 'tool'}${arg ? ` ${arg}` : ''}` })
      }
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; content?: unknown }>) {
      if (c.type === 'text' && c.text) out.push({ role: 'user', text: c.text })
      else if (c.type === 'tool_result') {
        const s = summarizeResult(c.content)
        if (s) out.push({ role: 'tool', text: s })
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    out.push({ role: 'user', text: content })
  }
  return out
}

// Read the last ~READ_CAP_BYTES of the file as UTF-8 (dropping the partial leading line on a
// capped read), or the whole file when it's small. Returns undefined if it can't be read.
export async function readCappedTail(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const start = stat.size - READ_CAP_BYTES
        const { buffer } = await fd.read({
          position: start,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n') // drop the first (partial) line
        return nl >= 0 ? s.slice(nl + 1) : s
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
export function parseTranscriptLines(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim()) lines.push(...linesFrom(raw))
  }
  return lines
}

export async function readTranscriptLines(filePath: string): Promise<TranscriptLine[]> {
  const buf = await readCappedTail(filePath)
  if (buf === undefined) return []
  return parseTranscriptLines(buf)
}

// Reconstruct structured chat messages from raw transcript JSONL lines. An assistant line's
// text + tool_use blocks become one message's ordered parts; a later user-line tool_result is
// correlated back onto its tool part by tool_use_id. User lines that carry only tool_results
// (no prose) are NOT rendered as bubbles — they're tool output, attached to the tool instead.
export function parseChatMessages(rawLines: string[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  for (const raw of rawLines) {
    if (!raw.trim()) continue
    let o: { type?: string; message?: { content?: unknown } }
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    const content = o.message?.content
    if (o.type === 'assistant' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        name?: string
        id?: string
        input?: unknown
      }>) {
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text })
        else if (c.type === 'tool_use') {
          const part: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: c.name ?? 'tool',
            arg: toolArg(c.input)
          }
          parts.push(part)
          if (c.id) toolById.set(c.id, part)
        }
      }
      if (parts.length) messages.push({ role: 'assistant', parts })
    } else if (o.type === 'user' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        tool_use_id?: string
        content?: unknown
      }>) {
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text })
        else if (c.type === 'tool_result') {
          const tool = c.tool_use_id ? toolById.get(c.tool_use_id) : undefined
          if (tool) {
            const s = summarizeResult(c.content)
            if (s) tool.result = s
          }
        }
      }
      if (parts.length) messages.push({ role: 'user', parts })
    } else if (o.type === 'user' && typeof content === 'string' && content.trim()) {
      messages.push({ role: 'user', parts: [{ kind: 'text', text: content }] })
    }
  }
  return messages
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
  const tail = await readSmallTail(p, TITLE_TAIL_BYTES)
  if (!tail) return null
  return pickSessionName(tail)
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
