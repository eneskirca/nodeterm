// The two transcript READ channels — the ⌘M chat view (`chat:read-transcript`) and the find-bar's
// full-transcript index (`claude:read-transcript`) — registered through the CorePlatform seam so
// BOTH shells serve them.
//
// This lived inline in `src/main/index.ts`, which is exactly the failure mode the seam exists to
// prevent: the Server Edition had no handler at all, its bridge stub rejected, and the chat panel
// (which never caught the rejection) presented every browser session as an empty conversation.
//
// The remote (SSH-project) leg stays an injected dep: it needs a ControlMaster, which only the
// Electron shell has. Absent deps ⇒ local-only, which is the correct and complete answer on the
// server — it runs ON the host whose transcripts it is reading.
import fsp from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult, TranscriptLine, TranscriptPresence } from '../shared/types'
import {
  CHAT_PAGE_MAX_BYTES,
  GROK_AMBIGUOUS_SESSION_MESSAGE,
  normalizeChatPage,
  type ChatTranscriptPage
} from '../shared/chat-page'
import { platform } from './platform'
import { parseGrokChat } from './grok-chat'
import type { RemoteGrokChat } from './remote-grok-chat'
import { readGeminiChatTranscript } from './gemini-chat'
import { chatMessagesFromCodex, locateCodexRollout, parseCodexChatWindow } from './codex-chat'
import { chatMessagesFromCopilot, locateCopilotTranscript, parseCopilotChatWindow } from './copilot-chat'
import { readOpencodeChat, type OpencodeExportRun } from './opencode-chat'
import { readCursorChat } from './cursor-chat'
import { locateGrok } from './handoff/locate'
import { capabilityAgentId } from '../shared/agents/config'
import {
  parseChatMessages,
  parseChatWindow,
  parseTranscriptLines,
  type ChatWindowParse,
  readChatWindow,
  readCappedTail,
  readChatMessages,
  readTranscriptLines,
  resolveTranscriptPath,
  transcriptPresence,
  transcriptPathForCwd,
  SESSION_ID_RE
} from './transcript-reader'

/** What a read is asked for. `nodeId` is only meaningful to the remote leg. */
export interface TranscriptQuery {
  sessionId: string | undefined
  cwd: string | undefined
  accountId: string | undefined
  nodeId: string | undefined
  /** The caller KNOWS this node is remote (from its own records, not from a live pty): the local
   *  resolver must never run, even when the remote leg cannot resolve the node. */
  remoteOnly?: boolean
}

