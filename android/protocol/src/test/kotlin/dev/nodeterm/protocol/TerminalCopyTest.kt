package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ExternalLink
import dev.nodeterm.protocol.model.Osc52
import dev.nodeterm.protocol.model.TerminalCopy
import dev.nodeterm.protocol.model.TerminalCopy.Selection
import dev.nodeterm.protocol.model.TerminalCopy.Text
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * A32: what the phone opens and copies from its terminal. [ExternalLink] is the app's own gate on a
 * link the page hands over (only http(s), with the host the "Open <host>?" offer names), and
 * [TerminalCopy] reads the Copy sheet's snapshot and turns a selection into text under the clipboard
 * cap the OSC 52 copy keeps (A53). The page's half is [TerminalJsLinksTest].
 */
class TerminalCopyTest {
    @Test
    fun `http and https links are accepted, with the host the offer names`() {
        assertEquals(ExternalLink("https://github.com/x/y?z=1#f", "github.com"), ExternalLink.parse("https://github.com/x/y?z=1#f"))
        assertEquals("example.com", ExternalLink.parse("HTTP://Example.COM:8080/a")?.host)
        assertEquals("[::1]", ExternalLink.parse("http://[::1]:3000/")?.host)
        assertEquals("example.com", ExternalLink.parse("https://example.com")?.host)
        assertEquals("example.com", ExternalLink.parse("https://example.com?q")?.host)
        // A backslash past the authority is the URL parser's own spelling of a query.
        assertEquals("a.example", ExternalLink.parse("https://a.example/?x=\\y")?.host)
    }

    @Test
    fun `the host named is where the link goes, not the user info in front of it`() {
        assertEquals("evil.example", ExternalLink.parse("https://github.com@evil.example/login")?.host)
        assertEquals("evil.example", ExternalLink.parse("https://user:pw@evil.example/")?.host)
    }

    @Test
    fun `everything that is not an http(s) URL with a host is refused`() {
        val refused = listOf(
            "",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "content://com.android.contacts/contacts",
            "intent://scan/#Intent;scheme=zxing;end",
            "ftp://example.com/x",
            "data:text/html,<b>x</b>",
            "mailto:a@b.example",
            "http:/example.com",
            "https://",
            "https:///path",
            "https://:443/",
            "https://user@/x",
            "http://[::1/",
            "http://[::1]x/",
            "http://example.com:80a/",
            // Not as the page sends it: space, control and non-ASCII characters are always encoded.
            "https://example.com/a b",
            "https://example.com/\u0007",
            "https://exämple.com/",
            // A browser reads a backslash in the authority as a slash, so the host would be github.com
            // while the offer named evil.example; the page's URL parser never sends one.
            "https://github.com\\@evil.example/",
            " https://example.com/",
        )
        for (url in refused) assertNull(ExternalLink.parse(url), "accepted: $url")
    }

    @Test
    fun `a link longer than the cap is refused`() {
        val base = "https://example.com/"
        assertEquals("example.com", ExternalLink.parse(base + "a".repeat(ExternalLink.MAX_LENGTH - base.length))?.host)
        assertNull(ExternalLink.parse(base + "a".repeat(ExternalLink.MAX_LENGTH - base.length + 1)))
    }

    private fun snapshotJson(lines: List<Any?>, links: List<Any?> = emptyList(), firstVisible: Any? = 0) = buildJsonObject {
        putJsonArray("lines") { lines.forEach { add(it.json()) } }
        putJsonArray("links") { links.forEach { add(it.json()) } }
        when (firstVisible) {
            is Int -> put("firstVisible", firstVisible)
            is String -> put("firstVisible", firstVisible)
            else -> Unit
        }
    }.toString()

    private fun Any?.json() = when (this) {
        null -> kotlinx.serialization.json.JsonNull
        is String -> JsonPrimitive(this)
        is Number -> JsonPrimitive(this)
        else -> error("unsupported")
    }

    @Test
    fun `a snapshot keeps its lines and only the http(s) links, each once`() {
        val snap = TerminalCopy.parse(
            snapshotJson(
                lines = listOf("a", "", "b"),
                links = listOf("https://a.example/", "javascript:alert(1)", "https://a.example/", "file:///x", "http://b.example/", 7),
                firstVisible = 1
            )
        )
        assertEquals(
            TerminalCopy.Snapshot(listOf("a", "", "b"), listOf(ExternalLink("https://a.example/", "a.example"), ExternalLink("http://b.example/", "b.example")), 1),
            snap
        )
    }

