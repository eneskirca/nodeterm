package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.BackStack
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The app's back stack (audit A43). The Navigator and its SaveableStateHolder wiring are only
 * type-checked; they file each entry's saved UI state under [BackStack.Entry.key] and drop the state
 * of every [BackStack.retired] key. These pin the keys: one per ENTRY, kept while the entry is on the
 * stack (and across recreation), retired when it leaves.
 */
class BackStackTest {
    private fun counter(): () -> String {
        var n = 0
        return { "k${++n}" }
    }

    /** The route codec the app uses, reduced: a route is its list of strings. */
    private val codec: (List<String>) -> List<String>? = { it.takeIf { r -> r.firstOrNull() != "pair" } }

    @Test
    fun `the same screen twice gets two keys`() {
        // A computer's Host screen opened again from a notification must not share state with the one
        // below it, so the key cannot be derived from the route.
        val s = BackStack.of(listOf("hosts"), "hosts").push("host:a").push("terminal:a:n1").push("host:a")
        val keys = s.entries.map { it.key }
        assertEquals(keys.size, keys.toSet().size)
        assertNotEquals(s.entries[1].key, s.entries[3].key)
    }

    @Test
    fun `pushing a terminal and popping it keeps the host screen's key, and retires the terminal's`() {
        val host = BackStack.of(listOf("hosts"), "hosts", counter()).push("host:a")
        val hostKey = host.currentKey
        val withTerminal = host.push("terminal:a:n1")
        val terminalKey = withTerminal.currentKey
        val back = withTerminal.pop()!!
        assertEquals(hostKey, back.currentKey)
        assertEquals(listOf(terminalKey), back.retired)
        assertEquals(emptyList(), back.withoutRetired().retired)
        assertEquals(hostKey, back.withoutRetired().currentKey)
    }

    @Test
    fun `the root is never popped`() {
        assertNull(BackStack.of(listOf("hosts"), "hosts").pop())
    }

    @Test
    fun `a new entry never reuses a key that still names saved state`() {
        // A counter that restarts would hand the new terminal the popped one's key, and with it the
        // popped terminal's saved state.
        var n = 0
        val source = { "k${(n++ % 3) + 1}" }
        val s = BackStack.of(listOf("hosts"), "hosts", source).push("host:a", source).push("terminal:a:n1", source)
        val popped = s.pop()!!
        val again = popped.push("terminal:a:n1", source)
        assertTrue(again.currentKey !in popped.retired)
        assertTrue(again.currentKey !in popped.entries.map { it.key })
    }

    @Test
    fun `replaceAll retires every entry, even one showing the same screen`() {
        val s = BackStack.of(listOf("hosts"), "hosts").push("host:a")
        val old = s.entries.map { it.key }
        val r = s.replaceAll("hosts")
        assertEquals(listOf("hosts"), r.values)
        assertEquals(old, r.retired)
        assertTrue(r.currentKey !in old)
    }

    @Test
    fun `retain keeps each surviving entry under its own key and retires the rest`() {
        val s = BackStack.of(listOf("hosts"), "hosts").push("host:a").push("host:gone").push("terminal:a:n1")
        val keys = s.entries.map { it.key }
        val r = s.retain("hosts") { !it.endsWith("gone") }
        assertEquals(listOf("hosts", "host:a", "terminal:a:n1"), r.values)
        assertEquals(listOf(keys[0], keys[1], keys[3]), r.entries.map { it.key })
        assertEquals(listOf(keys[2]), r.retired)
        // Nothing removed: the very same stack.
        assertTrue(r.retain("hosts") { true } === r)
    }

    @Test
    fun `retain that leaves nothing falls back to a new entry and retires everything`() {
        val s = BackStack.of(listOf("host:gone"), "hosts")
        val r = s.retain("hosts") { false }
        assertEquals(listOf("hosts"), r.values)
        assertEquals(s.entries.map { it.key }, r.retired)
        assertTrue(r.currentKey !in r.retired)
    }

    @Test
    fun `keys and retired keys survive a save and restore`() {
        // A recreation (rotation, process death) restores the SaveableStateHolder's state by key: the
        // restored stack must name its entries by the same keys, or the Host screen below a terminal
        // comes back on its first tab and scrolled to the top.
        val s = BackStack.of(listOf("hosts"), "hosts").push("host:a").push("terminal:a:n1").push("terminal:a:n2").pop()!!
        val restored = BackStack.decode(s.encode { it.split(":") }, "hosts", route = { it.joinToString(":") })
        assertEquals(s.entries, restored.entries)
        assertEquals(s.retired, restored.retired)
    }

    @Test
    fun `an entry that no longer restores is dropped and its key retired`() {
        val s = BackStack.of(listOf("hosts"), "hosts").push("pair:code")
        val pairKey = s.currentKey
        val restored = BackStack.decode(s.encode { it.split(":") }, listOf("hosts"), route = codec)
        assertEquals(listOf(listOf("hosts")), restored.values)
        assertEquals(s.entries[0].key, restored.currentKey)
        assertEquals(listOf(pairKey), restored.retired)
    }

    @Test
    fun `a stack saved before keys existed restores with new, distinct keys`() {
        // The audit A22 format: a bare array of routes.
        val raw = """[["hosts"],["host","a","0"],["pair","nodeterm://pair?code=x"],["terminal","a","n1","T"]]"""
        val restored = BackStack.decode(raw, listOf("hosts"), route = codec)
        assertEquals(listOf(listOf("hosts"), listOf("host", "a", "0"), listOf("terminal", "a", "n1", "T")), restored.values)
        assertEquals(3, restored.entries.map { it.key }.toSet().size)
        assertEquals(emptyList(), restored.retired)
    }

    @Test
    fun `a corrupted save cannot give two entries one key, nor retire a live one`() {
        val raw = """{"entries":[{"key":"a","route":["hosts"]},{"key":"a","route":["host","x","0"]},{"route":["settings"]}],""" +
            """"retired":["a","b","b"]}"""
        val restored = BackStack.decode(raw, listOf("hosts"), route = codec)
        assertEquals(listOf(listOf("hosts"), listOf("host", "x", "0"), listOf("settings")), restored.values)
        val keys = restored.entries.map { it.key }
        assertEquals("a", keys[0])
        assertEquals(3, keys.toSet().size)
        assertEquals(listOf("b"), restored.retired)
    }

    @Test
    fun `unreadable saves fall back to the root`() {
        for (raw in listOf("", "not json", "42", """{"entries":"x"}""", """{"entries":[{"key":"k","route":["pair","c"]}]}""")) {
            val restored = BackStack.decode(raw, listOf("hosts"), route = codec)
            assertEquals(listOf(listOf("hosts")), restored.values, raw)
            assertTrue(restored.currentKey !in restored.retired, raw)
        }
    }
}
