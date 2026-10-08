package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.*
import kotlinx.coroutines.*
import kotlin.test.*

class TerminalScrollActionsTest {
    private val history = TerminalScrollView.Result.History("b3b8e879-6449-4c8c-8529-4c02d6885878", 1, 2, 80,
        listOf(TerminalScrollView.Row("old", false, "normal")), false, false, true)
    private class Stream : TerminalStream {
        override val fresh = false
        val log = mutableListOf<String>()
        var clearCount = 0
        var result: suspend () -> TerminalScrollView.Result = { TerminalScrollView.Result.Input }
        override fun write(text: String) { log += "input:$text" }
        override fun resize(cols: Int, rows: Int) {}
        override suspend fun scroll(up: Boolean, lines: Int) { error("untyped path must not run") }
        override suspend fun scrollView(up: Boolean, lines: Int): TerminalScrollView.Result { log += "$up:$lines"; return result() }
        override fun clearScrollView() { clearCount++ }
        override suspend fun detach() {}
        override suspend fun endSession() {}
    }
    @Test fun `ordered chunks reversal and display epochs survive history responses`() = runBlocking {
        val stream = Stream().apply { result = { history } }
        val displays = mutableListOf<Pair<Long, Int>>()
        val actor = TerminalActions(this, stream, { _, epoch, display -> displays += epoch to display }) { true }
        try {
            assertTrue(actor.scroll(true, 45, 7)); assertTrue(actor.scroll(false, 3, 7)); assertTrue(actor.scroll(true, 2, 8))
            yield()
            assertEquals(listOf("true:20", "true:20", "true:5", "false:3", "true:2"), stream.log)
            assertEquals(listOf(7, 7, 7, 7, 8), displays.map { it.second })
            assertEquals(0, stream.clearCount)
        } finally { actor.close() }
    }
    @Test fun `explicit input suppresses an awaited page and invalidates already posted pages`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val stream = Stream().apply { result = { entered.complete(Unit); release.await(); history } }
        val displays = mutableListOf<Long>()
        val actor = TerminalActions(this, stream, { _, epoch, _ -> displays += epoch }) { true }
        try {
            actor.scroll(true, 40); entered.await(); actor.write("x"); release.complete(Unit); yield()
            assertTrue(displays.isEmpty(), "An in-flight pre-input page must not reopen history")
            assertEquals(listOf("true:20", "input:x"), stream.log)
            stream.result = { history }; actor.scroll(true, 1); yield()
            val posted = displays.single(); assertEquals(posted, actor.scrollEpoch)
            actor.write("y"); assertNotEquals(posted, actor.scrollEpoch, "The main-thread delivery fence must invalidate a queued page too")
            yield()
        } finally { actor.close() }
    }
    @Test fun `automatic reports and a new touch preserve the awaited page and token`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val stream = Stream().apply { result = { entered.complete(Unit); release.await(); history } }
        val displays = mutableListOf<TerminalScrollView.Result>()
        val actor = TerminalActions(this, stream, { result, _, _ -> displays += result }) { true }
        try {
            actor.scroll(true, 40); entered.await(); actor.report("reply"); actor.cancelScroll()
            release.complete(Unit); yield()
            assertEquals(listOf<TerminalScrollView.Result>(history), displays); assertEquals(listOf("true:20", "input:reply"), stream.log)
            assertEquals(0, stream.clearCount)
        } finally { actor.close() }
    }
    @Test fun `refusal uncertainty and thrown failure stop remaining momentum without replay`() = runBlocking {
        for (failure in listOf(TerminalScrollView.Result.Refused("old host"), TerminalScrollView.Result.Uncertain("lost result"), null)) {
            val stream = Stream().apply { result = { failure ?: throw IllegalStateException("lost") } }
            val displays = mutableListOf<TerminalScrollView.Result>()
            val actor = TerminalActions(this, stream, { result, _, _ -> displays += result }) { true }
            try {
                actor.scroll(true, 60); actor.report("reply"); actor.scroll(false, 5); yield()
                assertEquals(listOf("true:20", "input:reply"), stream.log)
                assertEquals(1, displays.size)
                assertTrue(displays.single() is TerminalScrollView.Result.Refused || displays.single() is TerminalScrollView.Result.Uncertain)
                assertFalse(actor.scroll(true, 3), "Late frames from the failed coast must not start another input-capable RPC")
                assertTrue(actor.cancelScroll(), "The next touch is a new explicit gesture")
                stream.result = { TerminalScrollView.Result.Input }; actor.scroll(false, 2); yield()
                assertEquals("false:2", stream.log.last(), "A new explicit gesture remains usable")
            } finally { actor.close() }
        }
    }
    @Test fun `retired and obsolete viewers never publish their awaited history`() = runBlocking {
        for (close in listOf(false, true)) {
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var current = true
            val stream = Stream().apply { result = { entered.complete(Unit); release.await(); history } }
            val displays = mutableListOf<TerminalScrollView.Result>()
            val actor = TerminalActions(this, stream, { result, _, _ -> displays += result }) { current }
            actor.scroll(true, 30); entered.await()
            if (close) actor.close() else current = false
            release.complete(Unit); yield(); assertTrue(displays.isEmpty()); actor.close()
        }
    }
    @Test fun `an old failed reply cannot cancel movement admitted after an input barrier`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var first = true
        val stream = Stream().apply { result = {
            if (first) { first = false; entered.complete(Unit); release.await(); error("old reply failed") }
            TerminalScrollView.Result.Input
        } }
        val actor = TerminalActions(this, stream) { true }
        try {
            actor.scroll(true, 40); entered.await()
            actor.write("x"); assertTrue(actor.scroll(false, 3, 1))
            release.complete(Unit); yield()
            assertEquals(listOf("true:20", "input:x", "false:3"), stream.log)
            assertFalse(actor.scrollPaused)
        } finally { actor.close() }
    }
}
