package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.AgentNodeStatus
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.model.SessionSearch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class SessionSearchTest {
    private fun node(id: String, title: String = id, agent: String? = null, cwd: String? = null, kind: NodeKind = NodeKind.TERMINAL) =
        NodeInfo(id, kind, title, null, agent, null, cwd, null, null, null, null)

    private fun project(id: String, vararg nodes: NodeInfo, name: String = id, cwd: String? = null, closed: Boolean = false) =
        ProjectInfo(id, name, null, cwd, null, closed, nodes.toList(), null)

    private fun status(name: String? = null, agent: String? = null, state: AgentState? = null, hibernated: Boolean = false, updatedAt: Long = 1) =
        AgentNodeStatus(state, agent, null, name, hibernated, updatedAt, null)

    private fun snapshot(vararg projects: ProjectInfo, states: Map<String, AgentNodeStatus> = emptyMap(), fetchedAt: Long = 1) =
        ProjectsSnapshot(projects.toList(), setOf("nt-running"), AgentStatusFile(1, states, null, null, null, null), fetchedAt)

    private fun ids(snapshot: ProjectsSnapshot, query: String) =
        SessionSearch.projects(snapshot, query).flatMap { it.sessions }.map { it.id }

    @Test
    fun `blank queries retain original open groups and rows without including closed or nonterminal projects`() {
        val a = project("a", node("second"), node("first"), node("note", kind = NodeKind.STICKY))
        val b = project("b", node("third"))
        val s = snapshot(a, project("closed", node("hidden"), closed = true), project("notes", node("note", kind = NodeKind.STICKY)), b)
        for (query in listOf("", "  ", "\t\n")) {
            val found = SessionSearch.projects(s, query)
            assertEquals(listOf("a", "b"), found.map { it.id })
            assertEquals(listOf("second", "first", "third"), ids(s, query))
            assertSame(a, found[0])
            assertSame(b, found[1])
        }
    }

    @Test
    fun `the current displayed session name takes precedence over a hidden canvas title`() {
        val n = node("n", title = "Old canvas name", agent = "claude")
        val s = snapshot(project("p", n), states = mapOf("n" to status(name = "Current task")))
        assertEquals("Current task", SessionSearch.title(n, s))
        assertEquals(listOf("n"), ids(s, " CURRENT TASK "))
        assertTrue(ids(s, "Old canvas name").isEmpty())
        val blankName = s.copy(status = s.status!!.copy(nodes = mapOf("n" to status(name = "  "))))
        assertEquals("Old canvas name", SessionSearch.title(n, blankName))
        assertEquals(listOf("n"), ids(blankName, "CANVAS"))
    }

    @Test
    fun `blank titles fall back to the displayed agent then Terminal`() {
        val agent = node("agent", title = "  ", agent = "claude")
        val shell = node("shell", title = "")
        val s = snapshot(project("p", agent, shell))
        assertEquals("Claude Code", SessionSearch.title(agent, s))
        assertEquals("Terminal", SessionSearch.title(shell, s))
        assertEquals(listOf("agent"), ids(s, "claude code"))
        assertEquals(listOf("shell"), ids(s, "terminal"))
    }

    @Test
    fun `project names and folders keep all sessions in that group but not empty or closed groups`() {
        val a = project("a", node("one"), node("two"), name = "Hike project", cwd = "/work/hike folder")
        val s = snapshot(a, project("b", node("three")), project("closed", node("hidden"), name = "Hike", closed = true), project("empty", name = "Hike"))
        for (query in listOf("HIKE PROJECT", " /WORK/HIKE FOLDER ")) {
            val found = SessionSearch.projects(s, query)
            assertEquals(listOf("a"), found.map { it.id })
            assertEquals(listOf("one", "two"), ids(s, query))
            assertSame(a, found.single())
        }
    }

    @Test
    fun `agent detail matches even when a custom session title hides the agent and the hook supplies its id`() {
        val n = node("n", title = "Fix tests")
        val s = snapshot(project("p", n), states = mapOf("n" to status(agent = "copilot")))
        assertEquals("Fix tests", SessionSearch.title(n, s))
        assertEquals("GitHub Copilot", SessionSearch.agentLabel(n, s))
        assertEquals(listOf("n"), ids(s, "github copilot"))
        val known = node("known", title = "Different task", agent = "codex")
        val preferred = snapshot(project("p", known), states = mapOf("known" to status(agent = "claude")))
        assertEquals("Codex", SessionSearch.agentLabel(known, preferred))
        assertTrue(ids(preferred, "Claude Code").isEmpty(), "match the displayed agent, not a hidden hook id")
    }

    @Test
    fun `phone shell folders distinguish sessions under the same project without changing their ids`() {
        val a = node("phone-a", title = "Terminal", cwd = "/work/one folder")
        val b = node("phone-b", title = "Terminal", cwd = "/work/two folder")
        val p = project("phone-terminals", a, b)
        val s = snapshot(p)
        val found = SessionSearch.projects(s, "TWO FOLDER")
        assertEquals(listOf("phone-terminals"), found.map { it.id })
        assertEquals(listOf("phone-b"), found.single().sessions.map { it.id })
        assertSame(b, found.single().sessions.single())
        assertEquals(listOf(a, b), p.nodes, "search never rewrites the received listing")
    }

    @Test
    fun `queries are trimmed case insensitive Unicode literals rather than regular expressions or joined fields`() {
        val s = snapshot(project("Beta", node("literal", title = "Task [a-z].* ΩMEGA"), node("other", title = "Alpha")))
        assertEquals(listOf("literal"), ids(s, " [A-Z].* "))
        assertEquals(listOf("literal"), ids(s, "ωmega"))
        assertTrue(ids(s, "^Task").isEmpty())
        assertTrue(ids(s, "AlphaBeta").isEmpty(), "do not invent matches spanning independent fields")
    }

    @Test
    fun `filtering preserves project and node order and the status and live data used for bucket order`() {
        val a = project("a", node("sleep", title = "same"), node("running", title = "same"), node("excluded", title = "other"))
        val b = project("b", node("needs", title = "same"), node("unknown", title = "same"))
        val s = snapshot(a, b, states = mapOf(
            "sleep" to status(hibernated = true, updatedAt = 9),
            "running" to status(state = AgentState.WORKING, updatedAt = 2),
            "needs" to status(state = AgentState.WAITING, updatedAt = 7)
        ))
        assertEquals(listOf("a", "b"), SessionSearch.projects(s, "same").map { it.id })
        assertEquals(listOf("sleep", "running", "needs", "unknown"), ids(s, "same"))
        assertEquals(SessionBucket.SLEEPING, s.statusOf("sleep")?.bucket)
        assertEquals(SessionBucket.RUNNING, s.statusOf("running")?.bucket)
        assertEquals(SessionBucket.NEEDS_YOU, s.statusOf("needs")?.bucket)
        assertTrue(s.isLive("running"))
        assertSame(a.nodes[0], SessionSearch.projects(s, "same")[0].sessions[0])
    }

    @Test
    fun `a relisting uses current titles and removals instead of holding stale search results`() {
        val n = node("n", title = "Original")
        val first = snapshot(project("p", n))
        assertEquals(listOf("n"), ids(first, "Original"))
        val renamed = snapshot(project("p", n), states = mapOf("n" to status(name = "Renamed")))
        assertTrue(ids(renamed, "Original").isEmpty())
        assertEquals(listOf("n"), ids(renamed, "Renamed"))
        assertTrue(ids(snapshot(), "Renamed").isEmpty())
    }

    @Test
    fun `search misses are distinct from loading and a completed truly empty listing`() {
        val s = snapshot(project("p", node("one")))
        assertTrue(SessionSearch.projects(s, "missing").isEmpty())
        assertEquals(SessionSearch.EmptyState.NO_MATCHES, SessionSearch.emptyState(s, "missing"))
        assertEquals(SessionSearch.EmptyState.LOADING, SessionSearch.emptyState(ProjectsSnapshot.EMPTY, "missing"))
        assertEquals(SessionSearch.EmptyState.EMPTY, SessionSearch.emptyState(snapshot(), "missing"))
        val closed = snapshot(project("p", node("one"), closed = true))
        assertEquals(SessionSearch.EmptyState.EMPTY, SessionSearch.emptyState(closed, "one"))
        assertEquals(SessionSearch.EmptyState.LOADING, SessionSearch.emptyState(ProjectsSnapshot.EMPTY, "  "))
    }

    @Test
    fun `the native query is saved within existing host and tab entry holders and clearing updates it`() {
        val ui = AppSourcePins.ui("SessionsTab.kt")
        assertTrue(ui.contains("var query by rememberSaveable(hostId) { mutableStateOf(\"\") }"))
        AppSourcePins.assertInOrder(ui, "value = query", "onValueChange = { query = it }", "label = { Text(\"Search sessions\") }")
        assertTrue(ui.contains("TextButton(onClick = { query = \"\" }) { Text(\"Clear search\") }"), "clear must be a labelled native action")
        assertTrue(ui.contains("val projects = SessionSearch.projects(snapshot, query)"), "draw the current filtered snapshot")
        assertTrue(AppSourcePins.ui("HostScreen.kt").contains("tabStates.SaveableStateProvider(tab)"))
        assertTrue(AppSourcePins.app("MainActivity.kt").contains("saved.SaveableStateProvider(top.key)"))
    }

    @Test
    fun `native search keeps project status grouping notes and separate empty labels`() {
        val ui = AppSourcePins.blockAfter(AppSourcePins.ui("SessionsTab.kt"), "fun SessionsTab(")
        assertTrue(ui.contains("when (SessionSearch.emptyState(snapshot, query))"))
        for (label in listOf("Loading sessions…", "No sessions on this computer yet.", "No sessions match your search.")) assertTrue(ui.contains(label))
        assertTrue(ui.contains("newSessionNote?.let { NewSessionNote(it) }"), "unavailable New-session reason survives an empty search")
        assertTrue(ui.contains("if (newSessionNote != null) item(key = \"new-session-note\")"))
        AppSourcePins.assertInOrder(ui, "for (project in projects)", "project.sessions.groupBy", "for (bucket in BUCKET_ORDER)", "sortedByDescending", "items(rows")
        assertFalse(ui.contains("if (projects.isEmpty()) return"))
        assertTrue(AppSourcePins.ui("SessionsTab.kt").contains("SessionSearch.title(node, snapshot)"), "search and the displayed title share the same fallback")
        assertTrue(AppSourcePins.ui("SessionsTab.kt").contains("add(SessionSearch.agentLabel(node, snapshot))"), "search and the displayed agent detail agree")
    }
}
