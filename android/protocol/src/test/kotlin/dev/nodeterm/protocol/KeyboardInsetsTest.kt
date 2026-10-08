package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A77: the app targets API 35, so on Android 15 its window is edge-to-edge and the keyboard no longer
 * resizes it; the keyboard's inset reaches Compose instead. The terminal screen applied the Scaffold's
 * padding and then `imePadding()` without consuming that padding, so with the keyboard up the
 * navigation bar was counted twice (the keyboard's inset already includes it). Pair and Settings,
 * whose text fields sit in a scrolling column, had no keyboard padding at all, so the keyboard could
 * cover the field being typed in.
 *
 * Insets, the keyboard and a Scaffold cannot run on a JVM, so the rule is pinned in the app's source
 * ([AppSourcePins]): one helper (`aboveKeyboard`) consumes the Scaffold's padding before it adds the
 * keyboard's inset, no other code asks for that inset, and every Scaffold body that holds a text field
 * uses the helper, before its scroll. How the screens look with the keyboard up is a device check.
 */
class KeyboardInsetsTest {
    private val helper = "fun Modifier.aboveKeyboard("

    /**
     * Every Kotlin source in the app, by its path under the app's package root, without its block
     * comments and whole-line comments: what the code does, not what its comments mention.
     */
    private fun appSources(): Map<String, String> =
        AppSourcePins.appSrc.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(AppSourcePins.appSrc).invariantSeparatorsPath to withoutComments(it.readText()) }

    private fun withoutComments(source: String): String =
        source.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("""(?m)^\s*//.*$"""), "")

    /** The body of the braces that open at [open] in [source], braces balanced. */
    private fun braces(source: String, open: Int): String = AppSourcePins.blockAfter(source.substring(open), "{")

    /**
     * Each Scaffold's content lambda in [source]: its parameter name and its body. The content is the
     * trailing lambda, the first `) { name ->` after `Scaffold(`.
     */
    private fun scaffoldBodies(source: String): List<Pair<String, String>> =
        Regex("""\bScaffold\(""").findAll(source).map { call ->
            val content = Regex("""\)\s*\{\s*(\w+)\s*->""").find(source, call.range.last)
                ?: error("a Scaffold without a content lambda")
            content.groupValues[1] to braces(source, content.range.first + content.value.indexOf('{'))
        }.toList()

    @Test
    fun `the helper consumes the Scaffold's padding before it adds the keyboard's inset`() {
        val insets = AppSourcePins.ui("Insets.kt")
        val at = insets.indexOf(helper)
        assertTrue(at >= 0, "Insets.kt must define $helper")
        val body = insets.substring(at)
        AppSourcePins.assertInOrder(
            body,
            "padding(scaffoldPadding)",
            "consumeWindowInsets(scaffoldPadding)",
            "imePadding()"
        )
    }

    @Test
    fun `nothing but the helper asks for the keyboard's inset`() {
        // A bare `imePadding()` after a Scaffold's padding counts the navigation bar twice; one in a
        // dialog's content can add the keyboard to a window the system already keeps clear of it.
        val callers = appSources().flatMap { (path, source) ->
            Regex("""\bimePadding\(\)|WindowInsets\.ime\b""").findAll(source).map { path }.toList()
        }
        assertEquals(listOf("ui/Insets.kt"), callers)
    }

    @Test
    fun `every Scaffold body that holds a text field makes room for the keyboard, before its scroll`() {
        val withField = mutableListOf<String>()
        for ((path, source) in appSources()) {
            for ((param, body) in scaffoldBodies(source)) {
                if (!body.contains("TextField(")) continue
                withField += path
                AppSourcePins.assertInOrder(body, ".aboveKeyboard($param)")
                assertTrue(
                    !Regex("""\.padding\($param\)""").containsMatchIn(body),
                    "$path applies the Scaffold's padding itself as well as through aboveKeyboard"
                )
                if (body.contains("verticalScroll(")) AppSourcePins.assertInOrder(body, ".aboveKeyboard($param)", ".verticalScroll(")
            }
        }
        // The scan finds the screens it exists for, so it cannot pass by finding nothing.
        assertTrue(
            withField.containsAll(listOf("ui/TerminalScreen.kt", "ui/PairScreen.kt", "ui/SettingsScreen.kt")),
            "Scaffold bodies with a text field: $withField"
        )
    }

    @Test
    fun `below Android 15 the window stays off the inset path`() {
        // On API 26-34 the decor consumes the bars' and the keyboard's insets and adjustResize resizes
        // the window, so the screens work there without them. enableEdgeToEdge() (or turning off
        // decorFitsSystemWindows) would move those phones onto the inset path as well: a change for
        // every screen on every phone, not part of this fix.
        val sources = appSources()
        assertTrue(sources.isNotEmpty())
        for ((path, source) in sources) {
            assertTrue(!source.contains("enableEdgeToEdge("), "$path calls enableEdgeToEdge()")
            assertTrue(!source.contains("setDecorFitsSystemWindows("), "$path changes decorFitsSystemWindows")
        }
    }
}
