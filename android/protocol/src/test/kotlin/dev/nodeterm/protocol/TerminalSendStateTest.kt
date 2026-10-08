package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ComposedCompletion
import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.host.ComposedInputResult
import dev.nodeterm.protocol.host.TerminalActions
import dev.nodeterm.protocol.host.TerminalStream
import dev.nodeterm.protocol.model.CtrlModifier
import dev.nodeterm.protocol.model.TerminalDrafts
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Real entry/actor policy, with deferred host calls; no Compose, Android Handler or physical claims. */
class TerminalSendStateTest {
    private data class Editor(val text: String = "", val start: Int = 0, val end: Int = start)
    private val empty = Editor()

    @Test fun `the exact accepted editor and modifier are reserved before preparation and survive coverage`() {
        val drafts = TerminalDrafts(empty); val entry = drafts.entry("terminal", "host")
        entry.edit(Editor("command Ω🧭", 2, 7)); entry.setCtrl(CtrlModifier().withArmed(true))
        val before = entry.state.value; val sent = assertNotNull(entry.beginSend())
        assertSame(before.value, sent.value); assertEquals(before.revision, sent.revision); assertSame(before.ctrl, sent.ctrl)
        entry.edit(Editor("new unsent", 3)); entry.setCtrl(entry.state.value.ctrl.withArmed(false))
        drafts.retain(setOf("terminal")); val remounted = drafts.entry("terminal", "host")
        assertSame(entry, remounted); assertSame(sent.attempt, remounted.state.value.pendingSend)
        assertNull(remounted.beginSend(), "both button and IME admission must refuse another pending attempt")
        assertTrue(entry.completeSend(sent.attempt, ComposedInputResult.uncertain(), false))
        assertNotNull(remounted.beginSend())
    }

    @Test fun `only the exact pending token can complete once and old results cannot end a newer Send`() {
        val drafts = TerminalDrafts(empty); val entry = drafts.entry("a", "host"); val other = drafts.entry("b", "host")
        val first = assertNotNull(entry.beginSend()); val foreign = assertNotNull(other.beginSend())
        assertFalse(entry.completeSend(foreign.attempt, ComposedInputResult.DELIVERED, true))
        assertSame(first.attempt, entry.state.value.pendingSend)
        assertTrue(entry.completeSend(first.attempt, ComposedInputResult.uncertain(), false))
        val second = assertNotNull(entry.beginSend()); val before = entry.state.value
        assertFalse(entry.completeSend(first.attempt, ComposedInputResult.DELIVERED, true))
        assertSame(before, entry.state.value); assertSame(second.attempt, entry.state.value.pendingSend)
        assertTrue(entry.completeSend(second.attempt, ComposedInputResult.DELIVERED, true))
        assertFalse(entry.completeSend(second.attempt, ComposedInputResult.refused(), true))
    }

    @Test fun `a stale positive becomes visible uncertainty without clearing a newer draft or Ctrl`() {
        val entry = TerminalDrafts(empty).entry("a", "host")
        entry.edit(Editor("sent", 4)); val sent = assertNotNull(entry.beginSend())
        val completion = ComposedCompletion(sent.ctrl.revision)
        entry.edit(Editor("next unsent", 2, 6)); entry.setCtrl(entry.state.value.ctrl.withArmed(true))
        assertTrue(entry.completeSend(sent.attempt, ComposedInputResult.DELIVERED, false))
        val notice = assertNotNull(entry.state.value.sendNotice)
        assertEquals(ComposedInputResult.Status.UNCERTAIN, notice.status)
        assertTrue(notice.message.contains("check the terminal", ignoreCase = true))
        assertFalse(completion.complete(ComposedInputResult.DELIVERED, false, entry.state.value.ctrl.revision,
            { entry.setCtrl(entry.state.value.ctrl.withArmed(false)) }, { entry.clearUnchangedDraft(sent.revision) }))
        assertEquals(Editor("next unsent", 2, 6), entry.state.value.value); assertTrue(entry.state.value.ctrl.armed)
    }

    @Test fun `known refusal stays refused after view retirement and releases its pending reservation`() {
        val entry = TerminalDrafts(empty).entry("a", "host"); entry.edit(Editor("kept", 1))
        val sent = assertNotNull(entry.beginSend())
        assertTrue(entry.completeSend(sent.attempt, ComposedInputResult.refused("Not dispatched"), false))
        assertNull(entry.state.value.pendingSend)
        assertEquals(ComposedInputResult.Status.REFUSED, entry.state.value.sendNotice?.status)
        assertEquals("Not dispatched", entry.state.value.sendNotice?.message)
        assertEquals(Editor("kept", 1), entry.state.value.value)
    }