export interface TranscriptIpcDeps {
  /** Transcript path a live context tail already knows for this session (hook-fed — authoritative
   *  when present). Optional: the sessionId scan below finds any transcript in a standard root. */
  pathFor?(sessionId: string): string | undefined
  /**
   * Tail text of a REMOTE node's transcript, or null when this is not a remote session (or it
   * could not be resolved). Electron-only — the server has no SSH-project manager.
   */
  readRemote?(q: TranscriptQuery): Promise<string | null>
  /**
   * Does the transcript exist on the HOST — or `null` when this is not a remote session, which is
   * the signal to take the local path below. Same `null` convention as `readRemote`.
   *
   * It must return `'unknown'` (not `null`) for a remote session it failed to ask, or the local
   * resolver would run against THIS machine's disk for a session that only ever existed on the
   * host and report `absent` — the one answer that destroys a resume. Electron-only.
   */
  remoteExists?(q: TranscriptQuery): Promise<TranscriptPresence | null>
  /**
   * ONE page of a REMOTE node's transcript — a ranged read on the host, so a paged ⌘M open moves
   * a window over ssh instead of the legacy 5 MB tail. `null` = not a remote session (same
   * convention as `readRemote`); `{ok:false}` = it IS remote and the host could not be read, which
   * must end as not-found rather than fall through to THIS machine's disk; `{ok:false, absent:true}`
   * = it IS remote and the host LOOKED and has no such transcript (or there is no session id to look
   * for) — a clean miss, which is `found:false` WITHOUT `unreadable`. `data` is the file's
   * bytes from absolute offset `start` (one lookbehind byte included — see `parseChatWindow`).
   * Electron-only.
   */
  readRemotePage?(q: TranscriptQuery, page: ChatTranscriptPage): Promise<RemoteTranscriptPage | null>
  /**
   * Is this node an SSH-project node — from the SHELL's own records (its workspace store, its live
   * pty), never from anything the renderer sends. Every channel below then applies `remoteOnly`:
   * a remote node whose remote leg cannot answer is a miss or a failure, never a read of THIS
   * machine's disk (claude's cwd-newest fallback there adopts a stranger's local session). Absent
   * (the Server Edition — it runs ON the host) = no node is remote, which is correct there.
   */
  isRemoteNode?(nodeId: string): boolean
  /**
   * A REMOTE grok node's conversation, read ON the host (`createReadRemoteGrokChat`). `null` = not
   * a remote session (take the local path); `{ok:false}` = it IS remote and the host could not be
   * read; `{ok:false, absent:true}` = the host looked and has no such session. Grok's own leg —
   * claude's `readRemotePage` tails a claude file and must never answer for a grok node.
   * Electron-only, like the other remote legs.
   */
  readRemoteGrok?(q: TranscriptQuery, opts?: { maxBytes?: number }): Promise<RemoteGrokChat | null>
  /**
   * The rollout path the CODEX context tail learned from a hook for this session (the `pathFor` above
   * is CLAUDE's tail and must never answer for a codex id). A hint only: `locateCodexRollout` uses it
   * when its file name names this very thread and it exists. Both shells wire it.
   */
  codexPathFor?(sessionId: string): string | undefined
  /**
   * ONE page of a REMOTE codex node's rollout, located ON the host under the node's own account home
   * and read with the same ranged read claude's remote leg uses. Same conventions as
   * `readRemotePage`: `null` = not a remote node; `{ok:false}` = remote and unreadable (terminal —
   * never this machine's disk); `{ok:false, absent:true}` = the host looked and has no such rollout.
   * Electron-only; the Server Edition runs on the host it reads.
   */
  readRemoteCodexPage?(q: TranscriptQuery, page: ChatTranscriptPage): Promise<RemoteTranscriptPage | null>
  /** `opencode export <id>` for an opencode node's chat read. A test seam: absent = the real,
   *  bounded and gated CLI call (`defaultOpencodeExport`) — both shells run it on their own host. */
  opencodeExport?: OpencodeExportRun
}

export type RemoteTranscriptPage = { ok: true; data: Buffer; start: number } | { ok: false; absent?: true }

/** How much a window with no complete line grows per re-read. ×4 reaches the 5 MB cap from the
 *  default 256 KB tail in three extra reads, and from the 64 KB minimum in four. */
const CHAT_PAGE_GROWTH = 4

/** A window read: its bytes from absolute offset `start` (lookbehind byte included), or `null` when
 *  the read failed — which ends the whole page as not-found. */
type WindowRead = (page: ChatTranscriptPage) => Promise<{ data: Buffer; start: number } | null>

/**
 * Parse the window `first` (already read for `page`), GROWING it while it holds no complete line.
 *
 * A record bigger than the window — in practice a `type:user` line carrying a pasted screenshot or
 * an image tool_result, measured at 181 lines above 512 KB in 30 days on one host — used to leave
 * the window empty, and the cursor then pointed INTO that record, so the next older read ended
 * mid-line, failed to parse and the record vanished: screenshot prompts gone, tools missing their
 * results. The legacy 5 MB read showed them. So the same `before` is re-read with a bigger window
 * (×`CHAT_PAGE_GROWTH`) up to `CHAT_PAGE_MAX_BYTES`, the legacy cap — no paged read ever costs more
 * than an unpaged one did, and only a line longer than 5 MB (which the legacy read could not show
 * either) is skipped. Shared by the local and the remote leg, so both page identically.
 *
 * A failed re-read is NOT answered with the skip: dropping a record because the host blinked is the
 * very bug this exists to fix. It is a failed read, and the caller's retry path handles it.
 */
async function parseGrowingWindow(
  page: ChatTranscriptPage,
  first: { data: Buffer; start: number },
  read: WindowRead,
  // The window parser: claude's, or another append-only JSONL reader's (codex's, copilot's).
  parse: (buf: Buffer, bufStart: number) => ChatWindowParse = parseChatWindow
): Promise<ChatTranscriptResult> {
  let w = first
  let maxBytes = page.maxBytes
  for (;;) {
    const { noCompleteLine, ...parsed } = parse(w.data, w.start)
    if (!noCompleteLine || w.start === 0 || maxBytes >= CHAT_PAGE_MAX_BYTES) return { found: true, ...parsed }
    maxBytes = Math.min(CHAT_PAGE_MAX_BYTES, maxBytes * CHAT_PAGE_GROWTH)
    const next = await read({ before: page.before, maxBytes })
    if (!next) return unreadablePage()
    w = next
  }
}

