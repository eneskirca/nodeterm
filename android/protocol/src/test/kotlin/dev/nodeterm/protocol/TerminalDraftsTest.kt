package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ComposedCompletion
import dev.nodeterm.protocol.host.ComposedInputResult
import dev.nodeterm.protocol.model.CtrlModifier
import dev.nodeterm.protocol.model.TerminalDrafts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue

class TerminalDraftsTest {
    private data class Editor(val text: String = "", val start: Int = 0, val end: Int = start)
    private val empty = Editor()

    @Test fun `covering a live entry retains its full editor selection revision and Ctrl`() {
        val drafts = TerminalDrafts(empty)
        val first = drafts.entry("terminal-1", "host-1")
        first.edit(Editor("unsent Ω🧭 command", 2, 7))
        first.setCtrl(CtrlModifier().withArmed(true))
        val before = first.state.value
        // The retained stack still contains this entry while its Pair screen is composed.
        drafts.retain(setOf("terminal-1"))
        val returned = drafts.entry("terminal-1", "host-1")
        assertSame(first, returned)
        assertSame(before, returned.state.value)
        assertEquals(Editor("unsent Ω🧭 command", 2, 7), returned.state.value.value)
        assertTrue(returned.state.value.ctrl.armed)
    }

    @Test fun `different entries for the same host have independent drafts and modifiers`() {
        val drafts = TerminalDrafts(empty)
        val a = drafts.entry("a", "host")
        val b = drafts.entry("b", "host")
        a.edit(Editor("first", 3)); a.setCtrl(CtrlModifier().withArmed(true))
        b.edit(Editor("second", 1, 4))
        assertNotSame(a, b)
        assertEquals(Editor("first", 3), a.state.value.value)
        assertEquals(Editor("second", 1, 4), b.state.value.value)
        assertTrue(a.state.value.ctrl.armed)
        assertFalse(b.state.value.ctrl.armed)
    }

    @Test fun `an edit away and back cannot be cleared by the earlier Send revision`() {
        val drafts = TerminalDrafts(empty)
        val entry = drafts.entry("a", "host")
        entry.edit(Editor("command", 7))
        val sent = entry.state.value
        entry.edit(Editor("other", 5)); entry.edit(sent.value)
        assertFalse(entry.clearUnchangedDraft(sent.revision))
        assertEquals(sent.value, entry.state.value.value)
        val latest = entry.state.value
        assertTrue(entry.clearUnchangedDraft(latest.revision))
        assertEquals(empty, entry.state.value.value)
        assertFalse(entry.clearUnchangedDraft(latest.revision), "the same completion clears once")
    }

    @Test fun `identical editor reports advance the draft revision while Ctrl changes do not`() {
        val entry = TerminalDrafts(empty).entry("a", "host")
        entry.edit(Editor("command", 7))
        val sent = entry.state.value
        entry.edit(sent.value)
        assertEquals(sent.revision + 1, entry.state.value.revision)
        val edited = entry.state.value
        entry.setCtrl(edited.ctrl.withArmed(true))
        assertEquals(edited.revision, entry.state.value.revision)
        assertFalse(entry.clearUnchangedDraft(sent.revision))
        assertTrue(entry.clearUnchangedDraft(edited.revision))
        assertTrue(entry.state.value.ctrl.armed, "clearing the draft cannot consume a new Ctrl arm")
    }

    @Test fun `retiring a stack releases values and seals old references before a new entry mounts`() {
        val drafts = TerminalDrafts(empty)
        val old = drafts.entry("a", "host")
        old.edit(Editor("secret command", 2)); old.setCtrl(CtrlModifier().withArmed(true))
        val sent = old.state.value
        drafts.retain(emptySet())
        assertEquals(empty, old.state.value.value)
        assertFalse(old.state.value.ctrl.armed)
        assertFalse(old.edit(Editor("late dictation")))
        assertFalse(old.setCtrl(CtrlModifier().withArmed(true)))
        assertFalse(old.clearUnchangedDraft(sent.revision))
        val replacement = drafts.entry("a", "host")
        assertNotSame(old, replacement)
        assertEquals(empty, replacement.state.value.value)
    }

    @Test fun `forgetting one owner retires all of its entries and preserves another host`() {
        val drafts = TerminalDrafts(empty)
        val a = drafts.entry("a", "host-a"); val a2 = drafts.entry("a2", "host-a")
        val b = drafts.entry("b", "host-b")
        a.edit(Editor("a")); a2.edit(Editor("a2")); b.edit(Editor("b", 1))
        val beforeB = b.state.value
        drafts.retireOwner("host-a")
        assertEquals(empty, a.state.value.value); assertEquals(empty, a2.state.value.value)
        assertFalse(a.edit(Editor("late"))); assertFalse(a2.edit(Editor("late")))
        assertSame(beforeB, b.state.value)
        assertSame(b, drafts.entry("b", "host-b"))
        assertNotSame(a, drafts.entry("a", "host-a"))
    }

    @Test fun `a key reused with a different owner cannot adopt its earlier editor`() {
        val drafts = TerminalDrafts(empty)
        val old = drafts.entry("a", "host-a"); old.edit(Editor("first host"))
        val next = drafts.entry("a", "host-b")
        assertNotSame(old, next)
        assertEquals(empty, next.state.value.value)
        assertEquals(empty, old.state.value.value)
        assertFalse(old.edit(Editor("late first host")))
    }

    @Test fun `retained large Unicode drafts are kept exactly without truncation or serialization`() {
        val drafts = TerminalDrafts(empty)
        val value = Editor("Ω🧭".repeat(300_000), 6, 899_997)
        drafts.entry("a", "host").edit(value)
        drafts.retain(setOf("a"))
        assertSame(value, drafts.entry("a", "host").state.value.value)
        // A new process has no draft store; command text was never serialized by this policy.
        assertEquals(empty, TerminalDrafts(empty).entry("a", "host").state.value.value)
    }

    @Test fun `a stale delivered receipt cannot clear the newer editor of a retained entry`() {
        val drafts = TerminalDrafts(empty)
        val entry = drafts.entry("a", "host")
        entry.edit(Editor("sent", 4)); val sent = entry.state.value
        val completion = ComposedCompletion(sent.ctrl.revision)
        drafts.retain(setOf("a")); val returned = drafts.entry("a", "host")
        returned.edit(Editor("next unsent", 2, 6)); returned.setCtrl(returned.state.value.ctrl.withArmed(true))
        var delivered = false
        assertFalse(completion.complete(ComposedInputResult.DELIVERED, false, returned.state.value.ctrl.revision,
            { returned.setCtrl(returned.state.value.ctrl.withArmed(false)) },
            { delivered = true; entry.clearUnchangedDraft(sent.revision) }))
        assertFalse(delivered)
        assertEquals(Editor("next unsent", 2, 6), returned.state.value.value)
        assertTrue(returned.state.value.ctrl.armed)
    }
}
