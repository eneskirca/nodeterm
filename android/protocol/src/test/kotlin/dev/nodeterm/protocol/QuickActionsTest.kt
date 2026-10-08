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
import kotlin.test.assertEquals

/**
 * Audit A38: which node state a quick answer requires depends on HOW it answers.
 *
 * The desktop publishes a concurrent (subagent) approval with its ticket while the node keeps the
 * parent's WAITING badge for a held AskUserQuestion (`recordAgentEvent`, pinned by
 * src/core/pending-question.test.ts "keeps the parent picker while concurrent child approvals…").
 * A ticket is answered deterministically and refused host-side once its hold ends, so the card
 * decides. Keys are not: `1` typed on a node whose question picker is on screen picks option 1.
 */
class QuickActionsTest {
    private val node = "term-1"

    private fun card(
        id: String = "e1",
        kind: InboxKind = InboxKind.APPROVAL,
        pendingId: String? = "term-1-1700000000000-42",
        resolved: Boolean = false,
        options: List<String> = emptyList(),
        multiSelect: Boolean = false
    ) = InboxEvent(
        id = id, ts = 1, nodeId = node, agentId = "claude", sessionId = "s", kind = kind,
        title = "Approve Bash", detail = null, interrupted = false, resolved = resolved,
        options = options, multiSelect = multiSelect, pendingId = pendingId
    )

    private fun snapshot(state: AgentState?, vararg events: InboxEvent) = ProjectsSnapshot(
        projects = emptyList(), liveSessions = setOf("nt-$node"),
        status = AgentStatusFile(
            updatedAt = 1,
            nodes = mapOf(node to AgentNodeStatus(state, "claude", "s", null, false, 1, null)),
            settings = null, usage = null,
            inbox = MirrorInbox(events.toList(), emptyMap()),
            server = null
        ),
        fetchedAt = 1
    )

    /** Records every write; answers each `listProjects` from [snapshots] in turn (the last repeats). */
    private class FakeConn(
        vararg snapshots: ProjectsSnapshot,
        private val outcome: ApprovalOutcome = ApprovalOutcome.SENT,
        answerApprovals: Boolean = true
    ) : HostConnection {
        private val queue = ArrayDeque(snapshots.toList())
        val answered = mutableListOf<Pair<String?, Boolean>>()
        val keys = mutableListOf<String>()

        override val kind = TransportKind.RELAY
        override val capabilities = HostCapabilities(
            boardWrites = true, git = true, nodeActions = true, registerNode = true, answerApprovals = answerApprovals
        )

        override suspend fun listProjects(): ProjectsSnapshot = if (queue.size > 1) queue.removeFirst() else queue.first()
        override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome {
            answered += event.pendingId to allow
            return outcome
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

    @Test
    fun `a ticketed approval on a node still WAITING on its question is answered`() = runBlocking<Unit> {
        val approval = card()
        val question = card(id = "q1", kind = InboxKind.QUESTION, pendingId = null, options = listOf("a", "b"))
        val conn = FakeConn(snapshot(AgentState.WAITING, question, approval))
        assertEquals(QuickActions.Result.SENT, QuickActions.answerApproval(conn, approval, allow = true))
        assertEquals(listOf<Pair<String?, Boolean>>(approval.pendingId to true), conn.answered)
        assertEquals(emptyList(), conn.keys)
    }

    @Test
    fun `a ticketed approval whose hold ended while the node WAITS opens the session`() = runBlocking<Unit> {
        // A06 on the concurrent path: "gone", and the card is still unresolved, so the prompt is on
        // screen now. "Already handled" would leave the subagent waiting on nobody.
        val approval = card()
        val conn = FakeConn(snapshot(AgentState.WAITING, approval), outcome = ApprovalOutcome.GONE)
        assertEquals(QuickActions.Result.EXPIRED, QuickActions.answerApproval(conn, approval, allow = false))
        assertEquals(emptyList(), conn.keys)
    }

    @Test
    fun `a gone ticket whose card the computer settled meanwhile is already handled`() = runBlocking<Unit> {
        val approval = card()
        val conn = FakeConn(
            snapshot(AgentState.WAITING, approval),
            snapshot(AgentState.WAITING, approval.copy(resolved = true)),
            outcome = ApprovalOutcome.GONE
        )
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerApproval(conn, approval, allow = true))
    }

    @Test
    fun `a resolved ticketed approval is not answered, whatever the node shows`() = runBlocking<Unit> {
        val approval = card()
        for (state in listOf(AgentState.BLOCKED, AgentState.WAITING)) {
            val conn = FakeConn(snapshot(state, approval.copy(resolved = true)))
            assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerApproval(conn, approval, allow = true))
            assertEquals(emptyList(), conn.answered)
            assertEquals(emptyList(), conn.keys)
        }
    }

