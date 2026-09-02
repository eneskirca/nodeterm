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
import { GROK_SUMMARY_FILE, isSafeGrokSessionId } from './agents/grok-paths'
import { writeFileAtomic } from './fs-atomic'
import { platform } from './platform'

/** Read at most this much of summary.json — it is small, and a capped read bounds a corrupt file. */
const SUMMARY_MAX_BYTES = 256 * 1024

export interface GrokSessionMeta {
  /** The session's own name — what `/resume` shows and what the node title adopts. */
  title: string | null
  /** grok's model id, for anything that needs the model (e.g. the context window). */
  model: string | null
}

/**
 * Title keys in PREFERENCE order: a manually set title wins over the model-generated one, exactly
 * as claude's `custom-title` wins over its `ai-title`.
 *
 * `generated_title` is DOCUMENTED (grok 1.0.0). `'title'` is UNVERIFIED — it is a first guess at the
 * key grok's `/rename` (alias `/title`) writes a manual title to, which could not be captured
 * because no grok binary or account was available (see the provenance note atop grok-session.test.ts
 * and the fixture it describes). It is listed FIRST so a real manual title wins the moment the key is
 * confirmed; an unknown key is simply absent from the file, so a wrong guess degrades to the
 * generated title rather than to a wrong name.
 */
const TITLE_KEYS = ['title', 'generated_title'] as const

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
//
// PERSISTED since 2026-09, and the distinction matters: persisting is not scanning. A scan is what
// claude does — it searches its transcript tree for a session id — and it is exactly the behaviour
// that made nodes adopt each other's names, which is why grok derives instead. What is written here
// is only what a hook already TOLD us, so a restart recovers facts we were given rather than
// guessing at facts we were not. Before this, a grok node's name went blank after every app restart
// until that session next fired a hook: correct, but silently unhelpful for a session sitting idle.
const MAX_TRACKED_SESSIONS = 512
const sessionDirs = new Map<string, string>()

/** Where the map lives. Under userDataDir like every other derived cache, so a managed-account or
 *  Server Edition install keeps its own. */
function mapFile(): string {
  return path.join(platform().userDataDir, 'grok-session-dirs.json')
}

/** Writes are debounced and never awaited by the hook path: a raw listener must not block on disk,
 *  and a burst of events for one session would otherwise be a burst of writes. */
const PERSIST_DEBOUNCE_MS = 1000
let persistTimer: ReturnType<typeof setTimeout> | null = null
let loaded = false

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistGrokSessionDirs()
  }, PERSIST_DEBOUNCE_MS)
  // Never hold the process open for a cache write.
  persistTimer.unref?.()
}

/** Write the map. Atomic (rule 14): a torn file here is a map that resolves nothing AND cannot be
 *  repaired, which is worse than no file at all. Failures are swallowed on purpose — this is a
 *  cache, and losing it costs a name until the next hook, exactly the pre-persistence behaviour. */
export async function persistGrokSessionDirs(): Promise<void> {
  try {
    await writeFileAtomic(mapFile(), JSON.stringify(Object.fromEntries(sessionDirs)), {
      mode: 0o600
    })
  } catch {
    // Cache write failed. Nothing to say and nothing to do: the in-memory map is unaffected.
  }
}

/**
 * Load the map from disk, once per process. Called lazily by the first read rather than at boot, so
 * neither shell needs a new startup step to keep the two in sync (invariant 11 by construction).
 *
 * Every entry is re-validated with `isSafeGrokSessionId` before it is trusted: this file is written
 * by us, but it sits in a directory a user can edit, and the values end up as filesystem paths. A
 * corrupt or hand-edited file yields an EMPTY map, never a partial one built from whatever parsed.
 */
function loadOnce(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(mapFile(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [id, dir] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dir !== 'string' || !dir) continue
      if (!isSafeGrokSessionId(id)) continue
      if (sessionDirs.size >= MAX_TRACKED_SESSIONS) break
      // An entry already learned from a live hook wins: it is newer by definition.
      if (!sessionDirs.has(id)) sessionDirs.set(id, dir)
    }
  } catch {
    // Absent (first run), unreadable, or not JSON — all mean "no remembered map", which is the
    // pre-persistence behaviour and never a wrong answer.
  }
}

export function rememberGrokSessionDir(sessionId: string, dir: string): void {
  if (!sessionId || !dir) return
  loadOnce()
  // Re-insert so the map's iteration order is least-recently-SEEN first: that is what makes the
  // eviction below drop the session nobody has heard from, not whichever one happened to be first.
  if (sessionDirs.has(sessionId)) sessionDirs.delete(sessionId)
  sessionDirs.set(sessionId, dir)
  if (sessionDirs.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionDirs.keys().next().value
    if (oldest !== undefined) sessionDirs.delete(oldest)
  }
  schedulePersist()
}

export function grokSessionDirFor(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  loadOnce()
  return sessionDirs.get(sessionId)
}

export function forgetGrokSession(sessionId: string | undefined): void {
  if (!sessionId) return
  loadOnce()
  if (sessionDirs.delete(sessionId)) schedulePersist()
}

/** Test seam: drop the in-memory map AND the load flag, so a test can simulate a process restart
 *  without a new process. */
export function _resetGrokSessionDirsForTests(): void {
  sessionDirs.clear()
  loaded = false
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}

/**
 * Reads a REMOTE grok session's `summary.json` on its own host.
 *
 * Returns `{ text }` for a session this reader owns (even when the body is empty — that is "remote
 * and unreadable", which must not become a local lookup), and `null` for a session it does not own,
 * which routes to the local map.
 */
export type GrokRemoteSummaryReader = (
  sessionId: string
) => Promise<{ text: string } | null>

/** The session NAME for a sessionId we have seen a hook for. null when unknown or unnamed. */
export async function readGrokSessionName(
  sessionId: string,
  remote?: GrokRemoteSummaryReader
): Promise<string | null> {
  // A REMOTE (SSH) node's session lives on the HOST. The shells derive the directory from the LOCAL
  // sessions root with the host's `cwd`, which is a path on the wrong machine — §8.4. So the remote
  // reader is asked FIRST, and its answer is final:
  //
  //   `{ text }`  this session is remote. Parse that text and stop. An empty/unreadable body means
  //               NO NAME — never the local map. Falling back would answer a question about the
  //               host with a fact about this machine, and "could not read" and "does not exist"
  //               are different facts that must stay different (rule 9).
  //   `null`      this session is not remote. Use the local map, exactly as before.
  //
  // Same shape as claude's `setRemoteTranscriptReader`, deliberately: one remote idiom, not two.
  if (remote) {
    const r = await remote(sessionId)
    if (r) return pickGrokSessionMeta(r.text)?.title ?? null
  }
  const dir = grokSessionDirFor(sessionId)
  if (!dir) return null
  return (await readGrokSessionMeta(dir))?.title ?? null
}
