package dev.nodeterm.protocol

import java.io.File
import kotlin.test.assertTrue

/**
 * Reading the app's Compose sources from a JVM test. What only a device can run (Compose focus, the
 * system back dispatcher, InputMethodManager) is pinned in the source instead: the calls a fix
 * depends on, in the order it depends on them.
 */
object AppSourcePins {
    val appSrc = File(InteropHarness.repoRoot, "android/app/src/main/kotlin/dev/nodeterm/android")
    val appUi = File(appSrc, "ui")

    fun ui(file: String): String = File(appUi, file).readText()

    /** A source file under the app's package root, e.g. `notify/InboxNotifier.kt`. */
    fun app(path: String): String = File(appSrc, path).readText()

    /** The block that follows the first occurrence of [start] in [source], braces balanced. */
    fun blockAfter(source: String, start: String): String {
        val at = source.indexOf(start)
        assertTrue(at >= 0, "not found: $start")
        val open = source.indexOf('{', at)
        var depth = 0
        for (i in open until source.length) {
            when (source[i]) {
                '{' -> depth++
                '}' -> if (--depth == 0) return source.substring(open, i + 1)
            }
        }
        error("unbalanced block after $start")
    }

    fun assertInOrder(block: String, vararg parts: String) {
        var from = 0
        for (p in parts) {
            val at = block.indexOf(p, from)
            assertTrue(at >= 0, "expected `$p` after `${parts.takeWhile { it != p }.lastOrNull()}` in:\n$block")
            from = at + p.length
        }
    }
}
