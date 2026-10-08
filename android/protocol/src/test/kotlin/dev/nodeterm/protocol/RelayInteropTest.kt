package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.git.GitConflict
import dev.nodeterm.protocol.git.GitDiff
import dev.nodeterm.protocol.git.GitFileChange
import dev.nodeterm.protocol.git.GitResult
import dev.nodeterm.protocol.git.SourceControl
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.QuickActions
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.RelayConnector
import dev.nodeterm.protocol.host.RelayApprovalRefusedException
import dev.nodeterm.protocol.host.RelayApprovalRequiredException
import dev.nodeterm.protocol.host.RelayApprovalTimeoutException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TerminalScrollView
import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.host.ComposedInputResult
import dev.nodeterm.protocol.model.AccountNames
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.LanRefresh
import dev.nodeterm.protocol.ssh.LanReport
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshHostConnection
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin relay client against the DESKTOP's real host code: `connectHostSession` +
 * `createHostHandlers` (host-service.ts) over `connectRelay` (relay-socket.ts, host role), through a
 * local broker. Everything the phone does over the relay goes across this wire at least once. The
 * `projects.list` blob it parses is the desktop's own (`buildProjectsListBlob` over a real
 * `WorkspaceStore` and a mirror file the real agent-status mirror wrote, audit A64); the pty,
 * kanban, inbox and node-action bridges behind the verbs are fakes that record what was asked. The
 * `git.*` verbs are not: they run the desktop's real `GitService` over a repository in the project's
 * folder (audit A29).
 */
class RelayInteropTest {
    private val harnesses = ArrayList<InteropHarness>()
    private val userDataDirs = ArrayList<File>()
    private val sshServers = ArrayList<SshServer>()

    @AfterTest
    fun tearDown() {
        harnesses.forEach { it.close() }
        sshServers.forEach { it.stop(true) }
        userDataDirs.forEach { it.deleteRecursively() }
    }

    /**
     * The fixture's userData is a scratch dir per harness: relay mode writes the desktop's workspace
     * (a v3 index and the project's `.nodeterm/project.json`) and its agent-status mirror there, and
     * serves `projects.list` from them through the desktop's own assembly (audit A64).
     */
    private fun start(approveAfterMs: Long = 0, rejectAfterMs: Long = -1, extra: Map<String, String> = emptyMap()): InteropHarness {
        val userData = Files.createTempDirectory("nt-relay-ud").toFile().also { userDataDirs += it }
        return InteropHarness.start(
            "relay",
            mapOf(
                "FIXTURE_APPROVE_AFTER_MS" to approveAfterMs.toString(),
                "FIXTURE_REJECT_AFTER_MS" to rejectAfterMs.toString(),
                "FIXTURE_USERDATA" to userData.path
            ) + extra
        ).also { harnesses += it }
    }

    private fun startLaunch(trusted: Boolean): InteropHarness {
        val userData = Files.createTempDirectory("nt-launch-ud").toFile().also { userDataDirs += it }
        return InteropHarness.start("project-launch", mapOf("FIXTURE_USERDATA" to userData.path,
            "SHELL" to "/fixture/a72-default",
            "FIXTURE_LAUNCH_TRUSTED" to if (trusted) "1" else "0")).also { harnesses += it }
    }

    private fun InteropHarness.str(key: String) = ready[key]!!.jsonPrimitive.content
    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content

    private fun connect(
        h: InteropHarness,
        keys: BoxKeyPair = BoxKeyPair.generate(),
        statuses: MutableList<RelayConnectStatus>? = null,
        approvalTimeoutMs: Long = 20_000,
        requireApproved: Boolean = false
    ) =
        runBlocking {
            RelayConnector.connect(
                requireApproved = requireApproved,
                relayUrl = h.str("relayUrl"),
                token = h.str("clientToken"),
                deviceKeys = keys,
                hostPublicKeyB64 = h.str("hostPublicKeyB64"),
                onStatus = { statuses?.add(it) },
                approvalTimeoutMs = approvalTimeoutMs,
                approvalPollMs = 200
            )
        }

    private class RecordingSink : TerminalSink {
        val paints = CopyOnWriteArrayList<String>()
        val output = ByteArrayOutputStream()
        val resized = CopyOnWriteArrayList<Pair<Int, Int>>()
        val exited = CountDownLatch(1)
        @Volatile var exitCode: Int? = null

        override fun onPaint(text: String) {
            paints += text
        }

        override fun onOutput(bytes: ByteArray) {
            synchronized(output) { output.write(bytes) }
        }

        override fun onResized(cols: Int, rows: Int) {
            resized += cols to rows
        }

        override fun onExit(code: Int?) {
            exitCode = code
            exited.countDown()
        }

        fun text(): String = synchronized(output) { output.toString(Charsets.UTF_8) }

