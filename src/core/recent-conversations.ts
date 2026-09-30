// "Open recent" — read the newest agent conversations THIS machine's CLIs keep on disk.
//
// Past conversations live in each CLI's own history (claude per config dir, codex rollouts, gemini,
// grok and copilot session stores), and until this existed nodeterm could only resume what a node
// happened to remember. This lists them; the renderer offers "Resume in <project>".
//
// Rules this module keeps, each for a reason:
//  - ONLY this user's own roots: the system config dirs under `os.homedir()` (and each CLI's own
//    relocation variable, read from this process's env exactly as the rest of core reads it), plus
//    the managed / linked account dirs this app already knows. Never another user's home, never a
//    path the caller names — the request carries account IDS, which resolve only under the managed
//    root (`codexHomeForAccount` refuses an id outside its alphabet).
//  - BOUNDED: per root, only the newest `PER_ROOT` candidates by mtime are opened, each read is a
//    capped head (and, for the claude title, a capped tail), and the parsed answer is cached by
//    (path, size, mtime), so a second open of the list reads nothing that did not change.
//  - Unknown shapes are SKIPPED, never guessed: a file with no parsable id, a subagent/child
//    session, an id that fails `SAFE_SESSION_ID` — none of those becomes a row.
//  - A title is untrusted text (a prompt anyone could have typed, a model-written name) and is
//    made into ONE display line with no control / bidi / zero-width characters (`untrustedLine`).
//    It is never typed into a pane; only the validated session id is.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import { SAFE_SESSION_ID } from '../shared/session-id'
import {
  RECENT_CONVERSATIONS_MAX,
  RECENT_TITLE_MAX,
  type RecentConversation,
  type RecentConversationAgent,
  type RecentConversationsRequest,
  type RecentConversationsResult
} from '../shared/recent-conversations'
import type { ChatMessage } from '../shared/types'
import { platform } from './platform'
import { transcriptRoot, parseChatMessages, pickSessionName } from './transcript-reader'
import { claudeAccountsSnapshot } from './claude-config-dir'
import { codexHomeForAccount } from './codex-accounts-core'
import { chatMessagesFromCodex, CODEX_THREAD_ID_RE } from './codex-chat'
import { chatFromGemini } from './gemini-chat'
import { pickGeminiTitle } from './gemini-session'
import { chatMessagesFromGrok } from './grok-chat'
import { readGrokSessionMeta } from './grok-session'
import {
  GROK_CHAT_HISTORY_FILE,
  grokEncodedCwdDirName,
  grokSessionsDir,
  isSafeGrokSessionId
} from './agents/grok-paths'
import { chatMessagesFromCopilot, COPILOT_EVENTS_FILE, copilotSessionStateRoots } from './copilot-chat'
import { untrustedLine } from './github/control-read'

/** Candidates opened per root (newest by mtime). A root with thousands of old transcripts costs a
 *  directory listing and a stat each, never a read. */
export const PER_ROOT = 25
/** Head bytes read for id / cwd / first prompt. A codex `session_meta` line carries the full base
 *  instructions (measured: tens of KB), so this is generous. */
export const HEAD_BYTES = 512 * 1024
/** Tail bytes read for a claude session name (`custom-title` / `ai-title` records). */
export const TITLE_TAIL_BYTES = 128 * 1024
const CACHE_MAX = 2000
/** More managed codex homes than anyone has is a hostile request, not a user. */
const MAX_CODEX_ACCOUNTS = 32

interface Candidate {
  file: string
  mtimeMs: number
  size: number
}

/** Where each agent's history lives. Injectable so tests point at fixture trees. */
export interface RecentRoots {
  claude: Array<{ root: string; accountId?: string }>
  codex: Array<{ home: string; accountId?: string }>
  geminiTmp: string | null
  grokSessions: string | null
  copilot: string[]
}

type Parsed = Omit<RecentConversation, 'lastActiveAt' | 'accountId'> | null

