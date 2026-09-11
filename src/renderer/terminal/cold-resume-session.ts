/**
 * Cold restore's last question before it types `claude --resume <id>`: is that conversation still
 * there?
 *
 * ## What goes wrong without this
 *
 * A cold start (reboot, first open, a reaped tmux server) relaunches an agent node's CLI and
 * resumes the session id nodeterm persisted for it — the live one from hooks, else the id minted at
 * node creation. Neither is evidence the transcript still EXISTS. Claude's own 30-day cleanup
 * removes old ones, a `/clear` mints a new id, a managed account can be removed, a minted id
 * belongs to a session that never ran. When the id is dead the CLI prints
 *
 *     No conversation found with session ID: <uuid>
 *
 * and exits, leaving the pane at a bare shell. Nothing noticed: the node kept its agent badge,
 * the terminal looked idle, and the only evidence was one line of scrollback.
 *
 * MEASURED on the reporting host (2026-09-09, `nodeterm-rmt` socket, 108 live sessions): **20**
 * panes sat at a bare shell showing exactly that line, and not one of the 20 session ids had a
 * `<id>.jsonl` anywhere under the system `~/.claude/projects` or the managed account root. The
 * ids outlived their transcripts; the resume was never going to work.
 *
 * ## The rule
 *
 * `absent` — and ONLY `absent` — drops the id, so the node launches the agent bare instead of
 * resuming something that is gone. A bare launch loses nothing that was still there: the
 * conversation it would have resumed does not exist.
 *
 * `unknown` resumes exactly as before. That is not caution for its own sake — the cost of the two
 * errors is wildly asymmetric. Wrongly resuming a dead id reproduces today's bug (one bad line,
 * a bare shell, recoverable). Wrongly dropping a LIVE id silently starts a blank conversation and
 * strands work the user believed was continuing, with the original still on disk and nothing on
 * screen pointing at it. So an unreadable transcript root, a downed ControlMaster, a relay tab,
 * a surface with no reader and a rejected call all mean "resume".
 *
 * ## Why the agent gate is `readsClaudeTranscript`
 *
 * The probe resolves a claude-shaped `<id>.jsonl` under a claude config dir. A codex, gemini or
 * grok id misses that resolver by construction — every time — so asking it about one would answer
 * `absent` for a perfectly good session and drop its resume. Those agents keep today's behaviour
 * unchanged until someone teaches the probe their layouts (`handoff/locate.ts` already has
 * `locateCodex` / `locateGemini` / `locateGrok` by sessionId — that is the seam).
 */
import type { TranscriptPresence } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import { readsClaudeTranscript } from '@renderer/lib/transcriptGates'

/** Is there anything worth asking about? Cheap gate, so the common paths pay no round trip. */
export function shouldProbeTranscript(
  priorId: string | undefined,
  agentId: AgentId | undefined
): boolean {
  return !!priorId && readsClaudeTranscript(agentId)
}

export interface ColdResumeDecision {
  /** The id to resume with — `undefined` means launch the agent bare. */
  sessionId: string | undefined
  /** Did we DROP an id because its transcript is gone? Drives the node's notice. */
  lostSession: boolean
}

/**
 * Turn the probe's answer into the id cold restore resumes with.
 *
 * Pure and total: every input that is not a positive `absent` on a real id resumes with that id,
 * which is byte-for-byte the pre-existing behaviour.
 */
export function coldResumeDecision(
  priorId: string | undefined,
  presence: TranscriptPresence
): ColdResumeDecision {
  if (priorId && presence === 'absent') return { sessionId: undefined, lostSession: true }
  return { sessionId: priorId || undefined, lostSession: false }
}
