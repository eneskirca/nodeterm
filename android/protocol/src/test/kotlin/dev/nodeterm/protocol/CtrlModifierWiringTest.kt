package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Source pins for Android delegation; these do not execute a WebView, Compose or main Handler. */
class CtrlModifierWiringTest {
    private fun controller() = AppSourcePins.ui("TerminalController.kt")
        .replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")

    @Test
    fun `the controller stores one immutable arm and revision snapshot`() {
        val source = controller()
        assertTrue("initialCtrl: CtrlModifier = CtrlModifier()" in source)
        assertTrue("private var ctrlModifier by mutableStateOf(initialCtrl)" in source)
        AppSourcePins.assertInOrder(source, "var ctrlArmed: Boolean", "get() = ctrlModifier.armed",
            "set(value) { updateCtrl(ctrlModifier.withArmed(value)) }")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "private fun updateCtrl("),
            "if (modifier == ctrlModifier) return", "ctrlModifier = modifier", "onCtrlChanged(modifier)")
        assertFalse(Regex("""\b(?:var|val) ctrl(?:State|Revision)\b""").containsMatchIn(source),
            "Separate flag/revision fields cannot be captured atomically by the bridge")
    }

    @Test
    fun `raw input consumes one captured arm on its current viewer without delaying the write`() {
        val input = AppSourcePins.blockAfter(controller(), "fun onInput(data:")
        AppSourcePins.assertInOrder(input, "val s = stream ?: return", "if (!page.isCurrent(gen)) return",
            "val modifier = ctrlModifier", "if (modifier.armed && data.length == 1)",
            "Keys.ctrl(data)?.let { out = it }", "main.post {")
        val posted = AppSourcePins.blockAfter(input, "main.post")
        AppSourcePins.assertInOrder(posted, "val current = page.isCurrent(gen) && stream === s",
            "updateCtrl(ctrlModifier.consume(modifier, current))")
        assertFalse(posted.contains("writeInput("), "Actual bytes stay ordered on the bridge's existing queue path")
        assertTrue(input.substringAfter(posted).contains("writeInput(out, s)"))
        assertEquals(1, Regex("""\bctrlModifier\b""").findAll(input.substringBefore("main.post")).count(),
            "One immutable snapshot supplies both the arm decision and delayed consumption")
        assertFalse(input.contains("ctrlArmed"))
        val report = AppSourcePins.blockAfter(controller(), "fun onReport(data:")
        assertFalse(report.contains("ctrlModifier"))
        assertFalse(report.contains("ctrlArmed"))
    }

    @Test
    fun `composed Send plans from its snapshot and completes against the latest revision`() {
        val submit = AppSourcePins.blockAfter(controller(), "fun submit(text:")
        assertTrue(controller().contains("modifier: CtrlModifier"))
        AppSourcePins.assertInOrder(submit, "InputBar.plan(attached, modifier.armed, text, enter)", "ComposedCompletion(modifier.revision)")
        val posted = AppSourcePins.blockAfter(submit, "main.post")
        AppSourcePins.assertInOrder(posted,
            "val current = webView === view && stream === expected && actions === actor && attached",
            "completionPolicy.complete(completion, current, ctrlModifier.revision, { ctrlArmed = false }, onDelivered)")
    }
}