const cache = new Map<string, { size: number; mtimeMs: number; parsed: Parsed }>()

export function resetRecentConversationsCacheForTests(): void {
  cache.clear()
}

/** The real roots for this process: system dirs, every LOCAL settled managed/linked claude account,
 *  and each requested managed codex account (ids re-validated by the resolver, which throws). */
export function defaultRecentRoots(req: RecentConversationsRequest = {}): RecentRoots {
  const claude: RecentRoots['claude'] = [{ root: transcriptRoot() }]
  const seen = new Set<string>([claude[0].root])
  for (const a of claudeAccountsSnapshot()) {
    // A host-pinned account's history is on that host; a pending one has never logged in.
    if (!a || typeof a.id !== 'string' || a.host || a.pending) continue
    let root: string
    try {
      root = transcriptRoot(a.id)
    } catch {
      continue
    }
    if (seen.has(root)) continue
    seen.add(root)
    claude.push({ root, accountId: a.id })
  }
  const codex: RecentRoots['codex'] = [{ home: codexHomeForAccount(platform().userDataDir) }]
  const ids = Array.isArray(req.codexAccountIds) ? req.codexAccountIds.slice(0, MAX_CODEX_ACCOUNTS) : []
  for (const id of ids) {
    if (typeof id !== 'string') continue
    try {
      codex.push({ home: codexHomeForAccount(platform().userDataDir, id), accountId: id })
    } catch {
      /* an id outside the account alphabet names no managed home */
    }
  }
  const geminiHome = process.env.GEMINI_CLI_HOME || os.homedir()
  return {
    claude,
    codex,
    geminiTmp: path.join(geminiHome, '.gemini', 'tmp'),
    grokSessions: grokSessionsDir(),
    copilot: copilotSessionStateRoots()
  }
}

// ── filesystem helpers ──────────────────────────────────────────────────────────────────────────

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith(suffix)).map((e) => e.name)
  } catch {
    return []
  }
}

async function statCandidate(file: string): Promise<Candidate | null> {
  try {
    // lstat, then a regular-file check: a symlink planted in a history dir must not make us read
    // (and title-list) whatever it points at.
    const st = await fs.promises.lstat(file)
    if (!st.isFile()) return null
    return { file, mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/** Stats run in parallel, but never more than this many at once: a history of 10,000 transcripts
 *  (measured in review: 1.6 s cold / 2.8–4.0 s warm, awaited one by one) must not open 10,000
 *  handles at the same instant either. */
export const STAT_CONCURRENCY = 32

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).isFile()
  } catch {
    return false
  }
}

function newest(cands: Array<Candidate | null>, n = PER_ROOT): Candidate[] {
  return cands
    .filter((c): c is Candidate => !!c && c.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, n)
}

async function readRange(file: string, start: number, len: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Complete lines only: a capped head can end mid-record, and a torn record parses as nothing. */
async function headLines(c: Candidate): Promise<string[]> {
  const text = await readRange(c.file, 0, Math.min(c.size, HEAD_BYTES))
  const lines = text.split('\n')
  if (c.size > HEAD_BYTES) lines.pop()
  return lines.filter((l) => l.trim())
}

async function tailText(c: Candidate, bytes: number): Promise<string> {
  const start = Math.max(0, c.size - bytes)
  const text = await readRange(c.file, start, c.size - start)
  // Drop the (possibly torn) first line of a window that does not start at 0.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(line) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** An absolute directory string, or null. A history file is input we did not write. */
export function safeCwd(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > 4096 || /[\x00-\x1f\x7f]/.test(s)) return null
  if (!path.isAbsolute(s) && !path.win32.isAbsolute(s)) return null
  return s
}

/** The first thing the human typed, as text. Harness-injected wrappers (`<command-…>`,
 *  `<session_context>`, …) are not a prompt anyone would recognise as theirs. */
export function firstPrompt(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.parts
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join(' ')
      .trim()
    if (!text || text.startsWith('<')) continue
    return text
  }
  return ''
}

