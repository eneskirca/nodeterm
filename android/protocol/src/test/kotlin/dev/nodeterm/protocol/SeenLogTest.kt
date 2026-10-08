package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.SeenLog
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A48: each Inbox event is announced once — no hash-order eviction, no lost update. Its
 * follow-up: the log is kept per computer, since two computers can mint the same event id, while one
 * event that reaches the phone through two pairings (a desktop and the SSH host it drives) is still
 * announced once.
 */
class SeenLogTest {
    private class MemStorage(
        var raw: String? = null,
        var v2: String? = null,
        var legacy: Set<String>? = null
    ) : SeenLog.Storage {
        var writes = 0
        override fun read(): String? = raw
        override fun readV2(): String? = v2
        override fun readLegacy(): Set<String>? = legacy
        override fun write(encoded: String) {
            raw = encoded
            v2 = null
            legacy = null
            writes++
        }
    }

    private class Clock(var now: Long) : () -> Long {
        override fun invoke(): Long = now
    }

    private val hour = 3_600_000L
    private val t0 = 1_800_000_000_000L

    /** The computer most cases run on, and a second one. */
    private val h = "host-a"
    private val other = "host-b"

    private fun ev(id: String, ts: Long, resolved: Boolean = false, kind: InboxKind = InboxKind.APPROVAL, node: String = "n1") = InboxEvent(
        id = id, ts = ts, nodeId = node, agentId = "claude", sessionId = null, kind = kind, title = "t",
        detail = null, interrupted = false, resolved = resolved, options = emptyList(), multiSelect = false, pendingId = null
    )

    private fun stored(storage: MemStorage, now: Long): SeenLog.Entries = SeenLog.decode(storage.raw ?: "{}", now)

    private fun ids(events: List<InboxEvent>) = events.map { it.id }

    // --- Per computer ------------------------------------------------------------------------------

    @Test
    fun `the same event id from two computers is announced for each, once`() {
        // Desktop ids are `${ts}-${seq}` with a per-run seq: two computers mint `<ts>-3` alike, each
        // for a node of its own.
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        val mine = ev("$t0-3", t0, node = "n1")
        val theirs = ev("$t0-3", t0, node = "n2")
        assertEquals(listOf(mine.id), ids(log.claimAnnounceable(h, listOf(mine))))
        assertEquals(listOf(theirs.id), ids(log.claimAnnounceable(other, listOf(theirs))), "one computer's event silenced another's")
        clock.now += 60_000
        assertEquals(emptyList(), log.claimAnnounceable(h, listOf(mine)))
        assertEquals(emptyList(), log.claimAnnounceable(other, listOf(theirs)))
    }

