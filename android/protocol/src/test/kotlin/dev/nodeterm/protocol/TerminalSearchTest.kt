package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.TerminalCopy
import dev.nodeterm.protocol.model.TerminalCopy.Match
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Search the captured output without typing into the remote terminal or changing a copy selection. */
class TerminalSearchTest {
    @Test
    fun `matching is literal and case insensitive with exact row offsets`() {
        val lines = listOf("ok", "[ERROR]. boom [error].", "error without punctuation")
        assertEquals(listOf(Match(1, 0, 8), Match(1, 14, 22)), TerminalCopy.search(lines, "[error].").matches)
        assertEquals(listOf(Match(1, 7, 8), Match(1, 21, 22)), TerminalCopy.search(lines, ".").matches)
        assertEquals(emptyList(), TerminalCopy.search(lines, "[unclosed").matches)
    }

    @Test
    fun `empty and blank queries never match all output`() {
        for (query in listOf("", " ", "\t\n")) {
            assertEquals(TerminalCopy.Search(emptyList()), TerminalCopy.search(listOf("text", " "), query))
        }
        assertEquals(emptyList(), TerminalCopy.search(emptyList(), "x").matches)
        assertEquals(emptyList(), TerminalCopy.search(listOf("tiny"), "a much longer query").matches)
    }

    @Test
    fun `spaces within a query are significant and occurrences do not overlap`() {
        assertEquals(listOf(Match(0, 1, 4)), TerminalCopy.search(listOf("x a x", "a"), " a ").matches)
        assertEquals(listOf(Match(0, 0, 2), Match(0, 2, 4)), TerminalCopy.search(listOf("aaaaa"), "aa").matches)
    }

    @Test
    fun `Unicode matching preserves original UTF16 highlighting offsets`() {
        assertEquals(listOf(Match(0, 3, 8), Match(0, 12, 17)), TerminalCopy.search(listOf("🚀 ÄRGER 🚀 ärger"), "ärger").matches)
        assertEquals(listOf(Match(0, 0, 2), Match(0, 9, 11)), TerminalCopy.search(listOf("🚀 ÄRGER 🚀 ärger"), "🚀").matches)
    }

    @Test
    fun `matching repeated text preserves original line identity and copy order`() {
        val lines = listOf("error old", "ok", "error new", "error new")
        val selected = TerminalCopy.Selection(setOf(2, 1), anchor = 2)
        val result = TerminalCopy.search(lines, "error")
        assertEquals(listOf(0, 2, 3), result.matches.map { it.line })
        assertEquals(TerminalCopy.Text.Copy("ok\nerror new", 2), TerminalCopy.text(lines, selected))
        assertEquals(2, result.matches[result.move(0, forward = true)!!].line)
    }

    @Test
    fun `navigation wraps in both directions and stale cursors choose the appropriate edge`() {
        val result = TerminalCopy.search(listOf("x x x"), "x")
        assertEquals(0, result.move(null, forward = true))
        assertEquals(2, result.move(null, forward = false))
        assertEquals(1, result.move(0, forward = true))
        assertEquals(0, result.move(2, forward = true))
        assertEquals(2, result.move(0, forward = false))
        assertEquals(1, result.move(2, forward = false))
        assertEquals(0, result.move(99, forward = true))
        assertEquals(2, result.move(-1, forward = false))
        assertNull(TerminalCopy.search(listOf("ok"), "x").move(0, forward = true))
        assertEquals(0, TerminalCopy.search(listOf("x"), "x").move(0, forward = false))
    }

    @Test
    fun `the match cap reports truncation only when another occurrence actually exists`() {
        val cap = TerminalCopy.MAX_SEARCH_MATCHES
        val atCap = TerminalCopy.search(listOf("x".repeat(cap)), "x")
        assertEquals(cap, atCap.matches.size)
        assertFalse(atCap.truncated)
        val over = TerminalCopy.search(listOf("x".repeat(cap), "x"), "x")
        assertEquals(cap, over.matches.size)
        assertTrue(over.truncated)
        assertEquals(Match(0, cap - 1, cap), over.matches.last())
    }

    @Test
    fun `native search uses captured rows and offsets without changing selection or sending input`() {
        val screen = AppSourcePins.ui("TerminalScreen.kt")
        val sheet = AppSourcePins.blockAfter(screen, "private fun CopySheet(")
        AppSourcePins.assertInOrder(sheet, "var query by remember(snapshot)", "TerminalCopy.search(snapshot.lines, query)")
        assertTrue("var matchIndex by remember(snapshot, query)" in sheet, "A different query must reset its match cursor")
        assertTrue("listState.scrollToItem(linkRows + it.line)" in sheet, "Links before the text must not offset search to the wrong row")
        assertTrue("itemsIndexed(snapshot.lines, key = { i, _ -> \"line:\$i\" })" in sheet, "Search must retain the original rows used by copy and range selection")
        assertTrue("match.start, match.end" in sheet, "Highlights must retain the model's UTF16 offsets")
        assertTrue("No matches in captured output" in sheet)
        assertTrue("Clear search" in sheet)
        assertTrue("Text(\"Previous\")" in sheet && "Text(\"Next\")" in sheet)
        assertFalse("controller.raw(" in sheet || "controller.key(" in sheet, "Local search must not send a query to the remote shell")
        val change = AppSourcePins.blockAfter(sheet, "onValueChange =")
        assertEquals("{ query = it }", change.trim())
    }

    @Test
    fun `the Find chip opens host history search without typing`() {
        val chip = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalScreen.kt"), "KeyChip(\"Find\")")
        AppSourcePins.assertInOrder(chip, "focusManager.clearFocus()", "controller.openHistory()")
        assertFalse("controller.raw(" in chip || "controller.key(" in chip)
    }
}
