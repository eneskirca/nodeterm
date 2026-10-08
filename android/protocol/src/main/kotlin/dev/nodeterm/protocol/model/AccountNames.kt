package dev.nodeterm.protocol.model

/**
 * Display names for Claude accounts, so no screen prints a managed account's raw UUID (audit A39,
 * A75). One resolver for every surface that names an account — the New session picker and the
 * sessions row — so the two cannot disagree about the same id.
 *
 * Where a name comes from, in order:
 *  1. `settings.claudeAccounts[].label` — written by both shells (desktop and Server Edition) and
 *     the desktop's per-host SSH slice (`mirrorClaudeAccount`), so it is the one source that is
 *     there whenever the account is;
 *  2. `usage.accounts[].label` — a host older than (1) still has it, but only for local accounts
 *     (it is dropped from SSH slices) and only after the first usage poll;
 *  3. the email, from either block;
 *  4. a short form of the id ([fallbackName]) — never the whole UUID.
 *
 * The mirror is a file the desktop documents as hand-editable, so a blank value counts as absent.
 */
object AccountNames {
    /** The name the picker gives the system `~/.claude` account (it has no record to name). */
    const val SYSTEM = "System account"

    /** How much of an unnamed account's id is shown. A managed id is a random UUID: eight hex
     *  characters tell two accounts apart and do not fill a line. */
    private const val SHORT_ID = 8

    /** The display name of the managed (or linked) Claude account [accountId] on the host whose
     *  mirror is [status]. */
    fun managed(accountId: String, status: AgentStatusFile?): String = named(accountId, status) ?: fallbackName(accountId)

    /** Steps 1–3 above: a name the mirror gives [accountId], or null when it gives none. */
    private fun named(accountId: String, status: AgentStatusFile?): String? {
        val settings = status?.settings?.claudeAccounts?.firstOrNull { it.id == accountId }
        val usage = status?.usage?.accounts?.firstOrNull { it.accountId == accountId }
        return settings?.label.nonBlank()
            ?: usage?.label.nonBlank()
            ?: settings?.email.nonBlank()
            ?: usage?.email.nonBlank()
    }

    /**
     * What a session row says about the account the session was OBSERVED running as, or null for
     * nothing. The desktop's account chip decides the same three cases (renderer/lib/accountChip.ts):
     *  - an account id → that account's name. An id this mirror cannot name (removed since the
     *    observation, or pinned to another machine) falls back to its dir, as the desktop's
     *    `resolveObserved` does — unless the dir's last segment is only the id again, which is what
     *    a managed account's dir is; then the short id;
     *  - no id and not known → a config dir the desktop has no record of, named by its last path
     *    segment (`.claude-2`), the only name such a dir has;
     *  - no id and known → the system account, the unremarkable case: nothing.
     */
    fun observed(account: ObservedAccount?, status: AgentStatusFile?): String? {
        if (account == null) return null
        val dir = account.configDir?.let(::configDirLabel)?.nonBlank()
        account.accountId?.nonBlank()?.let { id ->
            return named(id, status) ?: dir?.takeIf { it != id } ?: fallbackName(id)
        }
        if (account.known) return null
        return dir
    }

    /** An account nothing names: a short, recognisable form of its id. */
    fun fallbackName(accountId: String): String {
        val id = accountId.trim()
        return "Account " + if (id.length > SHORT_ID) id.take(SHORT_ID) else id
    }

    /**
     * The last segment of a config dir (`configDirLabel`, renderer/lib/accountChip.ts). The dir may
     * come from this desktop, an SSH host or Windows, so the separator follows the SHAPE of the
     * string: a drive letter, a UNC prefix, or backslashes with no forward slash is Windows-shaped,
     * and there both separators split (Windows takes either); anything else is POSIX, where a
     * backslash is ordinary filename text and only `/` splits.
     */
    fun configDirLabel(configDir: String): String {
        val dir = configDir.trim()
        if (dir.isEmpty()) return ""
        val windows = Regex("^[a-zA-Z]:[\\\\/]").containsMatchIn(dir) ||
            dir.startsWith("\\\\") ||
            ('\\' in dir && '/' !in dir)
        val parts = (if (windows) dir.split('\\', '/') else dir.split('/')).filter { it.isNotEmpty() }
        // A bare root (`/`) has no segment to name; say the whole string rather than nothing.
        return parts.lastOrNull() ?: dir
    }

    private fun String?.nonBlank(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
}
