package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.model.AgentNodeStatus
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxNodeNow
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.MirrorInbox
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TmuxNames
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What [SshScripts.browse] printed, and the listing it makes (audit A27).
 *
 * A computer the phone SSHes into can hold two kinds of nodeterm sessions at once: those of a nodeterm
 * running ON it (the desktop app or the Server Edition: `workspace.json` + `agent-status.json` in its
 * data dir, sessions on `node-terminal`), and those of a desktop ELSEWHERE that drives it over SSH
 * (sessions on `nodeterm-rmt`). For the second kind there is no workspace.json here at all; what that
 * desktop leaves on this computer is:
 *
 *  - its SSH project's canvas, `<remoteCwd>/.nodeterm/project.json` (the desktop's SSH mirror writes
 *    it with the desktop's project id as `id`; see `projectToFile` in src/core/workspace-files.ts),
 *  - one status slice per connected SSH project, `~/.nodeterm/agent-status-<projectId>.json`
 *    (src/main/remote-ssh/remote-status-push.ts), refreshed at least every [STATUS_HEARTBEAT_MS]
 *    while that desktop is connected, so an older one is NO DATA ([SLICE_STALE_MS]),
 *  - the sessions themselves.
 *
 * [assemble] turns those into [ProjectInfo.drivenRemotely] projects next to the host's own ones. The
 * host's own index always wins: a project or node it already lists is never listed twice, and a node
 * of the paired desktop's OWN SSH projects stays the desktop's (audit A09).
 */
object HostBrowse {
    /** `STATUS_HEARTBEAT_MS` in src/main/remote-ssh/remote-status-push.ts (pinned by a test). */
    const val STATUS_HEARTBEAT_MS = 60_000L

    /**
     * A slice whose `updatedAt` is older than this is no data: the desktop that wrote it disconnected
     * or quit, and its states are whatever they were then. Twice the heartbeat, so one late push does
     * not blank a connected desktop's sessions. Measured against this phone's clock: the slice carries
     * the desktop's clock, and the two are both network-synced in the setups this serves.
     */
    const val SLICE_STALE_MS = 2 * STATUS_HEARTBEAT_MS

    /** A project id as the desktop mints it (`[A-Za-z0-9._-]`, src/shared/project-id.ts). */
    private val PROJECT_ID = Regex("^[A-Za-z0-9._-]{1,200}$")

    /** The id of the one synthetic project that holds `nodeterm-rmt` sessions no project names. */
    const val OTHER_SESSIONS_ID = "host:other-sessions"
    const val OTHER_SESSIONS_NAME = "Other sessions on this computer"

    data class Output(
        /** True when the meta block was printed at all (an older or broken script prints none). */
        val metaSeen: Boolean,
        /** The data dir of a nodeterm running on this computer, or null when none was found. */
        val userData: String?,
        /** The part shaped like the relay's `projects.list` blob ([ProjectsParser.parseBlob]). */
        val blob: String,
        /** `nt-*` session names on `nodeterm-rmt`. */
        val rmtSessions: List<String>,
        /** projectId → the slice file's text. */
        val slices: List<Pair<String, String>>,
        /** A folder holding `.nodeterm/project.json` → that file's text. */
        val projectFiles: List<Pair<String, String>>,
        /**
         * Whether the computer advertises its relay right now (`~/.nodeterm/relay.json`, present
         * only while the desktop's phone host is registered at the relay; audit A26), or null when
         * the meta block did not say.
         */
        val relayAdvertised: Boolean? = null,
        /** Plain shells with validated atomic ownership metadata on the independent phone socket. */
        val phoneTerminals: List<PhoneTerminals.Entry> = emptyList()
    ) {
        /**
         * Nothing of nodeterm's was found as of [now]: no data dir, no session a desktop runs here, and
         * no slice that is still data ([freshSlices]). Not "no nodeterm here": a Server Edition started
         * with another `--data-dir` looks like this.
         *
         * Judged on what the listing can USE, not on what files exist: the desktop never deletes a
         * slice (remote-status-push.ts only writes), so on a computer a desktop drove once the stale
         * ones stay for good, and counting them made such a computer read as an empty one forever
         * (the review of A27a).
         */
        fun nothingFound(now: Long): Boolean =
            metaSeen && userData == null && rmtSessions.isEmpty() && phoneTerminals.isEmpty() && freshSlices(this, now).isEmpty()
    }

