package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.TerminalHistory as H
import kotlin.test.*

class TerminalHistoryTest {
    @Test fun `SSH framing preserves tabs Unicode and literal query syntax`() {
        val result = H.parseSsh("NT-HISTORY-1\t999\t0\n0\told.* Ω 😀\n998\ttab\t.* Ω 😀\n", ".* Ω 😀")!!
        assertEquals(999, result.searchedLines)
        assertEquals(listOf(H.Row(0, "old.* Ω 😀"), H.Row(998, "tab\t.* Ω 😀")), result.rows)
        assertFalse(result.truncated)
        assertTrue(H.parseSsh("NT-HISTORY-1\t999\t1\n", "x")!!.truncated)
    }
    @Test fun `malformed incomplete stale and oversized results are refused`() {
        for (text in listOf("", "NT-HISTORY-1\t-1\t0\n", "NT-HISTORY-1\t2\t2\n", "NT-HISTORY-1\t2\t0\n2\tx\n", "NT-HISTORY-1\t2\t0\n0\tx\n0\tx\n", "NT-HISTORY-1\t2\t0\n0\ty\n", "NT-HISTORY-1\t2\t0\n0\tX\n")) assertNull(H.parseSsh(text, "x"), text)
        assertNull(H.parseSsh("NT-HISTORY-1\t201\t0\n" + (0..200).joinToString("") { "$it\tx\n" }, "x"))
        assertNull(H.parseSsh("NT-HISTORY-1\t1\t0\n0\t" + "😀".repeat(70_000) + "x\n", "x"))
        val oversized = "😀".repeat(70_000) + "x"
        assertNull(H.parseRelay(J.parse("""{"searchedLines":1,"truncated":false,"rows":[{"line":0,"text":"$oversized"}]}"""), "x"))
        assertNull(H.parseRelay(J.parse("""{"searchedLines":1,"truncated":false,"rows":[{"line":0,"text":"y"}]}"""), "x"))
        assertNull(H.parseRelay(J.parse("""{"searchedLines":1,"rows":[]}"""), "x"))
        assertNull(H.parseRelay(J.parse("""{"searchedLines":1.5,"truncated":false,"rows":[]}"""), "x"))
        assertNull(H.parseRelay(J.parse("""{"searchedLines":1,"truncated":false,"rows":[{"line":0.5,"text":"x"}]}"""), "x"))
    }
    @Test fun `query validation preserves literal spaces and bounds single line input`() {
        assertTrue(H.validQuery(" "))
        assertTrue(H.validQuery("'\"`$(x).*😀"))
        for (q in listOf("", "x\ny", "\r", "\u0000", "\u007f", "x".repeat(257))) assertFalse(H.validQuery(q))
    }
    @Test fun `relay parses the same rows and truncation facts as SSH`() {
        val json = J.parse("""{"searchedLines":999,"truncated":true,"rows":[{"line":0,"text":"x Ω"},{"line":998,"text":"x"}]}""")
        assertEquals(H.parseSsh("NT-HISTORY-1\t999\t1\n0\tx Ω\n998\tx\n", "x"), H.parseRelay(json, "x"))
    }
}