const notFoundPage = (): ChatTranscriptResult => ({
  messages: [],
  found: false,
  olderCursor: null,
  unmatchedResults: []
})

/** Not found BECAUSE it could not be read — the host did not answer, or a remote node has no
 *  reachable master. Distinct from "no transcript exists" for a caller that must say so. */
const unreadablePage = (): ChatTranscriptResult => ({ ...notFoundPage(), unreadable: true })

/**
 * A paged chat read (`chat:read-transcript` with its trailing `page` argument). Kept apart from the
 * legacy branch so the unpaged result stays byte-for-byte what it was.
 *
 * Remote first, as in the legacy path, and a remote failure is TERMINAL: a remote session's
 * transcript lives on the host, so falling through to the local resolver would answer from the
 * wrong machine. The remote leg is `readRemotePage` ONLY: a shell that can read a remote transcript
 * must inject it (the desktop does), because paging with only the legacy `readRemote` would read a
 * remote session's LOCAL namesake. (A `readRemote`-only fallback lived here with no caller; it was
 * removed rather than kept untested.)
 */
async function readChatPage(
  q: TranscriptQuery,
  page: ChatTranscriptPage,
  deps: TranscriptIpcDeps
): Promise<ChatTranscriptResult> {
  const readRemotePage = deps.readRemotePage
  if (readRemotePage) {
    const remote = await readRemotePage(q, page)
    if (remote !== null) {
      if (!remote.ok) return remote.absent ? notFoundPage() : unreadablePage()
      // A growth re-read that suddenly says "not remote" (null) is a failed read too — never a
      // reason to go read THIS machine's disk halfway through a remote page.
      return parseGrowingWindow(page, remote, async (p) => {
        const r = await readRemotePage(q, p)
        return r && r.ok ? r : null
      })
    }
  }
  // A node its caller KNOWS is remote (an SSH project's node, whether or not a pty is attached):
  // "the remote leg could not resolve it" is a failed read, never "take THIS machine's disk" —
  // that would answer from the wrong machine, or adopt a local transcript sharing its cwd.
  if (q.remoteOnly) return unreadablePage()
  const p = await resolveTranscript(q, deps.pathFor)
  if (!p) return notFoundPage()
  const w = await readChatWindow(p, page)
  // Resolved but unreadable (deleted between resolve and read): not-found, like a failed remote.
  if (!w) return notFoundPage()
  return parseGrowingWindow(page, w, async (pg) => (await readChatWindow(p, pg)) ?? null)
}

/**
 * A paged read of a CODEX node's rollout — `readChatPage`'s shape with codex's own locator and parser
 * (a rollout is append-only JSONL, so it pages by byte offset exactly like claude's transcript).
 * Nothing claude-shaped runs: not `resolveTranscript` (its cwd fallback answers with the newest
 * CLAUDE session in the directory), not claude's remote leg (it locates a claude file on the host).
 * Remote first and terminal, as everywhere: a remote node is read on its host or not at all.
 */
async function readCodexChatPage(
  q: TranscriptQuery,
  page: ChatTranscriptPage,
  deps: TranscriptIpcDeps
): Promise<ChatTranscriptResult> {
  const readRemote = deps.readRemoteCodexPage
  if (readRemote) {
    const remote = await readRemote(q, page)
    if (remote !== null) {
      if (!remote.ok) return remote.absent ? notFoundPage() : unreadablePage()
      return parseGrowingWindow(
        page,
        remote,
        async (p) => {
          const r = await readRemote(q, p)
          return r && r.ok ? r : null
        },
        parseCodexChatWindow
      )
    }
  }
  if (q.remoteOnly) return unreadablePage()
  const p = await locateCodexRollout({ sessionId: q.sessionId, accountId: q.accountId }, deps.codexPathFor)
  if (!p) return notFoundPage()
  const w = await readChatWindow(p, page)
  if (!w) return notFoundPage()
  return parseGrowingWindow(page, w, async (pg) => (await readChatWindow(p, pg)) ?? null, parseCodexChatWindow)
}