function titled(name: string | null | undefined, prompt: string): Pick<RecentConversation, 'title' | 'titleSource'> {
  const n = untrustedLine(name ?? '', RECENT_TITLE_MAX)
  if (n) return { title: n, titleSource: 'name' }
  const p = untrustedLine(prompt, RECENT_TITLE_MAX)
  if (p) return { title: p, titleSource: 'prompt' }
  return { title: '', titleSource: 'none' }
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_SESSION_ID.test(id)
}

// ── per-agent parsers (pure over a candidate; cached by the caller) ───────────────────────────

async function parseClaude(c: Candidate): Promise<Parsed> {
  const id = path.basename(c.file, '.jsonl')
  if (!validId(id)) return null
  const lines = await headLines(c)
  let cwd: string | null = null
  for (const l of lines) {
    const o = parseJson(l)
    if (!o) continue
    // A session started as a sidechain (a subagent transcript at the top level of an old layout)
    // is not a conversation anyone resumes by hand.
    if (o.isSidechain === true && !cwd) return null
    cwd = safeCwd(o.cwd)
    if (cwd) break
  }
  const prompt = firstPrompt(parseChatMessages(lines))
  const name = pickSessionName(await tailText(c, TITLE_TAIL_BYTES))
  const t = titled(name, prompt)
  // No prompt and no name: a transcript holding only bookkeeping (a `/clear` stub, a session that
  // never took a turn) is not a conversation.
  if (t.titleSource === 'none') return null
  return { agentId: 'claude', sessionId: id, cwd, ...t }
}

async function parseCodex(c: Candidate): Promise<Parsed> {
  const lines = await headLines(c)
  const meta = lines.length ? parseJson(lines[0]) : null
  if (!meta || meta.type !== 'session_meta' || !isObj(meta.payload)) return null
  const p = meta.payload
  const id = p.id
  if (typeof id !== 'string' || !CODEX_THREAD_ID_RE.test(id) || !validId(id)) return null
  // MEASURED (codex 0.156): a spawned child rollout carries `thread_source: "subagent"` and a
  // `source: {subagent: …}` object; a user's own thread says `thread_source: "user"`.
  if (p.thread_source === 'subagent' || isObj(p.source)) return null
  const prompt = firstPrompt(chatMessagesFromCodex(lines.join('\n')))
  const t = titled(null, prompt)
  if (t.titleSource === 'none') return null
  return { agentId: 'codex', sessionId: id, cwd: safeCwd(p.cwd), ...t }
}

async function parseGemini(c: Candidate, cwd: string | null): Promise<Parsed> {
  const lines = await headLines(c)
  const header = lines.length ? parseJson(lines[0]) : null
  if (!header || !validId(header.sessionId)) return null
  // `kind: "main"` measured on the user's own session; anything else (a subagent) is skipped.
  if (header.kind !== undefined && header.kind !== 'main') return null
  const prompt = firstPrompt(chatFromGemini(lines.join('\n')).messages)
  const name = pickGeminiTitle(await tailText(c, TITLE_TAIL_BYTES))
  const t = titled(name, prompt)
  if (t.titleSource === 'none') return null
  return { agentId: 'gemini', sessionId: header.sessionId, cwd, ...t }
}

async function parseGrok(c: Candidate, sessionId: string, cwd: string | null): Promise<Parsed> {
  const lines = await headLines(c)
  const prompt = firstPrompt(chatMessagesFromGrok(lines.join('\n')))
  const dir = path.dirname(c.file)
  // summary.json is opened by the shared reader, which follows links — lstat it here first.
  const meta = (await isRegularFile(path.join(dir, 'summary.json'))) ? await readGrokSessionMeta(dir) : null
  const t = titled(meta?.title, prompt)
  if (t.titleSource === 'none') return null
  return { agentId: 'grok', sessionId, cwd, ...t }
}

