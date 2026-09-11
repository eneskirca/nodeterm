// ONE routing rule for "what is this session's own display name?" — the name a node title adopts,
// per agent. This is the READ leg (`TITLE_READ_CAPABLE`); the WRITE leg (`/rename <name>`, gated by
// `RENAME_CAPABLE`) is a separate, smaller list, because gemini names its own sessions but has no
// command to rename one.
//
// It exists as its own module because the rule has THREE consumers already (the desktop's
// `IPC.ptyReadSessionName` handler for the mounted node's poll, and the session-name sweep that
// refreshes the agent-status mirror in BOTH shells), and a routing rule kept in three places is the
// exact drift this branch has been bitten by twice. No reader may ever search another's tree:
//   claude → a transcript `.jsonl` under `~/.claude/projects` (or a managed account's root)
//   grok   → `summary.json` in the session directory a hook told us about (core/grok-session.ts)
//   gemini → its own transcript `.jsonl`, at the path the context tail already tracks, read for the
//            `update_topic` tool call that carries the name (core/gemini-session.ts)
//   codex  → `Thread.name`, read over the shared app-server's own socket (core/codex-session-name.ts).
//            There is no file to read: with the shared server the name lives in the server, and the
//            node's session id IS the thread id.
// Anything else has no readable session name; the claude reader answers null for it, which is what
// every pre-grok caller already got.
import { readSessionName, readSmallTail, TITLE_TAIL_BYTES } from './transcript-reader'
import { readGrokSessionName, type GrokRemoteSummaryReader } from './grok-session'
import { pickGeminiTitle } from './gemini-session'
import { readCodexSessionName } from './codex-session-name'

/**
 * Per-agent associations this router cannot own itself, injected by the shell.
 *
 * grok's leg needs none (its sessionId → directory map lives in core, fed by the shells' raw hook
 * listeners); gemini's path authority is the CONTEXT TAIL, which each shell creates, so it arrives
 * here as a function rather than as a core singleton.
 */
export interface AgentSessionNameDeps {
  /**
   * Reads a REMOTE grok session's `summary.json` on its host — the grok analogue of claude's
   * `setRemoteTranscriptReader`, and the fix for §8.4: without it the shells derive the session
   * directory from the LOCAL sessions root while the payload's `cwd` came from the host, i.e. a path
   * on the wrong machine.
   *
   * Its answer is FINAL for a session it owns: `{ text: '' }` means "remote, unreadable" and yields
   * no name, never a local lookup. Only `null` — "not a remote session" — routes to the local map.
   */
  grokRemoteSummary?: GrokRemoteSummaryReader
  /**
   * sessionId → that gemini session's transcript path, i.e. `geminiContextTail.pathFor`. Fed only
   * by hook POSTs, so `undefined` for a session no hook has been seen for — and for a REMOTE (SSH)
   * gemini node, whose transcript is on the host and which the tails deliberately never track
   * (metering the local disk would report the wrong machine). Both mean "no name", which is
   * honest: the node keeps its own title.
   */
  geminiPathFor?: (sessionId: string) => string | undefined
}

/** The gemini leg. Its transcript carries a model-generated name that it rewrites as the
 *  conversation develops. Read-only — gemini has no rename command, so this never round-trips.
 *  Bounded tail read, the same cap claude's title read uses. */
async function readGeminiSessionName(
  sessionId: string,
  pathFor?: (id: string) => string | undefined
): Promise<string | null> {
  const p = pathFor?.(sessionId)
  if (!p) return null
  const tail = await readSmallTail(p, TITLE_TAIL_BYTES)
  return tail ? pickGeminiTitle(tail) : null
}

/**
 * The session's display name, or null when it cannot be resolved.
 *
 * `agentId` is TRAILING and optional so every pre-grok caller is unchanged — omitted means claude's
 * transcript reader, the only reader that existed. `accountId` is claude's (managed accounts are
 * Claude-only), and the other legs ignore it. `deps` is likewise trailing: a caller with no gemini
 * association simply gets null for gemini nodes.
 *
 * Routing MATTERS beyond correctness: claude's resolver scans `~/.claude/projects` when its cache
 * misses, and a grok or gemini session id can never be found there — so an unrouted node would pay
 * that scan on every poll, forever, for a guaranteed null.
 */
export function readAgentSessionName(
  sessionId: string,
  accountId?: string,
  agentId?: string,
  deps?: AgentSessionNameDeps
): Promise<string | null> {
  if (!sessionId) return Promise.resolve(null)
  if (agentId === 'grok') return readGrokSessionName(sessionId, deps?.grokRemoteSummary)
  if (agentId === 'gemini') return readGeminiSessionName(sessionId, deps?.geminiPathFor)
  // Never falls through to claude's reader: that one SCANS ~/.claude/projects on a cache miss, so
  // an unrouted codex node would pay that scan once a minute for a guaranteed null.
  if (agentId === 'codex') return readCodexSessionName(sessionId)
  return readSessionName(sessionId, accountId)
}