    @Test fun `uncertainty survives edits modifier changes remount and later success until explicitly dismissed`() {
        val drafts = TerminalDrafts(empty); val entry = drafts.entry("a", "host")
        val sent = assertNotNull(entry.beginSend()); entry.completeSend(sent.attempt, ComposedInputResult.uncertain(), false)
        val notice = assertNotNull(entry.state.value.sendNotice)
        entry.edit(Editor("later", 1, 3)); entry.setCtrl(CtrlModifier().withArmed(true))
        drafts.retain(setOf("a")); assertSame(notice, drafts.entry("a", "host").state.value.sendNotice)
        val later = assertNotNull(entry.beginSend()); entry.completeSend(later.attempt, ComposedInputResult.DELIVERED, true)
        assertSame(notice, entry.state.value.sendNotice)
        assertTrue(entry.dismissSendNotice(notice)); assertNull(entry.state.value.sendNotice)
        assertFalse(entry.completeSend(sent.attempt, ComposedInputResult.uncertain(), false))
        assertNull(entry.state.value.sendNotice, "a duplicate old result cannot resurrect dismissed guidance")
    }

    @Test fun `a stale dismissal cannot hide an identical notice from a newer attempt`() {
        val entry = TerminalDrafts(empty).entry("a", "host")
        val first = assertNotNull(entry.beginSend()); entry.completeSend(first.attempt, ComposedInputResult.uncertain(), false)
        val old = assertNotNull(entry.state.value.sendNotice)
        val second = assertNotNull(entry.beginSend()); entry.completeSend(second.attempt, ComposedInputResult.uncertain(), false)
        val latest = assertNotNull(entry.state.value.sendNotice); assertEquals(old.message, latest.message)
        assertFalse(entry.dismissSendNotice(old)); assertSame(latest, entry.state.value.sendNotice)
        assertTrue(entry.dismissSendNotice(latest))
    }

    @Test fun `a later known refusal cannot erase earlier uncertainty before explicit dismissal`() {
        val entry = TerminalDrafts(empty).entry("a", "host")
        val first = assertNotNull(entry.beginSend()); entry.completeSend(first.attempt, ComposedInputResult.uncertain(), false)
        val uncertain = assertNotNull(entry.state.value.sendNotice)
        val second = assertNotNull(entry.beginSend())
        assertTrue(entry.completeSend(second.attempt, ComposedInputResult.refused("Invalid later Send"), true))
        assertNull(entry.state.value.pendingSend); assertSame(uncertain, entry.state.value.sendNotice)
        assertEquals(ComposedInputResult.Status.UNCERTAIN, entry.state.value.sendNotice?.status)
        assertTrue(entry.dismissSendNotice(uncertain))
        val third = assertNotNull(entry.beginSend()); entry.completeSend(third.attempt, ComposedInputResult.refused("Not dispatched"), false)
        assertEquals(ComposedInputResult.Status.REFUSED, entry.state.value.sendNotice?.status)
        assertEquals("Not dispatched", entry.state.value.sendNotice?.message)
    }

    @Test fun `pop forget and owner replacement release all Send state and seal old handles`() {
        for (retire in listOf<(TerminalDrafts<Editor>) -> Unit>({ it.retain(emptySet()) },
            { it.retireOwner("host") }, { it.entry("a", "different host") })) {
            val drafts = TerminalDrafts(empty); val old = drafts.entry("a", "host")
            old.edit(Editor("private")); val first = assertNotNull(old.beginSend())
            old.completeSend(first.attempt, ComposedInputResult.uncertain(), false)
            val notice = assertNotNull(old.state.value.sendNotice); val pending = assertNotNull(old.beginSend())
            retire(drafts)
            assertNull(old.state.value.pendingSend); assertNull(old.state.value.sendNotice); assertEquals(empty, old.state.value.value)
            assertNull(old.beginSend()); assertFalse(old.completeSend(pending.attempt, ComposedInputResult.DELIVERED, true))
            assertFalse(old.dismissSendNotice(notice))
            val next = drafts.entry("a", "host"); val fresh = assertNotNull(next.beginSend())
            assertFalse(next.completeSend(pending.attempt, ComposedInputResult.DELIVERED, true))
            assertSame(fresh.attempt, next.state.value.pendingSend)
        }
    }

    @Test fun `two live entries keep independent pending state and guidance`() {
        val drafts = TerminalDrafts(empty); val a = drafts.entry("a", "host"); val b = drafts.entry("b", "host")
        val sa = assertNotNull(a.beginSend()); val sb = assertNotNull(b.beginSend())
        a.completeSend(sa.attempt, ComposedInputResult.uncertain(), false)
        assertNull(a.state.value.pendingSend); assertNotNull(a.state.value.sendNotice)
        assertSame(sb.attempt, b.state.value.pendingSend); assertNull(b.state.value.sendNotice)
    }

