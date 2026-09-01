// Reads what nodeterm needs from a grok session DIRECTORY. Grok's hook envelope carries no
// transcript path (claude's does), but every event carries `cwd` and `sessionId` — and grok stores
// a session at `$GROK_HOME/sessions/<url-encoded cwd>/<id>/`. So the directory is DERIVED, never
// searched, and this module only ever reads inside a directory a hook told us about.
//
// Contents, MEASURED on 1.0.13 across 29 local sessions (2026-09-02) — the previous version of this
// comment called `updates.jsonl` the "authoritative conversation log" and `chat_history.jsonl` "raw
// model messages", which is backwards where it matters and is the single most expensive false claim
// in this integration: it sends a reader to build against the file that cannot be read message by
// message.
//
//   summary.json        `generated_title`, `session_summary`, `current_model_id`, `info`,
//                       timestamps, counts.
//   signals.json        the context meter's numbers — `contextTokensUsed`, `contextWindowTokens`
//                       and grok's own `contextWindowUsage` — plus 63 unrelated metrics.
//   chat_history.jsonl  THE CONVERSATION, one settled message per line (`system`, `user`,
//                       `assistant`, `tool_result`, `backend_tool_call`, `reasoning`). This is what
//                       context links, the ⌘M panel and cross-agent transfer read.
//   updates.jsonl       the ACP event STREAM (`session/update` notifications). It is not empty of
//                       conversation — `agent_message_chunk`, `user_message_chunk` and
//                       `agent_thought_chunk` are in there — but it carries CHUNKS interleaved with
//                       `tool_call`/`tool_call_update`, `hook_execution`, `plan`, compaction and
//                       subagent events, so reading a message out of it means reassembling it.
//                       `chat_history.jsonl` is the same conversation already settled.
//
// The trap: grok's hook payloads advertise `updates.jsonl` as the transcript path, so following the
// advertisement is the obvious move and it fails SILENTLY — a real file opens, our line parser finds
// no `type` field on any line, and the caller gets an empty transcript with nothing logged.
//
// This is grok's reader, and `transcript-reader.ts` stays claude's: a "shared" reader that knows two
// storage layouts is two readers in a trench coat, and the one thing neither must ever do is search
// the other's tree. The choice is made once, at the IPC handler.
import fs from 'fs'
import path from 'path'
import { GROK_SUMMARY_FILE } from './agents/grok-paths'

/** Read at most this much of summary.json — it is small, and a capped read bounds a corrupt file. */
const SUMMARY_MAX_BYTES = 256 * 1024

export interface GrokSessionMeta {
  /** The session's own name — what `/resume` shows and what the node title adopts. */
  title: string | null
  /** grok's model id, for anything that needs the model (e.g. the context window). */
  model: string | null
}

/**
 * Title keys in PREFERENCE order. `generated_title` is grok's actual session name;
 * `session_summary` is the human-readable fallback before that title is generated.
 *
 * Do not restore the guessed `title` key: a real grok 1.0.13 summary has no such field, and
 * accepting one lets a hand-edited or foreign value override the name grok actually generated.
 */
const TITLE_KEYS = ['generated_title', 'session_summary'] as const

/** Pure: the meta from a summary.json body. null when this is not a summary object at all. */
export function pickGrokSessionMeta(summaryJson: string): GrokSessionMeta | null {
  let o: unknown
  try {
    o = JSON.parse(summaryJson)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const rec = o as Record<string, unknown>
  let title: string | null = null
  for (const k of TITLE_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) {
      title = v.trim()
      break
    }
  }
  const model = typeof rec.current_model_id === 'string' ? rec.current_model_id : null
  return { title, model }
}

/** Read a session directory's summary.json. null when it is absent or unreadable. */
export async function readGrokSessionMeta(sessionDir: string): Promise<GrokSessionMeta | null> {
  try {
    const fd = await fs.promises.open(path.join(sessionDir, GROK_SUMMARY_FILE), 'r')
    try {
      const buf = Buffer.alloc(SUMMARY_MAX_BYTES)
      const { bytesRead } = await fd.read(buf, 0, SUMMARY_MAX_BYTES, 0)
      return pickGrokSessionMeta(buf.subarray(0, bytesRead).toString('utf-8'))
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
}

// The hook-fed association: sessionId → its resolved session directory. Populated by the shells'
// raw listeners (which see cwd + sessionId together) so every later read is a direct open. Bounded
// because a long-lived app can see many sessions; the oldest entry is dropped first.
const MAX_TRACKED_SESSIONS = 512
const sessionDirs = new Map<string, string>()

export function rememberGrokSessionDir(sessionId: string, dir: string): void {
  if (!sessionId || !dir) return
  // Re-insert so the map's iteration order is least-recently-SEEN first: that is what makes the
  // eviction below drop the session nobody has heard from, not whichever one happened to be first.
  if (sessionDirs.has(sessionId)) sessionDirs.delete(sessionId)
  sessionDirs.set(sessionId, dir)
  if (sessionDirs.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionDirs.keys().next().value
    if (oldest !== undefined) sessionDirs.delete(oldest)
  }
}

export function grokSessionDirFor(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionDirs.get(sessionId) : undefined
}

export function forgetGrokSession(sessionId: string | undefined): void {
  if (sessionId) sessionDirs.delete(sessionId)
}

/** The session NAME for a sessionId we have seen a hook for. null when unknown or unnamed. */
export async function readGrokSessionName(sessionId: string): Promise<string | null> {
  const dir = grokSessionDirFor(sessionId)
  if (!dir) return null
  return (await readGrokSessionMeta(dir))?.title ?? null
}