async function parseCopilot(c: Candidate, dirId: string): Promise<Parsed> {
  const lines = await headLines(c)
  const start = lines.map(parseJson).find((o) => o?.type === 'session.start')
  const data = start && isObj(start.data) ? start.data : null
  // The journal's own id must name the directory it sits in — a copied journal is not this session.
  if (!data || data.sessionId !== dirId || !validId(dirId)) return null
  const cwd = isObj(data.context) ? safeCwd(data.context.cwd) : null
  const prompt = firstPrompt(chatMessagesFromCopilot(lines.join('\n')))
  const t = titled(null, prompt)
  if (t.titleSource === 'none') return null
  return { agentId: 'copilot', sessionId: dirId, cwd, ...t }
}

async function cached(c: Candidate, parse: () => Promise<Parsed>): Promise<Parsed> {
  const hit = cache.get(c.file)
  if (hit && hit.size === c.size && hit.mtimeMs === c.mtimeMs) return hit.parsed
  let parsed: Parsed
  try {
    parsed = await parse()
  } catch {
    // A read that failed is not cached: the file may be readable next time.
    return null
  }
  cache.delete(c.file)
  cache.set(c.file, { size: c.size, mtimeMs: c.mtimeMs, parsed })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return parsed
}

type Row = RecentConversation

function row(parsed: Parsed, c: Candidate, accountId?: string): Row | null {
  if (!parsed) return null
  return { ...parsed, lastActiveAt: Math.round(c.mtimeMs), ...(accountId ? { accountId } : {}) }
}

// ── per-agent enumeration ─────────────────────────────────────────────────────────────────────

async function claudeRows(root: string, accountId?: string): Promise<Row[]> {
  const files: string[] = []
  const projects = await listDirs(root)
  const lists = await mapLimit(projects, STAT_CONCURRENCY, (proj) => listFiles(path.join(root, proj), '.jsonl'))
  projects.forEach((proj, i) => {
    for (const f of lists[i]) files.push(path.join(root, proj, f))
  })
  const cands = await mapLimit(files, STAT_CONCURRENCY, statCandidate)
  const out: Row[] = []
  for (const c of newest(cands)) {
    const r = row(await cached(c, () => parseClaude(c)), c, accountId)
    if (r) out.push(r)
  }
  return out
}

async function codexRows(home: string, accountId?: string): Promise<Row[]> {
  // YYYY/MM/DD, newest first by NAME: the tree is dated, so walking it in reverse order finds the
  // newest rollouts without statting the whole history. A generous window (4× the per-root cap)
  // is statted, since a rollout's mtime (last activity) can be newer than a later-dated sibling.
  const root = path.join(home, 'sessions')
  const files: string[] = []
  const want = PER_ROOT * 4
  outer: for (const y of (await listDirs(root)).sort().reverse()) {
    for (const m of (await listDirs(path.join(root, y))).sort().reverse()) {
      for (const d of (await listDirs(path.join(root, y, m))).sort().reverse()) {
        const dir = path.join(root, y, m, d)
        for (const f of (await listFiles(dir, '.jsonl')).sort().reverse()) {
          files.push(path.join(dir, f))
          if (files.length >= want) break outer
        }
      }
    }
  }
  const out: Row[] = []
  for (const c of newest(await mapLimit(files, STAT_CONCURRENCY, statCandidate))) {
    const r = row(await cached(c, () => parseCodex(c)), c, accountId)
    if (r) out.push(r)
  }
  return out
}

