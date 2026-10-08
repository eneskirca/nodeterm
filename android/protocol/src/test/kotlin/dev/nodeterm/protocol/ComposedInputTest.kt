package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.host.ComposedInputResult
import dev.nodeterm.protocol.host.ComposedPreparation
import dev.nodeterm.protocol.host.TerminalActions
import dev.nodeterm.protocol.host.TerminalStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposedInputTest {
    @Test fun `a throwing momentum evaluator refuses preparation without spending draft or Ctrl`() = runBlocking {
        for (error in listOf(IllegalStateException("renderer gone"), IllegalArgumentException("provider failed"))) {
            var late: ((Boolean) -> Unit)? = null
            val ready = ComposedPreparation.cancelMomentum { complete -> late = complete; throw error }
            assertFalse(ready.await())
            late!!(true)
            assertFalse(ready.await(), "a late callback cannot turn failed preparation into delivery")
            assertFalse(ComposedPreparation.cancelMomentum { complete -> complete(true); throw error }.await(),
                "an immediate callback cannot hide a synchronous provider failure")
            val stream = Stream(); val actions = TerminalActions(this, stream) { true }
            try {
                if (ready.await()) actions.submit(ComposedInput.Control("\u0003"))
                assertTrue(stream.inputs.isEmpty()); assertTrue(stream.log.isEmpty())
            } finally { actions.close() }
        }
    }

    private class Stream : TerminalStream {
        override val fresh = false
        val log = mutableListOf<String>()
        val inputs = mutableListOf<ComposedInput>()
        var onScroll: suspend () -> Unit = {}
        var onSubmit: suspend () -> ComposedInputResult = { ComposedInputResult.DELIVERED }
        var retired = false
        override fun write(text: String) { log += "raw:$text" }
        override fun resize(cols: Int, rows: Int) {}
        override suspend fun scroll(up: Boolean, lines: Int) { log += "scroll:$up:$lines"; onScroll() }
        override suspend fun submitComposed(input: ComposedInput): ComposedInputResult {
            log += "send"; inputs += input; return onSubmit()
        }
        override fun retireComposed() { retired = true }
        override suspend fun detach() {}
        override suspend fun endSession() {}
    }

    @Test fun `paste normalization matches xterm while armed control stays one raw byte`() {
        assertEquals(ComposedInput.Paste("one\rtwo\rthree[?1;2c", true),
            ComposedInput.Paste("one\r\ntwo\nthree\u001b[?1;2c\u009b", true).normalized())
        for (byte in listOf(0, 3, 26, 27, 31, 127)) {
            val input = ComposedInput.Control(byte.toChar().toString())
            assertTrue(input.valid()); assertEquals(input, input.normalized())
        }
        assertFalse(ComposedInput.Control("z").valid())
        assertFalse(ComposedInput.Control("\u0003\r").valid())
        assertFalse(ComposedInput.Paste("nul\u0000", true).valid())
        assertTrue(ComposedInput.Paste("é".repeat(ComposedInput.MAX_BYTES / 2), false).valid())
        assertFalse(ComposedInput.Paste("é".repeat(ComposedInput.MAX_BYTES / 2 + 1), false).valid())
    }

    @Test fun `Send cancels unsent momentum waits for the in-flight scroll and preserves reports`() = runBlocking {
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onScroll = { started.complete(Unit); release.await() }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 80)); withTimeout(2_000) { started.await() }
            assertTrue(actions.report("\u001b[?1;2c")); assertTrue(actions.scroll(false, 12))
            val sent = async(start = CoroutineStart.UNDISPATCHED) { actions.submit(ComposedInput.Paste("command\n", true)) }
            yield(); assertFalse(sent.isCompleted); assertEquals(listOf("scroll:true:20"), stream.log)
            release.complete(Unit)
            assertEquals(ComposedInputResult.DELIVERED, sent.await())
            assertEquals(listOf("scroll:true:20", "raw:\u001b[?1;2c", "send"), stream.log)
            assertEquals(listOf<ComposedInput>(ComposedInput.Paste("command\r", true)), stream.inputs)
            assertTrue(actions.scroll(false, 2)); yield(); assertEquals("scroll:false:2", stream.log.last())
        } finally { actions.close() }
    }

    @Test fun `Ctrl Send is composed once without converting it to paste or adding Enter`() = runBlocking {
        val stream = Stream(); val actions = TerminalActions(this, stream) { true }
        try {
            assertEquals(ComposedInputResult.DELIVERED, actions.submit(ComposedInput.Control("\u0003")))
            assertEquals(listOf<ComposedInput>(ComposedInput.Control("\u0003")), stream.inputs)
            assertTrue(actions.write("raw\r")); yield(); assertEquals(listOf("send", "raw:raw\r"), stream.log)
        } finally { actions.close() }
    }

    @Test fun `refused and uncertain Send results are retained and never automatically replayed`() = runBlocking {
        for (result in listOf(ComposedInputResult.refused(), ComposedInputResult.uncertain())) {
            val stream = Stream().apply { onSubmit = { result } }; val actions = TerminalActions(this, stream) { true }
            try {
                assertEquals(result, actions.submit(ComposedInput.Paste("keep draft", true)))
                yield(); assertEquals(1, stream.inputs.size)
                assertTrue(actions.report("report")); yield(); assertEquals(1, stream.inputs.size)
            } finally { actions.close() }
        }
    }

    @Test fun `unexpected dispatched error is uncertain without raw fallback or replay`() = runBlocking {
        val stream = Stream().apply { onSubmit = { throw IllegalStateException("lost receipt") } }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertEquals(ComposedInputResult.Status.UNCERTAIN, actions.submit(ComposedInput.Paste("keep", true)).status)
            yield(); assertEquals(listOf("send"), stream.log)
        } finally { actions.close() }
    }

    @Test fun `retiring a queued Send refuses before dispatch and immediately retires stream permission`() = runBlocking {
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onScroll = { started.complete(Unit); release.await() }
        val actions = TerminalActions(this, stream) { true }
        assertTrue(actions.scroll(true, 20)); started.await()
        val sent = async(start = CoroutineStart.UNDISPATCHED) { actions.submit(ComposedInput.Paste("stale", true)) }
        actions.close()
        assertTrue(stream.retired, "retirement cannot wait behind raw I/O or detach")
        assertEquals(ComposedInputResult.Status.REFUSED, sent.await().status)
        release.complete(Unit); yield(); assertTrue(stream.inputs.isEmpty())
    }

    @Test fun `retiring an in-flight Send makes its completion uncertain and never uses a replacement`() = runBlocking {
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onSubmit = { started.complete(Unit); release.await(); ComposedInputResult.DELIVERED }
        var current = true; val actions = TerminalActions(this, stream) { current }
        val sent = async(start = CoroutineStart.UNDISPATCHED) { actions.submit(ComposedInput.Paste("old view", true)) }
        started.await(); current = false; actions.close()
        assertEquals(ComposedInputResult.Status.UNCERTAIN, sent.await().status)
        assertTrue(stream.retired); release.complete(Unit); yield(); assertEquals(1, stream.inputs.size)
    }

    @Test fun `cancelling the caller removes a queued Send without disturbing accepted raw input`() = runBlocking {
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onScroll = { started.complete(Unit); release.await() }
        val actions = TerminalActions(this, stream) { true }
        try {
            assertTrue(actions.scroll(true, 20)); started.await()
            val sent = async(start = CoroutineStart.UNDISPATCHED) { actions.submit(ComposedInput.Paste("cancelled", true)) }
            sent.cancelAndJoin(); assertTrue(actions.report("still accepted")); release.complete(Unit); yield()
            assertEquals(listOf("scroll:true:20", "raw:still accepted"), stream.log)
        } finally { actions.close() }
    }

    @Test fun `legacy stream refuses composed Send instead of writing raw text`() = runBlocking {
        var writes = 0
        val stream = object : TerminalStream {
            override val fresh = false
            override fun write(text: String) { writes++ }
            override fun resize(cols: Int, rows: Int) {}
            override suspend fun scroll(up: Boolean, lines: Int) {}
            override suspend fun detach() {}
            override suspend fun endSession() {}
        }
        assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("draft", true)).status)
        assertEquals(0, writes)
    }
}
