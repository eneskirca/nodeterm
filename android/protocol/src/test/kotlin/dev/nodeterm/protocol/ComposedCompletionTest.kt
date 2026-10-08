package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ComposedCompletion
import dev.nodeterm.protocol.host.ComposedInputResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposedCompletionTest {
    private class Ui {
        var draft = "command"
        var draftRevision = 0L
        var ctrl = true
        var ctrlRevision = 0L
        var clears = 0
        var deliveredCallbacks = 0
        fun edit(text: String) { draft = text; draftRevision++ }
        fun toggleCtrl() { ctrl = !ctrl; ctrlRevision++ }
        fun completion(): Pair<ComposedCompletion, () -> Unit> {
            val revision = draftRevision
            return ComposedCompletion(ctrlRevision) to {
                deliveredCallbacks++
                ComposedCompletion.clearUnchangedDraft(revision, draftRevision) { draft = ""; draftRevision++; clears++ }
            }
        }
        fun complete(policy: ComposedCompletion, callback: () -> Unit, result: ComposedInputResult, current: Boolean = true) =
            policy.complete(result, current, ctrlRevision, { ctrl = false; ctrlRevision++ }, callback)
    }

    @Test fun `admission does not clear anything and only a confirmed same-view delivery clears once`() = runBlocking {
        val ui = Ui(); val (policy, callback) = ui.completion(); val receipt = CompletableDeferred<ComposedInputResult>()
        val sending = async { ui.complete(policy, callback, receipt.await()) }
        yield(); assertEquals("command", ui.draft); assertTrue(ui.ctrl); assertEquals(0, ui.deliveredCallbacks)
        receipt.complete(ComposedInputResult.DELIVERED); assertTrue(sending.await())
        assertEquals("", ui.draft); assertFalse(ui.ctrl); assertEquals(1, ui.clears); assertEquals(1, ui.deliveredCallbacks)
        assertFalse(ui.complete(policy, callback, ComposedInputResult.DELIVERED)); assertEquals(1, ui.clears)
    }

    @Test fun `refused uncertain and stale positive completions keep the draft and armed Ctrl`() {
        for ((result, current) in listOf(ComposedInputResult.refused() to true,
            ComposedInputResult.uncertain() to true, ComposedInputResult.DELIVERED to false)) {
            val ui = Ui(); val (policy, callback) = ui.completion()
            assertFalse(ui.complete(policy, callback, result, current))
            assertEquals("command", ui.draft); assertTrue(ui.ctrl); assertEquals(0, ui.clears); assertEquals(0, ui.deliveredCallbacks)
            assertFalse(ui.complete(policy, callback, ComposedInputResult.DELIVERED), "a later reply never upgrades a completed uncertain ticket")
        }
    }

    @Test fun `editing away and back to identical draft text preserves the new draft after confirmed delivery`() {
        val ui = Ui(); val (policy, callback) = ui.completion()
        ui.edit("another command"); ui.edit("command")
        assertTrue(ui.complete(policy, callback, ComposedInputResult.DELIVERED))
        assertEquals("command", ui.draft); assertEquals(0, ui.clears); assertEquals(1, ui.deliveredCallbacks)
    }

    @Test fun `rearming Ctrl while Send awaits receipt keeps the new control state`() {
        val ui = Ui(); val (policy, callback) = ui.completion()
        ui.toggleCtrl(); ui.toggleCtrl()
        assertTrue(ui.complete(policy, callback, ComposedInputResult.DELIVERED))
        assertTrue(ui.ctrl); assertEquals(2L, ui.ctrlRevision); assertEquals("", ui.draft)
    }
}