async function geminiRows(tmp: string): Promise<Row[]> {
  const cands: Array<{ c: Candidate | null; cwd: string | null }> = []
  for (const proj of await listDirs(tmp)) {
    const projDir = path.join(tmp, proj)
    // MEASURED (gemini-cli, 2026-09): each project dir holds `.project_root`, the absolute cwd.
    let cwd: string | null = null
    try {
      const rootFile = path.join(projDir, '.project_root')
      // lstat first: a symlink planted here must not make us read whatever it points at.
      if (await isRegularFile(rootFile)) cwd = safeCwd((await readRange(rootFile, 0, 4096)).trim())
    } catch {
      /* an older layout (hash-named dir) has none — the row keeps a null cwd */
    }
    const chats = path.join(projDir, 'chats')
    const stats = await mapLimit(await listFiles(chats, '.jsonl'), STAT_CONCURRENCY, (f) =>
      statCandidate(path.join(chats, f))
    )
    for (const c of stats) cands.push({ c, cwd })
  }
  const byFile = new Map(cands.filter((x) => x.c).map((x) => [x.c!.file, x.cwd]))
  const out: Row[] = []
  for (const c of newest(cands.map((x) => x.c))) {
    const r = row(await cached(c, () => parseGemini(c, byFile.get(c.file) ?? null)), c)
    if (r) out.push(r)
  }
  return out
}

async function grokRows(sessions: string): Promise<Row[]> {
  const cands: Array<{ c: Candidate | null; id: string; cwd: string | null }> = []
  for (const group of await listDirs(sessions)) {
    // grok names a session group by the URL-encoded cwd. Decoded, it must re-encode to the same
    // name — otherwise it is the slug+hash form (a long cwd) we cannot invert, and the cwd is null.
    let cwd: string | null = null
    try {
      const decoded = decodeURIComponent(group)
      if (grokEncodedCwdDirName(decoded) === group) cwd = safeCwd(decoded)
    } catch {
      /* not an encoded path */
    }
    const ids = (await listDirs(path.join(sessions, group))).filter((id) => isSafeGrokSessionId(id) && validId(id))
    const stats = await mapLimit(ids, STAT_CONCURRENCY, (id) =>
      statCandidate(path.join(sessions, group, id, GROK_CHAT_HISTORY_FILE))
    )
    ids.forEach((id, i) => cands.push({ c: stats[i], id, cwd }))
  }
  const meta = new Map(cands.filter((x) => x.c).map((x) => [x.c!.file, x]))
  const out: Row[] = []
  for (const c of newest(cands.map((x) => x.c))) {
    const m = meta.get(c.file)!
    const r = row(await cached(c, () => parseGrok(c, m.id, m.cwd)), c)
    if (r) out.push(r)
  }
  return out
}

async function copilotRows(root: string): Promise<Row[]> {
  const ids = (await listDirs(root)).filter(validId)
  const cands = await mapLimit(ids, STAT_CONCURRENCY, (id) => statCandidate(path.join(root, id, COPILOT_EVENTS_FILE)))
  const out: Row[] = []
  for (const c of newest(cands)) {
    const id = path.basename(path.dirname(c.file))
    const r = row(await cached(c, () => parseCopilot(c, id)), c)
    if (r) out.push(r)
  }
  return out
}

/** Newest first; the same (agent, session) seen twice keeps its NEWEST sighting. A tie — a codex
 *  rollout HARDLINKED into a second home by "Switch Codex account" is one inode, so both sightings
 *  carry the same mtime — goes to the MANAGED account's copy: that is the account the conversation
 *  was usually switched to. A switch BACK to the system login is credited wrongly, at no cost: both
 *  homes hold the same file, so the resume finds it under either login. */
export function mergeRecent(rows: Row[], limit: number): Row[] {
  const best = new Map<string, Row>()
  for (const r of rows) {
    const key = `${r.agentId}\0${r.sessionId}`
    const prev = best.get(key)
    if (
      !prev ||
      r.lastActiveAt > prev.lastActiveAt ||
      (r.lastActiveAt === prev.lastActiveAt && !!r.accountId && !prev.accountId)
    ) {
      best.set(key, r)
    }
  }
  return [...best.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, limit)
}

export function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : RECENT_CONVERSATIONS_MAX
  return Math.min(RECENT_CONVERSATIONS_MAX, Math.max(1, n))
}

