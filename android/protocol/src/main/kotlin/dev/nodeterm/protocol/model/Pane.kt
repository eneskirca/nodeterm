package dev.nodeterm.protocol.model

/**
 * What a tmux pane's foreground command (`#{pane_current_command}`) says about a session: the
 * desktop's `isShellCommand` (src/shared/agents/pane.ts), the gate its own wake keeps before it types
 * a resume line. True means a SHELL owns the pane, so the agent CLI has let go of it.
 *
 * The same seven names, and deliberately not "anything but a known agent": an npm-installed CLI
 * reports `node`, a native one its own name, and a shell the list does not know (nu, pwsh, xonsh)
 * reads as "not a shell". For the question asked here (may a launch line be typed into this pane?),
 * an unknown answers no. A login shell reports as `-zsh`, and tmux may report a full path.
 */
object Pane {
    /** `SHELLS` in src/shared/agents/pane.ts (pinned against that file by a test). */
    val SHELLS: Set<String> = setOf("zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh")

    fun isShell(command: String?): Boolean {
        if (command.isNullOrEmpty()) return false
        return command.removePrefix("-").substringAfterLast('/') in SHELLS
    }
}
