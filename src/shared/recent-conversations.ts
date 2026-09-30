// "Open recent": the agent conversations this machine's CLIs have on disk, listed so one can be
// resumed from its own history instead of only from a node that happens to remember its id.
//
// Shared because three sides speak it: core reads it (`core/recent-conversations.ts`), both
// shells serve it over `recent-conversations:list`, and the renderer groups and resumes it. No
// imports beyond the agent id list — usable everywhere.
import type { AgentId } from './agents/config'

/**
 * The agents whose history core can read, and ONLY those. Each is in `RESUMABLE_AGENTS` (the
 * resume line comes from `resumeCommandWith`) AND has an on-disk shape measured here:
 *  - claude  — `<config dir>/projects/<cwd>/<id>.jsonl`, per record `cwd`; system, managed and
 *              linked accounts.
 *  - codex   — `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, first line `session_meta`
 *              (`id`, `cwd`, `thread_source`); system and managed accounts.
 *  - gemini  — `~/.gemini/tmp/<project>/chats/session-*.jsonl` + the project's `.project_root`.
 *  - grok    — `$GROK_HOME/sessions/<url-encoded cwd>/<id>/`.
 *  - copilot — `<copilot home>/session-state/<id>/events.jsonl`, `session.start` `context.cwd`.
 *
 * Deliberately absent: opencode (its history is a SQLite database we never open; the only reader
 * is `opencode export`, one CLI spawn of ~1.5 s and ~320 MB per session — far too heavy for a
 * list) and antigravity (its transcript record shapes were never captured). An agent absent here
 * simply contributes no rows; nothing guesses at its layout.
 */
export const RECENT_CONVERSATION_AGENTS = ['claude', 'codex', 'gemini', 'grok', 'copilot'] as const
export type RecentConversationAgent = (typeof RECENT_CONVERSATION_AGENTS)[number]

export function isRecentConversationAgent(id: AgentId | string): id is RecentConversationAgent {
  return (RECENT_CONVERSATION_AGENTS as readonly string[]).includes(id)
}

/** Longest title we hand to a surface, in code points. A title is display text, never a name. */
export const RECENT_TITLE_MAX = 120

/** Newest conversations returned in total (every agent and account together). */
export const RECENT_CONVERSATIONS_MAX = 60

export interface RecentConversation {
  agentId: RecentConversationAgent
  /** The CLI's own session id — re-validated (`SAFE_SESSION_ID`) before it reaches a command. */
  sessionId: string
  /** The absolute directory the conversation ran in, or null when the history does not say. */
  cwd: string | null
  /** Last activity: the transcript's modification time, epoch ms. */
  lastActiveAt: number
  /** One line of display text: the agent's own session name when it has one, else the first thing
   *  the user typed. Untrusted input made safe: no control, bidi or zero-width characters, capped. */
  title: string
  /** Where `title` came from — `none` means neither existed and the title is empty. */
  titleSource: 'name' | 'prompt' | 'none'
  /** The managed or linked account whose config dir holds this history; absent = the system
   *  account. A resume MUST run under this account or the CLI will not find the conversation. */
  accountId?: string
  /** Does `cwd` still exist as a directory on this machine? Only a definite ENOENT/ENOTDIR is
   *  `absent` — a stat that failed otherwise is `unknown`, never evidence of absence. Absent when
   *  `cwd` is null or the reader did not look. */
  cwdState?: 'present' | 'absent' | 'unknown'
}

export interface RecentConversationsRequest {
  /** Managed Codex account ids to include (the renderer owns that list; core re-validates each). */
  codexAccountIds?: string[]
  /** Cap on the result; clamped to [1, RECENT_CONVERSATIONS_MAX]. */
  limit?: number
}

export type RecentConversationsResult =
  | { ok: true; items: RecentConversation[] }
  /** Could not look at all (a relay tab, a failed call) — never shown as "no conversations". */
  | { ok: false; reason: 'unsupported' | 'failed' }

export interface RecentConversationsApi {
  /** Never rejects on the real legs: a failure is `{ok:false}`, never an empty list. */
  list(req?: RecentConversationsRequest): Promise<RecentConversationsResult>
}