/** Every agent's newest conversations under `roots`. Never throws: an unreadable root adds no rows. */
export async function listRecentConversations(
  roots: RecentRoots,
  limit: number = RECENT_CONVERSATIONS_MAX
): Promise<RecentConversation[]> {
  const jobs: Array<Promise<Row[]>> = [
    ...roots.claude.map((r) => claudeRows(r.root, r.accountId)),
    ...roots.codex.map((r) => codexRows(r.home, r.accountId)),
    ...(roots.geminiTmp ? [geminiRows(roots.geminiTmp)] : []),
    ...(roots.grokSessions ? [grokRows(roots.grokSessions)] : []),
    ...roots.copilot.map((r) => copilotRows(r))
  ]
  const settled = await Promise.allSettled(jobs)
  const rows = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
  const merged = mergeRecent(rows, clampLimit(limit))
  // Does each folder still exist? A removed worktree is the common case, and "Open folder & resume"
  // would otherwise RECREATE it (the store mkdirs `<cwd>/.nodeterm`). One stat per distinct cwd.
  const cwds = [...new Set(merged.map((r) => r.cwd).filter((c): c is string => !!c))]
  const states = new Map(
    (await mapLimit(cwds, STAT_CONCURRENCY, async (c) => [c, await dirState(c)] as const)).map(([c, st]) => [c, st])
  )
  return merged.map((r) => (r.cwd ? { ...r, cwdState: states.get(r.cwd) ?? 'unknown' } : r))
}

/** `absent` only on a definite ENOENT/ENOTDIR (or a path that is not a directory) — any other error
 *  is `unknown`: a failed stat is never evidence of absence. */
export async function dirState(dir: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    return (await fs.promises.stat(dir)).isDirectory() ? 'present' : 'absent'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

/** How long one answer is reused. Opening ⌘K twice in a row must not re-stat the whole history;
 *  a conversation that ended a few seconds ago appearing a few seconds late costs nothing. */
export const RESULT_REUSE_MS = 10_000
let reuse: { key: string; at: number; items: Promise<RecentConversation[]> } | null = null

export function resetRecentConversationsReuseForTests(): void {
  reuse = null
}

/** `listRecentConversations` with a short reuse window, keyed by the exact roots + limit (so an
 *  account added in Settings is looked at on the next open, not after the window). A concurrent
 *  second call shares the first's in-flight read. */
export function listRecentConversationsReused(
  roots: RecentRoots,
  limit: number,
  now: number = Date.now()
): Promise<RecentConversation[]> {
  const key = JSON.stringify([roots, limit])
  if (reuse && reuse.key === key && now - reuse.at < RESULT_REUSE_MS) return reuse.items
  const items = listRecentConversations(roots, limit)
  reuse = { key, at: now, items }
  // A failed read is not reused.
  items.catch(() => {
    if (reuse?.items === items) reuse = null
  })
  return items
}

/** Sanitize a request that arrived over IPC / the WS bridge. */
export function normalizeRecentRequest(raw: unknown): RecentConversationsRequest {
  if (!isObj(raw)) return {}
  const ids = Array.isArray(raw.codexAccountIds)
    ? raw.codexAccountIds.filter((x): x is string => typeof x === 'string').slice(0, MAX_CODEX_ACCOUNTS)
    : undefined
  return { ...(ids ? { codexAccountIds: ids } : {}), limit: clampLimit(raw.limit) }
}

/** `recent-conversations:list`, registered by BOTH shells (each lists its own machine's history). */
export function registerRecentConversationsIpc(): void {
  platform().handle(IPC.recentConversationsList, async (raw: unknown): Promise<RecentConversationsResult> => {
    try {
      const req = normalizeRecentRequest(raw)
      return { ok: true, items: await listRecentConversationsReused(defaultRecentRoots(req), clampLimit(req.limit)) }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  })
}

export type { RecentConversationAgent }
