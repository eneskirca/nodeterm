package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.TerminalExit
import kotlin.test.Test
import kotlin.test.assertEquals

class TerminalExitTest {
    @Test
    fun `a failed viewer does not report that the host session ended`() {
        for (code in listOf(1, 137, 255, -1)) {
            assertEquals("The terminal connection closed (exit $code).", TerminalExit.closedMessage(code))
        }
    }

    @Test
    fun `zero after the recovery budget is exhausted still describes only the viewer`() {
        assertEquals("The terminal connection closed (exit 0).", TerminalExit.closedMessage(0))
    }

    @Test
    fun `an unknown exit retains the existing disconnected notice`() {
        assertEquals("Disconnected.", TerminalExit.closedMessage(null))
    }
}
