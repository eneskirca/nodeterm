package dev.nodeterm.protocol.model

import java.security.SecureRandom

/**
 * The builtin agents, as `AGENT_CONFIG` (src/shared/agents/config.ts) defines them — label, brand
 * colour, launch command — and the two command lines the phone types: a first launch and a resume.
 * The phone never invents a flag the desktop would not emit; where it cannot know a host fact it
 * emits the bare command (the desktop's own degrade direction).
 */
enum class Agent(val id: String, val label: String, val color: String, val launchCmd: String, val resumable: Boolean) {
    CLAUDE("claude", "Claude Code", "#d97757", "claude", true),
    CODEX("codex", "Codex", "#10a37f", "codex", true),
    ANTIGRAVITY("antigravity", "Antigravity", "#00a3a3", "agy", true),
    GEMINI("gemini", "Gemini", "#4285f4", "gemini", true),
    OPENCODE("opencode", "opencode", "#a78bfa", "opencode", true),
    GROK("grok", "Grok", "#64748b", "grok", true),
    COPILOT("copilot", "GitHub Copilot", "#8957e5", "copilot", true);

    companion object {
        fun of(id: String?): Agent? = entries.firstOrNull { it.id == id }
    }
}

object Launch {
    /** `SAFE_SESSION_ID` (config.ts): only this charset ever reaches a command line. */
    private val SAFE_SESSION_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
    private val PERMISSION_MODES = setOf("manual", "auto", "acceptEdits", "plan", "bypassPermissions")
    private val SAFE_DIR = Regex("^/[^\\u0000-\\u001f'\"`$\\\\]*$")

    /** `resumeCommandWith` (config.ts): each builtin's own resume grammar, or null. */
    fun resumeCommand(agent: Agent, sessionId: String): String? {
        val sid = sessionId.trim()
        if (!agent.resumable || sid.isEmpty() || !SAFE_SESSION_ID.matches(sid)) return null
        return when (agent) {
            Agent.CODEX -> "${agent.launchCmd} resume $sid"
            Agent.OPENCODE -> "${agent.launchCmd} --session $sid"
            Agent.COPILOT -> "${agent.launchCmd} --resume=$sid"
            Agent.ANTIGRAVITY -> "${agent.launchCmd} --conversation=$sid"
            Agent.CLAUDE, Agent.GEMINI, Agent.GROK -> "${agent.launchCmd} --resume $sid"
        }
    }

    /**
     * The permission mode an agent session starts in on this host: the project's own override when
     * it names a valid mode, else the global setting — the desktop's `resolvePermissionMode(project,
     * settings)` (audit A16). Both values come from hand-editable files, so both are re-validated.
     * No mirror settings at all = `manual` (no flag): the phone never invents one.
     */
    fun permissionMode(settings: MirrorSettings?, projectMode: String? = null): String =
        projectMode?.takeIf { it in PERMISSION_MODES }
            ?: settings?.claudePermissionMode?.takeIf { it in PERMISSION_MODES }
            ?: "manual"

    /**
     * The managed Claude account a new session in [project] starts under by default: the project's
     * default, but only when this host still has that account (a stale id falls back to System,
     * exactly as the desktop validates an id before stamping it on a node).
     */
    fun defaultAccount(settings: MirrorSettings?, project: ProjectInfo?): String? {
        val id = project?.defaultAccountId ?: return null
        return id.takeIf { settings?.claudeAccounts?.any { it.id == id } == true }
    }

    /**
     * A first launch using each agent's measured approval dialect. Claude's `auto` flag requires
     * this host's own capability; Codex's version-dependent values require its advertised
     * vocabulary. Unsupported modes keep the CLI's default rather than substituting a looser one.
     */
    fun launchCommand(
        agent: Agent,
        settings: MirrorSettings?,
        accountId: String?,
        cwd: String?,
        projectMode: String? = null
    ): String = compose(agent, agent.launchCmd, settings, accountId, cwd, projectMode)