    @Test
    fun `a ticketed approval the fresh feed no longer lists needs a needs-you node`() = runBlocking<Unit> {
        // The host trims its feed; with no card to consult, the node's state is the evidence left.
        val approval = card()
        val waiting = FakeConn(snapshot(AgentState.WAITING))
        assertEquals(QuickActions.Result.SENT, QuickActions.answerApproval(waiting, approval, allow = true))
        val working = FakeConn(snapshot(AgentState.WORKING))
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerApproval(working, approval, allow = true))
        assertEquals(emptyList(), working.answered)
    }

    @Test
    fun `keys are not typed for a card the fresh feed no longer lists`() = runBlocking<Unit> {
        // The review of A25: the desktop drops events after 6 h and trims its feed to 50, keeping only
        // each node's newest unresolved ask, so a card settled long ago disappears while its node
        // blocks on a NEWER prompt in the same state. A key carries no identity of the prompt it
        // answers: `1` here would approve the newer prompt.
        val stale = card(id = "e1", pendingId = null)
        val newer = card(id = "e2", pendingId = null)
        val blocked = FakeConn(snapshot(AgentState.BLOCKED, newer))
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerApproval(blocked, stale, allow = true))
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerApproval(blocked, stale, allow = false))
        assertEquals(emptyList(), blocked.keys)
        val question = card(id = "q1", kind = InboxKind.QUESTION, pendingId = null, options = listOf("yes", "no"))
        val otherQuestion = card(id = "q2", kind = InboxKind.QUESTION, pendingId = null, options = listOf("a", "b"))
        val waiting = FakeConn(snapshot(AgentState.WAITING, otherQuestion))
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestion(waiting, question, 0))
        // No feed at all is no evidence either.
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestion(FakeConn(snapshot(AgentState.WAITING)), question, 0))
        assertEquals(emptyList(), waiting.keys)
        // The node moved on: settled, whatever the feed lists.
        val working = FakeConn(snapshot(AgentState.WORKING))
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerApproval(working, stale, allow = true))
        assertEquals(emptyList(), working.keys)
    }

    @Test
    fun `a ticketed approval this host cannot answer opens the session, never keys`() = runBlocking<Unit> {
        val approval = card()
        val conn = FakeConn(snapshot(AgentState.WAITING, approval), answerApprovals = false)
        assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerApproval(conn, approval, allow = true))
        assertEquals(emptyList(), conn.keys)
    }

    @Test
    fun `a ticketless approval is not typed into a node WAITING on a question`() = runBlocking<Unit> {
        // `1` here would pick option 1 of the question on screen, not approve anything.
        val approval = card(pendingId = null)
        val conn = FakeConn(snapshot(AgentState.WAITING, approval))
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerApproval(conn, approval, allow = true))
        assertEquals(emptyList(), conn.keys)
        assertEquals(emptyList(), conn.answered)
    }

    @Test
    fun `a ticketless approval on a BLOCKED node is typed`() = runBlocking<Unit> {
        val approval = card(pendingId = null)
        val conn = FakeConn(snapshot(AgentState.BLOCKED, approval))
        assertEquals(QuickActions.Result.SENT, QuickActions.answerApproval(conn, approval, allow = true))
        assertEquals(listOf("1"), conn.keys)
    }

    @Test
    fun `a question is not typed into a BLOCKED node`() = runBlocking<Unit> {
        // The digit would answer whatever permission prompt is on screen.
        val question = card(kind = InboxKind.QUESTION, pendingId = null, options = listOf("yes", "no"))
        val conn = FakeConn(snapshot(AgentState.BLOCKED, question))
        assertEquals(QuickActions.Result.ALREADY_HANDLED, QuickActions.answerQuestion(conn, question, 0))
        assertEquals(emptyList(), conn.keys)
    }

    @Test
    fun `a question on a WAITING node is typed`() = runBlocking<Unit> {
        val question = card(kind = InboxKind.QUESTION, pendingId = null, options = listOf("yes", "no"))
        val conn = FakeConn(snapshot(AgentState.WAITING, question))
        assertEquals(QuickActions.Result.SENT, QuickActions.answerQuestion(conn, question, 1))
        assertEquals(listOf("2"), conn.keys)
    }

    @Test
    fun `a multi-select question is never typed, even on a WAITING node`() = runBlocking<Unit> {
        // A57: its card shows the options read-only. The picker's toggle and submit keys are
        // unmeasured, so a digit could submit a one-option answer (or toggle without submitting).
        val question = card(kind = InboxKind.QUESTION, pendingId = null, options = listOf("a", "b", "c"), multiSelect = true)
        val conn = FakeConn(snapshot(AgentState.WAITING, question))
        for (i in question.options.indices) {
            assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestion(conn, question, i))
        }
        assertEquals(emptyList(), conn.keys)
    }
}
