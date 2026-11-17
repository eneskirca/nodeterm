// Which file a Claude SUBAGENT chat read may open (`chat:read-transcript`'s trailing `subagent`).
//
// A native subagent writes its own transcript beside the parent session's, at
// `<parent without .jsonl>/subagents/agent-<agent_id>.jsonl` (`claudeSubagentTranscriptPath`, pinned
// against the measured hook capture). The agent id arrives over IPC / the WS bridge and becomes part
// of a FILE NAME, so it is validated before anything touches the disk, and the derived file is held
// to the parent session's own directory: a regular file (never a symlink, which could point at any
// file the user can read) whose REAL directory is the parent's real directory plus
// `<session>/subagents`. Resolving the parent's directory first is what lets a `~/.claude` that is
// itself a symlink (a dotfile manager) keep working while a symlinked `<session>` or `subagents`
// directory is refused.
//
// The remote (SSH) leg derives the same path from the HOST's located parent and jails it with the
// host jail (`src/main/remote-transcript-page.ts`); this module is the local half.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { claudeSubagentTranscriptPath, isClaudeAgentId } from '../shared/agents/claude-subagents'
import type { ChatTranscriptSubagent } from '../shared/types'

/**
 * The untrusted `subagent` argument, validated. `undefined` / `null` (a JSON hop turns a trailing
 * `undefined` into `null`) = no subagent read. Anything else present must be an object whose
 * `agentId` is a plain token (`isClaudeAgentId`: no separator, no leading dot) — otherwise this
 * THROWS, like an invalid page `before`: answering a malformed request with some other file, or with
 * the parent's conversation, would be worse than refusing it. Other keys are ignored.
 */
export function normalizeSubagentArg(raw: unknown): ChatTranscriptSubagent | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') throw new Error('Invalid subagent')
  const { agentId } = raw as { agentId?: unknown }
  if (!isClaudeAgentId(agentId)) throw new Error('Invalid subagent')
  return { agentId }
}

/**
 * The LOCAL subagent transcript for `agentId` beside `parentPath`, or `undefined` when there is none
 * this read may open: an unsafe id, a parent that is not a transcript, a missing file, a file that is
 * not a regular file (a symlink included), or a `<session>` / `subagents` directory that resolves
 * anywhere but the parent's own. Returns the path with its directory resolved, so the read opens the
 * file that was checked rather than walking the links again.
 */
export async function subagentTranscriptFor(parentPath: string, agentId: string): Promise<string | undefined> {
  const child = claudeSubagentTranscriptPath(parentPath, agentId)
  if (!child) return undefined
  try {
    const realParentDir = await fsp.realpath(path.dirname(parentPath))
    const expectedDir = path.join(realParentDir, path.basename(parentPath, '.jsonl'), 'subagents')
    const realChildDir = await fsp.realpath(path.dirname(child))
    if (realChildDir !== expectedDir) return undefined
    const resolved = path.join(realChildDir, path.basename(child))
    // lstat, not stat: a symlink reads as "not a regular file" whatever it points at.
    return (await fsp.lstat(resolved)).isFile() ? resolved : undefined
  } catch {
    return undefined
  }
}
