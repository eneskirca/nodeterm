package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.LabelEditResult
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.NewSessionHint
import dev.nodeterm.protocol.host.QuickActions
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.AgentNodeStatus
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.MirrorInbox
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import dev.nodeterm.protocol.model.*
import kotlin.test.assertEquals

class HeldQuickActionsTest {
    private val node = "term-1"
    private val ticket = "term-1-1700000000000-42"
    private val questions = listOf(HookQuestion("Which?", "Choice", listOf(HookQuestionOption("A", ""), HookQuestionOption("B", "")), true))
    private fun card(kind: InboxKind = InboxKind.QUESTION) = InboxEvent(
        "e1", 1, node, "claude", "s", kind, "Which?", null, false, false,
        options = listOf("unsafe legacy choice"), multiSelect = false, pendingId = ticket.takeIf { kind == InboxKind.APPROVAL },
        permissionSuggestions = listOf(PermissionSuggestion(0, "Bash(npm test) — session")),
        questionPendingId = ticket.takeIf { kind == InboxKind.QUESTION }, questions = questions)
    private fun snapshot(vararg events: InboxEvent) = ProjectsSnapshot(emptyList(), emptySet(), AgentStatusFile(
        1, mapOf(node to AgentNodeStatus(AgentState.WAITING, "claude", "s", null, false, 1, null)), null, null, MirrorInbox(events.toList(), emptyMap()), null), 1)
    private class FakeConn(
        vararg snapshots: ProjectsSnapshot,
        private val outcome: ApprovalOutcome = ApprovalOutcome.SENT,
        answerApprovals: Boolean = true
    ) : HostConnection {
        private val queue = ArrayDeque(snapshots.toList())
        val answered = mutableListOf<Pair<String?, Boolean>>()
        val keys = mutableListOf<String>()
        val structured = mutableListOf<String>()

        override val kind = TransportKind.RELAY
        override val capabilities = HostCapabilities(
            boardWrites = true, git = true, nodeActions = true, registerNode = true, answerApprovals = answerApprovals
        )

        override suspend fun listProjects(): ProjectsSnapshot = if (queue.size > 1) queue.removeFirst() else queue.first()
        override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome {
            answered += event.pendingId to allow
            return outcome
        }
        override suspend fun rememberApproval(event: InboxEvent, suggestionIndex: Int): ApprovalOutcome {
            structured += "remember:$suggestionIndex"; return outcome
        }
        override suspend fun answerQuestions(event: InboxEvent, selections: List<List<Int>>): ApprovalOutcome {
            structured += "questions:$selections"; return outcome
        }
        override suspend fun sendKeys(nodeId: String, keys: String) {
            this.keys += keys
        }

        override suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint?): TerminalStream =
            error("unused")
        override suspend fun wake(nodeId: String) { error("unused") }
        override suspend fun refresh(nodeId: String) { error("unused") }
        override suspend fun rename(nodeId: String, title: String) { error("unused") }
        override suspend fun ensureBoard(projectId: String): List<KanbanColumn>? = error("unused")
        override suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean = error("unused")
        override suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult? = error("unused")
        override suspend fun registerNode(projectId: String, node: NewNode): Boolean = error("unused")
        override suspend fun ackRead(nodeId: String, eventId: String?) { error("unused") }
        override suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement>): JsonElement? = error("unused")
        override fun setOnChanged(listener: (() -> Unit)?) {}
        override fun setOnClosed(listener: ((String?) -> Unit)?) {}
        override fun close() {}
    }


    @Test fun `held multi-select uses one structured call and never keys even with legacy options present`() = runBlocking {
        val event = card(); val conn = FakeConn(snapshot(event))
        assertEquals(QuickActions.Result.SENT, QuickActions.answerQuestions(conn, event, listOf(listOf(0, 1))))
        assertEquals(listOf("questions:[[0, 1]]"), conn.structured); assertEquals(emptyList(), conn.keys)
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestion(conn, event, 0))
        assertEquals(emptyList(), conn.keys)
    }
    @Test fun `remember uses only advertised exact index and does not require parent blocked badge`() = runBlocking {
        val event = card(InboxKind.APPROVAL); val conn = FakeConn(snapshot(event))
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.rememberApproval(conn, event, 1))
        assertEquals(QuickActions.Result.SENT, QuickActions.rememberApproval(conn, event, 0))
        assertEquals(listOf("remember:0"), conn.structured); assertEquals(emptyList(), conn.keys)
    }
    @Test fun `disappearing ticket or changed schema does not report success or write anything`() = runBlocking {
        val event = card()
        for (fresh in listOf(snapshot(), snapshot(event.copy(questionPendingId = "new")), snapshot(event.copy(questions = emptyList())))) {
            val conn = FakeConn(fresh)
            assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestions(conn, event, listOf(listOf(0))))
            assertEquals(emptyList(), conn.structured); assertEquals(emptyList(), conn.keys)
        }
        val approval = card(InboxKind.APPROVAL)
        val changed = FakeConn(snapshot(approval.copy(permissionSuggestions = listOf(PermissionSuggestion(0, "different")))))
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.rememberApproval(changed, approval, 0))
        assertEquals(emptyList(), changed.structured)
    }
    @Test fun `expired hold opens the session while independently settled card is already handled`() = runBlocking {
        val event = card()
        val open = FakeConn(snapshot(event), outcome = ApprovalOutcome.GONE)
        assertEquals(QuickActions.Result.EXPIRED, QuickActions.answerQuestions(open, event, listOf(listOf(0))))
        val settled = FakeConn(snapshot(event), snapshot(event.copy(resolved = true)), outcome = ApprovalOutcome.GONE)
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerQuestions(settled, event, listOf(listOf(0))))
        val missingAfter = FakeConn(snapshot(event), snapshot(), outcome = ApprovalOutcome.GONE)
        assertEquals(QuickActions.Result.EXPIRED, QuickActions.answerQuestions(missingAfter, event, listOf(listOf(0))))
        assertEquals(emptyList(), missingAfter.keys)
    }
    @Test fun `older unsupported ambiguous or resolved responses never fall back to keystrokes`() = runBlocking {
        val event = card()
        for (outcome in listOf(ApprovalOutcome.UNSUPPORTED, ApprovalOutcome.ALREADY_HANDLED)) {
            val conn = FakeConn(snapshot(event), outcome = outcome)
            assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestions(conn, event, listOf(listOf(0))))
            assertEquals(emptyList(), conn.keys)
        }
        val resolved = FakeConn(snapshot(event.copy(resolved = true)))
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerQuestions(resolved, event, listOf(listOf(0))))
        assertEquals(emptyList(), resolved.structured)
    }
    @Test fun `incomplete or duplicate selections cannot reach transport`() = runBlocking {
        val event = card(); val conn = FakeConn(snapshot(event))
        for (selection in listOf(emptyList(), listOf(emptyList()), listOf(listOf(0, 0)), listOf(listOf(2))))
            assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestions(conn, event, selection))
        assertEquals(emptyList(), conn.structured); assertEquals(emptyList(), conn.keys)
    }
}
