package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InputBar
import dev.nodeterm.protocol.model.InputBar.Send
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The terminal input bar's Send (audits A34, A41). TerminalController is only type-checked; it sends
 * what [InputBar.plan] says, clears Ctrl only when something was sent, and tells the screen to clear
 * the draft only then.
 */
class InputBarTest {
    @Test
    fun `nothing is sent while no stream is attached, so the draft is kept`() {
        assertEquals(Send.NotAttached, InputBar.plan(attached = false, ctrlArmed = false, text = "ls -la", enter = true))
        assertEquals(Send.NotAttached, InputBar.plan(attached = false, ctrlArmed = false, text = "", enter = true))
    }

    @Test
    fun `an armed Ctrl is not spent while no stream is attached`() {
        // Not Control("\u001a"): that would disarm the chip for a byte that reaches nothing.
        assertEquals(Send.NotAttached, InputBar.plan(attached = false, ctrlArmed = true, text = "z", enter = true))
    }

    @Test
    fun `an attached stream gets the text as a paste, then Enter`() {
        assertEquals(Send.Paste("ls -la", true), InputBar.plan(attached = true, ctrlArmed = false, text = "ls -la", enter = true))
        // An empty bar still sends the Enter.
        assertEquals(Send.Paste("", true), InputBar.plan(attached = true, ctrlArmed = false, text = "", enter = true))
    }

    @Test
    fun `Ctrl and one character is that control byte alone`() {
        assertEquals(Send.Control("\u001a"), InputBar.plan(attached = true, ctrlArmed = true, text = "z", enter = true))
    }

    @Test
    fun `Ctrl and anything else is sent as typed`() {
        assertEquals(Send.Paste("zz", true), InputBar.plan(attached = true, ctrlArmed = true, text = "zz", enter = true))
    }
}
