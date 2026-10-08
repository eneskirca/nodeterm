package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ConnectionUsers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The review of audit A25: a computer's one connection is shared by the screens that show it and by
 * the background jobs that run on it (the periodic Inbox check, each answer given from a
 * notification). Each job used to close it when it ended and no screen watched, under another job
 * still sending on it, so two answers a few seconds apart (or an answer and the check) cut each other
 * off. [ConnectionUsers] closes it only after the LAST user, which the app's HostSession uses.
 */
class ConnectionUsersTest {
    @Test
    fun `two overlapping background jobs close the connection once, after the last`() = runBlocking<Unit> {
        val users = ConnectionUsers()
        var closes = 0
        val firstIn = CompletableDeferred<Unit>()
        val secondIn = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val releaseSecond = CompletableDeferred<Unit>()
        val first = launch { users.hold({ closes++ }) { firstIn.complete(Unit); releaseFirst.await() } }
        val second = launch { users.hold({ closes++ }) { secondIn.complete(Unit); releaseSecond.await() } }
        firstIn.await()
        secondIn.await()
        releaseFirst.complete(Unit)
        first.join()
        assertEquals(0, closes, "the first job to finish closed the connection under the other")
        releaseSecond.complete(Unit)
        second.join()
        assertEquals(1, closes)
    }

    @Test
    fun `a screen showing the computer keeps the connection open, and leaving it closes nothing`() = runBlocking<Unit> {
        val users = ConnectionUsers()
        var closes = 0
        assertTrue(users.watch())
        assertEquals("checked", users.hold({ closes++ }) { "checked" })
        assertEquals(0, closes, "a background job closed the connection of a screen being looked at")
        assertTrue(users.unwatch())
        assertEquals(0, closes, "leaving the screen closed the connection (it is kept for a quick return)")
        users.hold({ closes++ }) {}
        assertEquals(1, closes)
    }

    @Test
    fun `a screen that leaves while a job runs, and the job closes the connection when it ends`() = runBlocking<Unit> {
        val users = ConnectionUsers()
        var closes = 0
        users.watch()
        users.hold({ closes++ }) { users.unwatch() }
        assertEquals(1, closes)
    }

    @Test
    fun `a job that fails or is cancelled still closes the connection when it is the last`() = runBlocking<Unit> {
        val users = ConnectionUsers()
        var closes = 0
        assertFailsWith<IllegalStateException> { users.hold({ closes++ }) { error("socket closed") } }
        assertEquals(1, closes)
        val inside = CompletableDeferred<Unit>()
        val job = launch { users.hold({ closes++ }) { inside.complete(Unit); awaitCancellation() } }
        inside.await()
        job.cancel()
        job.join()
        assertEquals(2, closes)
    }

    @Test
    fun `watch and unwatch report the first and the last screen`() {
        val users = ConnectionUsers()
        assertFalse(users.watched)
        assertTrue(users.watch())
        assertFalse(users.watch())
        assertTrue(users.watched)
        assertFalse(users.unwatch())
        assertTrue(users.unwatch())
        assertFalse(users.watched)
        // One unwatch too many changes nothing (a screen disposed twice).
        assertTrue(users.unwatch())
        assertTrue(users.watch())
    }

    @Test
    fun `under concurrent jobs the connection is never closed while one of them runs`() = runBlocking<Unit> {
        val users = ConnectionUsers()
        val running = AtomicInteger()
        val closedUnderAJob = AtomicInteger()
        val closes = AtomicInteger()
        val close = {
            if (running.get() != 0) closedUnderAJob.incrementAndGet()
            closes.incrementAndGet()
            Unit
        }
        val jobs = (1..200).map { i ->
            launch(Dispatchers.Default) {
                delay(Random(i).nextLong(0, 5))
                users.hold(close) {
                    running.incrementAndGet()
                    try {
                        repeat(Random(i).nextInt(1, 4)) { yield() }
                        delay(Random(i * 7).nextLong(0, 3))
                    } finally {
                        running.decrementAndGet()
                    }
                }
            }
        }
        jobs.forEach { it.join() }
        assertEquals(0, closedUnderAJob.get(), "the connection was closed under a job still running on it")
        assertTrue(closes.get() >= 1, "nothing closed the connection after the last job")
    }
}