    /** Split [SshScripts.browse]'s output into its sections. Every section is best-effort. */
    fun split(raw: String): Output {
        val metaEnd = raw.indexOf(SshScripts.META_END)
        val meta = if (metaEnd >= 0) raw.substring(0, metaEnd) else ""
        val rest = if (metaEnd >= 0) raw.substring(metaEnd + SshScripts.META_END.length).removePrefix("\n") else raw
        val ud = meta.lineSequence().firstOrNull { it.startsWith("ud=") }?.removePrefix("ud=")?.takeIf { it.isNotBlank() }
        val relay = when (meta.lineSequence().firstOrNull { it.startsWith("relay=") }?.removePrefix("relay=")?.trim()) {
            "1" -> true
            "0" -> false
            else -> null
        }

        val blob = StringBuilder()
        val rmt = ArrayList<String>()
        val slices = ArrayList<Pair<String, String>>()
        val files = ArrayList<Pair<String, String>>()
        val phone = ArrayList<PhoneTerminals.Entry>()
        var section: String? = null // null = the blob; "rmt"; "slice"; "file"; "end"
        var key = ""
        val body = StringBuilder()
        fun close() {
            when (section) {
                "slice" -> slices += key to body.toString()
                "file" -> files += key to body.toString()
            }
            body.setLength(0)
        }
        for (line in rest.split('\n')) {
            when {
                line == SshScripts.RMT_MARK -> { close(); section = "rmt" }
                line == SshScripts.PHONE_MARK -> { close(); section = "phone" }
                line.startsWith(SshScripts.SLICE_MARK) -> { close(); section = "slice"; key = line.removePrefix(SshScripts.SLICE_MARK) }
                line.startsWith(SshScripts.PROJECT_FILE_MARK) -> { close(); section = "file"; key = line.removePrefix(SshScripts.PROJECT_FILE_MARK) }
                line == SshScripts.END_MARK -> { close(); section = "end" }
                section == null -> blob.append(line).append('\n')
                section == "rmt" -> line.trim().takeIf(TmuxNames::isSessionName)?.let(rmt::add)
                section == "phone" -> PhoneTerminals.parse(line)?.let(phone::add)
                section == "slice" || section == "file" -> body.append(line).append('\n')
            }
        }
        close()
        return Output(metaEnd >= 0, ud, blob.toString(), rmt.distinct(), slices, files, relay, phone.distinctBy { it.id })
    }

    /**
     * The listing: [base] (the host's own projects, sessions and status, already resolved from its
     * index) plus what a desktop that drives this computer over SSH left in [out], as of [now].
     */
    fun assemble(base: ProjectsSnapshot, out: Output, now: Long): ProjectsSnapshot {
        // Which socket each session is on. A name on both is the host's own (first wins, the
        // desktop's session-memory sweep's rule), and is then not a session of a driven project.
        val sockets = LinkedHashMap<String, String>()
        for (s in base.liveSessions) sockets[s] = TmuxNames.SOCKET
        for (s in out.rmtSessions) sockets.putIfAbsent(s, TmuxNames.REMOTE_SOCKET)
        val rmtOnly = out.rmtSessions.filter { sockets[it] == TmuxNames.REMOTE_SOCKET }.toSet()

        val fresh = freshSlices(out, now)

        val baseIds = base.projects.mapTo(HashSet()) { it.id }
        val usedIds = HashSet(baseIds)
        // A node is listed once: the host's own index first, then the first driven project naming it.
        val claimed = base.projects.flatMapTo(HashSet()) { p -> p.nodes.map { it.id } }
        // The host's own folder projects read the same file through their index entry.
        val ownFolders = base.projects.mapNotNullTo(HashSet()) { it.cwd?.trimEnd('/')?.ifEmpty { "/" } }
        val driven = ArrayList<ProjectInfo>()

        for ((dir, text) in out.projectFiles) {
            val folder = dir.trimEnd('/').ifEmpty { "/" }
            if (!folder.startsWith("/") || folder in ownFolders) continue
            val root = J.obj(J.parse(text)) ?: continue
            val fileId = root.s("id")
            // The paired desktop's own SSH project (it drives this computer itself): its index entry
            // already lists it, and its nodes stay the desktop's to reach (A09).
            if (fileId != null && fileId in baseIds) continue
            val id = fileId?.takeIf { PROJECT_ID.matches(it) && it !in usedIds } ?: "host:$folder"
            if (id in usedIds) continue
            // Machine-local fields are never read from the shared file: this computer's folder is the
            // one the file was found in, and nothing here says the project is closed.
            val content = JsonObject(root - setOf("id", "cwd", "ssh", "closed") + ("id" to JsonPrimitive(id)))
            val parsed = ProjectsParser.parseProject(content) ?: continue
            val nodes = parsed.nodes.filter { it.id !in claimed }.map { n ->
                val c = n.cwd
                if (c != null && (c == "." || c.startsWith("./"))) n.copy(cwd = folder.trimEnd('/') + c.removePrefix(".")) else n
            }
            // Listed when something here is live or reported: a session of one of its nodes runs on
            // `nodeterm-rmt`, or its desktop is connected (a fresh slice). A folder that merely has a
            // project.json above some session is not a project anyone is driving.
            val live = nodes.any { TmuxNames.sessionName(it.id) in rmtOnly }
            if (!live && id !in fresh) continue
            usedIds += id
            nodes.forEach { claimed += it.id }
            driven += parsed.copy(cwd = folder, nodes = nodes, drivenRemotely = true)
        }

        // A connected desktop's project whose file was not found (its sessions are not running, or
        // they start outside its folder, or the file is unreadable): its slice still names its agents.
        for ((id, slice) in fresh) {
            if (id in usedIds) continue
            val nodes = slice.nodes.filterKeys { it !in claimed }.map { (nodeId, st) -> bareNode(nodeId, st.agentId) }
            if (nodes.isEmpty()) continue
            usedIds += id
            nodes.forEach { claimed += it.id }
            driven += ProjectInfo(
                id = id, name = id, color = null, cwd = null, sshTarget = null, closed = false,
                nodes = nodes, board = null, drivenRemotely = true
            )
        }

        // Sessions on `nodeterm-rmt` that no project names: still sessions on this computer, so they
        // are listed (and can be opened) rather than hidden.
        // Compared as session names: a node id with characters tmux names cannot hold maps to `_`.
        val claimedSessions = claimed.mapTo(HashSet(), TmuxNames::sessionName)
        val orphans = rmtOnly.filter { it !in claimedSessions }.map { it.removePrefix("nt-") }.sorted()
            .map { nodeId -> bareNode(nodeId, fresh.values.firstNotNullOfOrNull { it.nodes[nodeId]?.agentId }) }
        if (orphans.isNotEmpty()) {
            driven += ProjectInfo(
                id = OTHER_SESSIONS_ID, name = OTHER_SESSIONS_NAME, color = null, cwd = null, sshTarget = null,
                closed = false, nodes = orphans, board = null, drivenRemotely = true
            )
        }

        // These plain shells belong to the phone, not either desktop's canvas. Their cwd is shown
        // on the node; grouping never edits a shared project.json or invents managed agent status.
        val phone = out.phoneTerminals.filter { it.id !in claimed && TmuxNames.sessionName(it.id) !in sockets }
        for (entry in phone) sockets[TmuxNames.sessionName(entry.id)] = TmuxNames.PHONE_SOCKET
        val phoneProjects = if (phone.isEmpty()) emptyList() else listOf(ProjectInfo(
            id = PhoneTerminals.PROJECT_ID, name = PhoneTerminals.PROJECT_NAME, color = null,
            cwd = null, sshTarget = null, closed = false, board = null,
            nodes = phone.map { bareNode(it.id, null).copy(title = "Terminal", cwd = it.cwd) }
        ))

        return base.copy(
            projects = base.projects + driven + phoneProjects,
            liveSessions = base.liveSessions + rmtOnly + phone.map { TmuxNames.sessionName(it.id) },
            status = mergeStatus(base.status, fresh.values.sortedByDescending { it.updatedAt }),
            sockets = sockets
        )
    }