    /**
     * The resume line for a cold attach, built like the desktop's cold restore (audit A15): in the
     * node's own directory, under the node's managed Claude account, with the same approval policy as
     * [launchCommand]. A
     * bare `claude --resume <id>` typed into a relay-created pane in `$HOME`, under the default
     * config dir, finds no transcript for a managed account (and, by the transcript path's encoded
     * cwd, likely none at all). Null when the agent or id cannot be resumed.
     */
    fun resumeLine(
        agent: Agent,
        sessionId: String,
        settings: MirrorSettings?,
        accountId: String?,
        cwd: String?,
        projectMode: String? = null
    ): String? = resumeCommand(agent, sessionId)?.let { compose(agent, it, settings, accountId, cwd, projectMode) }

    /**
     * The line that wakes a Sleeping (Eco-hibernated) session, after the desktop's own wake
     * (TerminalNode's wake closure: the resume with the approval policy re-resolved, audit A76).
     * It carries no `cd` and no account: the pane's shell is the one the CLI exited back to,
     * so it already sits in the node's directory and its tmux env already names the account's config
     * dir. Null when the agent or id cannot be resumed.
     */
    fun wakeLine(
        agent: Agent,
        sessionId: String,
        settings: MirrorSettings?,
        projectMode: String? = null
    ): String? = resumeCommand(agent, sessionId)?.let { compose(agent, it, settings, null, null, projectMode) }

    private fun compose(
        agent: Agent,
        command: String,
        settings: MirrorSettings?,
        accountId: String?,
        cwd: String?,
        projectMode: String?
    ): String {
        val parts = ArrayList<String>()
        if (!cwd.isNullOrBlank() && SAFE_DIR.matches(cwd)) parts += "cd '${cwd}' &&"
        val account = accountId?.let { id -> settings?.claudeAccounts?.firstOrNull { it.id == id } }
        if (agent == Agent.CLAUDE && account != null && SAFE_DIR.matches(account.dir)) {
            parts += "CLAUDE_CONFIG_DIR='${account.dir}'"
        }
        parts += command
        approvalFlags(agent, permissionMode(settings, projectMode), settings)
            .takeIf { it.isNotEmpty() }?.let { parts += it.joinToString(" ") }
        return parts.joinToString(" ")
    }

    /** The desktop's measured approval dialects; mirror values only select known literal flags. */
    internal fun approvalFlags(agent: Agent, mode: String, settings: MirrorSettings?): List<String> {
        if (mode !in PERMISSION_MODES) return emptyList()
        return when (agent) {
            Agent.CLAUDE, Agent.GROK -> when {
                mode == "manual" -> emptyList()
                agent == Agent.CLAUDE && mode == "auto" && settings?.autoSupported != true -> emptyList()
                else -> listOf("--permission-mode", mode)
            }
            Agent.GEMINI -> when (mode) {
                "plan" -> listOf("--approval-mode", "plan")
                "acceptEdits" -> listOf("--approval-mode", "auto_edit")
                "bypassPermissions" -> listOf("--approval-mode", "yolo")
                else -> emptyList()
            }
            Agent.CODEX -> {
                val wanted = when (mode) {
                    "manual" -> "untrusted"
                    "auto" -> "on-request"
                    "bypassPermissions" -> "never"
                    else -> return emptyList()
                }
                // Unknown hosts use the desktop's measured stable baseline; manual's removed
                // `untrusted` value is emitted only when this host actually advertised it.
                val vocabulary = settings?.codexApprovalValues?.takeIf { it.isNotEmpty() }
                    ?: listOf("on-request", "never")
                if (wanted in vocabulary) listOf("--ask-for-approval", wanted) else emptyList()
            }
            Agent.OPENCODE, Agent.COPILOT, Agent.ANTIGRAVITY -> emptyList()
        }
    }

    /** A node id in the desktop's shape (`term-<base36 ms>-<token>`, project-node-append.ts
     *  `SAFE_NODE_ID`), so the host registrar accepts it and it is a boring tmux name. */
    fun newNodeId(now: Long = System.currentTimeMillis(), random: SecureRandom = SecureRandom()): String {
        val token = ByteArray(5).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        return "term-${now.toString(36)}-$token"
    }
}