    private class Stream : TerminalStream {
        override val fresh = false
        val inputs = mutableListOf<ComposedInput>()
        var retired = false
        var onScroll: suspend () -> Unit = {}
        var onSubmit: suspend () -> ComposedInputResult = { ComposedInputResult.DELIVERED }
        override fun write(text: String) {}
        override fun resize(cols: Int, rows: Int) {}
        override suspend fun scroll(up: Boolean, lines: Int) { onScroll() }
        override suspend fun submitComposed(input: ComposedInput): ComposedInputResult { inputs += input; return onSubmit() }
        override fun retireComposed() { retired = true }
        override suspend fun detach() {}
        override suspend fun endSession() {}
    }

    @Test fun `covering a dispatched actor retains pending until its exact uncertainty settles without replay`() = runBlocking {
        val drafts = TerminalDrafts(empty); val entry = drafts.entry("a", "host"); entry.edit(Editor("command", 7))
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onSubmit = { started.complete(Unit); release.await(); ComposedInputResult.DELIVERED }
        var current = true; val actor = TerminalActions(this, stream) { current }
        val sent = assertNotNull(entry.beginSend())
        val receipt = async(start = CoroutineStart.UNDISPATCHED) { actor.submit(ComposedInput.Paste(sent.value.text, true)) }
        try {
            withTimeout(2_000) { started.await() }; current = false; actor.close(); drafts.retain(setOf("a"))
            val remounted = drafts.entry("a", "host")
            assertNull(remounted.beginSend()); assertSame(sent.attempt, remounted.state.value.pendingSend)
            val result = receipt.await(); assertEquals(ComposedInputResult.Status.UNCERTAIN, result.status)
            assertTrue(remounted.completeSend(sent.attempt, result, false)); assertTrue(stream.retired)
            assertNull(remounted.state.value.pendingSend); assertEquals(ComposedInputResult.Status.UNCERTAIN, remounted.state.value.sendNotice?.status)
            release.complete(Unit); yield(); assertEquals(listOf<ComposedInput>(ComposedInput.Paste("command", true)), stream.inputs)
            assertEquals(Editor("command", 7), remounted.state.value.value)
        } finally { release.complete(Unit); actor.close() }
    }

    @Test fun `covering a queued actor retains a known refusal with no host execution`() = runBlocking {
        val entry = TerminalDrafts(empty).entry("a", "host"); entry.edit(Editor("unsent", 6))
        val stream = Stream(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        stream.onScroll = { started.complete(Unit); release.await() }
        val actor = TerminalActions(this, stream) { true }
        try {
            actor.scroll(true, 20); withTimeout(2_000) { started.await() }
            val sent = assertNotNull(entry.beginSend())
            val receipt = async(start = CoroutineStart.UNDISPATCHED) { actor.submit(ComposedInput.Paste(sent.value.text, true)) }
            actor.close(); val result = receipt.await()
            assertEquals(ComposedInputResult.Status.REFUSED, result.status)
            assertTrue(entry.completeSend(sent.attempt, result, false))
            assertEquals(ComposedInputResult.Status.REFUSED, entry.state.value.sendNotice?.status)
            assertEquals(Editor("unsent", 6), entry.state.value.value); assertTrue(stream.inputs.isEmpty())
        } finally { release.complete(Unit); actor.close() }
    }

    @Test fun `a current confirmed attempt settles then clears only its unchanged draft and captured Ctrl`() {
        val entry = TerminalDrafts(empty).entry("a", "host"); entry.edit(Editor("sent", 4))
        entry.setCtrl(CtrlModifier().withArmed(true)); val sent = assertNotNull(entry.beginSend())
        val policy = ComposedCompletion(sent.ctrl.revision)
        assertTrue(entry.completeSend(sent.attempt, ComposedInputResult.DELIVERED, true))
        assertTrue(policy.complete(ComposedInputResult.DELIVERED, true, entry.state.value.ctrl.revision,
            { entry.setCtrl(entry.state.value.ctrl.withArmed(false)) }, { entry.clearUnchangedDraft(sent.revision) }))
        assertEquals(empty, entry.state.value.value); assertFalse(entry.state.value.ctrl.armed)
        assertNull(entry.state.value.pendingSend); assertNull(entry.state.value.sendNotice)
        assertFalse(entry.completeSend(sent.attempt, ComposedInputResult.DELIVERED, true))
    }
}