/**
 * A copilot node's read. Its journal (`<COPILOT_HOME>/session-state/<id>/events.jsonl`) is
 * append-only JSONL, so it pages exactly like claude's — same window, growth and cursor rules
 * (`parseGrowingWindow`), copilot's record parser.
 *
 * Located STRICTLY by the node's session id: no cwd fallback, no claude resolver, no hook-fed claude
 * path, no remote claude reader — each of those answers a copilot id with some other session. A
 * remote (SSH) node's journal is on the host and no remote copilot reader exists yet, so it is
 * `unreadable` (paged) / not found (legacy) BEFORE anything is read — never this machine's disk.
 * A local read that fails is a plain not-found, like grok's, so `unreadable` on a copilot result
 * can only mean "remote", which is what the panel says.
 */
async function readCopilotChat(
  sessionId: string | undefined,
  remoteOnly: boolean | undefined,
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  if (remoteOnly) return page ? unreadablePage() : { messages: [], found: false }
  const p = await locateCopilotTranscript(sessionId)
  if (!page) {
    const buf = p ? await readCappedTail(p) : undefined
    return buf === undefined ? { messages: [], found: false } : { messages: chatMessagesFromCopilot(buf), found: true }
  }
  if (!p) return notFoundPage()
  const w = await readChatWindow(p, page)
  if (!w) return notFoundPage()
  const out = await parseGrowingWindow(page, w, async (pg) => (await readChatWindow(p, pg)) ?? null, parseCopilotChatWindow)
  // A LOCAL growth re-read that failed (the journal vanished mid-read) comes back `unreadable`, but
  // on a copilot result the panel reads `unreadable` as "remote, unsupported" — keep that claim true.
  return out.unreadable ? notFoundPage() : out
}

/**
 * Resolve a session's transcript path: the exact session file when a (valid) sessionId is known,
 * else the node's cwd — durable, and needing no live hook event. `accountId` scopes BOTH legs to
 * the same root: dropping it on the fallback sent a managed-account node to the system root, where
 * it found nothing or adopted an unrelated session's newest transcript.
 */
export async function resolveTranscript(
  q: Pick<TranscriptQuery, 'sessionId' | 'cwd' | 'accountId'>,
  pathFor?: (sessionId: string) => string | undefined
): Promise<string | undefined> {
  let p: string | undefined
  if (q.sessionId && SESSION_ID_RE.test(q.sessionId)) {
    p = pathFor?.(q.sessionId) ?? (await resolveTranscriptPath(q.sessionId, q.accountId))
  }
  if (!p && q.cwd) p = await transcriptPathForCwd(q.cwd, q.accountId)
  return p
}

/**
 * A grok node's chat read. Grok does NOT page: its `chat_history.jsonl` is rewritten in place (a
 * `.sync.tmp` + rename; `/compact`, `/rewind` and history repair replace lines), so a byte offset
 * is no stable identity for a line. A paged request therefore gets the whole capped read with
 * `olderCursor: null` ("nothing older to fetch"), no carried results and no keys — plus the newest
 * assistant record's `model` / `effort`, as claude's paged reads carry theirs. The legacy unpaged
 * read stays `{messages, found}` byte for byte.
 *
 * Remote first, and its answer is TERMINAL: a remote grok session lives on the host, and the local
 * map can even hold a path derived for it on THIS machine (the hook listener builds it from the
 * local sessions root and the host's cwd), so falling through would read the wrong machine.
 */
async function readGrokChat(
  q: TranscriptQuery,
  page: ChatTranscriptPage | null,
  deps: TranscriptIpcDeps
): Promise<ChatTranscriptResult> {
  const paging = page ? { olderCursor: null, unmatchedResults: [] } : {}
  const notFound = (): ChatTranscriptResult => ({ messages: [], found: false, ...paging })
  const unreadable = (): ChatTranscriptResult => (page ? unreadablePage() : { messages: [], found: false })
  const served = (buf: string): ChatTranscriptResult => {
    const { messages, model, effort } = parseGrokChat(buf)
    return {
      messages,
      found: true,
      ...paging,
      ...(page && model !== undefined ? { model } : {}),
      ...(page && effort !== undefined ? { effort } : {})
    }
  }
  if (deps.readRemoteGrok) {
    // A paged read asks for the newest `page.maxBytes` only (the phone asks for 256 KB): still one
    // whole capped read, just a smaller tail window. The legacy read keeps the full cap.
    const remote = await deps.readRemoteGrok(q, page ? { maxBytes: page.maxBytes } : undefined)
    if (remote !== null) {
      // Two host sessions carry this id: its own sentence, as a rejection (the result shape is a
      // locked wire format) — never `unreadable`, whose copy promises a retry that cannot help.
      if (!remote.ok && remote.ambiguous) throw new Error(GROK_AMBIGUOUS_SESSION_MESSAGE)
      if (!remote.ok) return remote.absent ? notFound() : unreadable()
      return served(remote.text)
    }
  }
  // A node its caller KNOWS is remote whose remote leg could not resolve it: a failed read, never
  // this machine's disk.
  if (q.remoteOnly) return unreadable()
  const gp = q.sessionId ? await locateGrok(q.sessionId) : undefined
  if (!gp) return notFound()
  // Same window as the remote leg: a paged read's newest `page.maxBytes`, the legacy read the cap.
  const buf = await readCappedTail(gp, page ? page.maxBytes : undefined)
  return buf === undefined ? notFound() : served(buf)
}

