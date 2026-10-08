package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A85: AndroidView's default WRAP_CONTENT height makes WebView force Chromium's layout height to
 * zero, even when Compose measures a large terminal viewport. The percentage-height page then fits
 * to one row. Native WebView layout cannot run in this protocol JVM, so pin its height policy before
 * loading the page; actual rows and keyboard/rotation resizing remain device checks.
 */
class TerminalWebViewLayoutTest {
    @Test
    fun `the terminal WebView uses the parent dimensions before the page is loaded`() {
        val source = AppSourcePins.ui("TerminalController.kt")
            .replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("""(?m)^\s*//.*$"""), "")
        val body = AppSourcePins.blockAfter(source, "fun createWebView(")
        val assignments = Regex(
            """\blayoutParams\s*=\s*ViewGroup\.LayoutParams\s*\(\s*ViewGroup\.LayoutParams\.(\w+)\s*,\s*ViewGroup\.LayoutParams\.(\w+)\s*\)"""
        ).findAll(body).toList()
        assertEquals(1, assignments.size, "The WebView needs an explicit native height policy")
        val layout = assignments.single()
        assertEquals("MATCH_PARENT", layout.groupValues[1], "Terminal width follows Compose's viewport")
        assertEquals("MATCH_PARENT", layout.groupValues[2], "WRAP_CONTENT forces Chromium's HTML height to zero")
        val load = body.indexOf("loadUrl(")
        assertTrue(load > layout.range.last, "The height policy must be set before loading terminal/index.html")
        assertEquals(1, Regex("""\blayoutParams\s*=""").findAll(body).count(), "A later policy must not undo the fixed height")
    }
}
