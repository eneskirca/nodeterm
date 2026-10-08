package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.model.J.a
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.d
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.objects
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.J.strings
import kotlinx.serialization.json.JsonObject

/**
 * Parses the `projects.list` blob: `<workspace json>\n--NT-PROJECTS-SPLIT--\n<tmux session
 * names>\n--NT-STATUS-SPLIT--\n<agent-status.json>` (`buildProjectsListBlob` in
 * src/core/projects-list-blob.ts, which the desktop's `listProjectsOutput` serves). The
 * direct-SSH browse produces the same shape, so both transports share this parser. Every section
 * is best-effort: a missing or corrupt one degrades to empty, never to an exception.
 */
object ProjectsParser {
    const val PROJECTS_MARK = "--NT-PROJECTS-SPLIT--"
    const val STATUS_MARK = "--NT-STATUS-SPLIT--"

    fun parseBlob(blob: String, now: Long = System.currentTimeMillis()): ProjectsSnapshot {
        val p = blob.indexOf(PROJECTS_MARK)
        val s = blob.indexOf(STATUS_MARK)
        val workspaceText = if (p >= 0) blob.substring(0, p) else blob
        val sessionsText = if (p >= 0) blob.substring(p + PROJECTS_MARK.length, if (s > p) s else blob.length) else ""
        val statusText = if (s >= 0) blob.substring(s + STATUS_MARK.length) else ""
        return ProjectsSnapshot(
            projects = parseWorkspace(workspaceText),
            liveSessions = sessionsText.lineSequence().map { it.trim() }.filter { it.startsWith("nt-") }.toSet(),
            status = parseStatus(statusText),
            fetchedAt = now
        )
    }

    /** The assembled v2 workspace `{version:2, projects:[…]}`. A v3 index carries no nodes and is
     *  resolved by the SSH browse before it gets here. */
    fun parseWorkspace(text: String): List<ProjectInfo> {
        val root = J.obj(J.parse(text)) ?: return emptyList()
        return root.objects("projects").mapNotNull(::parseProject)
    }

    fun parseProject(p: JsonObject): ProjectInfo? {
        val id = p.s("id") ?: return null
        val ssh = p.o("ssh")?.o("server")
        val sshTarget = ssh?.let { srv ->
            val host = srv.s("host") ?: return@let null
            val user = srv.s("user")
            if (user.isNullOrEmpty()) host else "$user@$host"
        }
        return ProjectInfo(
            id = id,
            name = p.s("name") ?: id,
            color = p.s("color"),
            cwd = p.s("cwd"),
            sshTarget = sshTarget,
            closed = p.b("closed") == true,
            nodes = p.objects("nodes").mapNotNull(::parseNode),
            board = p.o("kanban")?.let(::parseBoard),
            defaultPermissionMode = p.s("defaultPermissionMode"),
            defaultAccountId = p.s("defaultAccountId")
        )
    }

    fun parseNode(n: JsonObject): NodeInfo? {
        val id = n.s("id") ?: return null
        val icon = n.o("icon")
        val emoji = if (icon?.s("type") == "emoji") icon.s("value")?.takeIf { it.isNotBlank() && it.length <= 16 } else null
        return NodeInfo(
            id = id,
            kind = NodeKind.of(n.s("kind")),
            title = n.s("title") ?: "",
            color = n.s("color"),
            agentId = n.s("agentId") ?: legacyAgent(n),
            accountId = n.s("accountId"),
            cwd = n.s("cwd"),
            parentId = n.s("parentId") ?: n.s("group"),
            iconEmoji = emoji,
            agentSessionId = n.s("agentSessionId"),
            text = n.s("text")
        )
    }

    /** `nodeStatesToFlow` migrates the legacy `tags:['claude']` marker to `agentId = 'claude'`. */
    private fun legacyAgent(n: JsonObject): String? = if ("claude" in n.strings("tags")) "claude" else null

    fun parseBoard(k: JsonObject): KanbanBoard? {
        val columns = k.objects("columns").mapNotNull { c ->
            val id = c.s("id") ?: return@mapNotNull null
            KanbanColumn(id, c.s("title") ?: "", c.s("color"))
        }
        // `validKanban` drops a malformed board to the fresh default; the phone does the same by
        // reporting none, so the UI shows the default and a write seeds a real one.
        if (columns.isEmpty() && k["columns"] == null) return null
        val assignments = k.objects("assignments").mapNotNull { a ->
            val nodeId = a.s("nodeId") ?: return@mapNotNull null
            val columnId = a.s("columnId") ?: return@mapNotNull null
            nodeId to columnId
        }
        val labels = k.objects("labels").mapNotNull { l ->
            val id = l.s("id") ?: return@mapNotNull null
            KanbanLabel(id, l.s("name") ?: "", l.s("color") ?: "default")
        }
        val meta = k.objects("meta").mapNotNull { m ->
            val nodeId = m.s("nodeId") ?: return@mapNotNull null
            KanbanCardMeta(
                nodeId = nodeId,
                assignees = m.objects("assignees").mapNotNull { it.s("name") },
                dueAt = m.l("dueAt"),
                priority = m.s("priority"),
                labels = m.strings("labels")
            )
        }
        return KanbanBoard(columns, assignments, labels, meta)
    }

