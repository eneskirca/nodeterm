// Pure helpers for the transcript index: extract searchable fields from a transcript's raw
// JSONL text, build snippets, and rank sessions by a query. No filesystem access — the
// service layer (transcript-index.ts) reads files and calls these. Reuses the same JSONL
// parser as the single-session reader so indexed text stays consistent with the find-bar.
import type { TranscriptHit } from '../shared/types'
import { parseTranscriptLines } from './transcript-reader'

export type { TranscriptHit }

export const INDEX_TEXT_CAP_BYTES = 200 * 1024

export interface TranscriptIndexEntry {
  sessionId: string
  transcriptPath: string
  cwd: string
  mtime: number
  title: string
  text: string
}

// Read `cwd` from the first JSONL line that carries it (every Claude line does); reliable,
// unlike decoding the dashed directory name.
function firstCwd(rawText: string): string {
  for (const raw of rawText.split('\n')) {
    if (!raw.trim()) continue
    try {
      const o = JSON.parse(raw) as { cwd?: unknown }
      if (typeof o.cwd === 'string' && o.cwd) return o.cwd
    } catch {
      /* skip */
    }
  }
  return ''
}

export function extractEntryFields(rawText: string): { cwd: string; title: string; text: string } {
  // Pastes stay as recorded (no code fences in a title), as before the ⌘M view fenced them.
  const lines = parseTranscriptLines(rawText, { expandPastes: false })
  const firstUser = lines.find((l) => l.role === 'user')
  const title = (firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  let text = lines.map((l) => l.text).join('\n')
  if (text.length > INDEX_TEXT_CAP_BYTES) text = text.slice(text.length - INDEX_TEXT_CAP_BYTES)
  return { cwd: firstCwd(rawText), title, text }
}

export function makeSnippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0) return text.slice(0, 160).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, i - 60)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + 160).replace(/\s+/g, ' ').trim()
  )
}

export function searchEntries(
  entries: TranscriptIndexEntry[],
  query: string,
  limit = 20,
  /** The managed/linked account whose root holds a transcript (undefined = system). A resume of the
   *  hit must run under that account, or the CLI answers "No conversation found". */
  accountOf?: (transcriptPath: string) => string | undefined
): TranscriptHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  return entries
    .filter((e) => e.title.toLowerCase().includes(q) || e.text.toLowerCase().includes(q))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((e) => ({
      sessionId: e.sessionId,
      title: e.title || e.sessionId,
      snippet: makeSnippet(`${e.title}\n${e.text}`, q),
      cwd: e.cwd,
      projectLabel: e.cwd ? e.cwd.split('/').filter(Boolean).pop() ?? e.cwd : '',
      mtime: e.mtime,
      ...((a) => (a ? { accountId: a } : {}))(accountOf?.(e.transcriptPath))
    }))
}

// A directory listing of one transcript file (path + mtime), without its parsed contents.
export interface ScanFile {
  sessionId: string
  transcriptPath: string
  mtime: number
}

// The outcome of diffing a fresh scan against the prior index: which files to (re-)read and
// which prior entries to keep as-is. Entries absent from the scan are dropped (not returned).
export interface RefreshPlan {
  toRead: ScanFile[]
  keep: TranscriptIndexEntry[]
}

// Decide what an incremental refresh must do: re-read scan files that are new or whose mtime
// increased, keep prior entries whose file is unchanged and still present, drop the rest.
export function planRefresh(prior: TranscriptIndexEntry[], scan: ScanFile[]): RefreshPlan {
  const priorById = new Map(prior.map((e) => [e.sessionId, e]))
  const toRead: ScanFile[] = []
  const keep: TranscriptIndexEntry[] = []
  for (const f of scan) {
    const p = priorById.get(f.sessionId)
    if (p && p.mtime === f.mtime) keep.push(p)
    else toRead.push(f)
  }
  return { toRead, keep }
}
