package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** App source pins only; queue/page behavior is exercised by TerminalOutputTest. */
class TerminalOutputWiringTest {
    @Test fun `app sinks delegate paint and bytes to the viewer-owned queue`() {
        val source = AppSourcePins.ui("TerminalController.kt")
        assertTrue(source.contains("isCurrent = slot::isCurrent"))
        assertTrue(source.contains("main.postDelayed({ callback() }, delay)"))
        val sink = AppSourcePins.blockAfter(source, "private fun sinkFor(")
        assertTrue(sink.contains("output.paint(ticket, text)"))
        assertTrue(sink.contains("output.append(ticket, bytes)"))
        assertFalse(source.contains("outBuf"), "no second unowned output buffer")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(sink, "override fun onExit("),
            "slot.isCurrent(ticket)", "output.finish(ticket)", "slot.ended(ticket)", "retireOutput()")
    }

    @Test fun `all viewer retirement paths invalidate output and queued page commands`() {
        val source = AppSourcePins.ui("TerminalController.kt")
        val retire = AppSourcePins.blockAfter(source, "private fun retireOutput()")
        AppSourcePins.assertInOrder(retire, "output.retire()", "page.viewerChanged(null)")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "private fun attach()"),
            "val ticket = slot.begin()", "page.viewerChanged(ticket)", "output.begin(ticket)", "val sink = sinkFor(ticket)")
        for (method in listOf("fun onStop()", "fun dispose()", "private fun rendererGone(")) {
            val block = AppSourcePins.blockAfter(source, method)
            assertTrue(block.contains("retireOutput()"), "$method must retire output")
            AppSourcePins.assertInOrder(block, "retireOutput()", if (method.contains("dispose")) "slot.close()" else "slot.leave()")
        }
    }

    @Test fun `queued raw keys resume and history capture a viewer while font setup stays page-global`() {
        val source = AppSourcePins.ui("TerminalController.kt")
        val owned = AppSourcePins.blockAfter(source, "private fun js(code:")
        AppSourcePins.assertInOrder(owned, "val ticket = output.owner ?: return", "jsViewer(ticket, code)")
        assertFalse(owned.contains("jsPage("), "an absent viewer never adopts stream commands as page-global")
        assertTrue(AppSourcePins.blockAfter(source, "private fun jsViewer(").contains("page.offerViewer(ticket, code)"))
        assertTrue(AppSourcePins.blockAfter(source, "private fun jsPage(").contains("page.offer(code)"))
        assertTrue(AppSourcePins.blockAfter(source, "fun raw(data:").contains("js(\"nt.raw("))
        assertTrue(AppSourcePins.blockAfter(source, "fun key(name:").contains("js(\"nt.key("))
        assertTrue(source.contains("js(\"nt.resumeScroll()\")"))
        assertTrue(source.contains("js(\"nt.showScrollView("))
        assertTrue(source.contains("jsPage(\"nt.setFontSize("))
        assertFalse(source.contains("js(\"nt.setFontSize("))
        assertTrue(source.contains("jsPage(\"nt.suspendScroll()\")"))
        assertFalse(source.contains("js(\"nt.suspendScroll()\")"))
        assertTrue(source.contains("jsPage(\"nt.focusForKeyboard()\")"))
        assertTrue(AppSourcePins.blockAfter(source, "private fun retireActions()").contains("jsPage(\"nt.closeScrollView()\")"))
    }
}
