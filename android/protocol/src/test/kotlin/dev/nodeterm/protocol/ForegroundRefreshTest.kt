package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ConnectionUsers
import dev.nodeterm.protocol.host.ForegroundRefresh
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import dev.nodeterm.protocol.host.RelayApprovalRefusedException
import dev.nodeterm.protocol.host.RelayApprovalTimeoutException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The same loop/ownership/serialization used by HostSession, with controllable network and ticks. */
class ForegroundRefreshTest {
    private class Computer(scope: CoroutineScope) {
        val users = ConnectionUsers()
        val requests = Channel<Trigger>(Channel.UNLIMITED)
        val ticks = Channel<Unit>(Channel.UNLIMITED)
        var closes = 0
        var work: suspend (Trigger) -> Unit = {}
        val poll: ForegroundRefresh = ForegroundRefresh(scope, users, { closes++ }, refresh = { trigger ->
            serialRefresh(trigger)
        }, pause = { ticks.receive() })

        suspend fun serialRefresh(trigger: Trigger): Unit = poll.serial {
            requests.send(trigger)
            work(trigger)
        }
        suspend fun next(): Trigger = try { withTimeout(2_000) { requests.receive() } }
        catch (e: TimeoutCancellationException) { throw AssertionError("expected a foreground listing within the bounded test deadline", e) }
        suspend fun stop(close: Boolean = true) {
            val stopped = poll.stop(close)
            if (stopped != null) assertTrue(stopped.isCancelled, "STOP must cancel an in-flight loop immediately")
            stopped?.join()
        }
    }