    fun parseStatus(text: String): AgentStatusFile? {
        val root = J.obj(J.parse(text)) ?: return null
        val nodes = LinkedHashMap<String, AgentNodeStatus>()
        root.o("nodes")?.forEach { (nodeId, raw) ->
            val e = J.obj(raw) ?: return@forEach
            nodes[nodeId] = AgentNodeStatus(
                state = AgentState.of(e.s("state")),
                agentId = e.s("agentId"),
                sessionId = e.s("sessionId"),
                name = e.s("name"),
                hibernated = e.b("hibernated") == true,
                updatedAt = e.l("updatedAt") ?: 0,
                account = e.o("account")?.let(::parseObservedAccount)
            )
        }
        return AgentStatusFile(
            updatedAt = root.l("updatedAt") ?: 0,
            nodes = nodes,
            settings = root.o("settings")?.let(::parseSettings),
            usage = root.o("usage")?.let(::parseUsage),
            inbox = root.o("inbox")?.let(::parseInbox),
            server = root.o("server")?.let(::parseServer)
        )
    }

    /**
     * The `server` block (`MirrorServer`). Strings from a file on the host, shown on the phone: each
     * is kept only when it is short, printable text, so a hand-edited install-meta.json cannot put a
     * screenful (or control characters) into the host screen.
     */
    private fun parseServer(s: JsonObject): MirrorServer? {
        fun field(key: String) = s.s(key)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 && it.none { c -> c.isISOControl() } }
        return MirrorServer(field("version"), field("commit"), field("installedAt"))
            .takeIf { it.version != null || it.commit != null || it.installedAt != null }
    }

    /** `ObservedClaudeAccount`. A wrong-typed `known` reads as false: the entry then names its dir,
     *  which is the label that claims least. */
    private fun parseObservedAccount(a: JsonObject) = ObservedAccount(
        configDir = a.s("configDir"),
        accountId = a.s("accountId"),
        known = a.b("known") == true
    )

    private fun parseSettings(s: JsonObject) = MirrorSettings(
        claudePermissionMode = s.s("claudePermissionMode"),
        autoSupported = s.b("autoSupported"),
        claudeAccounts = s.objects("claudeAccounts").mapNotNull { a ->
            val id = a.s("id") ?: return@mapNotNull null
            val dir = a.s("dir") ?: return@mapNotNull null
            ManagedAccount(id, dir, label = a.s("label"), email = a.s("email"))
        },
        codexApprovalValues = s.strings("codexApprovalValues")
    )

    private fun parseUsage(u: JsonObject) = MirrorUsage(
        updatedAt = u.l("updatedAt") ?: 0,
        accounts = u.objects("accounts").map { a ->
            UsageAccount(
                accountId = a.s("accountId"),
                label = a.s("label"),
                email = a.s("email"),
                agentId = a.s("agentId") ?: "claude",
                status = a.s("status") ?: "unavailable",
                updatedAt = a.l("updatedAt") ?: 0,
                limits = a.objects("limits").mapNotNull { l ->
                    val kind = l.s("kind") ?: return@mapNotNull null
                    val used = l.d("usedPercent") ?: return@mapNotNull null
                    UsageLimit(
                        kind = kind,
                        group = l.s("group"),
                        usedPercent = used,
                        severity = l.s("severity"),
                        resetsAt = l.l("resetsAt"),
                        windowMinutes = l.l("windowMinutes"),
                        scopeLabel = l.s("scopeLabel"),
                        isActive = l.b("isActive") == true
                    )
                }
            )
        }
    )

    private fun parseInbox(i: JsonObject): MirrorInbox {
        val events = i.objects("events").mapNotNull { e ->
            val id = e.s("id") ?: return@mapNotNull null
            val nodeId = e.s("nodeId") ?: return@mapNotNull null
            val kind = InboxKind.of(e.s("kind")) ?: return@mapNotNull null
            InboxEvent(
                id = id,
                ts = e.l("ts") ?: 0,
                nodeId = nodeId,
                agentId = e.s("agentId"),
                sessionId = e.s("sessionId"),
                kind = kind,
                title = e.s("title") ?: "",
                detail = e.s("detail"),
                interrupted = e.b("interrupted") == true,
                resolved = e.b("resolved") == true,
                options = e.strings("options"),
                multiSelect = e.b("multiSelect") == true,
                pendingId = e.s("pendingId"),
                permissionSuggestions = HookReplies.permissionSuggestions(e["permissionSuggestions"]),
                questionPendingId = e.s("questionPendingId"),
                questions = HookReplies.questions(e["questions"]) ?: emptyList()
            )
        }
        val nodes = LinkedHashMap<String, InboxNodeNow>()
        i.o("nodes")?.forEach { (nodeId, raw) ->
            val n = J.obj(raw) ?: return@forEach
            nodes[nodeId] = InboxNodeNow(
                activity = n.s("activity"),
                tool = n.s("tool"),
                contextPercent = n.d("contextPercent"),
                prompt = n.s("prompt"),
                updatedAt = n.l("updatedAt") ?: 0
            )
        }
        return MirrorInbox(events, nodes)
    }

    @Suppress("unused")
    private fun JsonObject.hasArray(key: String): Boolean = a(key).isNotEmpty()
}
