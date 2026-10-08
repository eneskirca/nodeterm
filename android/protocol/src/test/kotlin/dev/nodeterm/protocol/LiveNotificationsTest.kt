package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.OnScreenTracker
import dev.nodeterm.protocol.model.SeenLog
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * A73: notifications were documented as live every 8 s while a computer is open, but only the
 * 15-minute background check ever posted one; the in-app refresh only updated the listing. Now every
 * fresh listing of a computer runs the one announce path, so notifications are live for the computer
 * whose screen is open, minus what the user is looking at: every event while that computer's Inbox
 * tab is on screen, and what the pane of a session attached in a terminal shows. Those are recorded as
 * seen, so no later check announces them. Other computers are not polled, and the copy now says so.
 * The review of A73 narrowed "a terminal is open" to what its pane shows: not a held hook-reply
 * approval (its prompt is not painted while held), nothing while an overlay covers the pane, and
 * nothing decided yet while the terminal is still connecting.
 *
 * The decision ([OnScreen], [SeenLog.claimLive]) and the screen bookkeeping ([OnScreenTracker]) are
 * pure and tested here. The wiring (the listing announces, the screens register while started, the
 * copy) cannot run on a JVM, so it is pinned in the app's source ([AppSourcePins]); whether a
 * notification appears on a phone is a device check.
 */
class LiveNotificationsTest {
    private class MemStorage : SeenLog.Storage {
        var raw: String? = null
        var reads = 0
        var writes = 0
        override fun read(): String? = raw.also { reads++ }
        override fun readV2(): String? = null
        override fun readLegacy(): Set<String>? = null
        override fun write(encoded: String) {
            raw = encoded
            writes++
        }
    }

    private class Clock(var now: Long) : () -> Long {
        override fun invoke(): Long = now
    }

    private val hour = 3_600_000L
    private val t0 = 1_800_000_000_000L

    /** The computer whose listings these are (the log is kept per computer; see SeenLogTest). */
    private val computer = "host-a"

    private fun ev(
        id: String,
        nodeId: String = "n1",
        ts: Long = t0,
        kind: InboxKind = InboxKind.APPROVAL,
        resolved: Boolean = false,
        pendingId: String? = null
    ) = InboxEvent(
        id = id, ts = ts, nodeId = nodeId, agentId = "claude", sessionId = null, kind = kind, title = "t",
        detail = null, interrupted = false, resolved = resolved, options = emptyList(), multiSelect = false, pendingId = pendingId
    )

    /** A held hook-reply approval: it carries its ticket, and its prompt is not painted while held. */
    private fun held(id: String, nodeId: String = "n1", ts: Long = t0) = ev(id, nodeId, ts, pendingId = "$nodeId-$ts-1")

    private fun ids(events: List<InboxEvent>) = events.map { it.id }

    // --- What is on screen ---------------------------------------------------------------------

    @Test
    fun `with nothing on screen the whole feed may be announced`() {
        val feed = listOf(ev("a", "n1"), ev("b", "n2", kind = InboxKind.DONE))
        val split = OnScreen.NOTHING.split(feed)
        assertEquals(emptyList(), split.shown)
        assertEquals(listOf("a", "b"), ids(split.offScreen))
    }

    @Test
    fun `while the Inbox tab shows, every event of that computer is on screen`() {
        // Questions and approvals are its cards; a finish is in its archive. None is announced.
        val feed = listOf(ev("a", "n1"), ev("q", "n2", kind = InboxKind.QUESTION), ev("d", "n3", kind = InboxKind.DONE))
        val split = OnScreen(inbox = true).split(feed)
        assertEquals(listOf("a", "q", "d"), ids(split.shown))
        assertEquals(emptyList(), split.offScreen)
    }

    @Test
    fun `a session open in a terminal hides only its own events, in feed order`() {
        val feed = listOf(ev("a", "open"), ev("b", "other"), ev("c", "open", kind = InboxKind.DONE), ev("d", "other"))
        val split = OnScreen(nodes = setOf("open")).split(feed)
        assertEquals(listOf("a", "c"), ids(split.shown))
        assertEquals(listOf("b", "d"), ids(split.offScreen))
        assertTrue(OnScreen(nodes = setOf("open")).shows(ev("x", "open")))
        assertFalse(OnScreen(nodes = setOf("open")).shows(ev("x", "other")))
    }

