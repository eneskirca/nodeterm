package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.Pane
import dev.nodeterm.protocol.model.ProjectsSnapshot

/**
 * The agent line the terminal screen OFFERS right after an attach. It is typed only when the user
 * taps it, never unasked into a pane the phone cannot see. There are two cases, and they build
 * different lines on purpose:
 *
 *  - [Kind.RESUME] (audit A15): the attach had to CREATE the tmux session, because the computer
 *    rebooted. The conversation is on disk and the pane is a new shell (in `$HOME` when the relay
 *    created it), so the line is built like the desktop's cold restore: `cd` into the node's folder,
 *    the node's managed Claude account, and its agent's approval policy ([Launch.resumeLine]).
 *  - [Kind.WAKE] (audit A76): the session is Sleeping. Eco (or a shallow "Pause session") exited the
 *    CLI and left the pane's shell behind. That shell already sits in the node's folder, and its tmux
 *    env already carries the account's CLAUDE_CONFIG_DIR / CODEX_HOME, so the line is the desktop's
 *    own wake line: the resume plus its measured approval policy ([Launch.wakeLine]). It is typed after a kill-line
 *    so a half-typed line left at that prompt is not spliced into it. A `cd` or an account prefix
 *    could only be wrong there: the pane's shell and env are the authority, not project.json.
 *
 * A wake is offered only while a SHELL owns the pane ([Pane.isShell] of the pane's foreground
 * command, read over SSH right before), the gate the desktop's own wake keeps. The mirror's
 * `hibernated` flag alone is not enough, because it can outlive the sleep. A desktop older than the
 * A76 review dropped its own copy on a resumed CLI's first live hook event without telling the
 * mirror (and codex reports its start only that way), so a CLI started outside the desktop's own
 * wake, this phone's included, stayed Sleeping there. With the desktop app not running, nothing
 * hears the resumed CLI at all. A running CLI would take the wake line as a prompt.
 *
 * A wake is offered over DIRECT SSH only. A relay attach tells the desktop that a phone opened the
 * node (host-service `remoteViewer.attached` → `agent:wake`), and the desktop wakes it itself, after
 * checking that the pane is still the one its CLI exited from. Offering the line on the phone as well
 * would type `--resume` into the CLI the desktop just started, where it arrives as a prompt. The
 * desktop resolves saved offscreen nodes too, and refuses a missing or changed pane proof. Over SSH nothing tells
 * the desktop about the attach, which is why the phone offers it there.
 *
 * `paused`: the desktop never wakes a paused node on its own, but its own UI offers the explicit
 * Resume (the PAUSED chip, the node menu). The mirror carries `hibernated` and not `paused`, so a
 * shallow-paused node reads as Sleeping here too; an offer the user taps is that explicit Resume,
 * never an automatic one. A deep pause ("pause & end session") recycles the tmux session and leaves
 * `hibernated` unset, so it gets no wake offer.
 *
 * A reattach of the same screen (the stream dropped, the app went to the background) is warm: the
 * cold attach before it created the session. An unanswered [Kind.RESUME] is therefore handed back in
 * as `carried` and kept, not re-derived from `fresh` (which would drop it: the A41 review). It is kept
 * only while the computer still describes the conversation it was made for, with nothing reported
 * from the node since ([statusAt]): the phone did not see the pane while it was away, and a CLI
 * started there meanwhile would take the resume line as a prompt. A wake needs no carrying; every
 * attach re-derives it.
 *
 * [statusAt] is the node's mirror entry `updatedAt` the offer was built against (null: the computer
 * had no entry). The mirror moves it only when a hook event from the node arrives.
 */
data class ResumeOffer(val kind: Kind, val agent: Agent, val command: String, val statusAt: Long?) {
    enum class Kind { RESUME, WAKE }

    /** What accepting the offer writes into the pane. */
    val keys: String
        get() = when (kind) {
            Kind.RESUME -> command + "\r"
            // The desktop's wake clears the line first (TerminalNode's wake closure, KILL_LINE in
            // src/shared/shell-kill-line.ts). The host is POSIX: a Windows desktop pairs relay-only.
            Kind.WAKE -> KILL_LINE + command + "\r"
        }

    val message: String
        get() = when (kind) {
            Kind.RESUME -> "This session had ended on the computer (it restarted). Resume the ${agent.label} conversation?"
            Kind.WAKE -> "This session is sleeping: ${agent.label} was closed on the computer to save memory. Wake the conversation?"
        }