    @Test
    fun `the live check, too, decides each computer on its own`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        val mine = ev("$t0-1", t0, node = "n1")
        val theirs = ev("$t0-1", t0, node = "n2")
        // On screen on one computer (its Inbox tab), off screen on the other.
        assertEquals(emptyList(), log.claimLive(h, listOf(mine), OnScreen(inbox = true), notify = true))
        assertEquals(listOf(theirs.id), ids(log.claimLive(other, listOf(theirs), OnScreen.NOTHING, notify = true)))
        assertTrue(log.isSeen(h, mine) && log.isSeen(other, theirs))
    }

    @Test
    fun `reading an event on one computer does not mark another's`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        log.markSeen(h, listOf(ev("e", t0, node = "n1")))
        assertTrue(log.isSeen(h, ev("e", t0, node = "n1")))
        assertFalse(log.isSeen(other, ev("e", t0, node = "n2")))
        assertEquals(listOf("e"), ids(log.claimAnnounceable(other, listOf(ev("e", t0, node = "n2")))))
    }

    // --- One event, two pairings ---------------------------------------------------------------------

    @Test
    fun `one event reached through two pairings is announced once, by either check`() {
        // A desktop's listing carries its SSH project's node, and so does the slice it pushes to the
        // SSH host the phone also added (audit A27): the same id, the same node, under both.
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val event = ev("$t0-7", t0, node = "ssh-node")
        assertEquals(listOf(event.id), ids(log.claimAnnounceable(h, listOf(event))))
        assertEquals(emptyList(), log.claimAnnounceable(other, listOf(event)), "announced a second time under the other pairing")
        assertEquals(emptyList(), log.claimLive(other, listOf(event), OnScreen.NOTHING, notify = true))
        // The other way round, through the live check.
        val next = ev("$t0-8", t0, node = "ssh-node")
        assertEquals(listOf(next.id), ids(log.claimLive(other, listOf(next), OnScreen.NOTHING, notify = true)))
        assertEquals(emptyList(), log.claimAnnounceable(h, listOf(next)))
        // Met that way, it is recorded under the other pairing too: forgetting the first one does
        // not announce it again.
        assertEquals(setOf(event.id, next.id), stored(storage, t0).ids(other))
        assertEquals(setOf(event.id, next.id), stored(storage, t0).ids(h))
        log.forgetHost(h)
        clock.now += 60_000
        assertEquals(emptyList(), log.claimAnnounceable(other, listOf(event, next)))
    }

    @Test
    fun `reading or seeing one event under one pairing keeps the other pairing quiet`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        // Read on the desktop's Inbox tab.
        log.markSeen(h, listOf(ev("read", t0, node = "ssh-node")))
        assertTrue(log.isSeen(other, ev("read", t0, node = "ssh-node")))
        assertEquals(emptyList(), log.claimAnnounceable(other, listOf(ev("read", t0, node = "ssh-node"))))
        // Its pane open from the desktop (HostSession.notePaneShown).
        log.claimLive(h, listOf(ev("pane", t0, node = "ssh-node")), OnScreen(nodes = setOf("ssh-node")), notify = false)
        assertEquals(emptyList(), log.claimLive(other, listOf(ev("pane", t0, node = "ssh-node")), OnScreen.NOTHING, notify = true))
        // On the Inbox tab of the other pairing: recorded there, so neither announces it.
        log.claimLive(other, listOf(ev("tab", t0, node = "ssh-node")), OnScreen(inbox = true), notify = true)
        assertEquals(emptyList(), log.claimAnnounceable(h, listOf(ev("tab", t0, node = "ssh-node"))))
    }

    @Test
    fun `an entry that names no node counts under its own computer only`() {
        // As the build before nodes were kept wrote it: a bare time under the computer.
        val storage = MemStorage(raw = """{"hosts":{"host-a":{"x":$t0}}}""")
        val log = SeenLog(storage, Clock(t0))
        assertTrue(log.isSeen(h, ev("x", t0)))
        assertFalse(log.isSeen(other, ev("x", t0)))
        assertEquals(listOf("x"), ids(log.claimAnnounceable(other, listOf(ev("x", t0)))))
        assertEquals(SeenLog.Seen(t0, null), stored(storage, t0).hosts[h]?.get("x"))
    }

    @Test
    fun `forgetting a computer drops its entries and only its own`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(h, listOf(ev("a", t0)))
        log.markSeen(other, listOf(ev("b", t0)))
        log.forgetHost(h)
        assertEquals(emptySet(), stored(storage, t0).ids(h))
        assertNull(stored(storage, t0).hosts[h], "a forgotten computer keeps an empty part")
        assertEquals(setOf("b"), stored(storage, t0).ids(other))
        // Forgetting what is not there writes nothing.
        val writes = storage.writes
        log.forgetHost("never-paired")
        log.forgetHost(h)
        assertEquals(writes, storage.writes)
    }

    @Test
    fun `a computer paired again keeps what the phone saw of it, the later anchor winning`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(other, listOf(ev("both", t0), ev("theirs", t0)))
        log.markSeen(h, listOf(ev("a", t0)))
        clock.now = t0 + hour
        log.markSeen(h, listOf(ev("both", t0)))
        log.moveHost(h, other)
        assertEquals(emptyList(), log.claimAnnounceable(other, listOf(ev("a", t0), ev("both", t0))))
        assertEquals<Map<String, Long>?>(
            mapOf("both" to t0 + hour, "theirs" to t0, "a" to t0),
            stored(storage, clock.now).anchors(other)
        )
        assertNull(stored(storage, clock.now).hosts[h])
        // Onto itself, or from nothing: no change, nothing written.
        val writes = storage.writes
        log.moveHost(other, other)
        log.moveHost("gone", other)
        assertEquals(writes, storage.writes)
        assertEquals(setOf("a", "both", "theirs"), stored(storage, clock.now).ids(other))
    }

    @Test
    fun `a computer paired again keeps the node an entry names`() {
        // The new pairing's entry for `x` names no node (written before nodes were kept), the old
        // one's does: the merged entry keeps it, so the other pairing still recognises the event.
        val storage = MemStorage(raw = """{"hosts":{"old":{"x":{"t":${t0 + hour},"n":"n7"}},"new":{"x":$t0}}}""")
        val log = SeenLog(storage, Clock(t0))
        log.moveHost("old", "new")
        assertEquals(SeenLog.Seen(t0 + hour, "n7"), stored(storage, t0).hosts["new"]?.get("x"))
        assertTrue(log.isSeen(other, ev("x", t0, node = "n7")))
    }

    // --- Migration -----------------------------------------------------------------------------------

    @Test
    fun `the phone-wide A48 log migrates as seen for every computer, announces nothing, then ages out`() {
        val clock = Clock(t0)
        val storage = MemStorage(v2 = SeenLog.encodeIds(mapOf("a" to t0 - hour, "b" to t0)).toString(), legacy = setOf("old"))
        val log = SeenLog(storage, clock)
        val feed = listOf(ev("a", t0 - hour), ev("b", t0), ev("c", t0))
        assertEquals(listOf("c"), ids(log.claimAnnounceable(h, feed)))
        // Another computer's events of the same ids (its own nodes): the shared ones count for it too.
        val theirs = feed.map { it.copy(nodeId = "n2") }
        assertEquals(listOf("c"), ids(log.claimAnnounceable(other, theirs)), "an upgrade re-announced an event the phone had seen")
        assertNull(storage.v2, "the A48 log is dropped in the same write")
        assertNull(storage.legacy)
        val after = stored(storage, t0)
        assertEquals(mapOf("a" to t0 - hour, "b" to t0), after.shared, "the anchors carry over unchanged")
        assertEquals(setOf("c"), after.ids(h))
        // New records go to their computer, never to the shared part.
        log.markSeen(h, listOf(ev("a", t0)))
        assertEquals(setOf("a", "c"), stored(storage, t0).ids(h))
        assertEquals(setOf("a", "b"), stored(storage, t0).shared.keys)
        // Forgetting a computer cannot drop the shared entries, which belong to no computer.
        log.forgetHost(other)
        assertTrue(log.isSeen(other, ev("b", t0)))
        // They age out on their own anchors: `a` one retention period after t0 - 1 h, `b` after t0.
        clock.now = t0 - hour + SeenLog.RETENTION_MS + 1
        log.markSeen(h, listOf(ev("d", clock.now)))
        assertEquals(setOf("b"), stored(storage, clock.now).shared.keys)
        assertTrue(log.isSeen(h, ev("a", t0)), "its own entry outlives the shared one")
        assertFalse(log.isSeen(other, ev("a", t0, node = "n2")))
        clock.now = t0 + SeenLog.RETENTION_MS + 1
        log.markSeen(h, listOf(ev("e", clock.now)))
        assertEquals(emptyMap(), stored(storage, clock.now).shared)
        assertFalse(storage.raw!!.contains("shared"), "an empty shared part is left out")
    }

    @Test
    fun `the pre-A48 id set migrates as seen now for every computer, announces nothing, then ages out`() {
        val clock = Clock(t0)
        val storage = MemStorage(legacy = setOf("a", "b"))
        val log = SeenLog(storage, clock)
        val feed = listOf(ev("a", t0 - hour), ev("b", t0 - 2 * hour), ev("c", t0))
        assertEquals(listOf("c"), ids(log.claimAnnounceable(h, feed)))
        assertEquals(listOf("c"), ids(log.claimAnnounceable(other, feed.map { it.copy(nodeId = "n2") })))
        assertNull(storage.legacy, "the legacy set is dropped in the same write")
        assertEquals(mapOf("a" to t0, "b" to t0), stored(storage, t0).shared)
        assertEquals<Map<String, Long>?>(mapOf("c" to t0), stored(storage, t0).anchors(h))
        clock.now = t0 + SeenLog.RETENTION_MS + 1
        log.markSeen(h, listOf(ev("d", clock.now)))
        assertEquals(emptyMap(), stored(storage, clock.now).shared)
        assertEquals(setOf("d"), stored(storage, clock.now).ids(h))
    }

    @Test
    fun `an older log is migrated by a read too, once`() {
        val storage = MemStorage(v2 = """{"a":$t0}""")
        val log = SeenLog(storage, Clock(t0))
        assertTrue(log.isSeen(h, ev("a", t0)))
        assertTrue(log.isSeen(other, ev("a", t0)))
        assertEquals(1, storage.writes)
        assertNull(storage.v2)
        val legacy = MemStorage(legacy = setOf("a"))
        val fromSet = SeenLog(legacy, Clock(t0))
        assertTrue(fromSet.isSeen(h, ev("a", t0)))
        assertTrue(fromSet.isSeen(h, ev("a", t0)))
        assertEquals(1, legacy.writes)
        assertNull(legacy.legacy)
    }

    @Test
    fun `the current log wins over an older one left beside it`() {
        val storage = MemStorage(raw = """{"hosts":{"host-a":{"x":$t0}}}""", v2 = """{"y":$t0}""", legacy = setOf("z"))
        val log = SeenLog(storage, Clock(t0))
        assertTrue(log.isSeen(h, ev("x", t0)))
        assertFalse(log.isSeen(h, ev("y", t0)))
        assertFalse(log.isSeen(h, ev("z", t0)))
        assertEquals(0, storage.writes)
    }

    // --- A48: what is kept, and for how long ----------------------------------------------------------

    @Test
    fun `an event is claimed once, and a read one is never claimed`() {
        val clock = Clock(t0)
        val log = SeenLog(MemStorage(), clock)
        log.markSeen(h, listOf(ev("read", t0 - hour)))
        val feed = listOf(ev("read", t0 - hour), ev("a", t0 - hour), ev("b", t0))
        assertEquals(listOf("a", "b"), ids(log.claimAnnounceable(h, feed)))
        clock.now += 60_000
        assertEquals(emptyList(), log.claimAnnounceable(h, feed))
        assertTrue(log.isSeen(h, ev("a", t0)) && log.isSeen(h, ev("b", t0)) && log.isSeen(h, ev("read", t0)))
    }

    @Test
    fun `only unresolved events inside the announce window are claimed`() {
        val log = SeenLog(MemStorage(), Clock(t0))
        val feed = listOf(
            ev("old", t0 - SeenLog.ANNOUNCE_WINDOW_MS),
            ev("resolved", t0 - hour, resolved = true),
            ev("recent", t0 - SeenLog.ANNOUNCE_WINDOW_MS + 1),
            ev("ahead", t0 + 3 * hour),
            ev("ancient", Long.MIN_VALUE)
        )
        assertEquals(listOf("recent", "ahead"), ids(log.claimAnnounceable(h, feed)))
        assertFalse(log.isSeen(h, ev("old", t0)))
        assertFalse(log.isSeen(h, ev("resolved", t0)))
    }

    @Test
    fun `a busy phone never evicts an event that could still be announced`() {
        // The old trim kept `takeLast(500)` of a HashSet: the 501st id evicted an arbitrary one.
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val first = ev("first", t0)
        assertEquals(1, log.claimAnnounceable(h, listOf(first)).size)
        for (i in 0 until 1_000) {
            clock.now = t0 + i * 1_000L
            log.markSeen(if (i % 2 == 0) h else other, listOf(ev("e$i", clock.now)))
        }
        clock.now = t0 + 5 * hour
        assertEquals(emptyList(), log.claimAnnounceable(h, listOf(first)), "re-announced a still-eligible event")
        assertEquals(1_001, stored(storage, clock.now).size)
    }

    @Test
    fun `entries age out one retention period after their anchor`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(h, listOf(ev("a", t0 - hour)))
        log.markSeen(other, listOf(ev("o", t0 - hour)))
        clock.now = t0 + SeenLog.RETENTION_MS
        log.markSeen(h, listOf(ev("b", clock.now)))
        assertEquals(setOf("a", "b"), stored(storage, clock.now).ids(h), "pruned at the boundary")
        clock.now += 1
        log.markSeen(h, listOf(ev("c", clock.now)))
        assertEquals(setOf("b", "c"), stored(storage, clock.now).ids(h))
        assertNull(stored(storage, clock.now).hosts[other], "a computer whose entries all aged out keeps an empty part")
    }

    @Test
    fun `a desktop clock running ahead keeps its event until the event itself is too old`() {
        // Seen at t0, but the event is stamped 20 h ahead: it stays announceable until ts + 6 h,
        // i.e. t0 + 26 h, past t0 + RETENTION (24 h). The anchor must carry the event's ts.
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        val ahead = ev("ahead", t0 + 20 * hour)
        assertEquals(1, log.claimAnnounceable(h, listOf(ahead)).size)
        clock.now = t0 + 25 * hour
        log.markSeen(h, listOf(ev("other", clock.now)))
        assertTrue(SeenLog.announceable(ahead, clock.now))
        assertEquals(emptyList(), log.claimAnnounceable(h, listOf(ahead)))
    }

    @Test
    fun `seeing an event again moves its anchor forward, never back`() {
        val clock = Clock(t0)
        val storage = MemStorage()
        val log = SeenLog(storage, clock)
        log.markSeen(h, listOf(ev("a", t0 + 10 * hour)))
        clock.now = t0 + hour
        log.markSeen(h, listOf(ev("a", t0 + 10 * hour)))
        assertEquals(t0 + 10 * hour, stored(storage, clock.now).anchors(h)?.get("a"))
        clock.now = t0 + 12 * hour
        log.markSeen(h, listOf(ev("a", t0 + 10 * hour)))
        assertEquals(t0 + 12 * hour, stored(storage, clock.now).anchors(h)?.get("a"))
    }

    @Test
    fun `an unreadable log is empty and an unreadable time counts as seen now`() {
        assertEquals(0, SeenLog.decode("not json", t0).size)
        assertEquals(0, SeenLog.decode("[1,2]", t0).size)
        val messy = SeenLog.decode(
            """{"hosts":{"h":{"a":5,"b":"x","noded":{"t":6,"n":"n9"},"badTime":{"t":"x","n":7},"noTime":{"n":"n1"},"list":[]},"bad":[1],"s":"x"},"shared":{"c":"x","d":7}}""",
            t0
        )
        assertEquals(setOf("h"), messy.hosts.keys)
        assertEquals<Map<String, SeenLog.Seen>?>(
            mapOf(
                "a" to SeenLog.Seen(5, null),
                "b" to SeenLog.Seen(t0, null),
                "noded" to SeenLog.Seen(6, "n9"),
                "badTime" to SeenLog.Seen(t0, null),
                "noTime" to SeenLog.Seen(t0, "n1"),
                "list" to SeenLog.Seen(t0, null)
            ),
            messy.hosts["h"]
        )
        assertEquals(mapOf("c" to t0, "d" to 7L), messy.shared)
        assertEquals(0, SeenLog.decode("""{"hosts":"x","shared":[1]}""", t0).size)
        val round = SeenLog.decode(SeenLog.encode(messy), t0)
        assertEquals(messy.hosts, round.hosts)
        assertEquals(messy.shared, round.shared)
        assertEquals(mapOf("a" to 5L, "b" to t0), SeenLog.decodeIds("""{"a":5,"b":"x"}""", t0))
        assertEquals(emptyMap(), SeenLog.decodeIds("not json", t0))
    }

    @Test
    fun `the memory backstop drops the oldest anchors across computers, not arbitrary ones`() {
        val clock = Clock(t0)
        val storage = MemStorage(v2 = """{"s0":${t0 - 1}}""")
        val log = SeenLog(storage, clock, maxEntries = 3)
        for (i in 0 until 5) {
            clock.now = t0 + i * 1_000L
            log.markSeen(if (i % 2 == 0) h else other, listOf(ev("e$i", clock.now)))
        }
        val kept = stored(storage, clock.now)
        assertEquals(setOf("e2", "e4"), kept.ids(h))
        assertEquals(setOf("e3"), kept.ids(other))
        assertEquals(emptyMap(), kept.shared)
    }

    @Test
    fun `concurrent callers do not lose each other's writes`() {
        // Deterministic: the first read waits (briefly) for a second reader. Without the lock the
        // second caller reads the same state and one write overwrites the other; with it the second
        // caller is still waiting for the lock, so the first times out, writes, and the second
        // reads that write.
        val storage = object : SeenLog.Storage {
            @Volatile var raw: String? = null
            val readers = CountDownLatch(2)
            val reads = AtomicInteger()
            override fun read(): String? {
                if (reads.incrementAndGet() <= 2) {
                    readers.countDown()
                    readers.await(500, TimeUnit.MILLISECONDS)
                }
                return raw
            }
            override fun readV2(): String? = null
            override fun readLegacy(): Set<String>? = null
            override fun write(encoded: String) {
                raw = encoded
            }
        }
        val log = SeenLog(storage, { t0 })
        val a = thread { log.markSeen(h, listOf(ev("a", t0))) }
        val b = thread { log.markSeen(other, listOf(ev("b", t0))) }
        a.join()
        b.join()
        val kept = SeenLog.decode(storage.raw!!, t0)
        assertEquals(setOf("a"), kept.ids(h))
        assertEquals(setOf("b"), kept.ids(other))
    }

    // --- The wiring, pinned in the app's source -----------------------------------------------------

    private val store get() = AppSourcePins.app("data/HostStore.kt")

    @Test
    fun `every caller names the computer its events came from`() {
        // A listing announces under the computer it listed.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(AppSourcePins.app("notify/InboxNotifier.kt"), "fun announce("),
            "graph.hosts.claimLive(host.id, snapshot.status?.inbox?.events.orEmpty(), onScreen, notify)"
        )
        val connections = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(connections.contains("class HostSession(val hostId: String"))
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "fun notePaneShown(nodeId: String)"),
            "graph.hosts.claimLive(hostId, events, OnScreen(nodes = setOf(nodeId)), notify = false)"
        )
        // A merged feed holds cards of several computers: each is marked under its own.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(AppSourcePins.ui("InboxTab.kt"), "fun InboxFeedList("),
            "LaunchedEffect(feed.actionable.map { it.key })",
            "feed.actionable.groupBy({ it.hostId }, { it.event })",
            "graph.hosts.markSeen(hostId, events)"
        )
        // Reading a finished session in its terminal.
        assertTrue(AppSourcePins.ui("TerminalController.kt").contains("graph.hosts.markSeen(session.hostId, listOf(ev))"))
        // Nothing records for a computer no longer paired.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(store, "fun markSeen(hostId: String"), "if (get(hostId) == null) return", "seenLog.markSeen(hostId, events)")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "fun claimLive(hostId: String"),
            "if (get(hostId) == null) return emptyList()",
            "seenLog.claimLive(hostId, events, onScreen, notify)"
        )
    }

    @Test
    fun `forgetting a computer drops its log, and pairing it again carries it over`() {
        val removeSignature = "fun remove(id: String, successor: String? = null, removeToken: () -> Unit = {})"
        assertTrue(store.contains(removeSignature))
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store.substringAfter(removeSignature), ""),
            "null -> seenLog.forgetHost(id)",
            "id -> Unit",
            "else -> seenLog.moveHost(id, successor)"
        )
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(store, "fun upsert(host: PairedHost)"), "for (old in replaced) seenLog.moveHost(old.id, host.id)")
        // Forget (the computers list) passes no successor; pairing the same computer again does.
        val hosts = AppSourcePins.ui("HostsScreen.kt")
        assertTrue(hosts.contains("graph.hosts.remove(host.id) { graph.secure.remove(SecureStore.relayTokenKey(host.id)) }"), "Forget no longer drops the computer's seen log")
        val pair = AppSourcePins.ui("PairScreen.kt")
        AppSourcePins.assertInOrder(pair, "PairedHostReplacement.retired(graph.hosts.hosts.value, host, previous)",
            "graph.hosts.publishPairing(host, previous")
        // The current log is v3; both older formats are read once and removed by the same edit.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "private val seenLog: SeenLog = SeenLog(object : SeenLog.Storage"),
            "prefs.getString(SEEN_LOG_KEY, null)",
            "prefs.getString(V2_SEEN_KEY, null)",
            "prefs.getStringSet(LEGACY_SEEN_KEY, null)",
            "prefs.edit().putString(SEEN_LOG_KEY, encoded).remove(V2_SEEN_KEY).remove(LEGACY_SEEN_KEY).apply()"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "private companion object"),
            "const val SEEN_LOG_KEY = \"seenEvents.v3\"",
            "const val V2_SEEN_KEY = \"seenEvents.v2\"",
            "const val LEGACY_SEEN_KEY = \"seenEvents\""
        )
    }
}