        fun awaitText(needle: String, timeoutMs: Long = 5_000) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!text().contains(needle)) {
                if (System.currentTimeMillis() > deadline) throw AssertionError("'$needle' not in output: ${text()}")
                Thread.sleep(20)
            }
        }
    }

    @Test
    fun `handshake, approval wait and SAS agree with the desktop`() {
        val h = start(approveAfterMs = 700)
        val keys = BoxKeyPair.generate()
        val statuses = ArrayList<RelayConnectStatus>()
        val connected = connect(h, keys, statuses)
        connected.connection.use {
            val peer = h.awaitEvent("peer-ready")
            assertEquals(peer.str("sas"), connected.sas, "both ends must show the same code")
            assertEquals(keys.publicKeyB64, peer.str("pub"), "the host pins exactly our box key")
            assertTrue(statuses.any { it is RelayConnectStatus.AwaitingApproval }, "the wait was surfaced: $statuses")
            h.awaitEvent("approved")
        }
    }

    @Test
    fun `an unapproved phone is told so and never served`() {
        val h = start(approveAfterMs = -1)
        val e = assertFailsWith<RelayApprovalTimeoutException> { connect(h, approvalTimeoutMs = 1_200) }
        assertTrue(e.message!!.contains("approved"), e.message)
    }

    @Test
    fun `pressing Deny on the desktop reads as a refusal, not a network error`() {
        // A30: the refusal has to be recognisable, or the phone re-dials and the dialog comes back.
        val h = start(approveAfterMs = -1, rejectAfterMs = 600)
        val statuses = ArrayList<RelayConnectStatus>()
        assertFailsWith<RelayApprovalRefusedException> { connect(h, statuses = statuses, approvalTimeoutMs = 10_000) }
        assertTrue(statuses.any { it is RelayConnectStatus.AwaitingApproval })
        h.awaitEvent("rejected")
    }

    @Test
    fun `a background dial gives up instead of waiting on an approval dialog`() {
        val h = start(approveAfterMs = -1)
        val statuses = ArrayList<RelayConnectStatus>()
        val t0 = System.currentTimeMillis()
        assertFailsWith<RelayApprovalRequiredException> {
            connect(h, statuses = statuses, approvalTimeoutMs = 20_000, requireApproved = true)
        }
        assertTrue(System.currentTimeMillis() - t0 < 10_000, "it did not wait out the approval window")
        assertTrue(statuses.none { it is RelayConnectStatus.AwaitingApproval }, "no code shown for a dial nobody watches")
    }

    @Test
    fun `a background dial is not turned away while the computer approves it on its own`() {
        // Review of A07-late: the standing host decides silently whether a phone is approved (its pin
        // store, and for a paired phone whose key pairing recorded, the late pin, which writes it),
        // and the phone's first request can arrive while that is still on disk. The desktop holds it
        // until the decision instead of answering "Awaiting host approval.", which a background check
        // reads as "a human must approve this phone": it gives up and forgets it was approved.
        val h = start(approveAfterMs = -1, extra = mapOf("FIXTURE_DECIDE_AFTER_MS" to "600", "FIXTURE_DECIDE" to "approve"))
        val statuses = ArrayList<RelayConnectStatus>()
        val connected = connect(h, statuses = statuses, requireApproved = true)
        connected.connection.use {
            assertTrue(connected.first.projects.isNotEmpty(), "served the listing it asked for while the host decided")
            assertTrue(statuses.none { it is RelayConnectStatus.AwaitingApproval }, "no code shown: $statuses")
            assertTrue(h.awaitEvent("decided")["approved"]!!.jsonPrimitive.content.toBoolean())
            h.awaitEvent("approved")
        }
    }

    @Test
    fun `a background dial still gives up when the computer's decision is to ask the human`() {
        // The hold ends with the decision: a phone the host hands to its dialog hears "Awaiting host
        // approval." then, exactly as before, and a background dial does not wait on the human.
        val decideMs = 600L
        val h = start(approveAfterMs = -1, extra = mapOf("FIXTURE_DECIDE_AFTER_MS" to decideMs.toString(), "FIXTURE_DECIDE" to "ask"))
        val t0 = System.currentTimeMillis()
        assertFailsWith<RelayApprovalRequiredException> { connect(h, requireApproved = true) }
        val elapsed = System.currentTimeMillis() - t0
        assertFalse(h.awaitEvent("decided")["approved"]!!.jsonPrimitive.content.toBoolean())
        assertTrue(elapsed >= decideMs - 100, "answered only once the host had decided (after ${elapsed} ms)")
        assertTrue(elapsed < 10_000, "it did not wait on the human")
    }

    @Test
    fun `projects list parses the desktop blob`() {
        val h = start()
        val connected = connect(h)
        connected.connection.use {
            val snap = connected.first
            val p = snap.projects.single()
            assertEquals("Demo", p.name)
            assertEquals(listOf("term-abc-1"), p.sessions.map { it.id })
            assertEquals(NodeKind.STICKY, p.nodes[1].kind)
            assertTrue(snap.isLive("term-abc-1"))
            val st = snap.statusOf("term-abc-1")!!
            assertEquals(AgentState.BLOCKED, st.state)
            assertEquals(SessionBucket.NEEDS_YOU, st.bucket)
            assertEquals("fix bug", st.name)
            // A39/A75: the account is named by the label the desktop's own builder wrote, never its id.
            assertEquals("Work", AccountNames.observed(st.account, snap.status))
            assertEquals("Work", AccountNames.managed("acct-1", snap.status))
            assertEquals("me@work.example", snap.status!!.settings!!.claudeAccounts.single().email)
            val ev = snap.status!!.inbox!!.events.single()
            assertEquals(InboxKind.APPROVAL, ev.kind)
            assertEquals("term-abc-1-1700000000000-42", ev.pendingId)
            // The mirror's own summary of the held Bash call (A64: nothing here is hand-written).
            assertEquals("Run command", ev.title)
            assertEquals("npm test", ev.detail)
            assertEquals("s-1", ev.sessionId)
            assertFalse(ev.resolved)
            assertEquals("Running npm test", snap.status!!.inbox!!.nodes["term-abc-1"]!!.activity)
            val board = p.board!!
            assertEquals("c1", board.columnOf("term-abc-1"))
            assertEquals(listOf("l1"), board.metaOf("term-abc-1")!!.labels)
        }
    }

    @Test
    fun `phone terminal route fallback refuses before creating any desktop session`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val e = assertFailsWith<HostException> {
                conn.attach("phone-12345678-1234-1234-1234-123456789abc", 80, 24, RecordingSink())
            }
            assertTrue(e.message!!.contains("SSH"))
            // Flush the fixture via a real later RPC, then inspect its application event stream.
            conn.listProjects()
            assertFailsWith<AssertionError> { h.awaitEvent("attach", 250) }
        }
    }

    @Test
    fun `attach paints the snapshot, streams output and carries input`() = runBlocking<Unit> {
        val h = start()
        val conn = connect(h).connection
        conn.use {
            val sink = RecordingSink()
            val stream = conn.attach("term-abc-1", 90, 30, sink)
            assertFalse(stream.fresh, "a live session is a warm join")
            val attach = h.awaitEvent("attach")
            assertEquals(90, attach.str("cols").toInt())
            assertEquals("false", attach.str("adaptsToSize"), "a phone is a size CEILING, like iOS")
            sink.awaitText("hello term-abc-1")
            assertEquals(listOf("screen of term-abc-1"), sink.paints)
            stream.write("ls -la\r")
            assertEquals("ls -la\r", h.awaitEvent("write").str("data"))
            sink.awaitText("echo:ls -la")
            stream.write("ünïcødé ✓\r")
            sink.awaitText("echo:ünïcødé ✓")
        }
    }

    @Test
    fun `an attach cancelled while its request is on the wire leaves no viewer on the host`() = runBlocking<Unit> {
        // A40 review: the host reserves the stream (a viewer on the node: an Eco shield and a size
        // ceiling on the desktop) before it replies. A caller that gave up meanwhile never gets the
        // stream, so the transport must let it go, or nothing ever does.
        val h = start()
        connect(h).connection.use { conn ->
            val job = launch(Dispatchers.Default) { conn.attach("term-slow-1", 80, 24, RecordingSink()) }
            assertEquals("term-slow-1", h.awaitEvent("probe").str("persistKey"), "the request reached the host")
            assertEquals("term-slow-1", h.awaitEvent("viewer-attached").str("nodeId"))
            job.cancelAndJoin()
            assertTrue(job.isCancelled)
            assertEquals("term-slow-1", h.awaitEvent("viewer-detached", 5_000).str("nodeId"), "the stream was let go of")
            // The connection is still good for the next attach.
            conn.attach("term-abc-1", 80, 24, RecordingSink()).detach()
        }
    }

    @Test
    fun `a multi-chunk snapshot survives a code point split across chunks`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            conn.attach("term-big-1", 80, 24, sink)
            sink.awaitText("hello term-big-1")
            assertEquals("SNAP-" + "€".repeat(100_000) + "-END", sink.paints.single())
        }
    }

    @Test
    fun `fresh reports a cold start, and resize round-trips a Resized frame`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-new-1", 80, 24, sink)
            assertTrue(stream.fresh)
            sink.awaitText("hello term-new-1")
            stream.resize(100, 30)
            val r = h.awaitEvent("resize")
            assertEquals(100, r.str("cols").toInt())
            assertEquals(30, r.str("rows").toInt())
            val deadline = System.currentTimeMillis() + 3_000
            while (sink.resized.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(listOf(132 to 43), sink.resized.toList())
        }
    }

    @Test
    fun `the pane exiting reaches the sink with its code`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-abc-1", 80, 24, sink)
            sink.awaitText("hello")
            stream.write("exit\r")
            assertTrue(sink.exited.await(5, TimeUnit.SECONDS))
            assertEquals(7, sink.exitCode)
        }
    }

    @Test
    fun `detach, end session, scroll and node actions reach the host`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val a = conn.attach("term-abc-1", 80, 24, RecordingSink())
            a.scroll(up = true, lines = 3)
            repeat(3) { assertEquals("\u001b[<64;1;1M", h.awaitEvent("write").str("data")) }
            a.detach()
            h.awaitEvent("kill")

            val b = conn.attach("term-new-1", 80, 24, RecordingSink())
            b.endSession()
            assertEquals("term-new-1", h.awaitEvent("destroyNode").str("nodeId"))

            conn.wake("term-abc-1")
            assertEquals("term-abc-1", h.awaitEvent("wake").str("nodeId"))
            conn.refresh("term-abc-1")
            h.awaitEvent("refresh")
            conn.rename("term-abc-1", "new\u001b[31m name")
            assertEquals("new [31m name", h.awaitEvent("rename").str("title"), "control chars are stripped host-side")
        }
    }

    @Test
    fun `history search reaches the attached desktop session and returns older retained output`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-abc-1", 80, 24, sink)
            sink.awaitText("hello")
            val result = stream.searchHistory(".* Ω 😀")
            assertEquals(501, result.searchedLines)
            assertFalse(result.truncated)
            assertEquals(listOf(dev.nodeterm.protocol.model.TerminalHistory.Row(0, "old.* Ω 😀")), result.rows)
            val request = h.awaitEvent("historySearch")
            assertEquals("sess-1", request.str("sessionId"))
            assertEquals(".* Ω 😀", request.str("query"))
            stream.detach()
            assertFailsWith<HostException> { stream.searchHistory("old") }
        }
    }

    @Test fun `composed Send uses the real attached-stream host RPC and normalized full paste`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
            val text = "a full prompt exceeding sixteen characters\nΩ 😀\u001b"
            assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Paste(text, true)))
            val event = h.awaitEvent("submitComposed")
            assertEquals("sess-1", event.str("sessionId"))
            val input = event.getValue("input").jsonObject
            assertEquals("paste", input.str("kind")); assertEquals(text.replace("\n", "\r").replace("\u001b", ""), input.str("text"))
            assertEquals(true, input.getValue("enter").jsonPrimitive.boolean)
            assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Control("\u0003")))
            val control = h.awaitEvent("submitComposed").getValue("input").jsonObject
            assertEquals("control", control.str("kind")); assertEquals("\u0003", control.str("text"))
            assertFalse(control.getValue("enter").jsonPrimitive.boolean)
            stream.detach()
        }
    }

    @Test fun `composed relay refusal uncertainty and legacy unsupported keep explicit outcomes without fallback`() = runBlocking<Unit> {
        for ((mode, expected) in listOf("refused" to ComposedInputResult.Status.REFUSED,
            "uncertain" to ComposedInputResult.Status.UNCERTAIN, "unsupported" to ComposedInputResult.Status.REFUSED)) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_INPUT" to mode))
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val result = stream.submitComposed(ComposedInput.Paste("must keep draft", true))
                assertEquals(expected, result.status, mode)
                assertTrue(result.message.orEmpty().isNotBlank(), mode)
                if (mode != "unsupported") assertEquals("sess-1", h.awaitEvent("submitComposed").str("sessionId"))
                stream.detach()
            }
        }
    }

    // Actual backend/client/emulator producer through the encrypted relay and Kotlin API.
    // Its native process leaf records bytes; this is not physical Windows ConPTY coverage.
    @Test fun `session host composed Send producer interops with Android full paste delay and raw Ctrl`() = runBlocking<Unit> {
        alternativeComposedProducer("session-host")
    }

    @Test fun `direct Windows composed Send producer interops with Android full paste delay and raw Ctrl`() = runBlocking<Unit> {
        alternativeComposedProducer("native-windows")
    }

    private suspend fun alternativeComposedProducer(backend: String) {
        for (mode in listOf("on", "off")) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_COMPOSED_MODE" to mode))
            connect(h).connection.use { conn ->
                val ready = h.awaitEvent("composed-backend-ready")
                assertEquals(backend, ready.str("backend"))
                assertEquals("byte-recorder", ready.str("nativeBoundary"))
                assertTrue(ready.getValue("actualBackend").jsonPrimitive.boolean)
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val text = "one complete Android draft\nΩ 😀\u001b"
                assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Paste(text, true)))
                val paste = h.awaitEvent("composed-native-write")
                val enter = h.awaitEvent("composed-native-write")
                val normalized = "one complete Android draft\rΩ 😀"
                assertEquals(if (mode == "on") "\u001b[200~${normalized}\u001b[201~" else normalized, paste.str("data"))
                assertEquals("\r", enter.str("data"))
                assertTrue(enter.getValue("at").jsonPrimitive.double - paste.getValue("at").jsonPrimitive.double >= 150,
                    "Enter must be a later native write, separated by at least 150ms")
                assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Control("\u0003")))
                assertEquals("\u0003", h.awaitEvent("composed-native-write").str("data"))
                stream.detach()
                assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("stale", true)).status)
            }
        }
    }

    @Test fun `native retained history producer reaches Android without wheel input`() = runBlocking<Unit> {
        alternativeHistoryProducer("native-windows")
    }
    @Test fun `session host retained history producer reaches Android without wheel input`() = runBlocking<Unit> {
        alternativeHistoryProducer("session-host")
    }
    private suspend fun alternativeHistoryProducer(backend: String) {
        val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_HISTORY_SCROLL" to "off"))
        connect(h).connection.use { conn ->
            h.awaitEvent("composed-backend-ready")
            val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
            var page = assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 20))
            val observed = h.awaitEvent("history-native-result")
            assertEquals("history", observed.str("status"))
            assertTrue(observed.getValue("writes").jsonArray.isEmpty(), "Mouse-off scrolling must deliver zero raw input")
            assertEquals(60, page.offset); assertTrue(page.totalRows > 200); assertEquals(24, page.rows.size)
            val view = page.viewId
            val original = page
            h.command("history-more-output"); h.awaitEvent("history-control-done")
            assertIs<TerminalScrollView.Result.History>(stream.scrollView(false, 20))
            page = assertIs(stream.scrollView(true, 20))
            assertEquals(original, page, "Live output and normal-buffer trimming cannot rewrite an existing viewer snapshot")
            repeat(8) { if (page.hasOlder) page = assertIs(stream.scrollView(true, 20)) }
            assertEquals(view, page.viewId, "Every further page belongs to the same immutable viewer capture")
            assertFalse(page.hasOlder)
            assertTrue(page.rows.any { it.text.startsWith("H0000") }, "Pre-attach history must reach the oldest page")
            val newer = assertIs<TerminalScrollView.Result.History>(stream.scrollView(false, 1))
            assertEquals(page.offset - 3, newer.offset); assertEquals(view, newer.viewId)
            val other = conn.attach("term-abc-1", 80, 24, RecordingSink())
            val otherPage = assertIs<TerminalScrollView.Result.History>(other.scrollView(true, 1))
            assertTrue(view != otherPage.viewId, "A different attached viewer never adopts this viewer's viewId")
            stream.clearScrollView()
            val fresh = assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 1))
            assertTrue(view != fresh.viewId, "Returning to live makes a later gesture capture a new view")
            stream.detach(); other.detach()
            assertIs<TerminalScrollView.Result.Refused>(stream.scrollView(true, 1))
        }
    }
    @Test fun `actual backend mouse encoders interop as typed input without history fallback`() = runBlocking<Unit> {
        for (backend in listOf("native-windows", "session-host")) for ((mode, up, down) in listOf(
            Triple("default", "\u001b[M`!!", "\u001b[Ma!!"),
            Triple("sgr", "\u001b[<64;1;1M", "\u001b[<65;1;1M"),
            Triple("pixels", "\u001b[<64;0;0M", "\u001b[<65;0;0M"))) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_HISTORY_SCROLL" to mode))
            connect(h).connection.use { conn ->
                h.awaitEvent("composed-backend-ready")
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                for ((direction, expected) in listOf(true to up, false to down)) {
                    assertEquals(TerminalScrollView.Result.Input, stream.scrollView(direction, 2))
                    val observed = h.awaitEvent("history-native-result")
                    assertEquals("input", observed.str("status"))
                    assertEquals(listOf(expected, expected), observed.getValue("writes").jsonArray.map { it.jsonPrimitive.content }, "$backend/$mode")
                }
                stream.detach()
            }
        }
    }
    @Test fun `unadvertised relay scrolling refuses without guessing legacy tmux or typing wheels`() = runBlocking<Unit> {
        for (extra in listOf(mapOf("FIXTURE_HISTORY_SCROLL" to "unsupported"),
            mapOf("FIXTURE_COMPOSED_BACKEND" to "native-windows", "FIXTURE_HISTORY_SCROLL" to "off", "FIXTURE_HISTORY_ADVERTISE_FALSE" to "1"))) {
            val h = start(extra = extra)
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val result = stream.scrollView(true, 1)
                h.command("history-state")
                assertEquals(0, h.awaitEvent("history-state").getValue("calls").jsonPrimitive.int,
                    "An unadvertised method must be refused locally before any backend call")
                h.awaitEvent("history-control-done")
                assertIs<TerminalScrollView.Result.Refused>(result)
                stream.detach()
            }
        }
    }
    @Test fun `a held real history reply cannot restore a token after explicit live exit`() = runBlocking<Unit> {
        for (backend in listOf("native-windows", "session-host")) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_HISTORY_SCROLL" to "off", "FIXTURE_HISTORY_HOLD" to "1"))
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val pending = async(start = CoroutineStart.UNDISPATCHED) { stream.scrollView(true, 1) }
                h.awaitEvent("history-scroll-held")
                stream.clearScrollView()
                h.command("history-release"); h.awaitEvent("history-control-done")
                assertIs<TerminalScrollView.Result.Refused>(pending.await(), "A late reply may not become this viewer's current token")
                assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 1), "A later explicit gesture captures a new view")
                stream.detach()
            }
        }
    }
    @Test fun `a held actual wheel result remains uncertain after live exit or viewer retirement without replay`() = runBlocking<Unit> {
        for (backend in listOf("native-windows", "session-host")) for (retire in listOf(false, true)) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_HISTORY_SCROLL" to "sgr", "FIXTURE_HISTORY_HOLD" to "1"))
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val pending = async(start = CoroutineStart.UNDISPATCHED) { stream.scrollView(true, 2) }
                h.awaitEvent("history-scroll-held")
                h.awaitEvent("scrollAttached")
                val observed = h.awaitEvent("history-native-result")
                assertEquals("input", observed.str("status"))
                assertEquals(listOf("\u001b[<64;1;1M", "\u001b[<64;1;1M"), observed.getValue("writes").jsonArray.map { it.jsonPrimitive.content })
                stream.clearScrollView()
                if (retire) stream.retireComposed()
                h.command("history-release"); h.awaitEvent("history-control-done")
                assertIs<TerminalScrollView.Result.Uncertain>(pending.await(), "Written wheels cannot become a confirmed refusal when the view closes")
                h.command("history-mouse-off"); h.awaitEvent("history-control-done")
                assertTrue(h.drainEvents().none { it.str("event") in setOf("history-native-result", "scrollAttached") }, "A sent scroll must never be retried")
                stream.detach()
            }
        }
    }
    @Test fun `typed relay refusal and uncertainty preserve their outcomes without input fallback`() = runBlocking<Unit> {
        for (status in listOf("refused", "uncertain")) {
            val h = start(extra = mapOf("FIXTURE_HISTORY_RESULT" to status))
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val result = stream.scrollView(true, 1)
                if (status == "refused") assertIs<TerminalScrollView.Result.Refused>(result)
                else assertIs<TerminalScrollView.Result.Uncertain>(result)
                stream.detach()
            }
        }
    }
    @Test fun `actual runtime mouse changes apply only after leaving immutable history`() = runBlocking<Unit> {
        for (backend in listOf("native-windows", "session-host")) {
            val h = start(extra = mapOf("FIXTURE_COMPOSED_BACKEND" to backend, "FIXTURE_HISTORY_SCROLL" to "off"))
            connect(h).connection.use { conn ->
                val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
                val page = assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 1))
                h.awaitEvent("history-native-result")
                h.command("history-mouse-sgr"); h.awaitEvent("history-control-done")
                assertEquals(page.viewId, assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 1)).viewId,
                    "Application tracking changes never inject input into a retained history view")
                stream.clearScrollView()
                assertEquals(TerminalScrollView.Result.Input, stream.scrollView(true, 1))
                assertEquals(listOf("\u001b[<64;1;1M"), h.awaitEvent("history-native-result").getValue("writes").jsonArray.map { it.jsonPrimitive.content })
                h.command("history-mouse-off"); h.awaitEvent("history-control-done")
                assertIs<TerminalScrollView.Result.History>(stream.scrollView(true, 1))
                assertTrue(h.awaitEvent("history-native-result").getValue("writes").jsonArray.isEmpty())
                stream.detach()
            }
        }
    }

    @Test fun `retired or detached relay viewer refuses composed Send before invoking host`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val stream = conn.attach("term-abc-1", 80, 24, RecordingSink())
            stream.retireComposed()
            assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("old", true)).status)
            stream.write("raw unchanged")
            assertEquals("raw unchanged", h.awaitEvent("write").str("data"))
            stream.detach()
            assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("detached", true)).status)
        }
    }

    @Test
    fun `board verbs carry null as the Ungrouped column`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            assertEquals(listOf("To Do"), conn.ensureBoard("p1")!!.map { it.title })
            assertTrue(conn.setCardColumn("p1", "term-abc-1", null))
            val moved = h.awaitEvent("setCardColumn")
            assertEquals(JsonNull, moved["columnId"])
            assertTrue(conn.setCardColumn("p1", "term-abc-1", "c1"))
            assertEquals("c1", h.awaitEvent("setCardColumn").str("columnId"))
            val res = conn.editCardLabels("p1", "term-abc-1", CardLabelEdit(add = listOf("l1"), create = listOf("urgent" to "red")))!!
            assertTrue(res.edited)
            assertEquals(listOf("l1"), res.cardLabelIds)
            val edit = h.awaitEvent("editCardLabels")["edit"].toString()
            assertTrue(edit.contains("urgent"), edit)
            assertTrue(conn.registerNode("p1", NewNode("term-kx1-abc", "Claude Code", "claude", null)))
            assertEquals("p1", h.awaitEvent("registerNode").str("projectId"))
        }
    }

    @Test
    fun `quick approve answers the held hook through the relay verb, never with keys`() = runBlocking<Unit> {
        val h = start()
        connect(h).connection.use { conn ->
            val event = conn.listProjects().status!!.inbox!!.events.single()
            assertEquals(QuickActions.Result.SENT, QuickActions.answerApproval(conn, event, allow = true))
            val answer = h.awaitEvent("answer")
            assertEquals("allow", answer.str("decision"))
            assertEquals("term-abc-1-1700000000000-42", answer.str("pendingId"))
            conn.ackRead("term-abc-1", event.id)
            assertEquals("term-abc-1", h.awaitEvent("ack").str("nodeId"))
            assertNotNull(event)
        }
    }

    @Test
    fun `new hook capabilities and complete answers interoperate with the real host producer and verbs`() = runBlocking<Unit> {
        val h = start(extra = mapOf("FIXTURE_STRUCTURED_HOOKS" to "1"))
        connect(h).connection.use { conn ->
            val feed = conn.listProjects().status!!.inbox!!.events
            val permission = feed.single { it.kind == InboxKind.APPROVAL }
            assertEquals("Bash(npm test) — localSettings", permission.permissionSuggestions.single().label)
            assertEquals(QuickActions.Result.SENT, QuickActions.rememberApproval(conn, permission, 0))
            val remembered = h.awaitEvent("answer")
            assertEquals("allow-always", remembered.str("decision"))
            assertEquals("0", remembered.str("suggestionIndex"))
            val question = feed.single { it.kind == InboxKind.QUESTION }
            assertTrue(question.options.isEmpty(), "an old consumer must not receive numbered actions")
            assertEquals(2, question.questions.size)
            assertEquals(QuickActions.Result.SENT, QuickActions.answerQuestions(conn, question, listOf(listOf(0, 1), listOf(1))))
            val answer = h.awaitEvent("question-answer")
            assertEquals("term-question-1-1700000000000-43", answer.str("pendingId"))
            assertEquals("[[0,1],[1]]", answer["selections"].toString())
            assertEquals(dev.nodeterm.protocol.host.ApprovalOutcome.GONE,
                conn.answerQuestions(question.copy(questionPendingId = "term-question-1-1700000000000-44-expired"), listOf(listOf(0), listOf(1))))
        }
    }

    @Test
    fun `an older host without structured questions never falls back to typing before the held picker paints`() = runBlocking<Unit> {
        val h = start(extra = mapOf("FIXTURE_STRUCTURED_HOOKS" to "1", "FIXTURE_NO_STRUCTURED_QUESTIONS" to "1"))
        connect(h).connection.use { conn ->
            val event = conn.listProjects().status!!.inbox!!.events.single { it.kind == InboxKind.QUESTION }
            assertEquals(QuickActions.Result.OPEN_SESSION, QuickActions.answerQuestions(conn, event, listOf(listOf(0), listOf(1))))
        }
    }

    @Test
    fun `an answer that arrives after the hold ended opens the session instead of claiming success`() = runBlocking<Unit> {
        // A06/A35 against the desktop's real verb: `{answered:false, reason:"gone"}`, and the node is
        // still blocked, so the prompt is on screen now.
        val h = start()
        connect(h).connection.use { conn ->
            val live = conn.listProjects().status!!.inbox!!.events.single()
            val late = live.copy(id = "e-late", pendingId = "term-abc-1-1700000000000-43-expired")
            assertEquals(dev.nodeterm.protocol.host.ApprovalOutcome.GONE, conn.answerApproval(late, allow = true))
            assertEquals(QuickActions.Result.EXPIRED, QuickActions.answerApproval(conn, late, allow = false))
        }
    }

    @Test
    fun `quick answers are typed through the node's session, not a throwaway client`() = runBlocking<Unit> {
        // A12: node.sendKeys through the desktop's real verb handler.
        val h = start()
        connect(h).connection.use { conn ->
            conn.sendKeys("term-abc-1", "\u001b")
            val ev = h.awaitEvent("sendKeys")
            assertEquals("term-abc-1", ev.str("nodeId"))
            assertEquals("\u001b", ev.str("keys"))
            // Not delivered is not "sent": the caller opens the session instead.
            assertFailsWith<HostException> { conn.sendKeys("term-gone-1", "1") }
        }
    }

    @Test
    fun `a quick answer for a node of the desktop's SSH project is typed on that host`() = runBlocking<Unit> {
        // Follow-up to A12, through the desktop's real verb handler and its A09 resolver: the keys
        // go over the project's master instead of answering sent:false (which opened the session).
        val h = start()
        connect(h).connection.use { conn ->
            conn.sendKeys("ssh-abc-1", "1")
            val ev = h.awaitEvent("sendKeysOver")
            assertEquals("ssh-abc-1", ev.str("nodeId"))
            assertEquals("1", ev.str("keys"))
            assertEquals("/cm/box.sock", ev.str("controlPath"))
            // Never the local writer: the first local `sendKeys` the desktop sees is this later one.
            conn.sendKeys("term-abc-1", "2")
            assertEquals("term-abc-1", h.awaitEvent("sendKeys").str("nodeId"))
            // A session the host does not have, and a project whose master is down, are not "sent":
            // the caller opens the session instead.
            assertFailsWith<HostException> { conn.sendKeys("ssh-gone-1", "1") }
            assertFailsWith<HostException> { conn.sendKeys("ssh-offline-1", "1") }
        }
    }

    @Test
    fun `an older desktop without the verb still gets the keys, after the pane painted`() = runBlocking<Unit> {
        val h = start(extra = mapOf("FIXTURE_NO_SENDKEYS" to "1"))
        connect(h).connection.use { conn ->
            conn.sendKeys("term-abc-1", "2")
            assertEquals("2", h.awaitEvent("write").str("data"))
        }
    }

    @Test
    fun `a session the phone starts is created in its project by the desktop`() = runBlocking<Unit> {
        // A33 + A72, through the desktop's real pty.attach handler and its real resolver: the host
        // applies the project folder and account, the AGENT (what gives the session its
        // agent-specific hook env: approvals, canvas control) and the pane OWNER it resolved from
        // its own index. The fixture's session "does not exist", so this attach creates it.
        val h = start()
        connect(h).connection.use { conn ->
            val s = conn.attach("term-new-9", 90, 30, RecordingSink(), dev.nodeterm.protocol.host.NewSessionHint("p1", "acct-1", "claude"))
            val ev = h.awaitEvent("attach")
            assertEquals("term-new-9", ev.str("persistKey"))
            assertTrue(s.fresh)
            assertEquals("/repo", ev.str("cwd"))
            assertEquals("acct-1", ev.str("accountId"))
            assertEquals("claude", ev.str("agentId"))
            assertEquals("p1", ev.str("ownerProjectId"))
            s.detach()
        }
    }

    @Test
    fun `managed phone creation consumes the real trusted project settings before launch input (A72)`() = runBlocking<Unit> {
        val h = startLaunch(true)
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-settings-new", 80, 24, sink,
                dev.nodeterm.protocol.host.NewSessionHint("launch-project", null, "claude"))
            assertTrue(stream.fresh)
            sink.awaitText("launch-env:trusted-project shell:/bin/sh")
            stream.write("A72_NEW_LAUNCH\r")
            val written = h.awaitEvent("launch-write")
            assertEquals("A72_NEW_LAUNCH\r", written.str("text"))
            assertEquals(h.str("projectCwd"), written.str("cwd"))
            assertEquals("trusted-project", written.str("projectEnv"))
            assertEquals("/bin/sh", written.str("shell"))
            stream.detach()
        }
    }

    @Test
    fun `cold saved node attach restores host project settings and cwd without wire hints (A72)`() = runBlocking<Unit> {
        val h = startLaunch(true)
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-settings-saved", 80, 24, sink)
            assertTrue(stream.fresh)
            sink.awaitText("launch-env:trusted-project shell:/bin/sh")
            stream.write("A72_SAVED_LAUNCH\r")
            val written = h.awaitEvent("launch-write")
            assertEquals(h.str("savedCwd"), written.str("cwd"))
            assertEquals("trusted-project", written.str("projectEnv"))
            assertEquals("/bin/sh", written.str("shell"))
            stream.detach()
        }
    }

    @Test
    fun `untrusted shared project env and shell stay out of a managed phone cold spawn (A72)`() = runBlocking<Unit> {
        val h = startLaunch(false)
        connect(h).connection.use { conn ->
            val sink = RecordingSink()
            val stream = conn.attach("term-settings-saved", 80, 24, sink)
            sink.awaitText("launch-env:absent shell:")
            stream.write("A72_UNTRUSTED_LAUNCH\r")
            val written = h.awaitEvent("launch-write")
            assertEquals(null, written["projectEnv"]?.takeUnless { it.toString() == "null" })
            assertFalse(written.str("shell") == "/bin/sh")
            assertEquals(setOf("agents", "shell"), setOf(h.awaitEvent("launch-trust").str("family"),
                h.awaitEvent("launch-trust").str("family")))
            stream.detach()
        }
    }

    @Test
    fun `a hint on an attach that joins a live session changes nothing, the owner included`() = runBlocking<Unit> {
        // A72: the phone must not be able to claim a running pane for its project by naming one.
        // The fixture's `term-a` exists, so this attach is a join and the host applies nothing.
        val h = start()
        connect(h).connection.use { conn ->
            val s = conn.attach("term-a", 90, 30, RecordingSink(), dev.nodeterm.protocol.host.NewSessionHint("p1", null, "claude"))
            val ev = h.awaitEvent("attach")
            assertEquals("term-a", ev.str("persistKey"))
            assertEquals(false, s.fresh)
            assertEquals(null, ev["cwd"])
            assertEquals(null, ev["agentId"])
            assertEquals(null, ev["ownerProjectId"])
            s.detach()
        }
    }

    /**
     * Audit A29: the phone's Source Control drives the desktop's REAL git bridge — `handleGit` behind
     * its jail, handing each verb to the real `GitService` (src/core/git-service.ts) — over a git
     * repository in the project's folder (seedGitRepo in host-fixture.ts). The folder is the one
     * `projects.list` names, as the app takes it.
     */
    @Test
    fun `source control works the project's repository through the desktop's git bridge`() = runBlocking<Unit> {
        val h = start()
        val connected = connect(h)
        connected.connection.use { conn ->
            val cwd = connected.first.projects.single().cwd!!
            val git = SourceControl(conn, cwd)

            val st = git.status()
            assertTrue(st.hasRepo)
            assertEquals("main", st.branch)
            assertTrue(st.hasRemote && st.hasUpstream, "the seed pushed main with -u")
            assertEquals(0, st.ahead)
            assertEquals(listOf(GitFileChange("staged.txt", "A", 1, 0)), st.staged)
            assertEquals(listOf(GitFileChange("README.md", "M", 1, 1)), st.unstaged)
            assertEquals(listOf("new.txt"), st.untracked.map { it.path })

            // Each side of the diff, and the whole file for an untracked one.
            val readme = git.diff(st.unstaged.single(), staged = false)
            assertTrue(GitDiff.Line(GitDiff.Kind.DEL, "-hello") in readme.lines, "${readme.lines}")
            assertTrue(GitDiff.Line(GitDiff.Kind.ADD, "+hello again") in readme.lines, "${readme.lines}")
            assertTrue(readme.lines.any { it.kind == GitDiff.Kind.HUNK })
            assertTrue(GitDiff.Line(GitDiff.Kind.ADD, "+staged") in git.diff(st.staged.single(), staged = true).lines)
            assertTrue(GitDiff.Line(GitDiff.Kind.ADD, "+new file") in git.diff(st.untracked.single(), staged = false).lines)

            // Stage the untracked file, unstage the staged one: both move.
            assertEquals(GitResult(true, ""), git.stage(listOf("new.txt")))
            assertEquals(GitResult(true, ""), git.unstage(listOf("staged.txt")))
            val moved = git.status()
            assertEquals(listOf("new.txt"), moved.staged.map { it.path })
            assertEquals(listOf("staged.txt"), moved.untracked.map { it.path })

            // A git command that fails on the computer is an ANSWER carrying git's own words, not an
            // RPC error: the screen shows it as it is.
            val badPath = git.stage(listOf("no-such-file"))
            assertFalse(badPath.ok)
            assertTrue(badPath.message.contains("no-such-file"), badPath.message)
            // The desktop refuses an empty message itself; the phone's button never sends one.
            assertEquals(GitResult(false, "Commit message is empty."), git.commit("  "))

            val commit = git.commit("Add new.txt from the phone")
            assertTrue(commit.ok, commit.message)
            assertTrue(commit.message.contains("Add new.txt from the phone"), commit.message)
            val after = git.status()
            assertEquals(1, after.ahead)
            assertTrue(after.staged.isEmpty())

            val history = git.history()
            assertEquals(listOf("Add new.txt from the phone", "initial"), history.commits.map { it.subject })
            val head = history.commits.first()
            assertEquals("Interop", head.author)
            assertEquals(head.id.take(head.shortId.length), head.shortId)
            assertTrue((head.timestampMs ?: 0) > 1_600_000_000_000, "author time in ms: ${head.timestampMs}")
            assertTrue("main" in head.refs, "${head.refs}")
            assertTrue(history.hasOutgoingChanges)

            assertEquals(GitResult(true, "Pushed."), git.push())
            assertEquals(0, git.status().ahead)
            val pulled = git.pull()
            assertTrue(pulled.ok, pulled.message)
            assertFalse(git.history().hasOutgoingChanges)
        }
    }

    /**
     * Review of A29: a merge that conflicted, read through the desktop's real `GitService`. Its status
     * sends an unmerged path's `U` exactly like an untracked file's (porcelain `??`), in both lists.
     * The phone lists such a path as a conflict, opens it as the combined diff with its markers (never
     * `git diff --no-index /dev/null <path>`, which showed the conflicted file as a NEW one), and does
     * not offer the commit git refuses. The merge is made here with git itself, as it would be on the
     * computer (a Pull from the phone that merges ends in the same state).
     */
    @Test
    fun `a merge that conflicted reaches the phone as conflicts, not as untracked files`() = runBlocking<Unit> {
        val h = start()
        val connected = connect(h)
        connected.connection.use { conn ->
            val cwd = connected.first.projects.single().cwd!!
            val noConfig = Files.createTempFile("gitconfig", "").toFile().also { it.deleteOnExit() }
            fun git(vararg args: String): Int {
                val pb = ProcessBuilder(listOf("git") + args).directory(File(cwd)).redirectErrorStream(true)
                // The repository's own config (seedGitRepo: identity, no hooks, no signing) and nothing of
                // the machine's, so a user's merge settings cannot change the conflict.
                pb.environment()["GIT_CONFIG_GLOBAL"] = noConfig.path
                pb.environment()["GIT_CONFIG_NOSYSTEM"] = "1"
                val proc = pb.start()
                proc.inputStream.readBytes()
                return proc.waitFor()
            }
            fun write(name: String, text: String) = File(cwd, name).writeText(text)

            // The base: the seed's README, staged.txt and new.txt, committed.
            assertEquals(0, git("add", "-A"))
            assertEquals(0, git("commit", "-q", "-m", "base"))
            // Theirs: README and staged.txt changed, new.txt deleted, both.txt added.
            assertEquals(0, git("checkout", "-q", "-b", "theirs"))
            write("README.md", "theirs\n")
            write("staged.txt", "theirs\n")
            write("both.txt", "theirs\n")
            assertEquals(0, git("rm", "-q", "new.txt"))
            assertEquals(0, git("add", "-A"))
            assertEquals(0, git("commit", "-q", "-m", "theirs"))
            // Ours: README and new.txt changed, staged.txt deleted, both.txt added differently.
            assertEquals(0, git("checkout", "-q", "main"))
            write("README.md", "ours\n")
            write("new.txt", "ours\n")
            write("both.txt", "ours\n")
            assertEquals(0, git("rm", "-q", "staged.txt"))
            assertEquals(0, git("add", "-A"))
            assertEquals(0, git("commit", "-q", "-m", "ours"))
            assertEquals(1, git("merge", "theirs"), "the merge conflicts")
            write("fresh.txt", "fresh\n")

            val git = SourceControl(conn, cwd)
            val st = git.status()
            assertEquals(
                setOf(
                    GitConflict("README.md", "U", "U"), GitConflict("both.txt", "A", "A"),
                    GitConflict("new.txt", "U", "D"), GitConflict("staged.txt", "D", "U")
                ),
                st.conflicts.toSet()
            )
            assertEquals(listOf("fresh.txt"), st.untracked.map { it.path }, "only the file git does not track is untracked")
            assertTrue(st.staged.isEmpty(), "${st.staged}")
            assertTrue(st.unstaged.isEmpty(), "${st.unstaged}")
            assertEquals("Resolve the conflicts on the computer first.", SourceControl.commitBlocker(st, "Merge theirs"))

            val readme = git.diff(st.conflicts.single { it.path == "README.md" })
            assertEquals(GitDiff.Line(GitDiff.Kind.META, "diff --cc README.md"), readme.lines.first(), "${readme.lines}")
            assertTrue(readme.lines.none { "/dev/null" in it.text }, "not the untracked form: ${readme.lines}")
            for (marker in listOf("<<<<<<<", "=======", ">>>>>>>")) {
                assertTrue(readme.lines.any { it.kind == GitDiff.Kind.ADD && marker in it.text }, "$marker: ${readme.lines}")
            }
            assertTrue(GitDiff.Line(GitDiff.Kind.ADD, " +ours") in readme.lines, "${readme.lines}")

            // git itself refuses the commit, which is what the button says first.
            val commit = git.commit("Merge theirs")
            assertFalse(commit.ok)
            assertTrue(commit.message.contains("unmerged"), commit.message)
        }
    }

    @Test
    fun `the git bridge's refusals reach the phone as the host's own sentences`() = runBlocking<Unit> {
        val h = start()
        val connected = connect(h)
        connected.connection.use { conn ->
            val cwd = connected.first.projects.single().cwd!!
            // The jail is lexical and resolves `..`: the folder above the project is outside it.
            for (outside in listOf("/etc", "$cwd/..", "")) {
                val e = assertFailsWith<HostException> { SourceControl(conn, outside).status() }
                assertEquals("cwd is outside the shared project roots.", e.message, outside)
            }
        }

        val bare = start(extra = mapOf("FIXTURE_NO_GIT" to "1"))
        val c2 = connect(bare)
        c2.connection.use { conn ->
            val e = assertFailsWith<HostException> { SourceControl(conn, c2.first.projects.single().cwd!!).status() }
            assertEquals("git is not served on this host.", e.message)
        }
    }

    // ---- A74-refresh: the computer's LAN leg, reported beside the listing -----------------------------

    /** sshd's `ssh_host_<name>_key.pub` files for [keys], under a new dir (the layout of /etc/ssh). */
    private fun hostKeyDir(vararg keys: Pair<String, java.security.PublicKey>): File {
        val dir = Files.createTempDirectory("nt-relay-etc-ssh").toFile().also { userDataDirs += it }
        for ((name, key) in keys) {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            File(dir, "ssh_host_${name}_key.pub").writeText("${KeyType.fromKey(key)} ${java.util.Base64.getEncoder().encodeToString(blob)} root@box\n")
        }
        return dir
    }

    /** A real SSH server that lets [identity] in as `dev`, and its host key. */
    private fun sshServer(identity: SshIdentity): Pair<SshServer, java.security.PublicKey> {
        val root = Files.createTempDirectory("nt-relay-sshd").toFile().also { userDataDirs += it }
        val server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
        val accepted = identity.keyPair.public.encoded
        server.publickeyAuthenticator = PublickeyAuthenticator { user, key, _ -> user == "dev" && key.encoded.contentEquals(accepted) }
        server.start()
        sshServers += server
        return server to server.keyPairProvider.loadKeys(null).first().public
    }

    /** The pin as the app keeps it (ConnectionManager's `pinFor`): read from, and written to, the record. */
    private class RecordPin(var record: PairedHost) : HostKeyPin {
        override fun pinned() = record.sshHostKeyFingerprint
        override fun pin(fingerprint: String) {
            record = record.copy(sshHostKeyFingerprint = fingerprint)
        }
        override fun anchors() = record.sshHostKeyAnchors
    }

    @Test
    fun `the relay listing names the computer's LAN address and SSH keys, and the phone trusts its new key from it (A74-refresh)`() = runBlocking<Unit> {
        // The computer's sshd keys were regenerated (a reinstall) and its lease moved since the phone
        // paired: the record still says the old address and pins a key the computer no longer has.
        val identity = SshIdentity.generate()
        val (sshd, serverKey) = sshServer(identity)
        val old = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair().public
        val oldFp = SshHostConnection.fingerprint(old)
        val serverFp = SshHostConnection.fingerprint(serverKey)
        val h = start(extra = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to hostKeyDir("ecdsa" to serverKey).path, "FIXTURE_LAN_ADDRESS" to "192.168.77.20"))
        val connected = connect(h)
        connected.connection.use { conn ->
            // The desktop's own reporter (the QR's address pick, the sealed answer's key reader), beside the blob.
            assertEquals(LanReport("192.168.77.20", listOf(serverFp)), connected.first.lan)
            // Every listing carries it, so a lease that moves while the phone is connected is picked up.
            assertEquals(connected.first.lan, conn.listProjects().lan)
            // The blob is what it was: the projects still parse.
            assertEquals("Demo", connected.first.projects.single().name)
        }

        val record = PairedHost(
            id = "dev-1", name = "Box", host = "192.168.1.5", port = 22, user = "dev", sshAvailable = true,
            hostKeyB64 = h.str("hostPublicKeyB64"), relay = null, sshHostKeyFingerprint = oldFp, pairedAt = 1,
            sshHostKeyAnchors = listOf(oldFp)
        )
        // Before the refresh the server's new key is a changed key: refused over SSH, pin untouched.
        val before = RecordPin(record)
        val changed = assertFailsWith<HostKeyChangedException> { SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, before).close() }
        assertEquals(oldFp, before.record.sshHostKeyFingerprint)
        // The app goes on to the relay with the key it was refused, as SshFallback hands it on.
        val refused = assertIs<SshFallback.Next.TryRelay>(SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true)).refusedHostKey
        assertEquals(serverFp, refused)

        // A listing over SSH carries no report, and one that did would still not count.
        assertNull(LanRefresh.afterListing(record, TransportKind.SSH, connected.first, refused))
        // A report alone moves the address and the anchors, never a pin the phone has not seen fail
        // (review of A74-refresh: the report is what the desktop could read, not what sshd serves).
        val unrefused = assertNotNull(LanRefresh.afterListing(record, TransportKind.RELAY, connected.first, refusedHostKey = null))
        assertEquals(oldFp, unrefused.host.sshHostKeyFingerprint)
        assertNull(unrefused.confirmedKey)
        // The key the SSH leg was refused, confirmed by the computer: the pin gives way to it.
        val refreshed = assertNotNull(LanRefresh.afterListing(record, TransportKind.RELAY, connected.first, refused))
        assertTrue(refreshed.addressChanged)
        assertEquals(serverFp, refreshed.confirmedKey)
        assertEquals("192.168.77.20", refreshed.host.host)
        assertNull(refreshed.host.sshHostKeyFingerprint)
        assertEquals(listOf(serverFp), refreshed.host.sshHostKeyAnchors)

        // After it, the next connect accepts the key the computer confirmed, and pins exactly that one.
        val after = RecordPin(refreshed.host)
        SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, after).close()
        assertEquals(serverFp, after.record.sshHostKeyFingerprint)
        // The record now says what the computer says: the next listing changes nothing.
        assertNull(LanRefresh.afterListing(after.record, TransportKind.RELAY, connected.first, refused), "nothing left to refresh")
    }

    /**
     * Review of A74-refresh: the desktop reports every `ssh_host_*_key.pub` on disk, whether sshd serves
     * it or not. When sshd stops serving the pinned key (its `HostKey` line removed, `HostKeyAlgorithms`
     * narrowed) and the `.pub` stays, the pin is still among the reported keys while the server presents
     * another one of them. Dropping a pin only when it was missing from the report left SSH refused
     * there for good; the key the SSH leg was refused, confirmed by the computer, is what lets it in.
     */
    @Test
    fun `a pin the computer still reports but sshd no longer serves gives way to the key it serves (A74-refresh)`() = runBlocking<Unit> {
        val identity = SshIdentity.generate()
        val (sshd, servedKey) = sshServer(identity)
        val unserved = net.i2p.crypto.eddsa.KeyPairGenerator().generateKeyPair().public
        val unservedFp = SshHostConnection.fingerprint(unserved)
        val servedFp = SshHostConnection.fingerprint(servedKey)
        val h = start(extra = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to hostKeyDir("ed25519" to unserved, "ecdsa" to servedKey).path))
        val connected = connect(h)
        val reported = assertNotNull(connected.first.lan).sshHostKeyFingerprints
        connected.connection.use { assertEquals(setOf(unservedFp, servedFp), reported.toSet()) }
        // Paired while sshd served the ed25519 key: the pairing named the same two keys, and the first
        // connect pinned that one.
        val record = PairedHost(
            id = "dev-1", name = "Box", host = "127.0.0.1", port = sshd.port, user = "dev", sshAvailable = true,
            hostKeyB64 = h.str("hostPublicKeyB64"), relay = null, sshHostKeyFingerprint = unservedFp, pairedAt = 1,
            sshHostKeyAnchors = reported
        )
        val changed = assertFailsWith<HostKeyChangedException> { SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, RecordPin(record)).close() }
        val refused = assertIs<SshFallback.Next.TryRelay>(SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true)).refusedHostKey
        assertEquals(servedFp, refused)

        // The pin is among the reported keys, so a report alone keeps it, and SSH stays refused.
        assertNull(LanRefresh.afterListing(record, TransportKind.RELAY, connected.first, refusedHostKey = null))
        val refreshed = assertNotNull(LanRefresh.afterListing(record, TransportKind.RELAY, connected.first, refused))
        assertNull(refreshed.host.sshHostKeyFingerprint)
        assertEquals(servedFp, refreshed.confirmedKey)
        val after = RecordPin(refreshed.host)
        SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, after).close()
        assertEquals(servedFp, after.record.sshHostKeyFingerprint)
    }

    @Test
    fun `a computer whose keys did not change keeps its pin, and one that sends nothing changes nothing (A74-refresh)`() = runBlocking<Unit> {
        val identity = SshIdentity.generate()
        val (_, serverKey) = sshServer(identity)
        val serverFp = SshHostConnection.fingerprint(serverKey)
        val record = PairedHost(
            id = "dev-1", name = "Box", host = "192.168.1.5", port = 22, user = "dev", sshAvailable = true,
            hostKeyB64 = null, relay = null, sshHostKeyFingerprint = serverFp, pairedAt = 1
        )

        // Same keys, new lease: only the address moves.
        val moved = connect(start(extra = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to hostKeyDir("ecdsa" to serverKey).path, "FIXTURE_LAN_ADDRESS" to "192.168.1.6")))
        moved.connection.use {
            val r = assertNotNull(LanRefresh.afterListing(record, TransportKind.RELAY, moved.first, refusedHostKey = null))
            assertEquals(record.copy(host = "192.168.1.6", sshHostKeyAnchors = listOf(serverFp)), r.host)
            assertNull(r.confirmedKey)
        }

        // A desktop with no readable keys and no LAN address (offline Wi-Fi) reports nothing at all.
        val silent = connect(start())
        silent.connection.use {
            assertNull(silent.first.lan)
            assertNull(LanRefresh.afterListing(record, TransportKind.RELAY, silent.first, refusedHostKey = null))
        }

        // A desktop that predates the field: the same, and the listing is what it always was.
        val older = connect(start(extra = mapOf("FIXTURE_NO_LAN" to "1", "FIXTURE_LAN_ADDRESS" to "10.0.0.9")))
        older.connection.use {
            assertNull(older.first.lan)
            assertNull(LanRefresh.afterListing(record, TransportKind.RELAY, older.first, refusedHostKey = null))
            assertEquals("Demo", older.first.projects.single().name)
        }
    }
}
