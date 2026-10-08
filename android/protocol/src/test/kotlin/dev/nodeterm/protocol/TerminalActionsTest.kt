package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.TerminalActions
import dev.nodeterm.protocol.host.TerminalStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TerminalActionsTest {
    private class Stream : TerminalStream {
        override val fresh = false
        val log = mutableListOf<String>()
        var onScroll: suspend (Boolean, Int) -> Unit = { _, _ -> }
        var onWrite: (String) -> Unit = {}
        override fun write(text: String) { log += "input:$text"; onWrite(text) }
        override fun resize(cols: Int, rows: Int) {}
        override suspend fun scroll(up: Boolean, lines: Int) {
            log += "scroll:$up:$lines"
            onScroll(up, lines)
        }
        override suspend fun detach() {}
        override suspend fun endSession() {}
    }

    @Test
    fun `adjacent direction coalesces without losing distance and every host call is at most twenty`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 17))
            assertTrue(actions.scroll(true, 28))
            assertTrue(actions.scroll(false, 6))
            assertTrue(actions.scroll(true, 2))
            yield()
            assertEquals(listOf("scroll:true:20", "scroll:true:20", "scroll:true:5", "scroll:false:6", "scroll:true:2"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `a suspended relay scroll serializes subsequent chunks and a direction reversal`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 35))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.scroll(false, 8))
            yield()
            assertEquals(listOf("scroll:true:20"), stream.log, "No concurrent RPC or reversal may overtake the suspended call")
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "scroll:true:15", "scroll:false:8"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `Esc cancels unsent chunks and directions but waits for the already sent RPC`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 80))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.scroll(false, 12))
            assertTrue(actions.write("\u001b"))
            assertTrue(actions.write("command\r"))
            yield()
            assertEquals(listOf("scroll:true:20"), stream.log)
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "input:\u001b", "input:command\r"), stream.log)
            assertTrue(actions.scroll(false, 3), "A new gesture after input is still allowed")
            yield()
            assertEquals("scroll:false:3", stream.log.last())
        } finally { actions.close() }
    }

    @Test
    fun `input barrier preserves accepted input while cancelling scroll on both sides of it`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.write("first"))
            assertTrue(actions.scroll(true, 20))
            assertTrue(actions.write("second"))
            assertTrue(actions.scroll(false, 10))
            assertTrue(actions.write("third"))
            yield()
            assertEquals(listOf("input:first", "input:second", "input:third"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `automatic replies arriving during a scroll retain every chunk and direction in FIFO order`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 45))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.report("\u001b[1;1R"))
            assertTrue(actions.scroll(false, 7))
            assertTrue(actions.report("\u001b[?1;2c"))
            assertTrue(actions.scroll(true, 3))
            yield()
            assertEquals(listOf("scroll:true:20"), stream.log)
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "scroll:true:20", "scroll:true:5", "input:\u001b[1;1R",
                "scroll:false:7", "input:\u001b[?1;2c", "scroll:true:3"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `Esc still cancels pending gesture distance while preserving automatic replies`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 80))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.report("reply-before"))
            assertTrue(actions.scroll(false, 10))
            assertTrue(actions.write("\u001b"))
            assertTrue(actions.report("reply-after"))
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "input:reply-before", "input:\u001b", "input:reply-after"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `automatic replies share pending run and character bounds without cancelling accepted movement`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            repeat(64) { assertTrue(actions.scroll(it % 2 == 0, 1)) }
            assertFalse(actions.report("reply"), "Reports count queued scroll runs against capacity")
            yield()
            assertEquals(64, stream.log.size)
            stream.log.clear()
            assertTrue(actions.report("a".repeat(1024 * 1024)))
            assertTrue(actions.scroll(true, 13))
            assertFalse(actions.report("overflow"))
            assertFalse(actions.write("overflow"), "User input shares the report's character budget")
            yield()
            assertEquals(2, stream.log.size)
            assertEquals("scroll:true:13", stream.log.last())
            repeat(64) { assertTrue(actions.report("$it")) }
            assertFalse(actions.report("65th"))
        } finally { actions.close() }
    }

    @Test
    fun `a failed automatic reply is not retried and does not cancel following movement`() = runBlocking {
        val stream = Stream()
        stream.onWrite = { if (it == "reply") throw IllegalStateException("reply refused") }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 9))
            assertTrue(actions.report("reply"))
            assertTrue(actions.scroll(false, 6))
            yield()
            assertEquals(listOf("scroll:true:9", "input:reply", "scroll:false:6"), stream.log)
            assertTrue(actions.report("next"))
            yield()
            assertEquals("input:next", stream.log.last())
        } finally { actions.close() }
    }

    @Test
    fun `momentum cancellation preserves admitted input and reports while allowing new direction`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.write("typed"))
            assertTrue(actions.scroll(true, 45))
            assertTrue(actions.report("reply-one"))
            assertTrue(actions.scroll(false, 9))
            assertTrue(actions.report("reply-two"))
            assertTrue(actions.cancelScroll())
            assertTrue(actions.cancelScroll(), "Stopping an already stopped gesture is harmless")
            assertTrue(actions.scroll(false, 7))
            yield()
            assertEquals(listOf("input:typed", "input:reply-one", "input:reply-two", "scroll:false:7"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `momentum cancellation waits for one in flight scroll and preserves report order`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 65))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.report("reply-before"))
            assertTrue(actions.scroll(false, 13))
            assertTrue(actions.report("reply-after"))
            assertTrue(actions.cancelScroll())
            assertTrue(actions.scroll(false, 6))
            assertTrue(actions.report("new-reply"))
            yield()
            assertEquals(listOf("scroll:true:20"), stream.log, "Stopping momentum does not cancel or overtake the awaited call")
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "input:reply-before", "input:reply-after", "scroll:false:6", "input:new-reply"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `momentum cancellation keeps in flight and input budgets charged`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 320))
            withTimeout(2_000) { started.await() }
            val reply = "r".repeat(1024 * 1024)
            assertTrue(actions.report(reply))
            assertTrue(actions.cancelScroll())
            assertTrue(actions.scroll(false, 300), "Only the awaited twenty remain charged after cancellation")
            assertFalse(actions.scroll(false, 1), "Stopping momentum cannot free the in-flight budget")
            assertFalse(actions.report("overflow"), "Accepted reports retain their character budget")
            assertFalse(actions.write("overflow"))
            release.complete(Unit)
            yield()
            assertEquals("scroll:true:20", stream.log[0])
            assertEquals("input:$reply", stream.log[1])
            assertEquals(300, stream.log.drop(2).sumOf { it.substringAfterLast(':').toInt() })
            assertTrue(actions.scroll(true, 320), "Completed work releases its budget after cancellation too")
        } finally { actions.close() }
    }

    @Test
    fun `momentum cancellation cannot revive a retired obsolete or cancelled viewer`() = runBlocking {
        val stream = Stream()
        var current = true
        val actions = TerminalActions(this, stream) { current }
        assertTrue(actions.scroll(true, 9))
        current = false
        assertFalse(actions.cancelScroll())
        yield()
        assertTrue(stream.log.isEmpty())
        current = true
        assertFalse(actions.cancelScroll(), "An obsolete drain retires rather than being revived")
        actions.close()
        assertFalse(actions.cancelScroll())
        val owner = Job()
        val cancelled = TerminalActions(CoroutineScope(coroutineContext + owner), stream) { true }
        owner.cancel()
        assertFalse(cancelled.cancelScroll())
        cancelled.close()
        owner.join()
        assertTrue(stream.log.isEmpty())
    }

    @Test
    fun `close cancels suspended RPC and clears pending input and scroll permanently`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val never = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ ->
            started.complete(Unit)
            try { never.await() } finally { cancelled.complete(Unit) }
        }
        val actions = TerminalActions(this, stream) { true }
        assertTrue(actions.scroll(true, 50))
        withTimeout(2_000) { started.await() }
        assertTrue(actions.write("\u001b"))
        actions.close()
        actions.close()
        withTimeout(2_000) { cancelled.await() }
        assertFalse(actions.scroll(false, 1))
        assertFalse(actions.write("late"))
        assertFalse(actions.report("late reply"))
        assertEquals(listOf("scroll:true:20"), stream.log)
    }

    @Test
    fun `an obsolete viewer never executes queued actions on either the old or new stream`() = runBlocking {
        val old = Stream()
        val replacement = Stream()
        var current = true
        val oldActions = TerminalActions(this, old) { current }
        val newActions = TerminalActions(this, replacement) { true }
        try {
            assertTrue(oldActions.scroll(true, 40))
            current = false
            assertFalse(oldActions.write("obsolete"))
            assertFalse(oldActions.report("obsolete reply"))
            assertTrue(newActions.write("new"))
            yield()
            assertEquals(emptyList(), old.log)
            assertEquals(listOf("input:new"), replacement.log)
        } finally { oldActions.close(); newActions.close() }
    }

    @Test
    fun `becoming obsolete during an RPC prevents its remaining distance and input from running`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var current = true
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { current }
        try {
            assertTrue(actions.scroll(true, 60))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.write("late"))
            current = false
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20"), stream.log)
            assertFalse(actions.scroll(true, 1))
        } finally { actions.close() }
    }

    @Test
    fun `a failed RPC is not retried but input and a later explicit gesture remain usable`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ ->
            if (!started.isCompleted) {
                started.complete(Unit)
                release.await()
                throw IllegalStateException("RPC refused")
            }
        }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 60))
            withTimeout(2_000) { started.await() }
            assertTrue(actions.write("\u001b"))
            assertTrue(actions.scroll(false, 4))
            release.complete(Unit)
            yield()
            assertEquals(listOf("scroll:true:20", "input:\u001b", "scroll:false:4"), stream.log,
                "Failure of the old gesture cannot cancel a new gesture admitted after explicit input")
            assertTrue(actions.write("next"))
            assertTrue(actions.scroll(false, 2))
            yield()
            assertEquals(listOf("scroll:true:20", "input:\u001b", "scroll:false:4", "input:next", "scroll:false:2"), stream.log)
        } finally { actions.close() }
    }

    @Test
    fun `RPC cancellation retires admission and does not deliver later input`() = runBlocking {
        val stream = Stream()
        stream.onScroll = { _, _ -> throw CancellationException("cancelled RPC") }
        val actions = TerminalActions(this, stream) { true }
        assertTrue(actions.scroll(true, 40))
        yield()
        assertEquals(listOf("scroll:true:20"), stream.log)
        assertFalse(actions.write("late"))
        assertFalse(actions.report("late reply"))
        assertFalse(actions.scroll(false, 1))
        actions.close()
    }

    @Test
    fun `scroll bounds include the suspended call and input clears the unsent budget`() = runBlocking {
        val stream = Stream()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        stream.onScroll = { _, _ -> if (!started.isCompleted) { started.complete(Unit); release.await() } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertFalse(actions.scroll(true, 0))
            assertFalse(actions.scroll(true, -1))
            assertFalse(actions.scroll(true, Int.MAX_VALUE))
            assertTrue(actions.scroll(true, 320))
            withTimeout(2_000) { started.await() }
            assertFalse(actions.scroll(true, 1), "The 20 notches in flight are still charged")
            assertTrue(actions.write("\u001b"))
            assertTrue(actions.scroll(false, 300), "Only the in-flight 20 remain after input")
            assertFalse(actions.scroll(false, 1))
            release.complete(Unit)
            yield()
            assertEquals("input:\u001b", stream.log[1])
            assertEquals(300, stream.log.drop(2).sumOf { it.substringAfterLast(':').toInt() })
            assertTrue(actions.scroll(true, 320), "Completed actions release their budget")
        } finally { actions.close() }
    }

    @Test
    fun `sixty four pending direction runs are bounded while same direction can still merge`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            repeat(64) { assertTrue(actions.scroll(it % 2 == 0, 1)) }
            assertFalse(actions.scroll(true, 1), "The 65th direction run is refused")
            assertTrue(actions.scroll(false, 2), "A same-direction tail consumes no new run")
            yield()
            assertEquals(64, stream.log.size)
            assertEquals("scroll:false:3", stream.log.last())
            assertTrue(actions.scroll(true, 1))
        } finally { actions.close() }
    }

    @Test
    fun `input has both a run and character bound and a refusal preserves previously accepted actions`() = runBlocking {
        val stream = Stream()
        val actions = TerminalActions(this, stream) { true }
        try {
            repeat(64) { assertTrue(actions.write("$it")) }
            assertFalse(actions.scroll(true, 1))
            assertFalse(actions.write("65th"))
            yield()
            assertEquals((0 until 64).map { "input:$it" }, stream.log)
            stream.log.clear()
            val limit = "a".repeat(1024 * 1024)
            assertTrue(actions.write(limit))
            assertTrue(actions.scroll(true, 17))
            assertFalse(actions.write("x"), "A refused input must not clear the accepted scroll")
            assertFalse(actions.write(limit + "x"))
            yield()
            assertEquals(2, stream.log.size)
            assertEquals(limit.length + "input:".length, stream.log[0].length)
            assertEquals("scroll:true:17", stream.log[1])
            assertTrue(actions.write("next"), "Delivered input releases its character budget")
        } finally { actions.close() }
    }

    @Test
    fun `a cancelled owner scope refuses new actions without leaving an idle drain`() = runBlocking {
        val owner = Job()
        val stream = Stream()
        val actions = TerminalActions(CoroutineScope(coroutineContext + owner), stream) { true }
        owner.cancel()
        assertFalse(actions.write("late"))
        assertFalse(actions.scroll(true, 1))
        actions.close()
        owner.join()
        assertTrue(stream.log.isEmpty())
    }
}
