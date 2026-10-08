package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.PhoneLaunch
import dev.nodeterm.protocol.host.StreamLease
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.host.ViewerSlot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Audit A40: the terminal screen's attach hand-off, and the launch of a session the phone starts.
 * The screen (TerminalController) is only type-checked; these pin the rules it delegates to.
 */
class TerminalHandoffTest {
    private val log: MutableList<String> = Collections.synchronizedList(ArrayList())

    private inner class FakeStream(val name: String = "s") : TerminalStream {
        override val fresh = true
        override fun write(text: String) {
            log += "$name write ${text.replace("\r", "\\r")}"
        }
        override fun resize(cols: Int, rows: Int) {}
        override suspend fun scroll(up: Boolean, lines: Int) {}
        override suspend fun detach() {}
        override suspend fun endSession() {
            log += "$name end"
        }
    }

    private fun lease(name: String = "s") = StreamLease(FakeStream(name)) { log += "$name detach" }

    // ---- (a) the hand-off re-checks the screen ----------------------------------------------

    @Test
    fun `a stream handed over after the screen was closed is detached, not installed`() {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        slot.close() // back pressed while the attach was on its way
        assertFalse(slot.accept(t, l))
        assertNull(slot.stream)
        assertEquals(listOf("s detach"), log)
    }

    @Test
    fun `a stream handed over after the screen went to the background is detached, not installed`() {
        val slot = ViewerSlot()
        val t = slot.begin()
        slot.leave()
        assertFalse(slot.accept(t, lease()))
        assertEquals(listOf("s detach"), log)
    }

    @Test
    fun `a superseded attach cannot install its stream over the newer one`() {
        val slot = ViewerSlot()
        val old = slot.begin()
        slot.leave() // background ...
        val new = slot.begin() // ... and back: a second attach starts before the first one lands
        val newer = lease("new")
        assertTrue(slot.accept(new, newer))
        assertFalse(slot.isCurrent(old))
        assertFalse(slot.accept(old, lease("old")))
        assertSame(newer.stream, slot.stream)
        assertEquals(listOf("old detach"), log)
    }

    @Test
    fun `the current hand-off installs, and leaving detaches it exactly once`() {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        assertTrue(slot.accept(t, l))
        assertSame(l.stream, slot.stream)
        assertTrue(log.isEmpty())
        slot.leave()
        slot.close()
        l.release()
        assertNull(slot.stream)
        assertEquals(listOf("s detach"), log)
    }

    @Test
    fun `a stream that ended by itself is forgotten without a detach, and a late hand-off of it is refused`() {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        assertTrue(slot.accept(t, l))
        assertTrue(slot.ended(t))
        assertNull(slot.stream)
        // The exit of a stream the screen already let go of (its own detach) is not the screen's.
        assertFalse(slot.ended(t))
        slot.leave()
        assertTrue(log.isEmpty())

        // An exit that lands before its own hand-off: the dead stream must not be shown as attached.
        val t2 = slot.begin()
        assertTrue(slot.ended(t2))
        assertFalse(slot.accept(t2, lease("late")))
        assertNull(slot.stream)
    }

    @Test
    fun `the last of several holders detaches exactly once, whatever the threads`() {
        repeat(50) {
            val detaches = AtomicInteger()
            val l = StreamLease(FakeStream()) { detaches.incrementAndGet() }
            repeat(7) { assertTrue(l.acquire()) }
            val go = CountDownLatch(1)
            val threads = (0 until 8).map {
                thread {
                    go.await()
                    l.release()
                    l.release()
                }
            }
            go.countDown()
            threads.forEach { it.join() }
            assertEquals(1, detaches.get())
            assertFalse(l.acquire())
        }
    }

    // ---- (b) a launch outlives the screen ---------------------------------------------------

    @Test
    fun `leaving during the settle delay does not drop the launch, and the stream is detached after it`() = runBlocking {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        val settled = CompletableDeferred<Unit>()
        var outcome: PhoneLaunch.Outcome? = null
        val job = PhoneLaunch.start(this, l, "claude --permission-mode auto",
            register = { log += "register"; true },
            settle = { settled.await() },
            then = { outcome = it; log += "then" })
        assertTrue(slot.accept(t, l))
        yield() // the launch is now waiting for the shell to settle

        slot.close() // the user pressed back
        assertTrue(log.isEmpty(), "the stream must stay attached until the launch is done: $log")

        settled.complete(Unit)
        job.join()
        assertEquals(listOf("s write claude --permission-mode auto\\r", "register", "s detach", "then"), log)
        assertEquals(PhoneLaunch.Outcome.REGISTERED, outcome)
    }