    @Test
    fun `a malformed snapshot is refused or degrades, never throws`() {
        for (bad in listOf("", "not json", "[]", "{}", "{\"lines\":\"a\"}", "{\"lines\":null}")) assertNull(TerminalCopy.parse(bad), bad)
        assertNull(TerminalCopy.parse("{\"lines\":[]," + " ".repeat(TerminalCopy.MAX_JSON) + "\"links\":[]}"))
        // A wrong-typed line is empty, a wrong-typed or out-of-range firstVisible is clamped.
        assertEquals(TerminalCopy.Snapshot(listOf("a", "", ""), emptyList(), 0), TerminalCopy.parse(snapshotJson(listOf("a", 3, null), firstVisible = "x")))
        assertEquals(2, TerminalCopy.parse(snapshotJson(listOf("a", "b", "c"), firstVisible = 99))?.firstVisible)
        assertEquals(0, TerminalCopy.parse(snapshotJson(listOf("a"), firstVisible = -4))?.firstVisible)
        assertEquals(TerminalCopy.Snapshot(emptyList(), emptyList(), 0), TerminalCopy.parse("{\"lines\":[]}"))
    }

    @Test
    fun `a snapshot keeps the last lines and links, and the visible line moves with the cut`() {
        val lines = (0 until TerminalCopy.MAX_LINES + 10).map { "l$it" }
        val links = (0 until TerminalCopy.MAX_LINKS + 5).map { "https://h$it.example/" }
        val snap = TerminalCopy.parse(snapshotJson(lines, links, firstVisible = TerminalCopy.MAX_LINES + 3))!!
        assertEquals(lines.takeLast(TerminalCopy.MAX_LINES), snap.lines)
        assertEquals(links.takeLast(TerminalCopy.MAX_LINKS), snap.links.map { it.url })
        assertEquals("l${TerminalCopy.MAX_LINES + 3}", snap.lines[snap.firstVisible])
    }

    @Test
    fun `a tap toggles a line and a long-press selects the range from the last line tapped`() {
        var s = Selection()
        s = s.toggle(3)
        assertEquals(Selection(setOf(3), anchor = 3), s)
        s = s.extendTo(6)
        assertEquals(setOf(3, 4, 5, 6), s.selected)
        // From the new anchor, upwards, added to what is selected.
        s = s.toggle(9).extendTo(8)
        assertEquals(setOf(3, 4, 5, 6, 8, 9), s.selected)
        // A tap on a selected line deselects it and still anchors there.
        s = s.toggle(4)
        assertEquals(Selection(setOf(3, 5, 6, 8, 9), anchor = 4), s)
        // A long-press with nothing tapped yet selects that line.
        assertEquals(Selection(setOf(2), anchor = 2), Selection().extendTo(2))
        assertEquals(Selection(setOf(0, 1, 2)), s.all(3))
        assertEquals(Selection(), s.clear())
    }

    @Test
    fun `the selected lines are copied in screen order, one per line`() {
        val lines = listOf("one", "two", "", "four")
        assertEquals(Text.Copy("one\n\nfour", 3), TerminalCopy.text(lines, Selection(setOf(3, 0, 2))))
        assertEquals(Text.Copy("two", 1), TerminalCopy.text(lines, Selection(setOf(1, 7, -1))))
        assertEquals(Text.Empty, TerminalCopy.text(lines, Selection()))
        assertEquals(Text.Empty, TerminalCopy.text(lines, Selection(setOf(2))))
        assertEquals(Text.Empty, TerminalCopy.text(lines, Selection(setOf(9))))
    }

    @Test
    fun `a selection over the clipboard cap is refused before any text is built`() {
        val half = Osc52.MAX_TEXT_CHARS / 2
        // Two lines and the newline between them: exactly at the cap, then one over.
        val atCap = listOf("a".repeat(half), "b".repeat(Osc52.MAX_TEXT_CHARS - half - 1))
        val copied = TerminalCopy.text(atCap, Selection(setOf(0, 1)))
        assertEquals(Osc52.MAX_TEXT_CHARS, (copied as Text.Copy).text.length)
        val over = listOf("a".repeat(half), "b".repeat(Osc52.MAX_TEXT_CHARS - half))
        assertEquals(Text.TooLarge, TerminalCopy.text(over, Selection(setOf(0, 1))))
        assertEquals(Text.TooLarge, TerminalCopy.text(listOf("x".repeat(Osc52.MAX_TEXT_CHARS + 1)), Selection(setOf(0))))
    }
}
