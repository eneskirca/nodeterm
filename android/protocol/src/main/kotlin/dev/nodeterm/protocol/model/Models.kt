package dev.nodeterm.protocol.model

/**
 * The phone's view of one paired computer: its projects (the ASSEMBLED v2 workspace the desktop's
 * `projects.list` serves, src/core/projects-list-blob.ts), which tmux sessions are live, and the
 * agent-status mirror file (`agent-status.json`, see `src/core/agent-status-mirror.ts` and
 * docs/mobile-usage-inbox.md).
 */
data class ProjectsSnapshot(
    val projects: List<ProjectInfo>,
    /** Live nodeterm tmux session names (`nt-<nodeId>`), from `tmux ls` on the host. */
    val liveSessions: Set<String>,
    val status: AgentStatusFile?,
    val fetchedAt: Long,
    /**
     * Which tmux socket each live session is on ([TmuxNames.SOCKETS]), session name → socket. Only
     * the direct-SSH browse fills it: one host can carry both the `node-terminal` sessions of a
     * nodeterm running ON it and the `nodeterm-rmt` sessions of a desktop that drives it over SSH
     * (audit A27), and a session is reached on the socket it was listed on. Empty for a relay
     * listing (the desktop attaches its own sessions itself).
     */
    val sockets: Map<String, String> = emptyMap(),
    /**
     * What the computer said about its own LAN leg beside the listing (audit A74-refresh): its current
     * address and SSH host keys. Only a relay listing carries it, read off the answer next to the blob
     * ([dev.nodeterm.protocol.host.RelayHostConnection.listProjects]); a direct-SSH listing never does,
     * and [dev.nodeterm.protocol.ssh.LanRefresh] refuses one anyway, so nothing taken over SSH moves
     * the address or the keys that check SSH.
     */
    val lan: dev.nodeterm.protocol.ssh.LanReport? = null
) {
    fun isLive(nodeId: String): Boolean = liveSessions.contains(TmuxNames.sessionName(nodeId))

    /** The socket [nodeId]'s session was listed on, or null when the listing did not see it. */
    fun socketOf(nodeId: String): String? = sockets[TmuxNames.sessionName(nodeId)]

    fun statusOf(nodeId: String): AgentNodeStatus? = status?.nodes?.get(nodeId)

    fun openProjects(): List<ProjectInfo> = projects.filter { !it.closed }

    fun findNode(nodeId: String): Pair<ProjectInfo, NodeInfo>? {
        for (p in projects) p.nodes.firstOrNull { it.id == nodeId }?.let { return p to it }
        return null
    }

    companion object {
        val EMPTY = ProjectsSnapshot(emptyList(), emptySet(), null, 0)
    }
}

data class ProjectInfo(
    val id: String,
    val name: String,
    val color: String?,
    val cwd: String?,
    /** `user@host` for an SSH project (its terminals run on ANOTHER machine), else null. */
    val sshTarget: String?,
    val closed: Boolean,
    val nodes: List<NodeInfo>,
    /** The persisted board, or null when the project has never had one (the desktop's lazy default). */
    val board: KanbanBoard?,
    /** The project's own permission mode (project.json `defaultPermissionMode`), overriding the
     *  global one exactly as the desktop's `resolvePermissionMode` does. Unvalidated here. */
    val defaultPermissionMode: String? = null,
    /** The machine-local default Claude account for new sessions in this project. */
    val defaultAccountId: String? = null,
    /**
     * A project of a nodeterm desktop ELSEWHERE that drives this computer over SSH (audit A27): its
     * sessions run here, on the `nodeterm-rmt` socket, and its canvas is that desktop's. The direct-SSH
     * browse finds it from `<remoteCwd>/.nodeterm/project.json`, the status slice that desktop pushes
     * here (`~/.nodeterm/agent-status-<projectId>.json`) and `tmux ls`. What the machine does — attach,
     * keys, approvals, read-acks, ending the tmux session — works on it over SSH; what needs nodeterm
     * the app (new sessions, the board, node actions, git) belongs to that other desktop, which this
     * connection does not reach ([dev.nodeterm.protocol.host.LegRouting.forProject]).
     */
    val drivenRemotely: Boolean = false
) {
    /** Session nodes — what the phone lists and can attach to. */
    val sessions: List<NodeInfo> get() = nodes.filter { it.kind == NodeKind.TERMINAL }

    /**
     * Where [node] runs, as an absolute path: its own cwd, resolved against the project folder when
     * it is stored portable (`./sub`, the git-shared form), else the project folder. Null when
     * neither is absolute.
     */
    fun absoluteCwdOf(node: NodeInfo?): String? {
        val own = node?.cwd
        val root = cwd?.takeIf { it.startsWith("/") }
        return when {
            own != null && own.startsWith("/") -> own
            own != null && (own == "." || own.startsWith("./")) -> root?.let { it.trimEnd('/') + own.removePrefix(".") }
            else -> root
        }
    }
}

