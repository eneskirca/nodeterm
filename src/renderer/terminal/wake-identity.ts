/**
 * WHICH PANE MAY BE TYPED INTO — the identity behind Eco's exit and its much later wake.
 *
 * Hibernation is two writes separated by hours: `/exit` now, `claude --resume <id>` when the user
 * comes back. Both land in a tmux pane the user can also type into, and the second one carries a
 * session id that only resolves in the context the first one quit. So the pair needs an identity,
 * and the question it has to answer is NOT "is something shell-shaped in this pane?" but "is this
 * the shell we exited the CLI in?".
 *
 * ── WHY THE OLD GATE COULD NOT ANSWER IT (issue #823, measured on tmux 3.4) ─────────────────────
 *
 * The wake's gate was `isShellCommand(pane) || pane === hibernatedPane` — a NAME test. For a node
 * whose agent is reached over an interactive `ssh` inside its pane, the names read like this
 * (measured, a real pane, real ssh, real `ps`):
 *
 *   local shell idle           pane_current_command = bash   fg argv = `bash …`
 *   ssh up, agent on far side  pane_current_command = ssh    fg argv = `ssh -i … localhost`
 *   ssh dead, login shell back pane_current_command = bash   fg argv = `bash …`
 *
 * `pane_pid` and `pane_id` are IDENTICAL in all three readings — the pane's root process is the
 * local login shell throughout, and the remote shell was never a local process at all. So after the
 * fact NOTHING about the pane distinguishes "the CLI was here" from "the CLI was at the far end of
 * an ssh that has since died": both present a plain local shell. The old gate passed, and the
 * resume was typed into the Mac's login shell at `~`, where the remote session id cannot resolve.
 *
 * ── WHERE THE IDENTITY ACTUALLY LIVES ───────────────────────────────────────────────────────────
 *
 * The difference is only visible while the CLI is still running, so the proof has to be taken THEN.
 * `decideHibernateExit` refuses to quit a pane unless the kernel says the agent binary owns its
 * foreground process group (`isAgentPane` — the same positive, three-valued predicate the delivery
 * gate uses). An `ssh` pane answers `not-agent`, and so does a pane that is already sitting on a
 * shell because the CLI is long gone. Neither is exited, so neither ever becomes SLEEPING, and
 * there is nothing for a later wake to get wrong.
 *
 * `decideWakeResume` is then the cheap re-check across the gap: the same pane, still not an agent's,
 * still recognisable. It cannot re-derive the proof — that moment has passed — so a record without
 * one is refused rather than guessed at. That is deliberately the migration path too: a node
 * hibernated by the build that shipped this bug carries no proof, and refusing it is the only
 * honest answer (the node stays SLEEPING and its chip stays clickable).
 */
import { isShellCommand } from '@shared/agents/pane'
import { isAgentPane, type PaneOwner } from '@shared/agents/pane-owner-predicate'

/**
 * What a pane looked like at the instant our `/exit` was answered — the proof a wake re-checks.
 *
 * `panePid` and `paneId` cannot tell two SHELLS apart (see the header measurement), and they are
 * not here for that. They pin the PANE: a session recycled under the node, or a node respawned onto
 * a new one, changes both, and a resume aimed at a record from the pane before it would be landing
 * somewhere it was never authorised for. `command` carries the allowlist-free recognition the exit
 * half already relies on, so a `nu` / `xonsh` / `pwsh` user is not hibernated and then never woken.
 */
export interface WakeContext {
  /** `#{pane_current_command}` once the CLI had let go. */
  command: string
  /** `#{pane_pid}` — the process tmux forked for the pane. Constant for the pane's life. */
  panePid: number
  /** `#{pane_id}` (`%17`) — never reused for the life of the tmux server. Absent on an older read. */
  paneId?: string
}

/**
 * `'agent-owns-pane'` is the ONLY outcome that may be followed by a write.
 *
 * `'not-in-this-pane'` is terminal for this node until something changes: the kernel answered and
 * the agent is not in the pane's foreground group. `'unreadable'` is transient (no tmux, a pane
 * that stopped existing, `ps` unavailable, the deadline lapsed) and the next sweep re-asks — it is
 * never upgraded, because the exit it gates is irreversible.
 */
export type ExitContextVerdict = 'agent-owns-pane' | 'not-in-this-pane' | 'unreadable'

/**
 * May we ask the CLI in this pane to quit?
 *
 * Fails CLOSED on `unknown`, unlike most of this app's probes: everywhere else a probe that cannot
 * answer degrades to the bare, pre-feature behaviour, but here the pre-feature behaviour is to type
 * `/exit` into whatever is there. The conversation is only recoverable through the `--resume` this
 * pair promises, so "we could not see the pane" must mean "leave it alone", not "quit it anyway".
 */