    @Test
    fun `the app going to the background mid-launch does not drop it either`() = runBlocking {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        val settled = CompletableDeferred<Unit>()
        val job = PhoneLaunch.start(this, l, "bash", register = { log += "register"; true }, settle = { settled.await() })
        assertTrue(slot.accept(t, l))
        yield()
        slot.leave()
        // Back in the foreground: a new attach of the same session; the launch still holds the old stream.
        val t2 = slot.begin()
        assertTrue(slot.accept(t2, lease("new")))
        settled.complete(Unit)
        job.join()
        assertEquals(listOf("s write bash\\r", "register", "s detach"), log)
        assertTrue(slot.isCurrent(t2))
    }

    @Test
    fun `a launch whose hand-off was refused still runs, then detaches`() = runBlocking {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        val settled = CompletableDeferred<Unit>()
        // The attach thread starts the launch, then posts the hand-off; the screen closed in between.
        val job = PhoneLaunch.start(this, l, "claude", register = { log += "register"; true }, settle = { settled.await() })
        slot.close()
        assertFalse(slot.accept(t, l))
        assertTrue(log.isEmpty())
        settled.complete(Unit)
        job.join()
        assertEquals(listOf("s write claude\\r", "register", "s detach"), log)
    }

    @Test
    fun `a launch on a stream the screen still shows leaves it attached`() = runBlocking {
        val slot = ViewerSlot()
        val t = slot.begin()
        val l = lease()
        val job = PhoneLaunch.start(this, l, "claude", register = { log += "register"; true }, settle = {})
        assertTrue(slot.accept(t, l))
        job.join()
        assertEquals(listOf("s write claude\\r", "register"), log)
        assertSame(l.stream, slot.stream)
        slot.close()
        assertEquals(listOf("s write claude\\r", "register", "s detach"), log)
    }

    @Test
    fun `a refusal and a failed registration are both REFUSED, a connection without the verb is CANNOT_REGISTER`() = runBlocking {
        suspend fun run(register: (suspend () -> Boolean)?): PhoneLaunch.Outcome? {
            var outcome: PhoneLaunch.Outcome? = null
            val l = lease()
            val job = PhoneLaunch.start(this, l, null, register, settle = {}, then = { outcome = it })
            l.release() // the screen left
            job.join()
            return outcome
        }
        assertEquals(PhoneLaunch.Outcome.REFUSED, run { false })
        assertEquals(PhoneLaunch.Outcome.REFUSED, run { throw IllegalStateException("host gone") })
        assertEquals(PhoneLaunch.Outcome.CANNOT_REGISTER, run(null))
        // No command (a plain shell): nothing typed, the stream still let go of each time.
        assertEquals(listOf("s detach", "s detach", "s detach"), log)
    }

    @Test
    fun `a write that throws does not keep the stream attached or skip the registration`() = runBlocking {
        val l = StreamLease(object : TerminalStream {
            override val fresh = true
            override fun write(text: String) = throw IllegalStateException("socket closed")
            override fun resize(cols: Int, rows: Int) {}
            override suspend fun scroll(up: Boolean, lines: Int) {}
            override suspend fun detach() {}
            override suspend fun endSession() {}
        }) { log += "detach" }
        var outcome: PhoneLaunch.Outcome? = null
        val job = PhoneLaunch.start(this, l, "claude", register = { log += "register"; true }, settle = {}, then = { outcome = it })
        l.release() // the screen left
        job.join()
        assertEquals(listOf("register", "detach"), log)
        assertEquals(PhoneLaunch.Outcome.REGISTERED, outcome)
    }

    @Test
    fun `a launch cannot start on a stream that was already let go of`() {
        val l = lease()
        l.release()
        assertFailsWith<IllegalStateException> {
            runBlocking { PhoneLaunch.start(this, l, "claude", register = null, settle = {}) }
        }
    }

    // ---- (c) going to the background never drops an attach that is on the wire ---------------

    @Test
    fun `the screen's attach is not cancelled once it is sent, so the hand-off and the launch always run`() {
        // ON_STOP cancels the attach job. Cancelled inside conn.attach, the attach threw away a
        // stream the host had already reserved (and was creating the session for) and never took the
        // pending launch. What the screen does from the request to the hand-off must not be
        // cancellable; only a device runs the controller, so its source is pinned.
        val body = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "fun attach()")
        AppSourcePins.assertInOrder(
            body,
            "ensureActive()",
            "withContext(NonCancellable) {",
            "conn.attach(nodeId, c, r, sink, hint)",
            "PendingLaunches.take(nodeId)",
            "startLaunch(launch, lease, conn)",
            "slot.accept(ticket, lease)",
            "s to launch"
        )
        // A superseded attach's dial must not put its approval code over the current screen.
        AppSourcePins.assertInOrder(body, "RelayConnectStatus.AwaitingApproval", "slot.isCurrent(ticket)", "TermState.AwaitingApproval(")
    }
}