enum class NodeKind(val wire: String) {
    TERMINAL("terminal"), STICKY("sticky"), GROUP("group"), BROWSER("browser"), OTHER("");

    companion object {
        /** A missing kind is a terminal — the same backward-compat default `nodeStatesToFlow` applies. */
        fun of(wire: String?): NodeKind = when (wire ?: "terminal") {
            "terminal" -> TERMINAL
            "sticky" -> STICKY
            "group" -> GROUP
            "browser" -> BROWSER
            else -> OTHER
        }
    }
}

data class NodeInfo(
    val id: String,
    val kind: NodeKind,
    val title: String,
    val color: String?,
    val agentId: String?,
    val accountId: String?,
    val cwd: String?,
    val parentId: String?,
    /** A one-grapheme emoji icon, when the node has one (image icons are not drawn on the phone). */
    val iconEmoji: String?,
    /** The session id nodeterm minted at launch (`agentSessionId`), a resume fallback. */
    val agentSessionId: String?,
    /** Sticky text (sticky nodes only). */
    val text: String?
)

enum class AgentState(val wire: String) {
    WORKING("working"), WAITING("waiting"), BLOCKED("blocked"), DONE("done");

    companion object {
        fun of(wire: String?): AgentState? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The sessions sidebar's grouping (CLAUDE.md "Status-grouped sessions"): a finished turn, a
 * question and an approval ALL wait on the user; `working` is running; no live hook state is
 * unknown. There is deliberately no "done" bucket.
 */
enum class SessionBucket { NEEDS_YOU, RUNNING, SLEEPING, UNKNOWN }

data class AgentNodeStatus(
    val state: AgentState?,
    val agentId: String?,
    val sessionId: String?,
    /** The agent's own session name (the `/rename` name), when resolved. */
    val name: String?,
    val hibernated: Boolean,
    val updatedAt: Long,
    /** Which Claude account the session was OBSERVED running under, when a hook reported one.
     *  Name it with [AccountNames.observed]; the mirror carries no display name of its own here. */
    val account: ObservedAccount?
) {
    val bucket: SessionBucket
        get() = when {
            hibernated -> SessionBucket.SLEEPING
            state == AgentState.WORKING -> SessionBucket.RUNNING
            state == AgentState.DONE || state == AgentState.WAITING || state == AgentState.BLOCKED -> SessionBucket.NEEDS_YOU
            else -> SessionBucket.UNKNOWN
        }
}

/**
 * `ObservedClaudeAccount` (src/shared/types.ts): the account a running session's hooks reported,
 * classified by the desktop from the transcript path. `accountId` null + [known] = the system
 * `~/.claude`; `accountId` null + not [known] = a config dir the desktop has no record of.
 */
data class ObservedAccount(val configDir: String?, val accountId: String?, val known: Boolean)

data class AgentStatusFile(
    val updatedAt: Long,
    val nodes: Map<String, AgentNodeStatus>,
    val settings: MirrorSettings?,
    val usage: MirrorUsage?,
    val inbox: MirrorInbox?,
    /** The Server Edition's install metadata (the mirror's top-level `server` block), when present. */
    val server: MirrorServer?
)

/**
 * `MirrorServer` (src/core/agent-status-mirror.ts): what `scripts/install-server.sh` recorded in
 * `<data-dir>/install-meta.json`, surfaced by a Server Edition so a phone can show which version it
 * is on. Every field is optional there; a server started without the installer has no block at all.
 */
data class MirrorServer(val version: String?, val commit: String?, val installedAt: String?) {
    /** One line for the host screen ("nodeterm server 0.2.17 · 1e56f83 · installed 2026-09-01"), or null with nothing to say. */
    fun describe(): String? {
        if (version == null && commit == null && installedAt == null) return null
        return buildList {
            add("nodeterm server" + (version?.let { " $it" } ?: ""))
            commit?.let { add(it) }
            // An ISO-8601 timestamp: its date is what a person compares. Anything else is shown as given.
            installedAt?.let { add("installed " + (Regex("^\\d{4}-\\d{2}-\\d{2}").find(it)?.value ?: it)) }
        }.joinToString(" · ")
    }
}

data class MirrorSettings(
    val claudePermissionMode: String?,
    /** Answers for CLAUDE only: may `--permission-mode auto` be emitted on this host. */
    val autoSupported: Boolean?,
    val claudeAccounts: List<ManagedAccount>,
    /** Values this host's codex accepts for `--ask-for-approval`; empty = not probed. */
    val codexApprovalValues: List<String>
)

/**
 * One `MirrorSettings.claudeAccounts` entry (`mirrorClaudeAccount`, agent-status-mirror.ts): [id] and
 * [dir] are what a launch uses; [label] and [email] are what the phone shows (absent on a desktop
 * older than them). Show it through [AccountNames], never by printing [id].
 */
data class ManagedAccount(val id: String, val dir: String, val label: String? = null, val email: String? = null)

data class MirrorUsage(val updatedAt: Long, val accounts: List<UsageAccount>)

data class UsageAccount(
    val accountId: String?,
    val label: String?,
    val email: String?,
    val agentId: String,
    val status: String,
    val updatedAt: Long,
    val limits: List<UsageLimit>
)

data class UsageLimit(
    val kind: String,
    val group: String?,
    val usedPercent: Double,
    val severity: String?,
    val resetsAt: Long?,
    val windowMinutes: Long?,
    val scopeLabel: String?,
    val isActive: Boolean
)

data class MirrorInbox(val events: List<InboxEvent>, val nodes: Map<String, InboxNodeNow>)

enum class InboxKind(val wire: String) {
    APPROVAL("approval"), QUESTION("question"), DONE("done");

    companion object {
        fun of(wire: String?): InboxKind? = entries.firstOrNull { it.wire == wire }
    }
}

data class InboxEvent(
    val id: String,
    val ts: Long,
    val nodeId: String,
    val agentId: String?,
    val sessionId: String?,
    val kind: InboxKind,
    val title: String,
    val detail: String?,
    val interrupted: Boolean,
    val resolved: Boolean,
    val options: List<String>,
    val multiSelect: Boolean,
    /** The hook-reply ticket (docs/hook-reply-approvals.md): answer by writing the `.answer` file. */
    val pendingId: String?,
    val permissionSuggestions: List<PermissionSuggestion> = emptyList(),
    val questionPendingId: String? = null,
    val questions: List<HookQuestion> = emptyList()
) {
    val actionable: Boolean get() = !resolved && (kind == InboxKind.APPROVAL || kind == InboxKind.QUESTION)
}

data class InboxNodeNow(
    val activity: String?,
    val tool: String?,
    val contextPercent: Double?,
    val prompt: String?,
    val updatedAt: Long
)

data class KanbanColumn(val id: String, val title: String, val color: String?)

data class KanbanLabel(val id: String, val name: String, val color: String)

data class KanbanCardMeta(
    val nodeId: String,
    val assignees: List<String>,
    val dueAt: Long?,
    val priority: String?,
    val labels: List<String>
)

data class KanbanBoard(
    val columns: List<KanbanColumn>,
    /** nodeId → columnId, in persisted order (order within a column = relative order here). */
    val assignments: List<Pair<String, String>>,
    val labels: List<KanbanLabel>,
    val meta: List<KanbanCardMeta>
) {
    fun columnOf(nodeId: String): String? = assignments.firstOrNull { it.first == nodeId }?.second

    fun metaOf(nodeId: String): KanbanCardMeta? = meta.firstOrNull { it.nodeId == nodeId }

    companion object {
        /** `@shared/kanban-default-board`: the columns a project with no board is shown. Display only —
         *  a write first asks the host to seed the real board (`projects.ensureBoard`). */
        val DEFAULT_COLUMN_TITLES = listOf("To Do", "In Progress", "Done")
    }
}

/** `src/core/tmux-naming.ts`. */
object TmuxNames {
    /** The socket of a nodeterm running ON the computer (the desktop app or the Server Edition). */
    const val SOCKET = "node-terminal"
    /**
     * The socket a DESKTOP uses for the sessions it runs on an SSH host (`remoteTmuxCommand`,
     * src/shared/ssh.ts). The phone reaches it when it SSHes into that host itself (audit A27); a
     * node of the paired desktop's own SSH projects is still reached through the desktop (A09).
     */
    const val REMOTE_SOCKET = "nodeterm-rmt"

    /** Plain shells explicitly created by a phone; no desktop reaper or managed hook environment. */
    const val PHONE_SOCKET = "nodeterm-phone"

    /** Every socket a session may be on, in the order a name on both is attributed (first wins, as
     *  the desktop's session-memory sweep does). Nothing else is ever spliced into `tmux -L`. */
    val SOCKETS = listOf(SOCKET, REMOTE_SOCKET, PHONE_SOCKET)

    fun sessionName(persistKey: String): String = "nt-" + persistKey.replace(Regex("[^a-zA-Z0-9_-]"), "_")

    /** `^nt-[A-Za-z0-9_-]+$` — the only target shape we ever interpolate into a tmux command. */
    fun isSessionName(target: String): Boolean = Regex("^nt-[A-Za-z0-9_-]+$").matches(target)
}
