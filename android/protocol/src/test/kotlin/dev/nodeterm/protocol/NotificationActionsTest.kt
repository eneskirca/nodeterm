package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.InboxNotificationActions
import dev.nodeterm.protocol.host.InboxNotificationActions.Action
import dev.nodeterm.protocol.host.InboxNotificationActions.Outcome
import dev.nodeterm.protocol.host.InboxNotificationActions.Request
import dev.nodeterm.protocol.host.InboxNotificationActions.Verb
import dev.nodeterm.protocol.host.LabelEditResult
import dev.nodeterm.protocol.host.NeedsRelayException
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
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A25 (the in-app part): an Inbox notification carries the answers the Inbox card offers, and
 * its tap opens the session.
 *
 * Before, a notification had no actions at all and its tap opened only the computer's Inbox. Now an
 * approval gets Approve / Deny and a single-select question its options (three at most, Android's
 * limit), sent through [QuickActions] with its re-checks, and only over a leg that makes no first
 * relay handshake (nobody is at the app to compare the desktop's approval code, audit A05). The
 * decision is the pure [InboxNotificationActions], tested here against [QuickActions] itself, so the
 * notification cannot offer what the answer path refuses. The app's part (the PendingIntents, the
 * receiver, the expedited worker, the tap's route) cannot run on a JVM and is pinned in its source;
 * whether the actions show, and work, on a phone is a device check.
 */
class NotificationActionsTest {
    private val node = "term-1"

    private fun ev(
        kind: InboxKind = InboxKind.APPROVAL,
        pendingId: String? = "term-1-1700000000000-42",
        agentId: String? = "claude",
        options: List<String> = emptyList(),
        multiSelect: Boolean = false,
        resolved: Boolean = false,
        id: String = "e1"
    ) = InboxEvent(
        id = id, ts = 1_700_000_000_000, nodeId = node, agentId = agentId, sessionId = "s", kind = kind,
        title = "Run rm -rf build", detail = "secret detail", interrupted = false, resolved = resolved,
        options = options, multiSelect = multiSelect, pendingId = pendingId
    )

    private fun question(vararg options: String, multiSelect: Boolean = false) =
        ev(kind = InboxKind.QUESTION, pendingId = null, options = options.toList(), multiSelect = multiSelect)

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

    /**
     * A connection whose answers are [answer] / [keys] (default: accept and record). [ssh] makes it
     * the direct-SSH transport, which sends an SSH-project node to the relay (audit A09).
     */
    private class FakeConn(
        private val snap: ProjectsSnapshot,
        override val kind: TransportKind = TransportKind.RELAY,
        private val answer: suspend (InboxEvent, Boolean) -> ApprovalOutcome = { _, _ -> ApprovalOutcome.SENT },
        private val keys: suspend (String) -> Unit = {}
    ) : HostConnection {
        val answered = mutableListOf<Pair<String?, Boolean>>()
        val typed = mutableListOf<String>()

        override val capabilities = HostCapabilities(
            boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true
        )

        override suspend fun listProjects(): ProjectsSnapshot = snap
        override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome =
            answer(event, allow).also { answered += event.pendingId to allow }
        override suspend fun sendKeys(nodeId: String, keys: String) {
            keys(keys)
            typed += keys
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

    private fun plan(event: InboxEvent, showDetails: Boolean = false, quiet: Boolean = true) =
        InboxNotificationActions.plan(event, showDetails, quiet)

    private fun verbs(actions: List<Action>) = actions.map { it.verb }

    // --- Which actions an event gets --------------------------------------------------------------

    @Test
    fun `a held approval and a claude prompt get Approve and Deny`() {
        assertEquals(listOf(Verb.APPROVE, Verb.DENY), verbs(plan(ev())))
        // A held ticket is answered deterministically whatever the agent (QuickActions' ticket path).
        assertEquals(listOf(Verb.APPROVE, Verb.DENY), verbs(plan(ev(agentId = "codex"))))
        assertEquals(listOf(Verb.APPROVE, Verb.DENY), verbs(plan(ev(pendingId = null))))
        assertEquals(listOf("Approve", "Deny"), plan(ev()).map { it.label })
    }

    @Test
    fun `an approval the answer path sends to the session gets Open, not Approve`() {
        // No ticket and not claude: only claude's prompt layout is known, so QuickActions opens the
        // session. Offering Approve would only end in "answer it in the session".
        for (agent in listOf("codex", "gemini", null)) {
            assertEquals(listOf(Verb.OPEN), verbs(plan(ev(pendingId = null, agentId = agent))), "agent $agent")
        }
    }

    @Test
    fun `a single-select question gets one action per option, numbered as the picker numbers them`() {
        val actions = plan(question("Yes", "No", "Ask me later"))
        assertEquals(listOf(Verb.OPTION, Verb.OPTION, Verb.OPTION), verbs(actions))
        assertEquals(listOf(0, 1, 2), actions.map { it.option })
        assertEquals(listOf("Option 1", "Option 2", "Option 3"), actions.map { it.label })
        assertEquals(listOf("Option 1"), plan(question("Only")).map { it.label })
    }

    @Test
    fun `a question with more options than Android shows offers Open, never its first three`() {
        // A tap would answer a picker whose fourth option the user never saw.
        assertEquals(listOf(Verb.OPEN), verbs(plan(question("a", "b", "c", "d"))))
        assertEquals(listOf(Verb.OPEN), verbs(plan(question("a", "b", "c", "d", "e", "f", "g", "h", "i"))))
    }

    @Test
    fun `a multi-select question, or one without options, offers Open`() {
        // The multi-select picker's keys are unmeasured (audit A57): the card shows it read-only too.
        assertEquals(listOf(Verb.OPEN), verbs(plan(question("a", "b", multiSelect = true))))
        assertEquals(listOf(Verb.OPEN), verbs(plan(question())))
    }

    @Test
    fun `a finished turn and a settled card get no actions`() {
        assertEquals(emptyList(), plan(ev(kind = InboxKind.DONE, pendingId = null)))
        assertEquals(emptyList(), plan(ev(resolved = true)))
        assertEquals(emptyList(), plan(question("a", "b").copy(resolved = true)))
    }

    @Test
    fun `a computer reachable only through a first relay handshake offers Open`() {
        // The desktop would show an approval code that nobody at the phone sees (audit A05).
        assertEquals(listOf(Verb.OPEN), verbs(plan(ev(), quiet = false)))
        assertEquals(listOf(Verb.OPEN), verbs(plan(question("a", "b"), quiet = false)))
        assertEquals(emptyList(), plan(ev(kind = InboxKind.DONE, pendingId = null), quiet = false))
    }

    @Test
    fun `quiet reach is the SSH leg or a relay that already approved this phone`() {
        for (ssh in listOf(false, true)) for (relay in listOf(false, true)) for (approved in listOf(false, true)) {
            assertEquals(
                ssh || (relay && approved),
                InboxNotificationActions.reachableQuietly(ssh, relay, approved),
                "ssh=$ssh relay=$relay approved=$approved"
            )
        }
    }

    @Test
    fun `no plan has more than three actions, and the actions of one notification are told apart`() {
        val events = listOf(
            ev(), ev(pendingId = null), ev(pendingId = null, agentId = "codex"),
            question(), question("a"), question("a", "b"), question("a", "b", "c"), question("a", "b", "c", "d"),
            question("a", "b", multiSelect = true), ev(kind = InboxKind.DONE, pendingId = null)
        )
        for (e in events) for (details in listOf(false, true)) for (quiet in listOf(false, true)) {
            val actions = plan(e, details, quiet)
            assertTrue(actions.size <= InboxNotificationActions.MAX_ACTIONS, "${actions.size} actions for $e")
            assertEquals(actions.size, actions.map { it.key }.toSet().size, "two actions share a PendingIntent: $actions")
        }
    }

    @Test
    fun `with details off no label carries the option's text, and with details on it is cut`() {
        val secret = "Deploy to production with the key in /root/.ssh"
        val off = plan(question(secret, "No"), showDetails = false)
        assertTrue(off.none { "Deploy" in it.label || "No" == it.label }, "a label leaks the option: $off")
        val on = plan(question(secret, "No"), showDetails = true)
        assertEquals("2. No", on[1].label)
        assertTrue(on[0].label.startsWith("1. Deploy to production"), on[0].label)
        assertTrue(on[0].label.length <= InboxNotificationActions.MAX_LABEL_CHARS && on[0].label.endsWith("…"), on[0].label)
        // Approve and Deny say nothing about the request, either way.
        assertEquals(plan(ev(), showDetails = false), plan(ev(), showDetails = true))
    }

    @Test
    fun `every answer a notification offers is one QuickActions sends`() = runBlocking<Unit> {
        // The plan follows the answer path's own rules: what it offers on a node that still asks is
        // SENT, never "open the session".
        val cases = listOf(
            ev() to AgentState.WAITING, // a concurrent ticket on a node waiting on a question (A38)
            ev(pendingId = null) to AgentState.BLOCKED,
            question("a", "b", "c") to AgentState.WAITING
        )
        for ((event, state) in cases) {
            for (action in plan(event)) {
                val outcome = InboxNotificationActions.perform(
                    action, event,
                    connect = { FakeConn(snapshot(state, event)) },
                    viaRelay = { error("no relay needed") }
                )
                assertTrue(
                    outcome in setOf(Outcome.APPROVED, Outcome.DENIED, Outcome.ANSWERED),
                    "${action.verb} on $event ended $outcome"
                )
            }
        }
    }

    // --- What the notification says afterwards ------------------------------------------------------

    @Test
    fun `each result of the answer path is what the notification reports`() {
        val approve = Action(Verb.APPROVE, "Approve")
        val deny = Action(Verb.DENY, "Deny")
        val option = Action(Verb.OPTION, "Option 2", option = 1)
        assertEquals(Outcome.APPROVED, InboxNotificationActions.outcomeOf(approve, QuickActions.Result.SENT))
        assertEquals(Outcome.DENIED, InboxNotificationActions.outcomeOf(deny, QuickActions.Result.SENT))
        assertEquals(Outcome.ANSWERED, InboxNotificationActions.outcomeOf(option, QuickActions.Result.SENT))
        for (a in listOf(approve, deny, option)) {
            assertEquals(Outcome.ALREADY_HANDLED, InboxNotificationActions.outcomeOf(a, QuickActions.Result.ALREADY_HANDLED))
            assertEquals(Outcome.EXPIRED, InboxNotificationActions.outcomeOf(a, QuickActions.Result.EXPIRED))
            assertEquals(Outcome.OPEN_SESSION, InboxNotificationActions.outcomeOf(a, QuickActions.Result.OPEN_SESSION))
        }
    }

    @Test
    fun `an outcome that leaves something to do stays and says Tap, and a done one goes away`() {
        val option = Action(Verb.OPTION, "Option 2", option = 1)
        val done = setOf(Outcome.APPROVED, Outcome.DENIED, Outcome.ANSWERED, Outcome.ALREADY_HANDLED)
        for (outcome in Outcome.entries) {
            val s = InboxNotificationActions.settled(outcome, option, "studio-mac")
            if (outcome in done) {
                assertEquals(InboxNotificationActions.SETTLED_SHOWN_MS, s.dismissAfterMs, "$outcome")
            } else {
                assertNull(s.dismissAfterMs, "$outcome would vanish before the user acts on it")
                if (outcome != Outcome.NOT_PAIRED) assertTrue("Tap" in s.text, "$outcome: ${s.text}")
            }
        }
        assertEquals("Answered with option 2.", InboxNotificationActions.settled(Outcome.ANSWERED, option, "x").text)
        assertEquals("Already handled.", InboxNotificationActions.settled(Outcome.ALREADY_HANDLED, option, "x").text)
        assertTrue("studio-mac" in InboxNotificationActions.settled(Outcome.UNREACHABLE, option, "studio-mac").text)
        // Only an unconfirmed answer is said to MAYBE have arrived; the others say nothing was sent.
        assertTrue(InboxNotificationActions.settled(Outcome.UNCONFIRMED, option, "x").text.startsWith("Couldn't confirm"))
        for (o in listOf(Outcome.NOT_APPROVED, Outcome.UNREACHABLE, Outcome.LOCKED, Outcome.NOT_PAIRED)) {
            assertTrue(InboxNotificationActions.settled(o, option, "x").text.startsWith("Not sent"), "$o")
        }
    }

    // --- Running an answer --------------------------------------------------------------------------

    @Test
    fun `Approve and Deny answer the held ticket over the computer's connection`() = runBlocking<Unit> {
        val event = ev()
        for ((action, allow) in listOf(Action(Verb.APPROVE, "Approve") to true, Action(Verb.DENY, "Deny") to false)) {
            val conn = FakeConn(snapshot(AgentState.BLOCKED, event))
            val outcome = InboxNotificationActions.perform(action, event, connect = { conn }, viaRelay = { error("unused") })
            assertEquals(if (allow) Outcome.APPROVED else Outcome.DENIED, outcome)
            assertEquals(listOf<Pair<String?, Boolean>>(event.pendingId to allow), conn.answered)
            assertEquals(emptyList(), conn.typed)
        }
    }

    @Test
    fun `an option types its digit, and only on a node still waiting on the question`() = runBlocking<Unit> {
        val event = question("a", "b", "c")
        val action = plan(event)[2]
        val waiting = FakeConn(snapshot(AgentState.WAITING, event))
        assertEquals(Outcome.ANSWERED, InboxNotificationActions.perform(action, event, { waiting }, { error("unused") }))
        assertEquals(listOf("3"), waiting.typed)
        // A permission prompt is on screen now: the digit would answer it. QuickActions' rule holds.
        val blocked = FakeConn(snapshot(AgentState.BLOCKED, event))
        assertEquals(Outcome.ALREADY_HANDLED, InboxNotificationActions.perform(action, event, { blocked }, { error("unused") }))
        assertEquals(emptyList(), blocked.typed)
    }

    @Test
    fun `a settled card is not answered from a notification left in the shade`() = runBlocking<Unit> {
        val event = ev()
        val conn = FakeConn(snapshot(AgentState.WAITING, event.copy(resolved = true)))
        assertEquals(Outcome.ALREADY_HANDLED, InboxNotificationActions.perform(plan(event)[0], event, { conn }, { error("unused") }))
        assertEquals(emptyList(), conn.answered)
    }

    @Test
    fun `a notification whose card the desktop's feed dropped types nothing into the prompt on screen now`() = runBlocking<Unit> {
        // The review of A25. A notification stays in the shade with its actions for hours; the desktop
        // drops an event after 6 h and trims its feed to 50 events, keeping each node's newest
        // unresolved ask only. So: e1 answered on the desktop, then dropped; the node blocks on a newer
        // prompt e2. The old Approve (its details naming e1's command) must not type `1` into e2.
        val old = ev(pendingId = null)
        val newer = ev(pendingId = null, id = "e2")
        val blocked = FakeConn(snapshot(AgentState.BLOCKED, newer))
        for (action in plan(old)) {
            assertEquals(Outcome.OPEN_SESSION, InboxNotificationActions.perform(action, old, { blocked }, { error("unused") }), "${action.verb}")
        }
        assertEquals(emptyList(), blocked.typed)
        // The same for a question's digit into another picker.
        val q = question("a", "b")
        val waiting = FakeConn(snapshot(AgentState.WAITING, question("c", "d").copy(id = "e2")))
        for (action in plan(q)) {
            assertEquals(Outcome.OPEN_SESSION, InboxNotificationActions.perform(action, q, { waiting }, { error("unused") }), "${action.label}")
        }
        assertEquals(emptyList(), waiting.typed)
    }

    @Test
    fun `a computer that cannot be reached is reported, and nothing is sent`() = runBlocking<Unit> {
        val event = ev()
        var relayDialed = false
        val outcome = InboxNotificationActions.perform(
            plan(event)[0], event,
            connect = { throw HostException("Through the relay: not approved") },
            viaRelay = { relayDialed = true; error("unused") }
        )
        assertEquals(Outcome.UNREACHABLE, outcome)
        assertFalse(relayDialed)
    }

    @Test
    fun `a dial that hangs is given up within its budget`() = runBlocking<Unit> {
        val event = ev()
        val started = System.nanoTime()
        val outcome = InboxNotificationActions.perform(
            plan(event)[0], event,
            connect = { awaitCancellation() },
            viaRelay = { error("unused") },
            connectBudgetMs = 100
        )
        assertEquals(Outcome.UNREACHABLE, outcome)
        assertTrue(System.nanoTime() - started < 5_000_000_000L)
    }

    @Test
    fun `a node the SSH transport sends to the relay is answered through the relay`() = runBlocking<Unit> {
        // An SSH-project node over direct SSH (audit A09): the SSH transport refuses before sending.
        val event = ev(pendingId = null)
        val refuse: suspend (String) -> Unit = { throw NeedsRelayException(node, "runs on another host") }
        val ssh = FakeConn(snapshot(AgentState.BLOCKED, event), kind = TransportKind.SSH, keys = refuse)
        val relay = FakeConn(snapshot(AgentState.BLOCKED, event))
        val outcome = InboxNotificationActions.perform(plan(event)[0], event, connect = { ssh }, viaRelay = { relay })
        assertEquals(Outcome.APPROVED, outcome)
        assertEquals(emptyList(), ssh.typed)
        assertEquals(listOf("1"), relay.typed)
    }

    @Test
    fun `when the relay cannot be reached for such a node, nothing is sent`() = runBlocking<Unit> {
        val event = ev(pendingId = null)
        val ssh = FakeConn(
            snapshot(AgentState.BLOCKED, event), kind = TransportKind.SSH,
            keys = { throw NeedsRelayException(node, "runs on another host") }
        )
        val outcome = InboxNotificationActions.perform(
            plan(event)[0], event,
            connect = { ssh },
            viaRelay = { throw HostException("Not checked in the background: not approved") }
        )
        assertEquals(Outcome.UNREACHABLE, outcome)
    }

    @Test
    fun `an answer that fails once connected is unconfirmed, and is not sent again`() = runBlocking<Unit> {
        val event = ev()
        var tries = 0
        val conn = FakeConn(snapshot(AgentState.BLOCKED, event), answer = { _, _ -> tries++; throw HostException("socket closed") })
        val outcome = InboxNotificationActions.perform(plan(event)[0], event, { conn }, { error("unused") })
        assertEquals(Outcome.UNCONFIRMED, outcome)
        assertEquals(1, tries)
    }

    @Test
    fun `an answer that hangs is unconfirmed within its budget`() = runBlocking<Unit> {
        val event = ev()
        val conn = FakeConn(snapshot(AgentState.BLOCKED, event), answer = { _, _ -> awaitCancellation() })
        val outcome = InboxNotificationActions.perform(plan(event)[0], event, { conn }, { error("unused") }, answerBudgetMs = 100)
        assertEquals(Outcome.UNCONFIRMED, outcome)
    }

    @Test
    fun `Open answers nothing and connects to nothing`() = runBlocking<Unit> {
        val event = ev()
        val outcome = InboxNotificationActions.perform(
            Action(Verb.OPEN, InboxNotificationActions.OPEN_LABEL), event,
            connect = { error("Open dialed the computer") },
            viaRelay = { error("Open dialed the relay") }
        )
        assertEquals(Outcome.OPEN_SESSION, outcome)
    }

    // --- The work's whole run ----------------------------------------------------------------------

    /**
     * The computer as [InboxNotificationActions.answerOnce] reaches it: [conn] for every dial, which
     * must happen while the connection is held.
     */
    private class FakeRoute(
        private val conn: HostConnection,
        override val connected: Boolean = false,
        private val quiet: Boolean = true
    ) : InboxNotificationActions.QuietRoute {
        var holds = 0
        var holding = false
        var dials = 0
        var dialedOutsideHold = false

        override fun reachableQuietly(): Boolean = quiet
        override suspend fun hold(block: suspend () -> Outcome): Outcome {
            holds++
            holding = true
            try {
                return block()
            } finally {
                holding = false
            }
        }
        override suspend fun connect(): HostConnection = dial()
        override suspend fun viaRelay(): HostConnection = dial()
        private fun dial(): HostConnection {
            if (!holding) dialedOutsideHold = true
            dials++
            return conn
        }
    }

    @Test
    fun `the first run answers while it holds the shared connection`() = runBlocking<Unit> {
        val event = ev()
        val conn = FakeConn(snapshot(AgentState.BLOCKED, event))
        val route = FakeRoute(conn)
        assertEquals(Outcome.APPROVED, InboxNotificationActions.answerOnce(plan(event)[0], event, runAttempt = 0, route = route))
        assertEquals(listOf<Pair<String?, Boolean>>(event.pendingId to true), conn.answered)
        assertEquals(1, route.holds)
        assertEquals(1, route.dials)
        assertFalse(route.dialedOutsideHold, "dialed on a connection another job may close")
    }

    @Test
    fun `a run WorkManager starts again sends nothing and says the answer is unconfirmed`() = runBlocking<Unit> {
        // The review of A25: WorkManager runs again work that was interrupted rather than finished (a
        // system stop, or the process dying mid-run, re-enqueued at the next start). The first run may
        // have sent the answer; a second `1` would land in whatever the pane shows by then.
        val event = ev(pendingId = null)
        for (attempt in listOf(1, 2, 5)) {
            val conn = FakeConn(snapshot(AgentState.BLOCKED, event))
            val route = FakeRoute(conn)
            assertEquals(Outcome.UNCONFIRMED, InboxNotificationActions.answerOnce(plan(event)[0], event, attempt, route))
            assertEquals(0, route.holds, "attempt $attempt touched the connection")
            assertEquals(0, route.dials, "attempt $attempt dialed")
            assertEquals(emptyList(), conn.typed)
            // Even for a computer forgotten since: the first run may have answered it.
            assertEquals(Outcome.UNCONFIRMED, InboxNotificationActions.answerOnce(plan(event)[0], event, attempt, route = null))
        }
    }

    @Test
    fun `a forgotten computer, or one without quiet reach, is not dialed`() = runBlocking<Unit> {
        val event = ev()
        assertEquals(Outcome.NOT_PAIRED, InboxNotificationActions.answerOnce(plan(event)[0], event, 0, route = null))
        val conn = FakeConn(snapshot(AgentState.BLOCKED, event))
        val unapproved = FakeRoute(conn, quiet = false)
        assertEquals(Outcome.NOT_APPROVED, InboxNotificationActions.answerOnce(plan(event)[0], event, 0, unapproved))
        assertEquals(0, unapproved.dials)
        assertEquals(emptyList(), conn.answered)
        // A connection already open makes no handshake: it is reused.
        val open = FakeRoute(conn, connected = true, quiet = false)
        assertEquals(Outcome.APPROVED, InboxNotificationActions.answerOnce(plan(event)[0], event, 0, open))
        assertFalse(open.dialedOutsideHold)
    }

    // --- The tap's hand-off -------------------------------------------------------------------------

    private fun request(event: InboxEvent = question("Yes", "No"), action: Action = plan(event, showDetails = true)[1]) = Request(
        hostId = "host-1", computerName = "studio-mac",
        notificationId = InboxNotificationActions.notificationId("host-1", event.id),
        headline = "Needs you — build-bot", sessionTitle = "build-bot", action = action, event = event
    )

    @Test
    fun `a request survives the trip through the Intent and the work input`() {
        for (r in listOf(request(), request(ev(), plan(ev())[1]), request(ev(pendingId = null, agentId = null), Action(Verb.APPROVE, "Approve")))) {
            val back = Request.decode(r.encode())
            // Everything QuickActions reads, the notification's words, and the action itself.
            assertEquals(r.copy(event = r.event.copy(title = "", detail = null)), back)
        }
        assertEquals("nodeterm.inbox.answer.host-1.e1", request().workName)
        assertEquals("host-1:e1".hashCode(), request().notificationId)
    }

    @Test
    fun `the request carries no title or detail of the event`() {
        // Nothing after the tap needs them, and the extras outlive the notification (audit A52).
        val raw = request(ev()).encode()
        assertFalse("rm -rf" in raw, raw)
        assertFalse("secret detail" in raw, raw)
    }

    @Test
    fun `anything but an encoded request decodes to null`() {
        val good = request().encode()
        assertTrue(Request.decode(good) != null)
        for (bad in listOf(
            null, "", "{", "[]", "{}",
            good.replace("\"v\":1", "\"v\":2"),
            good.replace("\"verb\":\"option\"", "\"verb\":\"always\""),
            good.replace("\"option\":1", "\"option\":9"),
            good.replace("\"kind\":\"question\"", "\"kind\":\"other\""),
            good.replace("\"hostId\":\"host-1\"", "\"hostId\":\"\""),
            good.replace("\"nodeId\":\"term-1\"", "\"nodeId\":7")
        )) {
            assertNull(Request.decode(bad), "decoded: $bad")
        }
    }

    // --- The app's wiring, pinned in its source ----------------------------------------------------

    private val notifier get() = AppSourcePins.app("notify/InboxNotifier.kt")
    private val actions get() = AppSourcePins.app("notify/InboxActions.kt")

    /** An expression-bodied function of [source], from [start] to the blank line after it. */
    private fun expressionAfter(source: String, start: String): String {
        val at = source.indexOf(start)
        assertTrue(at >= 0, "not found: $start")
        val end = source.indexOf("\n\n", at)
        return if (end < 0) source.substring(at) else source.substring(at, end)
    }

    @Test
    fun `the notification carries the planned actions, each answer behind an unlock`() {
        val build = AppSourcePins.blockAfter(notifier, "private fun build(")
        AppSourcePins.assertInOrder(
            build,
            "for (action in InboxNotificationActions.plan(ev, showDetails, quiet))",
            "if (action.answers) answerIntent(context,",
            "else open",
            "builder.addAction(",
            ".setAuthenticationRequired(action.answers)"
        )
        assertFalse(build.contains("connections.session("), "Notification publication must not take ConnectionManager's monitor")
        assertTrue(notifier.contains("showDetails: Boolean,\n        quiet: Boolean"))
        // The id the receiver and the worker update is the one the notification was posted under.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(notifier, "fun announce("),
            "nm.notify(InboxNotificationActions.notificationId(host.id, ev.id), build(context, host, snapshot, ev, showDetails, quiet))"
        )
        val session = AppSourcePins.blockAfter(AppSourcePins.app("conn/ConnectionManager.kt"), "fun reachableQuietly()")
        AppSourcePins.assertInOrder(
            session,
            "InboxNotificationActions.reachableQuietly(",
            "sshLeg = host.sshAvailable && graph.hosts.route(hostId) != RoutePreference.RELAY_ONLY",
            "relayLeg = relayLeg() == LegRouting.RelayLeg.AVAILABLE",
            "relayApproved = graph.hosts.relayApproved(hostId)"
        )
    }

    @Test
    fun `every PendingIntent is immutable and explicit, and the tap names the session`() {
        val open = expressionAfter(notifier, "private fun openSession(")
        AppSourcePins.assertInOrder(
            open,
            "PendingIntent.getActivity(",
            // One per notification: the extras differ, and FLAG_UPDATE_CURRENT on a shared request code
            // hands every notification of a computer the last one's session.
            "notificationId,",
            "Intent(context, MainActivity::class.java)",
            ".putExtra(MainActivity.EXTRA_HOST_ID, hostId)",
            ".putExtra(MainActivity.EXTRA_NODE_ID, nodeId)",
            ".putExtra(MainActivity.EXTRA_NODE_TITLE, title)",
            "PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE"
        )
        val answer = expressionAfter(notifier, "private fun answerIntent(")
        AppSourcePins.assertInOrder(
            answer,
            "PendingIntent.getBroadcast(",
            "Intent(context, InboxActionReceiver::class.java)",
            ".setData(",
            "request.action.key",
            ".putExtra(EXTRA_REQUEST, request.encode())",
            "PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE"
        )
        for (src in listOf(notifier, actions)) {
            assertFalse("FLAG_MUTABLE" in src, "a mutable PendingIntent lets another app rewrite the answer")
        }
        val manifest = File(InteropHarness.repoRoot, "android/app/src/main/AndroidManifest.xml").readText()
        assertTrue(
            Regex("""<receiver\s+android:name="\.notify\.InboxActionReceiver"\s+android:exported="false"\s*/>""").containsMatchIn(manifest),
            "the answer receiver must be declared and not exported"
        )
    }

    @Test
    fun `a tap hands the answer to expedited work, once, after the lock check`() {
        val receive = AppSourcePins.blockAfter(actions, "override fun onReceive(")
        AppSourcePins.assertInOrder(
            receive,
            "Request.decode(intent.getStringExtra(InboxNotifier.EXTRA_REQUEST))",
            "if (!request.action.answers) return",
            "if (Build.VERSION.SDK_INT < 31",
            "isDeviceLocked",
            "InboxNotifier.settle(context, request, Outcome.LOCKED)",
            "return",
            "InboxNotifier.sending(context, request)",
            ".setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)",
            "enqueueUniqueWork(request.workName, ExistingWorkPolicy.KEEP, work)"
        )
    }

    @Test
    fun `an answer from a notification never makes a first relay handshake, and is never retried`() {
        // The run is answerOnce's (tested above against fakes): its run attempt count, so a run
        // WorkManager starts again sends nothing, and the computer as the background dials reach it.
        val doWork = AppSourcePins.blockAfter(actions, "override suspend fun doWork()")
        AppSourcePins.assertInOrder(
            doWork,
            "InboxNotificationActions.answerOnce(request.action, request.event, runAttemptCount, session?.let(::quietRoute))",
            "InboxNotifier.settle(applicationContext, request, outcome)",
            "return Result.success()"
        )
        assertFalse("retry" in doWork, "an unconfirmed answer must not be sent again")
        val route = AppSourcePins.blockAfter(actions, "private fun quietRoute(session: HostSession)")
        AppSourcePins.assertInOrder(
            route,
            "override val connected: Boolean get() = session.connection != null",
            "override fun reachableQuietly(): Boolean = session.reachableQuietly()",
            "override suspend fun hold(block: suspend () -> Outcome): Outcome = session.inBackground(block)",
            "override suspend fun connect(): HostConnection = session.ensureConnected(RelayApprovalGate.Trigger.BACKGROUND)",
            "override suspend fun viaRelay(): HostConnection = session.viaRelay(RelayApprovalGate.Trigger.BACKGROUND)"
        )
        // Every dial in the file is the background one; USER would release a hold and show a code.
        assertFalse(Regex("""Trigger\.(USER|AUTO)""").containsMatchIn(actions), "a notification action dials as the user at the app")
        assertFalse(Regex("""\.(ensureConnected|viaRelay)\(\s*\)""").containsMatchIn(actions), "a dial with the default trigger")
    }

    @Test
    fun `the background jobs share a computer's connection, and only the last one closes it`() {
        // The review of A25: each job closed the shared connection whenever no screen watched, under
        // another job still answering on it. The counting is ConnectionUsers' (ConnectionUsersTest).
        val session = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(
            session.contains("suspend fun <T> inBackground(block: suspend () -> T): T = users.hold({ disconnect() }, block)"),
            "HostSession.inBackground is not ConnectionUsers.hold"
        )
        assertTrue(session.contains("scope, users, { disconnect() },"), "polling and background jobs must share ConnectionUsers")
        assertTrue(AppSourcePins.blockAfter(session, "fun startWatching(").contains("foreground.start(initialTrigger)"))
        assertTrue(AppSourcePins.blockAfter(session, "fun stopWatching(").contains("foreground.stop(closeWhenUnused)"))
        val check = AppSourcePins.blockAfter(notifier, "override suspend fun doWork()")
        AppSourcePins.assertInOrder(check, "session.inBackground {", "session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND)")
        for ((name, src) in listOf("the answer" to actions, "the background check" to check)) {
            assertFalse(".disconnect()" in src, "$name closes the shared connection itself")
        }
    }

    @Test
    fun `a notification tap opens that session's terminal, at launch and while the app runs`() {
        val main = AppSourcePins.app("MainActivity.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(main, "private fun Navigator.openTap(tap: NotificationTap)"),
            "push(Route.Host(tap.hostId, tab = 2))",
            "push(Route.Terminal(tap.hostId, node,"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(main, "override fun onNewIntent(intent: Intent)"),
            "setIntent(intent)",
            "tapOf(intent)?.let { incomingTap = it }"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(main, "override fun onCreate("),
            "val launchTap = if (fresh) tapOf(intent) else null",
            "if (launchTap != null && graph.hosts.get(launchTap.hostId) != null) n.openTap(launchTap)",
            "LaunchedEffect(tap) {",
            "nav.replaceAll(Route.Hosts)",
            "nav.openTap(tap)"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(main, "private fun tapOf(intent: Intent?)"),
            "getStringExtra(EXTRA_HOST_ID)",
            "getStringExtra(EXTRA_NODE_ID)",
            "getStringExtra(EXTRA_NODE_TITLE)"
        )
    }
}