    @Test
    fun `a held approval is not in its session's pane, so an open terminal does not hide it`() {
        // docs/hook-reply-approvals.md: Claude applies the hook's decision before it paints the prompt,
        // so while the hook holds the request the pane shows no prompt (a subagent's concurrent
        // approval rides the parent node, whose pane shows the parent's question).
        assertFalse(OnScreen.inPane(held("h")))
        assertTrue(OnScreen.inPane(ev("keyed")), "an approval with no ticket is a prompt in the pane")
        assertTrue(OnScreen.inPane(ev("q", kind = InboxKind.QUESTION)))
        assertTrue(OnScreen.inPane(ev("d", kind = InboxKind.DONE)))
        val onScreen = OnScreen(nodes = setOf("open"))
        val feed = listOf(held("h", "open"), ev("keyed", "open"), ev("q", "open", kind = InboxKind.QUESTION), ev("d", "open", kind = InboxKind.DONE))
        val split = onScreen.split(feed)
        assertEquals(listOf("keyed", "q", "d"), ids(split.shown))
        assertEquals(listOf("h"), ids(split.offScreen))
        // The Inbox tab lists it as a card with its buttons: there it IS on screen.
        assertTrue(OnScreen(inbox = true).shows(held("h", "open")))
    }

    @Test
    fun `a held approval of the open session is announced, and not recorded as seen until it is`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val onScreen = OnScreen(nodes = setOf("open"))
        val feed = listOf(held("h", "open"), ev("keyed", "open"))
        // Notifications off: the prompt in the pane is recorded, the held approval is not spent.
        assertEquals(emptyList(), log.claimLive(computer, feed, onScreen, notify = false))
        assertTrue(log.isSeen(computer, ev("keyed")))
        assertFalse(log.isSeen(computer, ev("h")), "a held approval nobody could see was recorded as seen")
        // Notifications on: announced once, whether the terminal is still open or the user left it.
        clock.now += 8_000
        assertEquals(listOf("h"), ids(log.claimLive(computer, feed, onScreen, notify = true)))
        clock.now += 8_000
        assertEquals(emptyList(), log.claimLive(computer, feed, onScreen, notify = true))
        assertEquals(emptyList(), log.claimAnnounceable(computer, feed))
    }

    @Test
    fun `a terminal still connecting leaves its session's events for a later listing`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val opening = OnScreen(opening = setOf("open"))
        val feed = listOf(ev("q", "open", kind = InboxKind.QUESTION), held("h", "open"), ev("other", "n2"))
        val split = opening.split(feed)
        assertEquals(listOf("q"), ids(split.waiting))
        assertEquals(listOf("h", "other"), ids(split.offScreen), "a held approval is not in the pane about to show")
        assertEquals(emptyList(), split.shown)
        assertEquals(listOf("h", "other"), ids(log.claimLive(computer, feed, opening, notify = true)))
        assertFalse(log.isSeen(computer, ev("q")), "a pane that never showed was recorded as seen")
        // The attach failed and an overlay covers the pane: the next listing announces it.
        clock.now += 8_000
        assertEquals(listOf("q"), ids(log.claimLive(computer, feed, OnScreen.NOTHING, notify = true)))
    }

    @Test
    fun `once the terminal attaches, its pane is recorded from the latest listing, and leaving announces nothing`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val feed = listOf(ev("d", "open", kind = InboxKind.DONE), held("h", "open"))
        assertEquals(listOf("h"), ids(log.claimLive(computer, feed, OnScreen(opening = setOf("open")), notify = true)))
        // HostSession.notePaneShown, on the attach: records what the pane shows, announces nothing.
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen(nodes = setOf("open")), notify = false))
        assertTrue(log.isSeen(computer, ev("d")))
        // The user looked and left before the next refresh: nothing about it afterwards.
        clock.now += 3_000
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen.NOTHING, notify = true))
        assertEquals(emptyList(), log.claimAnnounceable(computer, feed))
    }

    // --- One check of a fresh listing -----------------------------------------------------------

    @Test
    fun `nothing on screen claims exactly what the background check claims`() {
        val feed = listOf(
            ev("a", ts = t0 - hour),
            ev("old", ts = t0 - SeenLog.ANNOUNCE_WINDOW_MS),
            ev("resolved", resolved = true),
            ev("b", "n2")
        )
        val live = SeenLog(MemStorage(), Clock(t0))
        val background = SeenLog(MemStorage(), Clock(t0))
        assertEquals(ids(background.claimAnnounceable(computer, feed)), ids(live.claimLive(computer, feed, OnScreen.NOTHING, notify = true)))
        assertEquals(listOf("a", "b"), ids(SeenLog(MemStorage(), Clock(t0)).claimLive(computer, feed, OnScreen.NOTHING, notify = true)))
    }

    @Test
    fun `an event shown on the Inbox tab is never announced, by this check or a later one`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val feed = listOf(ev("a", "n1"), ev("d", "n2", kind = InboxKind.DONE))
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen(inbox = true), notify = true))
        // The user left the tab (or the app): the next refresh and the background check stay quiet.
        clock.now += 60_000
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen.NOTHING, notify = true))
        assertEquals(emptyList(), log.claimAnnounceable(computer, feed))
        // Something new after that is announced, once.
        val next = feed + ev("b", "n1", ts = clock.now)
        assertEquals(listOf("b"), ids(log.claimLive(computer, next, OnScreen.NOTHING, notify = true)))
        assertEquals(emptyList(), log.claimLive(computer, next, OnScreen.NOTHING, notify = true))
    }

    @Test
    fun `with a terminal open, its session is recorded and another session is announced once`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val onScreen = OnScreen(nodes = setOf("open"))
        val feed = listOf(ev("mine", "open"), ev("theirs", "other"))
        assertEquals(listOf("theirs"), ids(log.claimLive(computer, feed, onScreen, notify = true)))
        clock.now += 8_000
        assertEquals(emptyList(), log.claimLive(computer, feed, onScreen, notify = true))
        // Back from the terminal: what it showed was seen there.
        assertEquals(emptyList(), log.claimAnnounceable(computer, feed))
        assertTrue(log.isSeen(computer, ev("mine")))
    }

    @Test
    fun `with notifications off nothing is claimed, but what is on screen is still recorded`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        val feed = listOf(ev("shown", "open"), ev("offscreen", "other"))
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen(nodes = setOf("open")), notify = false))
        assertTrue(log.isSeen(computer, ev("shown")))
        assertFalse(log.isSeen(computer, ev("offscreen")), "an event nobody saw was spent while notifications were off")
        // Turned on later: only what the user never looked at is announced.
        assertEquals(listOf("offscreen"), ids(log.claimLive(computer, feed, OnScreen.NOTHING, notify = true)))
    }

    @Test
    fun `the 8 s check writes only what is new and could still be announced`() {
        val storage = MemStorage()
        val clock = Clock(t0)
        val log = SeenLog(storage, clock)
        val feed = listOf(
            ev("a", "n1"),
            ev("resolved", "n1", resolved = true),
            ev("old", "n1", ts = t0 - SeenLog.ANNOUNCE_WINDOW_MS)
        )
        assertEquals(emptyList(), log.claimLive(computer, feed, OnScreen(inbox = true), notify = true))
        assertEquals(1, storage.writes)
        assertEquals(setOf("a"), SeenLog.decode(storage.raw!!, clock.now).ids(computer))
        // The same tab, ten refreshes later: nothing new, nothing written, the anchor unmoved.
        repeat(10) {
            clock.now += 8_000
            log.claimLive(computer, feed, OnScreen(inbox = true), notify = true)
        }
        assertEquals(1, storage.writes)
        assertEquals(t0, SeenLog.decode(storage.raw!!, clock.now).anchors(computer)?.get("a"))
        // A feed with nothing announceable in it is not even read back.
        val reads = storage.reads
        assertEquals(emptyList(), log.claimLive(computer, listOf(feed[1], feed[2]), OnScreen.NOTHING, notify = true))
        assertEquals(reads, storage.reads)
        assertEquals(1, storage.writes)
    }

    // --- Which screens are showing ----------------------------------------------------------------

    @Test
    fun `screens are counted, so an overlapping start and stop keeps what is still showing`() {
        val tracker = OnScreenTracker()
        assertSame(OnScreen.NOTHING, tracker.now())
        val first = tracker.showInbox()
        val second = tracker.showInbox() // the next screen started before the last one stopped
        first.close()
        assertEquals(OnScreen(inbox = true), tracker.now())
        second.close()
        assertEquals(OnScreen.NOTHING, tracker.now())
    }

    @Test
    fun `a terminal's session is on screen until its last handle closes, and a handle closes once`() {
        val tracker = OnScreenTracker()
        val a = tracker.showNode("n1")
        val b = tracker.showNode("n1")
        val c = tracker.showNode("n2")
        assertEquals(OnScreen(nodes = setOf("n1", "n2")), tracker.now())
        a.close()
        a.close() // twice counts once: n1 is still open through b
        assertEquals(OnScreen(nodes = setOf("n1", "n2")), tracker.now())
        b.close()
        assertEquals(OnScreen(nodes = setOf("n2")), tracker.now())
        c.close()
        assertEquals(OnScreen.NOTHING, tracker.now())
    }

    @Test
    fun `what is reported is a copy, not a live view`() {
        val tracker = OnScreenTracker()
        val h = tracker.showNode("n1")
        val seen = tracker.now()
        h.close()
        assertEquals(setOf("n1"), seen.nodes)
    }

    @Test
    fun `a terminal counts only while its pane shows, and the tracker asks it at every listing`() {
        val tracker = OnScreenTracker()
        var pane = OnScreen.Pane.OPENING
        val h = tracker.showNode("n1") { pane }
        assertEquals(OnScreen(opening = setOf("n1")), tracker.now())
        pane = OnScreen.Pane.SHOWN
        assertEquals(OnScreen(nodes = setOf("n1")), tracker.now())
        pane = OnScreen.Pane.HIDDEN // an overlay over the pane: the session ended, an offer, a lost view
        assertSame(OnScreen.NOTHING, tracker.now())
        // Two terminals of one session: the one that shows it wins over the one still connecting.
        val other = tracker.showNode("n1") { OnScreen.Pane.SHOWN }
        pane = OnScreen.Pane.OPENING
        assertEquals(OnScreen(nodes = setOf("n1")), tracker.now())
        other.close()
        assertEquals(OnScreen(opening = setOf("n1")), tracker.now())
        h.close()
        assertSame(OnScreen.NOTHING, tracker.now())
    }

    // --- The wiring, pinned in the app's source -----------------------------------------------------

    private val connections get() = AppSourcePins.app("conn/ConnectionManager.kt")
    private val notifier get() = AppSourcePins.app("notify/InboxNotifier.kt")

    @Test
    fun `every listing that arrives announces, outside the listing's own failure handling`() {
        val refresh = AppSourcePins.blockAfter(connections, "suspend fun refreshNow(")
        // A notification the system refused must not read as a transport failure (that disconnects).
        AppSourcePins.assertInOrder(
            refresh,
            "val listed = try {",
            "c.listProjects().also {",
            "_snapshot.value = it",
            "} catch (e: Exception) {",
            "if (e !is HostException) disconnect()",
            "return",
            "runCatching { lifetime.whenCurrent(operation) { graph.announce(hostId, listed, onScreen.now(), quiet = reachableQuietly()) } }"
        )
        // The 8 s poll re-lists through it.
        assertTrue(connections.contains("private val foreground = ForegroundRefresh("))
        assertTrue(connections.contains("refresh = { trigger -> refreshNow(trigger) }"))
        assertTrue(connections.contains("pause = { delay(POLL_MS) }"))
        assertTrue(AppSourcePins.blockAfter(connections, "fun startWatching(").contains("foreground.start(initialTrigger)"))
        val graph = AppSourcePins.app("NodetermApp.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(graph, "fun announce(hostId: String, snapshot: ProjectsSnapshot, onScreen: OnScreen, quiet: Boolean)"),
            "InboxNotifier.announce(appContext, host, snapshot, onScreen, quiet)"
        )
    }

    @Test
    fun `a change pushed by a computer whose screen is closed is not re-listed live`() {
        // The connection outlives the screen (the review of A73): a computer the user left kept
        // announcing live through its pushes until the connection dropped or the worker ran, while the
        // copy promises live notifications only for the computer on screen. Like the reconnect.
        val adopt = AppSourcePins.blockAfter(connections, "private fun adopt(c: HostConnection, lease: HostLifetime.Lease)")
        AppSourcePins.assertInOrder(adopt, "if (reconnect && isWatched) foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn == null })", "delay(1_500)")
        assertTrue(adopt.contains("c.setOnChanged { if (lifetime.isCurrent(lease) && conn === c && isWatched) foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn === c }) }"), adopt)
        assertEquals(1, Regex("""\.setOnChanged\b""").findAll(connections).count(), "another connection re-lists on its pushes")
    }

    @Test
    fun `announce decides with what is on screen, and gates only the claim on the switch and permission`() {
        val announce = AppSourcePins.blockAfter(notifier, "fun announce(")
        AppSourcePins.assertInOrder(
            announce,
            "val notify = graph.hosts.notificationsEnabled && canPost(context) && permitted",
            "graph.hosts.claimLive(host.id, snapshot.status?.inbox?.events.orEmpty(), onScreen, notify)",
            "nm.notify("
        )
        // An early return on the switch would skip recording what is on screen.
        assertFalse(announce.contains("if (!graph.hosts.notificationsEnabled"), "announce returns before recording what is on screen:\n$announce")
        assertFalse(announce.contains("claimAnnounceable"), "announce ignores what is on screen:\n$announce")
    }

    @Test
    fun `the background check announces through the listing, not from a stale snapshot`() {
        val work = AppSourcePins.blockAfter(notifier, "override suspend fun doWork()")
        assertTrue(work.contains("session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND)"))
        assertFalse(work.contains("InboxNotifier.announce("), "the worker announces a second time, without what is on screen:\n$work")
    }

    @Test
    fun `the Inbox tab and the terminal say what they show while they are started`() {
        val inbox = AppSourcePins.ui("InboxTab.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(inbox, "LifecycleStartEffect(hostId)"),
            "val showing = session.onScreen.showInbox()",
            "onStopOrDispose { showing.close() }"
        )
        // Registered before the watch starts, so the first listing already knows; closed after it stops.
        // The terminal says at every listing whether its pane shows (the A73 review).
        val terminal = AppSourcePins.ui("TerminalScreen.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(terminal, "LifecycleStartEffect(controller)"),
            "val showing = session.onScreen.showNode(nodeId) { controller.pane }",
            "session.startWatching()",
            "onStopOrDispose {",
            "session.stopWatching()",
            "showing.close()"
        )
        // Attached shows the pane, connecting is about to, every overlay covers it.
        val pane = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "val pane: OnScreen.Pane")
        AppSourcePins.assertInOrder(
            pane,
            "TermState.Attached -> OnScreen.Pane.SHOWN",
            "TermState.Connecting -> OnScreen.Pane.OPENING",
            "else -> OnScreen.Pane.HIDDEN"
        )
        // On the attach, what the pane shows of the latest listing is recorded, and nothing announced.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(terminal, "LaunchedEffect(controller, pane)"),
            "if (pane == OnScreen.Pane.SHOWN) session.notePaneShown(nodeId)"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "fun notePaneShown(nodeId: String)"),
            "_snapshot.value.status?.inbox?.events",
            "graph.hosts.claimLive(hostId, events, OnScreen(nodes = setOf(nodeId)), notify = false)"
        )
    }

    @Test
    fun `the copy promises background checks and live listings for visible computers`() {
        val promise = "Checked about every 15 minutes in the background, and live while this computer or All computers is on screen"
        val settings = AppSourcePins.ui("SettingsScreen.kt")
        assertTrue(settings.contains("\"$promise.\""), "Settings does not say what is live")
        assertFalse(settings.contains("live while a computer is open"))
        val kdoc = notifier.replace(Regex("\\s*\\n\\s*\\*\\s*"), " ")
        assertTrue(kdoc.contains("checked about every 15 minutes in the background, and live while the computer or All computers is on screen"))
        val readme = File(InteropHarness.repoRoot, "android/README.md").readText().replace(Regex("\\s+"), " ")
        assertTrue(readme.contains("checked about every 15 minutes in the background (WorkManager's floor), and live while the computer or All computers is on screen"))
        assertFalse(readme.contains("live every 8 seconds while a computer is open"))
        assertTrue(AppSourcePins.ui("AllComputersScreen.kt").contains("session.startWatching(Trigger.AUTO)"))
    }
}