/** What a chat read is asked for — the IPC channel's positional arguments, named. */
export interface ChatReadQuery {
  sessionId?: string
  cwd?: string
  accountId?: string
  nodeId?: string
  agentId?: string
  /** See `TranscriptQuery.remoteOnly`. Honoured by every read: paged, legacy unpaged, and grok's
   *  reader (whose remote leg is `readRemoteGrok`). */
  remoteOnly?: boolean
}

/**
 * The `chat:read-transcript` read, callable without the IPC seam — the relay's `chat.page` verb
 * serves the phone through it, so the phone and the ⌘M panel can never read a session differently.
 * `rawPage` is untrusted (IPC / WS bridge / relay) and validated here; absent = the legacy unpaged
 * read, byte for byte. Paged claude and grok results also carry `model` / `effort` (see
 * `parseChatWindow` / `parseGrokChat`).
 */
export async function readChatTranscript(
  q: ChatReadQuery,
  rawPage: unknown,
  deps: TranscriptIpcDeps
): Promise<ChatTranscriptResult> {
  const { sessionId, cwd, accountId, nodeId, agentId, remoteOnly } = q
  // Validated FIRST: it arrived over IPC / the WS bridge, and `before` reaches a remote shell
  // line. `null` = no page asked for = the legacy read below, byte for byte.
  const page = normalizeChatPage(rawPage)
  // Routed by agent BEFORE anything claude-shaped runs. `resolveTranscript` below falls back to
  // the newest claude transcript for the cwd when its sessionId leg misses, and a grok id always
  // misses — so reaching that fallback with a grok node would answer with a stranger's
  // conversation. Resolved through the base harness, so a custom agent built on grok (which the
  // panel and the phone admit via `canChat`) is routed here too instead of into that fallback.
  if (agentId !== undefined && capabilityAgentId(agentId) === 'grok') {
    return readGrokChat({ sessionId, cwd, accountId, nodeId, ...(remoteOnly ? { remoteOnly } : {}) }, page, deps)
  }
  // Gemini, routed through the base harness so a custom agent built on it (which the relay serves)
  // reads gemini's file too. Its own locator, keyed strictly on the session id in the file header —
  // never claude's resolver, never a cwd — and local-only (`CHAT_LOCAL_ONLY`).
  if (agentId && capabilityAgentId(agentId) === 'gemini') return readGeminiChatTranscript({ sessionId, remoteOnly }, page)
  // Codex — the builtin or a custom agent whose base harness it is — is routed BEFORE the claude
  // path for the same reason as grok: a codex thread id never resolves under claude's tree, and the
  // cwd fallback would then answer with somebody else's claude session.
  if (agentId && capabilityAgentId(agentId) === 'codex') {
    if (page) return readCodexChatPage({ sessionId, cwd, accountId, nodeId, ...(remoteOnly ? { remoteOnly } : {}) }, page, deps)
    // The unpaged (legacy) read has no live caller — the ⌘M panel and the phone always page — so it
    // is served locally or not at all, like grok's: a remote node's rollout is on its host.
    if (remoteOnly) return { messages: [], found: false }
    const cp = await locateCodexRollout({ sessionId, accountId }, deps.codexPathFor)
    const text = cp ? await readCappedTail(cp) : undefined
    return text === undefined ? { messages: [], found: false } : { messages: chatMessagesFromCodex(text), found: true }
  }
  // Copilot, by its base harness (a custom agent built on it reads the same journal). Before
  // anything claude-shaped, for the same reason as grok and codex. Local-only (`CHAT_LOCAL_ONLY`).
  if (agentId && capabilityAgentId(agentId) === 'copilot') return readCopilotChat(sessionId, remoteOnly, page)
  // Opencode has no transcript file — its sessions live in a database read through
  // `opencode export <id>` — so it must never reach claude's resolver below (whose cwd fallback
  // would answer with a stranger's session). Routed through the base harness, so a custom agent
  // built on opencode reads as opencode. Local only: a remote node is refused inside, before
  // anything runs. See core/opencode-chat.ts.
  if (agentId && capabilityAgentId(agentId) === 'opencode') {
    return readOpencodeChat({ sessionId, remoteOnly }, page, deps.opencodeExport)
  }
  // Cursor keeps chats in a SQLite store (`~/.cursor/chats/<md5 cwd>/<id>/store.db`), found strictly by
  // its whole-UUID id, never claude's resolver, whose cwd fallback would answer with a stranger's
  // session. Local only (`CHAT_LOCAL_ONLY`). See core/cursor-chat.ts.
  if (agentId && capabilityAgentId(agentId) === 'cursor') return readCursorChat({ sessionId, cwd, remoteOnly }, page)
  if (page) return readChatPage({ sessionId, cwd, accountId, nodeId, ...(remoteOnly ? { remoteOnly } : {}) }, page, deps)
  const remote = deps.readRemote ? await deps.readRemote({ sessionId, cwd, accountId, nodeId }) : null
  // A resolved-but-unreadable remote file is NOT "no conversation yet" — the read failed
  // (master down, transcript gone), and the panel must be able to say so.
  if (remote !== null) return { messages: parseChatMessages(remote.split('\n')), found: !!remote }
  // A known-remote node the remote leg could not resolve: not found — never THIS machine's disk.
  if (remoteOnly) return { messages: [], found: false }
  const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
  return p
    ? { messages: await readChatMessages(p), found: true }
    : { messages: [], found: false }
}

