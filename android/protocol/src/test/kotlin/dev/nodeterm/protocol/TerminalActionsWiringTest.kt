package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Native lifecycle/bridge callbacks need a device; pin their delegation to the tested queue. */
class TerminalActionsWiringTest {
    private fun controller() = AppSourcePins.ui("TerminalController.kt")
        .replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    @Test
    fun `a queue belongs to the accepted stream and ticket and starts before JS scrolling resumes`() {
        val source = controller()
        val attach = AppSourcePins.blockAfter(source, "private fun attach()")
        AppSourcePins.assertInOrder(attach, "retireActions()", "nt.suspendScroll()", "slot.begin()")
        AppSourcePins.assertInOrder(attach, "if (!slot.accept(ticket, lease)) return@post",
            "actor = TerminalActions(graph.scope, s, onScrollView", "actions = actor", "nt.resumeScroll()")
        assertEquals(1, Regex("""\bTerminalActions\(""").findAll(source).count())
    }

    @Test
    fun `every viewer retirement closes its queue and stop suspends the page before detaching`() {
        val source = controller()
        val retire = AppSourcePins.blockAfter(source, "private fun retireActions()")
        AppSourcePins.assertInOrder(retire, "actions?.close()", "actions = null")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "override fun onExit(code:"),
            "if (!slot.ended(ticket)) return@post", "retireActions()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "private fun rendererGone("),
            "page.lost()", "retireActions()", "slot.leave()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun onStop()"),
            "nt.suspendScroll()", "retireActions()", "slot.leave()", "webView?.onPause()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun dispose()"),
            "retireActions()", "slot.close()")
    }

    @Test
    fun `bridge input and scrolling use bounded admission and never launch independent RPCs`() {
        val source = controller()
        val input = AppSourcePins.blockAfter(source, "fun onInput(data:")
        AppSourcePins.assertInOrder(input, "val s = stream ?: return", "if (!page.isCurrent(gen)) return", "writeInput(out, s)")
        val scroll = AppSourcePins.blockAfter(source, "fun onScrollView(up:")
        AppSourcePins.assertInOrder(scroll, "val input = actions ?: return", "if (!page.isCurrent(gen)) return",
            "if (!input.scroll(up, notches, displayEpoch) && !input.scrollPaused) inputBusy()")
        assertFalse(scroll.contains("launch"), "A suspended relay RPC must not run in a per-gesture coroutine")
        val write = AppSourcePins.blockAfter(source, "private fun writeInput(")
        AppSourcePins.assertInOrder(write, "val input = actions ?: return", "expected == null || stream !== expected",
            "if (!input.write(data)) inputBusy()")
        assertTrue(AppSourcePins.blockAfter(source, "private fun inputBusy()").contains("notice ="))
    }

    @Test
    fun `automatic reports keep their stream and queue while preserving Ctrl and pending scrolling`() {
        val source = controller()
        assertTrue(Regex("""@JavascriptInterface\s+fun onReport\(""").containsMatchIn(source),
            "The release WebView must expose its automatic-report callback")
        val report = AppSourcePins.blockAfter(source, "fun onReport(data:")
        AppSourcePins.assertInOrder(report, "val s = stream ?: return", "if (!page.isCurrent(gen)) return", "writeReport(data, s)")
        assertFalse(report.contains("ctrlArmed"), "Automatic replies must not consume an armed Ctrl chip")
        assertFalse(report.contains("Keys.ctrl("))
        assertFalse(report.contains("cancelScroll"))
        val write = AppSourcePins.blockAfter(source, "private fun writeReport(")
        AppSourcePins.assertInOrder(write, "val input = actions ?: return", "stream !== expected",
            "if (!input.report(data)) inputBusy()")
        assertFalse(write.contains(".write("), "A report must not use the user-input scroll barrier")
    }

    @Test
    fun `a page scroll stop cancels only its captured viewer queue without sending input`() {
        val source = controller()
        assertTrue(Regex("""@JavascriptInterface\s+fun onScrollStop\(""").containsMatchIn(source))
        val stop = AppSourcePins.blockAfter(source, "fun onScrollStop()")
        AppSourcePins.assertInOrder(stop, "val input = actions ?: return", "if (!page.isCurrent(gen)) return", "input.cancelScroll()")
        assertFalse(stop.contains(".write("), "Stopping momentum must not type a synthetic key")
        assertFalse(stop.contains(".close("), "The accepted viewer remains attached")
        assertFalse(stop.contains("launch"), "A stop must be ordered with JavaBridge callbacks")
        assertFalse(stop.contains("main.post"), "Do not delay a stop behind main-thread work")
    }

    @Test
    fun `native input cancels page momentum before the queue write and rechecks its stream`() {
        val source = controller()
        val raw = AppSourcePins.blockAfter(source, "fun raw(data:")
        assertTrue(raw.contains("nt.raw("), "Raw chips must enter the page's scroll-cancelling input path")
        assertFalse(raw.contains(".write("))
        val resume = AppSourcePins.blockAfter(source, "fun acceptResume()")
        assertEquals(2, Regex("""writeAfterScrollCancel\(offer\.keys, s\)""").findAll(resume).count())
        val cancel = AppSourcePins.blockAfter(source, "private fun writeAfterScrollCancel(")
        AppSourcePins.assertInOrder(cancel, "val wv = webView ?: return", "actions?.closeScrollView()", "wv.evaluateJavascript(\"nt.cancelScroll();nt.closeScrollView()\") {",
            "webView === wv && stream === expected && attached", "writeInput(data, expected)")
        assertFalse(Regex("""\b(?:stream|s)\??\.write\(""").containsMatchIn(source),
            "Installed-viewer input must not bypass its ordered queue")
    }

    @Test
    fun `history callback checks viewer page and epoch inside the posted main runnable`() {
        val attach = AppSourcePins.blockAfter(controller(), "private fun attach()")
        AppSourcePins.assertInOrder(attach, "onScrollView = { result, epoch, displayEpoch ->", "main.post {",
            "!slot.isCurrent(ticket)", "stream !== s", "actions !== actor", "webView !== view",
            "!page.isCurrent(generation)", "actor.scrollEpoch != epoch", "when (result)", "nt.showScrollView(")
        assertTrue(attach.contains("nt.scrollFailed($" + "displayEpoch)"))
    }
}
