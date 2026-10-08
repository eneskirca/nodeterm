package dev.nodeterm.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/** App source pins only; TerminalJsClosedViewTest runs the actual parser/display behavior. */
class TerminalClosedViewWiringTest {
    @Test
    fun `SSH viewer begins on the main thread before attachment`() {
        val attach = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "private fun attach()")
        AppSourcePins.assertInOrder(attach, "withContext(Dispatchers.Main.immediate)",
            "slot.isCurrent(ticket)", "jsViewer(ticket, \"nt.beginViewer(",
            "conn.kind == TransportKind.SSH", "val sink = sinkFor(ticket)",
            "conn.attachManagedSession(", "conn.attach(nodeId")
        val script = terminalScript()
        assertTrue(AppSourcePins.blockAfter(script, "function beginViewer(").contains("sshTmux === true"),
            "relay/native streams never implicitly opt into outer-tmux capture")
    }

    @Test
    fun `current EOF finishes output before its owned closed display and retirement`() {
        val sink = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "private fun sinkFor(")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(sink, "override fun onExit("),
            "slot.isCurrent(ticket)", "output.finish(ticket)", "jsViewer(ticket, \"nt.endViewer(",
            "slot.ended(ticket)", "retireOutput()", "retireActions()")
    }

    @Test
    fun `background stop retires the same-page closed capture`() {
        val stop = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "fun onStop()")
        AppSourcePins.assertInOrder(stop, "stopped = true", "retireOutput()",
            "jsPage(\"nt.suspendScroll()\")", "slot.leave()", "webView?.onPause()")
        val script = terminalScript()
        assertTrue(script.contains("suspendScroll: function () { retireViewer();"))
        assertTrue(script.contains("window.addEventListener('pagehide', retireViewer)"))
    }

    private fun terminalScript(): String = File(InteropHarness.repoRoot,
        "android/app/src/main/assets/terminal/terminal.js").readText()
}