    @Test
    fun `All computers starts AUTO and every later tick remains AUTO`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        assertEquals(Trigger.AUTO, c.next())
        repeat(3) {
            c.ticks.send(Unit)
            assertEquals(Trigger.AUTO, c.next())
        }
        c.stop()
        assertFalse(c.users.watched)
        assertEquals(1, c.closes)
        c.ticks.send(Unit)
        yield()
        assertTrue(c.requests.tryReceive().isFailure, "a stopped screen kept polling")
    }

    @Test
    fun `STOP before deferred startup cancels the first dial and later START makes one loop`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.stop() // same dispatcher turn, before the queued loop has started
        yield()
        assertTrue(c.requests.tryReceive().isFailure, "a disposed screen's queued start dialed anyway")
        assertEquals(1, c.closes)
        c.poll.start(Trigger.AUTO)
        assertEquals(Trigger.AUTO, c.next())
        c.stop()
        assertEquals(2, c.closes)
    }

    @Test
    fun `opening an individual computer uses USER then AUTO and retains quick return`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start()
        assertEquals(Trigger.USER, c.next())
        c.ticks.send(Unit)
        assertEquals(Trigger.AUTO, c.next())
        c.stop(close = false)
        assertEquals(0, c.closes)
        c.poll.start()
        assertEquals(Trigger.USER, c.next())
        c.stop(close = false)
        assertEquals(0, c.closes)
    }

    @Test
    fun `two visible screens share one loop and leaving All computers retains the other`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        assertEquals(Trigger.AUTO, c.next())
        c.poll.start()
        yield()
        assertTrue(c.requests.tryReceive().isFailure, "a second watcher started another loop")
        assertEquals(null, c.poll.stop(closeWhenUnused = true))
        assertTrue(c.users.watched)
        assertEquals(0, c.closes)
        c.ticks.send(Unit)
        assertEquals(Trigger.AUTO, c.next())
        c.stop(close = false)
        assertEquals(0, c.closes, "All computers left a close request under another visible screen")
    }

    @Test
    fun `STOP cancels an in-flight connect and closes after its cancellation cleanup`() = runBlocking<Unit> {
        val c = Computer(this)
        val connecting = CompletableDeferred<Unit>()
        var cancelled = false
        c.work = {
            connecting.complete(Unit)
            try { awaitCancellation() } finally {
                assertEquals(0, c.closes, "connection closed before cancelled connect finished its cleanup")
                cancelled = true
            }
        }
        c.poll.start(Trigger.AUTO)
        connecting.await()
        c.stop()
        assertTrue(cancelled)
        assertEquals(1, c.closes)
        assertFalse(c.users.watched)
    }

    @Test
    fun `STOP cancels an in-flight listing without publishing or announcing stale cards`() = runBlocking<Unit> {
        val c = Computer(this)
        val listing = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var snapshot = "cached"
        val announced = mutableListOf<String>()
        c.work = {
            listing.complete(Unit)
            release.await()
            snapshot = "new"
            announced += snapshot
        }
        c.poll.start(Trigger.AUTO)
        listing.await()
        c.stop()
        release.complete(Unit)
        yield()
        assertEquals("cached", snapshot)
        assertTrue(announced.isEmpty())
        assertEquals(1, c.closes)
    }

    @Test
    fun `STOP closes an idle connection immediately and resume makes exactly one new loop`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.next()
        yield() // waiting in pause, not in a listing
        val stopped = c.poll.stop(closeWhenUnused = true)
        assertEquals(1, c.closes)
        stopped?.join()
        c.poll.start(Trigger.AUTO)
        assertEquals(Trigger.AUTO, c.next())
        c.ticks.send(Unit)
        assertEquals(Trigger.AUTO, c.next())
        c.stop()
        assertEquals(2, c.closes)
    }

    @Test
    fun `a background answer retains its connection when All computers stops`() = runBlocking<Unit> {
        val c = Computer(this)
        val answering = CompletableDeferred<Unit>()
        val answered = CompletableDeferred<Unit>()
        val worker = launch { c.users.hold({ c.closes++ }) { answering.complete(Unit); answered.await() } }
        answering.await()
        c.poll.start(Trigger.AUTO)
        c.next()
        c.stop()
        assertEquals(0, c.closes, "STOP closed under a background answer")
        answered.complete(Unit)
        worker.join()
        assertEquals(1, c.closes)
    }

    @Test
    fun `an old cancelled poll cannot close a new watch even after its new screen leaves`() = runBlocking<Unit> {
        val c = Computer(this)
        val oldEntered = CompletableDeferred<Unit>()
        val cleanup = CompletableDeferred<Unit>()
        c.work = {
            oldEntered.complete(Unit)
            try { awaitCancellation() }
            finally { withContext(NonCancellable) { cleanup.await() } }
        }
        c.poll.start(Trigger.AUTO)
        oldEntered.await()
        try {
            val old = c.poll.stop(closeWhenUnused = true)
            assertEquals(0, c.closes)
            val newerListing = CompletableDeferred<Unit>()
            c.work = { newerListing.complete(Unit); awaitCancellation() }
            c.poll.start() // clears the old screen's deferred close
            yield() // waits for the old listing mutex
            assertTrue(c.users.watched)
            cleanup.complete(Unit)
            old?.join()
            assertEquals(Trigger.AUTO, c.next()) // old request was already queued
            assertEquals(Trigger.USER, c.next())
            newerListing.await()
            assertEquals(0, c.closes)
            c.stop(close = false)
            assertEquals(0, c.closes, "old cleanup closed the quick-return connection of a newer watch")
        } finally { cleanup.complete(Unit) }
    }

    @Test
    fun `manual push and poll refreshes serialize listing publication and announcement together`() = runBlocking<Unit> {
        val c = Computer(this)
        val firstListed = CompletableDeferred<Unit>()
        val releaseAnnounce = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()
        var version = 0
        c.work = {
            val own = ++version
            order += "listed:$own"
            order += "published:$own"
            if (own == 1) { firstListed.complete(Unit); releaseAnnounce.await() }
            order += "announced:$own"
        }
        c.poll.start(Trigger.AUTO)
        firstListed.await()
        val pushed = c.poll.changed()!!
        val manual = launch { c.serialRefresh(Trigger.USER) }
        yield()
        assertEquals(listOf("listed:1", "published:1"), order, "another listing overtook an unfinished publication")
        releaseAnnounce.complete(Unit)
        pushed.join()
        manual.join()
        assertEquals(listOf("listed:1", "published:1", "announced:1", "listed:2", "published:2", "announced:2", "listed:3", "published:3", "announced:3"), order)
        c.stop()
    }

    @Test
    fun `a cancelled queued listing never runs and releases its connection ownership`() = runBlocking<Unit> {
        val c = Computer(this)
        val first = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        c.work = { first.complete(Unit); release.await() }
        c.poll.start(Trigger.AUTO)
        first.await()
        val queued = launch { c.serialRefresh(Trigger.USER) }
        yield()
        queued.cancel()
        queued.join()
        c.stop()
        release.complete(Unit)
        assertEquals(Trigger.AUTO, c.next())
        assertTrue(c.requests.tryReceive().isFailure)
        assertEquals(1, c.closes)
    }

    @Test
    fun `failed serialized work releases the lock and a background job close is not lost`() = runBlocking<Unit> {
        val c = Computer(this)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val passive = launch { c.poll.serial { entered.complete(Unit); release.await() } }
        entered.await()
        c.users.hold({ c.closes++ }) { } // the last background request finishes before passive work
        assertEquals(0, c.closes)
        release.complete(Unit)
        passive.join()
        assertEquals(1, c.closes)
        try { c.poll.serial { error("failed list") } } catch (_: IllegalStateException) { }
        assertEquals("next", c.poll.serial { "next" })
    }

    @Test
    fun `removing one host cancels only its loop while another host keeps its tick`() = runBlocking<Unit> {
        val a = Computer(this)
        val b = Computer(this)
        a.poll.start(Trigger.AUTO)
        b.poll.start(Trigger.AUTO)
        a.next(); b.next()
        a.stop()
        assertEquals(1, a.closes)
        assertEquals(0, b.closes)
        b.ticks.send(Unit)
        assertEquals(Trigger.AUTO, b.next())
        val added = Computer(this)
        added.poll.start(Trigger.AUTO)
        assertEquals(Trigger.AUTO, added.next())
        assertTrue(b.users.watched)
        b.stop(); added.stop()
    }

    @Test
    fun `automatic merged ticks preserve denied and timed-out approvals until explicit Try again`() = runBlocking<Unit> {
        for (failure in listOf(RelayApprovalRefusedException(), RelayApprovalTimeoutException())) {
            val gate = RelayApprovalGate({ false }, { _, _ -> })
            gate.onFailed("host", failure)
            val c = Computer(this)
            val decisions = mutableListOf<RelayApprovalGate.Decision>()
            c.work = { decisions += gate.decide("host", it) }
            c.poll.start(Trigger.AUTO)
            c.next(); yield()
            repeat(2) { c.ticks.send(Unit); c.next(); yield() }
            c.poll.changed()!!.join()
            assertEquals(4, decisions.size)
            assertTrue(decisions.all { it is RelayApprovalGate.Decision.Skip })
            assertTrue(gate.hold("host") != null)
            c.serialRefresh(Trigger.USER)
            assertTrue(decisions.last() is RelayApprovalGate.Decision.Dial)
            assertEquals(null, gate.hold("host"))
            c.stop()
        }
    }

    @Test
    fun `STOP cancels a delayed reconnect and unwatched changes never dial`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.next(); yield()
        val waiting = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val changed = c.poll.changed { waiting.complete(Unit); release.await() }!!
        waiting.await()
        c.stop()
        assertTrue(changed.isCancelled)
        release.complete(Unit)
        yield()
        assertTrue(c.requests.tryReceive().isFailure, "delayed reconnect reopened a hidden computer")
        assertEquals(null, c.poll.changed(), "unwatched pushes must not launch refresh jobs")
        assertEquals(1, c.closes)
    }

    @Test
    fun `STOP cancels both in-flight and mutex-queued pushed listings`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.next(); yield()
        val listing = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var published = false
        c.work = { listing.complete(Unit); release.await(); published = true }
        val first = c.poll.changed()!!
        listing.await()
        val queued = c.poll.changed()!!
        yield()
        c.stop()
        assertTrue(first.isCancelled)
        assertTrue(queued.isCancelled)
        release.complete(Unit)
        yield()
        assertFalse(published)
        assertEquals(Trigger.AUTO, c.next())
        assertTrue(c.requests.tryReceive().isFailure, "a queued push survived STOP")
        assertEquals(1, c.closes)
    }

    @Test
    fun `a delayed old watch cannot refresh after a new watch starts and another watcher retains changes`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.next(); yield()
        val delayed = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val oldChange = c.poll.changed { delayed.complete(Unit); withContext(NonCancellable) { release.await() } }!!
        delayed.await()
        try {
            val stopped = c.poll.stop(closeWhenUnused = true)
            c.poll.start()
            assertEquals(Trigger.USER, c.next())
            release.complete(Unit)
            stopped?.join()
            assertTrue(oldChange.isCancelled)
            yield()
            assertTrue(c.requests.tryReceive().isFailure, "old reconnect was adopted by the new watcher")
            c.poll.start(Trigger.AUTO) // a second visible screen
            assertEquals(null, c.poll.stop(closeWhenUnused = true))
            c.poll.changed()!!.join()
            assertEquals(Trigger.AUTO, c.next(), "remaining visible screen lost pushed changes")
            c.stop(close = false)
            assertEquals(1, c.closes, "new screen lost quick return to an old deferred close")
            assertTrue(c.requests.tryReceive().isFailure, "another watcher spawned an extra loop or repeated a pushed listing")
        } finally { release.complete(Unit) }
    }

    @Test
    fun `a replaced connection cannot deliver a stale queued push or reconnect`() = runBlocking<Unit> {
        val c = Computer(this)
        c.poll.start(Trigger.AUTO)
        c.next(); yield()
        val delayEntered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var current = true
        val old = c.poll.changed(stillCurrent = { current }) { delayEntered.complete(Unit); release.await() }!!
        delayEntered.await()
        current = false // a different connection was installed meanwhile
        release.complete(Unit)
        old.join()
        assertTrue(c.requests.tryReceive().isFailure)
        c.stop()
    }

    @Test
    fun `app owns watchers per STARTED host and serializes the whole real listing`() {
        val all = AppSourcePins.ui("AllComputersScreen.kt")
        AppSourcePins.assertInOrder(all, "for (hostId in hostIds) key(hostId)", "LifecycleStartEffect(hostId)", "val starting = uiScope.launch", "yield()", "session.startWatching(Trigger.AUTO)", "watching = true", "onStopOrDispose", "starting.cancel()", "if (watching) session.stopWatching(closeWhenUnused = true)")
        val inbox = AppSourcePins.blockAfter(all, "private fun AllInbox(")
        AppSourcePins.assertInOrder(inbox, "LifecycleStartEffect(hostIds)", ".onScreen.showInbox()", "onStopOrDispose", "showing.forEach { it.close() }")
        val host = AppSourcePins.ui("HostScreen.kt")
        assertTrue(host.contains("session.startWatching()"), "ordinary host opening must retain its USER default")
        val connections = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(connections.contains("private val foreground = ForegroundRefresh("))
        assertTrue(connections.contains("refresh = { trigger -> refreshNow(trigger) }"))
        assertTrue(connections.contains("pause = { delay(POLL_MS) }"))
        assertTrue(connections.contains("const val POLL_MS = 8_000L"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(connections, "suspend fun refreshNow("), "foreground.serial {", "ensureConnected(trigger)", "c.listProjects()", "_snapshot.value = it", "graph.announce(hostId, listed, onScreen.now(), quiet = reachableQuietly())")
        assertTrue(AppSourcePins.blockAfter(connections, "fun startWatching(").contains("foreground.start(initialTrigger)"))
        assertTrue(AppSourcePins.blockAfter(connections, "fun stopWatching(").contains("foreground.stop(closeWhenUnused)"))
        val adopt = AppSourcePins.blockAfter(connections, "private fun adopt(c: HostConnection, lease: HostLifetime.Lease)")
        assertTrue(adopt.contains("foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn == null })"))
        assertTrue(adopt.contains("c.setOnChanged { if (lifetime.isCurrent(lease) && conn === c && isWatched) foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn === c }) }"))
    }
}
