// ONE routing rule for "what is this session's own display name?" — the `/rename` name a node title
// adopts, per agent.
//
// It exists as its own module because the rule has THREE consumers already (the desktop's
// `IPC.ptyReadSessionName` handler for the mounted node's poll, and the session-name sweep that
// refreshes the agent-status mirror in BOTH shells), and a routing rule kept in three places is the
// exact drift this branch has been bitten by twice. Neither reader may ever search the other's tree:
//   claude → a transcript `.jsonl` under `~/.claude/projects` (or a managed account's root)
//   grok   → `summary.json` in the session directory a hook told us about (core/grok-session.ts)
// Anything else has no readable session name; the claude reader answers null for it, which is what
// every pre-grok caller already got.
import { readSessionName } from './transcript-reader'
import { readGrokSessionName } from './grok-session'

/**
 * The session's display name, or null when it cannot be resolved.
 *
 * `agentId` is TRAILING and optional so every pre-grok caller is unchanged — omitted means claude's
 * transcript reader, the only reader that existed. `accountId` is claude's (managed accounts are
 * Claude-only), and grok ignores it.
 *
 * Routing MATTERS beyond correctness: claude's resolver scans `~/.claude/projects` when its cache
 * misses, and a grok session id can never be found there — so an unrouted grok node would pay that
 * scan on every poll, forever, for a guaranteed null.
 */
export function readAgentSessionName(
  sessionId: string,
  accountId?: string,
  agentId?: string
): Promise<string | null> {
  if (!sessionId) return Promise.resolve(null)
  return agentId === 'grok'
    ? readGrokSessionName(sessionId)
    : readSessionName(sessionId, accountId)
}
