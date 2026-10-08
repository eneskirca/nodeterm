package dev.nodeterm.protocol.model

/** Local filtering of the sessions list; a query never changes the host's listing or node ids. */
object SessionSearch {
    enum class EmptyState { LOADING, EMPTY, NO_MATCHES }

    /** The same title displayed by a session row and used when opening its terminal. */
    fun title(node: NodeInfo, snapshot: ProjectsSnapshot): String =
        snapshot.statusOf(node.id)?.name?.takeIf { it.isNotBlank() }
            ?: node.title.takeIf { it.isNotBlank() }
            ?: Agent.of(node.agentId)?.label
            ?: "Terminal"

    /** The row's agent detail, which can also come from a hook when the node has no agent id. */
    fun agentLabel(node: NodeInfo, snapshot: ProjectsSnapshot): String =
        Agent.of(node.agentId ?: snapshot.statusOf(node.id)?.agentId)?.label ?: "Terminal"

    /**
     * Trimmed, case-insensitive literal matching, keeping project and node order. A project name or
     * folder match keeps all its sessions; a session match keeps only that row. The node's folder
     * is included too: phone-created shells have distinct folders under one synthetic project.
     * A blank query returns the original open, nonempty projects unchanged.
     */
    fun projects(snapshot: ProjectsSnapshot, query: String): List<ProjectInfo> {
        val needle = query.trim()
        val available = snapshot.openProjects().filter { it.sessions.isNotEmpty() }
        if (needle.isEmpty()) return available
        fun String?.matches(): Boolean = this?.contains(needle, ignoreCase = true) == true
        return available.mapNotNull { project ->
            if (project.name.matches() || project.cwd.matches()) return@mapNotNull project
            val matching = project.sessions.filter { node ->
                title(node, snapshot).matches() || agentLabel(node, snapshot).matches() || node.cwd.matches()
            }
            if (matching.isEmpty()) null else project.copy(nodes = matching)
        }
    }

    /** Called when the filtered list is empty, so a search miss does not claim the host is empty. */
    fun emptyState(snapshot: ProjectsSnapshot, query: String): EmptyState = when {
        query.isNotBlank() && snapshot.openProjects().any { it.sessions.isNotEmpty() } -> EmptyState.NO_MATCHES
        snapshot.fetchedAt == 0L -> EmptyState.LOADING
        else -> EmptyState.EMPTY
    }
}