export function decideHibernateExit(
  owner: PaneOwner | null | undefined,
  agentId: string,
  binaries?: readonly string[] | null
): ExitContextVerdict {
  switch (isAgentPane(owner, agentId, binaries)) {
    case 'agent':
      return 'agent-owns-pane'
    case 'not-agent':
      return 'not-in-this-pane'
    default:
      return 'unreadable'
  }
}

/** The pane identity to remember, or null when the read gave us nothing to remember. Null is not a
 *  blank record — it is the absence of one, and the wake refuses on it. */
export function captureWakeContext(owner: PaneOwner | null | undefined): WakeContext | null {
  if (!owner || !owner.command || !(owner.panePid > 0)) return null
  return { command: owner.command, panePid: owner.panePid, paneId: owner.paneId }
}

/**
 * `'resume'` is the only outcome that may be followed by a write.
 *
 *  - `'agent-running'`   — a CLI owns this pane again (the user relaunched one by hand, or a
 *                          wrapper loop restarted it). A launch line typed into a live CLI is sent
 *                          to it as a MESSAGE. Standing refusal.
 *  - `'no-proof'`        — we exited this node ourselves but hold no record of the pane we exited
 *                          into. Pre-fix records, and any record a failed post-exit read dropped.
 *  - `'context-changed'` — we hold a record and the pane no longer matches it.
 *  - `'unreadable'`      — the pane could not be read. Transient; the caller may retry.
 */
export type WakeVerdict = 'resume' | 'agent-running' | 'no-proof' | 'context-changed' | 'unreadable'

export interface WakeDecisionInput {
  owner: PaneOwner | null | undefined
  /** The proof recorded by the exit that produced this state, if any. */
  recorded: WakeContext | null | undefined
  /**
   * Did OUR exit put this pane on a shell (`agentStatus.hibernated`)?
   *
   * The two wake families need different questions, and this is what separates them. When we did
   * the exit there is a specific pane we exited INTO, and matching it is the whole point. When we
   * did not — a deep "pause & end session" deliberately RECYCLES the tmux session, and a `dropped`
   * node's CLI died on its own — there is no prior pane to match, and requiring one would strand
   * both behind a refusal they can never satisfy. Those keep exactly the shell recognition they
   * have today, plus the agent-running refusal below, which they did not have.
   */
  exitedByUs: boolean
  agentId: string
  binaries?: readonly string[] | null
}

export function decideWakeResume(i: WakeDecisionInput): WakeVerdict {
  if (!i.owner) return 'unreadable'
  // Asked FIRST, and for both families: whatever else is true, a pane an agent is running in is
  // never a pane to type a launch line into.
  if (isAgentPane(i.owner, i.agentId, i.binaries) === 'agent') return 'agent-running'
  const pane = i.owner.command
  if (!pane) return 'unreadable'
  if (!i.exitedByUs) return isShellCommand(pane) ? 'resume' : 'context-changed'
  const rec = i.recorded
  if (!rec) return 'no-proof'
  if (i.owner.panePid !== rec.panePid) return 'context-changed'
  // Compared only when BOTH sides carry one: a record taken before `paneId` existed, or a read the
  // format expanded to nothing for, must not read as a mismatch — that is missing evidence, and
  // `panePid` above is already holding the pane's identity.
  if (rec.paneId && i.owner.paneId && rec.paneId !== i.owner.paneId) return 'context-changed'
  if (!isShellCommand(pane) && pane !== rec.command) return 'context-changed'
  return 'resume'
}

/** Does this verdict mean "ask again in a moment"? Everything else is a standing refusal, and the
 *  wake's bounded retry must not spend its attempts on one. */
export function wakeVerdictIsTransient(v: WakeVerdict): boolean {
  return v === 'unreadable'
}

/** What to tell the user about a wake that refused. One sentence, no jargon: the chip's tooltip is
 *  the only place any of this is ever visible. */
export function wakeRefusalReason(v: WakeVerdict): string | null {
  switch (v) {
    case 'agent-running':
      return 'Something is already running in this terminal, so the session was not resumed. Open it to see.'
    case 'context-changed':
      return 'This terminal is no longer the shell the session was paused in, so it was not resumed. Open it and resume by hand.'
    case 'no-proof':
      return 'This session was paused by an older version that did not record where, so it cannot be resumed safely. Open the terminal and resume by hand.'
    default:
      return null
  }
}