    /**
     * The slices in [out] that are data as of [now]: named by a valid project id, parseable, and no
     * older than [SLICE_STALE_MS]. projectId → slice, in the order they were printed.
     */
    fun freshSlices(out: Output, now: Long): Map<String, AgentStatusFile> {
        val fresh = LinkedHashMap<String, AgentStatusFile>()
        for ((id, text) in out.slices) {
            if (!PROJECT_ID.matches(id)) continue
            val slice = ProjectsParser.parseStatus(text) ?: continue
            if (slice.updatedAt >= now - SLICE_STALE_MS) fresh[id] = slice
        }
        return fresh
    }

    private fun bareNode(id: String, agentId: String?) = NodeInfo(
        id = id, kind = NodeKind.TERMINAL, title = "", color = null, agentId = agentId, accountId = null,
        cwd = null, parentId = null, iconEmoji = null, agentSessionId = null, text = null
    )

    /**
     * The host's own mirror with the fresh slices' nodes and inbox added. The host's own entries win
     * (node ids are global, so a clash would be the same node), and its settings, usage and `server`
     * block are the host's: a slice carries no usage, and its settings are a fallback for a host that
     * runs no nodeterm of its own.
     */
    private fun mergeStatus(own: AgentStatusFile?, slices: List<AgentStatusFile>): AgentStatusFile? {
        if (slices.isEmpty()) return own
        val nodes = LinkedHashMap<String, AgentNodeStatus>()
        own?.nodes?.let(nodes::putAll)
        for (s in slices) for ((id, st) in s.nodes) nodes.putIfAbsent(id, st)
        val inboxes = listOfNotNull(own?.inbox) + slices.mapNotNull { it.inbox }
        val inbox = if (inboxes.isEmpty()) null else {
            val seen = HashSet<String>()
            val events = inboxes.flatMap { it.events }.filter { seen.add(it.id) }.sortedBy(InboxEvent::ts)
            val inboxNodes = LinkedHashMap<String, InboxNodeNow>()
            for (i in inboxes) for ((id, n) in i.nodes) inboxNodes.putIfAbsent(id, n)
            MirrorInbox(events, inboxNodes)
        }
        return AgentStatusFile(
            updatedAt = maxOf(own?.updatedAt ?: 0, slices.maxOf { it.updatedAt }),
            nodes = nodes,
            settings = own?.settings ?: slices.firstNotNullOfOrNull { it.settings },
            usage = own?.usage,
            inbox = inbox,
            server = own?.server
        )
    }
}