export function registerTranscriptIpc(deps: TranscriptIpcDeps = {}): void {
  const remoteText = (q: TranscriptQuery): Promise<string | null> =>
    deps.readRemote ? deps.readRemote(q) : Promise.resolve(null)
  // Decided HERE from the shell's records, for every channel — the renderer's arguments carry no
  // remoteness, and must not: a renderer flag would be one more thing a forged call could lie about.
  const isRemote = (nodeId: string | undefined): boolean => !!nodeId && !!deps.isRemoteNode?.(nodeId)

  platform().handle(
    IPC.claudeReadTranscript,
    async (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptLine[]> => {
      const remote = await remoteText({ sessionId, cwd, accountId, nodeId })
      if (remote !== null) return parseTranscriptLines(remote)
      // The find bar must not index THIS machine's transcript for a remote node.
      if (isRemote(nodeId)) return []
      const p = await resolveTranscript({ sessionId, cwd, accountId }, deps.pathFor)
      return p ? readTranscriptLines(p) : []
    }
  )

  platform().handle(
    IPC.transcriptExists,
    async (
      sessionId: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined
    ): Promise<TranscriptPresence> => {
      if (!sessionId) return 'unknown'
      // Remote first, and its `'unknown'` is TERMINAL. Falling through to the local resolver for
      // a remote session whose host we could not reach would search this machine for a file that
      // only ever existed on the other one, and answer `absent` about it.
      const remote = deps.remoteExists ? await deps.remoteExists({ sessionId, cwd: undefined, accountId, nodeId }) : null
      if (remote !== null) return remote
      // Remote by the shell's records but the remote leg could not ask (no live pty yet): `unknown`,
      // never a local scan whose `absent` would drop a resume.
      if (isRemote(nodeId)) return 'unknown'
      // A live context tail's own path is the authoritative hint — but it is a HINT, so it is
      // verified rather than trusted: the file it names can have been deleted since.
      const hinted = deps.pathFor?.(sessionId)
      if (hinted) {
        try {
          await fsp.access(hinted)
          return 'present'
        } catch {
          /* fall through to the scan */
        }
      }
      return transcriptPresence(sessionId, accountId)
    }
  )

  platform().handle(
    IPC.chatReadTranscript,
    (
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined,
      nodeId: string | undefined,
      agentId: string | undefined,
      rawPage?: unknown
    ): Promise<ChatTranscriptResult> =>
      readChatTranscript(
        { sessionId, cwd, accountId, nodeId, agentId, ...(isRemote(nodeId) ? { remoteOnly: true } : {}) },
        rawPage,
        deps
      )
  )
}
