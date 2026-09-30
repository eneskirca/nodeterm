// Claude Code's native subagent hooks (`SubagentStart` / `SubagentStop`) — the pure, measured facts
// the normalizer, the lifecycle (core/claude-subagent-lifecycle.ts) and both shells' transcript
// tails share. MEASURED on Claude Code 2.1.284 (fixture: __fixtures__/claude/subagent-hook-payloads.json);
// the full write-up is CLAUDE.md → Agent support → Subagent visualization.

/**
 * A native subagent id as the CLI prints it (measured: `a` + 16 hex, e.g. `a4809888b14b29608`).
 * Deliberately a TOKEN rule, not that exact shape: the id becomes a card key and a FILE NAME
 * (`agent-<id>.jsonl`), so what matters is that it cannot carry a separator or a traversal — and a
 * shape pinned to today's 17 characters would silently drop every card the day the format grows.
 */
export const CLAUDE_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isClaudeAgentId(v: unknown): v is string {
  return typeof v === 'string' && CLAUDE_AGENT_ID_RE.test(v)
}

/**
 * Where a subagent's own transcript lives, derived from the PARENT's transcript path (every
 * `SubagentStart` carries it as `transcript_path`) and the child's `agent_id`:
 *
 *   <parent transcript without .jsonl>/subagents/agent-<agent_id>.jsonl
 *
 * `SubagentStart` does not name the file; only `SubagentStop` does (`agent_transcript_path`), which
 * is too late for a live tail. The derivation is pinned against every stop in the capture, nested
 * children included (they live in the TOP session's `subagents/` directory, not in their parent
 * agent's). `undefined` for an unsafe id or a parent path that is not a transcript — the caller
 * then simply has no tail, never a guessed file.
 *
 * Separator-agnostic on purpose: the path is the one the CLI reported (POSIX on the hosts we tail
 * remotely, possibly `\` on a Windows desktop), and only its `.jsonl` suffix is replaced.
 */
export function claudeSubagentTranscriptPath(parentTranscript: string, agentId: string): string | undefined {
  if (!isClaudeAgentId(agentId) || !parentTranscript.endsWith('.jsonl')) return undefined
  const sep = parentTranscript.includes('/') ? '/' : '\\'
  return `${parentTranscript.slice(0, -'.jsonl'.length)}${sep}subagents${sep}agent-${agentId}.jsonl`
}

/** A background-task status that says the task is OVER. A CLOSED set: any other value — including
 *  one a future release invents — reads as still running, the direction in which both consumers
 *  fail safe (Eco does not exit the CLI; the lifecycle does not end a card). */
const FINISHED_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled'])

/** Bound on what one Stop may report — the list rides every turn end to the renderer. */
const BACKGROUND_TASKS_MAX = 64

/**
 * The ids of the background tasks a `Stop` hook reports as still alive, or `undefined` when the
 * payload carries no inventory at all (an older CLI: absent through 2.1.112, present from some
 * native-binary release up to 2.1.284 — the exact first version was not bisected, so this is
 * FEATURE-detected per payload, never version-gated).
 *
 * MEASURED: `background_tasks` lists every running BACKGROUND task of the session — async
 * subagents (nested ones included), background shells — as `{id, type, status, description, …}`;
 * a foreground subagent is never in it (a parent `Stop` cannot happen while one runs).
 */
export function liveBackgroundTaskIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const { id, status } = t as { id?: unknown; status?: unknown }
    if (typeof id !== 'string' || !id || id.length > 128) continue
    if (typeof status === 'string' && FINISHED_TASK_STATUSES.has(status)) continue
    out.push(id)
    if (out.length >= BACKGROUND_TASKS_MAX) break
  }
  return out
}

/**
 * The subset of `liveBackgroundTaskIds` that are background SUBAGENTS (`type: 'subagent'`, the
 * value every measured async child carries in the fixtures), or `undefined` with no inventory.
 *
 * Why a subset: plain `--after` holds a station whose turn ended with background work still
 * running (core/station-handover.ts), and only a subagent is safe to hold on. An async subagent
 * ENDS, and its `<task-notification>` wakes the parent into another turn, so a later `Stop` with
 * it gone reliably comes. A background SHELL may never end (a dev server, a file watcher,
 * `tail -f`) and does not reliably wake the station, so holding on one could hold a dependent
 * forever. Any other or unknown `type` is treated like a shell: not held on.
 */
export function liveBackgroundSubagentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const live = new Set(liveBackgroundTaskIds(value))
  const out: string[] = []
  for (const t of value) {
    if (!t || typeof t !== 'object') continue
    const { id, type } = t as { id?: unknown; type?: unknown }
    if (type === 'subagent' && typeof id === 'string' && live.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The prompt Claude injects into the PARENT when a background subagent hands its result back
 * (measured, 2.1.284, via the child's `SubagentHandback` tool): `<agent-message from="<agent id>">
 * [Subagent hand-back] …`. Like `<task-notification>` it is not a genuine user turn. Matched on the
 * whole marker, not on `<agent-message` alone: that envelope may also carry messages that ARE work
 * requests, and those must keep resetting the turn.
 */
const HANDBACK_RE = /^<agent-message from="[^"]*">\s*\[Subagent hand-back\]/

export function isInjectedSubagentPrompt(prompt: string): boolean {
  const p = prompt.trimStart()
  return p.startsWith('<task-notification>') || HANDBACK_RE.test(p)
}