    val button: String
        get() = when (kind) {
            Kind.RESUME -> "Resume"
            Kind.WAKE -> "Wake ${agent.label}"
        }

    /**
     * Re-asked when the user taps the offer, against the snapshot at that moment and the pane's
     * foreground command read just then ([paneCommand]; the same rule as the Inbox quick actions:
     * act only on what is still true). A wake is withdrawn once the node is no longer Sleeping, or
     * once anything but a shell owns the pane: a CLI started there meanwhile (the desktop woke it, or
     * someone typed the resume) would take the line as a prompt. An unread pane (null) withdraws it.
     */
    fun stillOffered(current: ProjectsSnapshot, nodeId: String, paneCommand: String? = null): Boolean = when (kind) {
        Kind.RESUME -> true
        Kind.WAKE -> current.statusOf(nodeId)?.hibernated == true && Pane.isShell(paneCommand)
    }

    companion object {
        /** `KILL_LINE` (src/shared/shell-kill-line.ts): Ctrl-U, the POSIX shells' line discard. */
        const val KILL_LINE = "\u0015"

        /** Shown when a tapped wake is withdrawn ([stillOffered]): nothing was typed. */
        const val WITHDRAWN = "This session is no longer sleeping on the computer, so nothing was typed."

        /**
         * Whether [afterAttach] could offer a wake for this attach, i.e. whether the caller must read
         * the pane's foreground command ([HostConnection.paneCommand]) to pass it in. Only then: the
         * read is one more command over SSH.
         */
        fun wantsPane(fresh: Boolean, transport: TransportKind, snapshot: ProjectsSnapshot, nodeId: String): Boolean =
            !fresh && transport == TransportKind.SSH && snapshot.statusOf(nodeId)?.hibernated == true

        /**
         * The offer after an attach of [nodeId] over [transport], or null. [fresh] is the attach's
         * own answer ([TerminalStream.fresh]); [snapshot] is the phone's latest view of the computer.
         * [carried] is the offer the screen still shows from its previous attach, unanswered: a
         * [Kind.RESUME] survives a warm reattach while the computer builds exactly that offer again
         * for a cold pane (same line, and no hook event from the node since, [statusAt]); otherwise
         * it is dropped. A fresh reattach is a new cold pane and gets the line built now.
         * [paneCommand] is the pane's foreground command, read after this attach when [wantsPane]
         * said so; a wake needs it to name a shell, and omitting it (null: unread) offers no wake.
         */
        fun afterAttach(
            fresh: Boolean,
            transport: TransportKind,
            snapshot: ProjectsSnapshot,
            nodeId: String,
            carried: ResumeOffer? = null,
            paneCommand: String? = null
        ): ResumeOffer? {
            // The pane is still the cold one the earlier attach created, so the cold line, and it
            // wins over a Sleeping flag as it did then.
            if (!fresh && carried?.kind == Kind.RESUME) return build(cold = true, transport, snapshot, nodeId, null).takeIf { it == carried }
            return build(fresh, transport, snapshot, nodeId, paneCommand)
        }

        private fun build(cold: Boolean, transport: TransportKind, snapshot: ProjectsSnapshot, nodeId: String, paneCommand: String?): ResumeOffer? {
            val found = snapshot.findNode(nodeId)
            val project = found?.first
            val node = found?.second
            val status = snapshot.statusOf(nodeId)
            val agent = Agent.of(node?.agentId ?: status?.agentId) ?: return null
            val sid = status?.sessionId ?: node?.agentSessionId ?: return null
            val settings = snapshot.status?.settings
            val at = status?.updatedAt
            return when {
                // A cold pane wins over a stale Sleeping flag: the shell the CLI exited to is gone
                // with the old tmux session, so the new one needs the full cold-restore line.
                cold -> Launch.resumeLine(agent, sid, settings, node?.accountId, project?.absoluteCwdOf(node), project?.defaultPermissionMode)
                    ?.let { ResumeOffer(Kind.RESUME, agent, it, at) }
                // Sleeping by the mirror AND a shell in the pane: the flag can outlive the sleep.
                status?.hibernated == true && transport == TransportKind.SSH && Pane.isShell(paneCommand) ->
                    Launch.wakeLine(agent, sid, settings, project?.defaultPermissionMode)?.let { ResumeOffer(Kind.WAKE, agent, it, at) }
                else -> null
            }
        }
    }
}
