package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Real bundled xterm produces the events here; jsdom supplies browser facilities, not input events. */
class TerminalJsXtermInteractionTest {
    @Test
    fun `real terminal reports preserve a swipe while keyboard paste and IME cancel it`() {
        val root = InteropHarness.repoRoot
        // Installed npm dependencies are represented by package-lock.json in the workflow filter.
        val nodeOk = runCatching {
            ProcessBuilder("node", "-e", "require.resolve('jsdom')").directory(root).start().waitFor() == 0
        }.getOrDefault(false)
        assumeTrue(nodeOk,
            "node + npm ci (jsdom) are needed to run the actual xterm bundles")
        val driver = File(root, "android/protocol/src/test/interop/terminal-xterm-interaction-driver.cjs")
        val asset = File(root, "android/app/src/main/assets/terminal/terminal.js")
        val process = ProcessBuilder("node", driver.path, asset.path).directory(root).start()
        val reply = try {
            assertTrue(process.waitFor(30, TimeUnit.SECONDS), "actual-xterm interaction driver timed out")
            val out = process.inputStream.bufferedReader().readText()
            val err = process.errorStream.bufferedReader().readText()
            assertEquals(0, process.exitValue(), "actual-xterm driver failed: $err")
            Json.parseToJsonElement(out.trim()).jsonObject
        } finally {
            if (process.isAlive) process.destroyForcibly()
        }
        assertEquals(45, reply["rows"]!!.jsonPrimitive.int)
        assertEquals(52, reply["cols"]!!.jsonPrimitive.int)
        assertEquals("any", reply["mouseMode"]!!.jsonPrimitive.content)
        val cases = reply["results"]!!.jsonArray.associate { item ->
            item.jsonObject["name"]!!.jsonPrimitive.content to item.jsonObject
        }
        assertEquals(10, cases.size)
        val expectedReports = mapOf(
            "focus-report" to "\u001b[O", "mouse-motion-report" to "\u001b[<35;3;15M",
            "cursor-query-reply" to "\u001b[1;1R", "device-attributes-reply" to "\u001b[?1;2c",
            "legacy-mouse-report" to "\u001b[MC%1",
        )
        for (name in listOf("touch-only") + expectedReports.keys) {
            val case = cases.getValue(name)
            assertEquals(20, case["notches"]!!.jsonPrimitive.int, "$name preserves both halves of the real swipe")
            val events = case["events"]!!.jsonArray.map { it.jsonObject }
            assertFalse(events.any { "input" in it }, "$name must not enter the native input barrier")
            expectedReports[name]?.let { expected ->
                assertTrue(events.any { it["report"]?.jsonPrimitive?.content == expected },
                    "$name emits the actual encoded report to its own bridge path")
            }
        }
        assertTrue(cases.getValue("mouse-motion-report")["events"]!!.jsonArray.any {
            it.jsonObject["userOrigin"]?.jsonPrimitive?.boolean == true
        }, "xterm marks SGR mouse as user input; that flag alone cannot identify typed input")
        val expectedInput = mapOf(
            "keyboard-escape" to "\u001b", "bracketed-paste" to "\u001b[200~pasted text\u001b[201~",
            "ime-input" to "日", "ime-composition" to "本",
        )
        for ((name, expected) in expectedInput) {
            val case = cases.getValue(name)
            assertEquals(0, case["notches"]!!.jsonPrimitive.int, "$name stops pending movement and the gesture")
            val inputs = case["events"]!!.jsonArray.mapNotNull { it.jsonObject["input"]?.jsonPrimitive?.content }
            assertEquals(listOf(expected), inputs, "$name keeps its exact bytes on the input path")
        }
        val kinetic = reply["kinetic"]!!.jsonObject
        assertTrue(kinetic["notches"]!!.jsonPrimitive.int > 10, "the actual bundle coasts after release")
        assertTrue(kinetic["notches"]!!.jsonPrimitive.int <= 70)
        assertTrue(kinetic["duration"]!!.jsonPrimitive.int <= 1016)
        val kineticEvents = kinetic["events"]!!.jsonArray.map { it.jsonObject }
        assertEquals(1, kineticEvents.count { "stop" in it }, "focus/query replies preserve the real coast")
        assertTrue(kineticEvents.any { it["report"]?.jsonPrimitive?.content == "\u001b[O" })
        assertTrue(kineticEvents.any { it["report"]?.jsonPrimitive?.content == "\u001b[1;1R" })
        val repaint = reply["repaint"]!!.jsonObject
        assertEquals("none", repaint["touchAction"]!!.jsonPrimitive.content,
            "the computed stable-screen CSS reserves the gesture for the terminal")
        val removed = repaint["removedSpan"]!!.jsonObject
        assertTrue(removed["originalSpanRemoved"]!!.jsonPrimitive.boolean, "xterm's real redraw removes the touched text span")
        assertFalse(removed["targetStillConnected"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("touchstart", "touchmove"), removed["hostEvents"]!!.jsonArray.map { it.jsonPrimitive.content },
            "later events on the old detached span no longer reach the page swipe handlers")
        assertEquals(1, removed["notches"]!!.jsonPrimitive.int)
        val stable = repaint["pageHitTarget"]!!.jsonObject
        assertTrue(stable["originalSpanRemoved"]!!.jsonPrimitive.boolean)
        assertTrue(stable["targetWasScreen"]!!.jsonPrimitive.boolean, "real page CSS targets the stable screen behind painted text")
        assertTrue(stable["targetStillConnected"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("touchstart", "touchmove", "touchmove", "touchend"),
            stable["hostEvents"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertTrue(stable["notches"]!!.jsonPrimitive.int > 5, "the rest of the drag and release coast survive a real repaint")
        val history = reply["history"]!!.jsonObject
        assertTrue(history["visible"]!!.jsonPrimitive.boolean)
        assertTrue(history["rowReplaced"]!!.jsonPrimitive.boolean)
        assertTrue(history["layerConnected"]!!.jsonPrimitive.boolean)
        assertTrue(history["noHtml"]!!.jsonPrimitive.boolean)
        assertEquals(0, history["resets"]!!.jsonPrimitive.int)
        assertTrue(history["applicationCursor"]!!.jsonPrimitive.boolean, "Live parsing continues behind the separate history layer")
        assertFalse(history["bracketedPaste"]!!.jsonPrimitive.boolean)
        assertTrue(history["liveText"]!!.jsonPrimitive.content.contains("live output behind"))
        assertEquals(listOf("https://old.example/x"), history["openedUrls"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("界 https://old.example/x", "<b>inert captured text</b>"),
            history["copySnapshot"]!!.jsonObject["lines"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertTrue(history["events"]!!.jsonArray.any { "report" in it.jsonObject }, "The real live parser still answers cursor queries")
        assertTrue(history["events"]!!.jsonArray.count { "scroll" in it.jsonObject } > 1, "Replacing history rows preserves the rest of the drag and coast")
        assertTrue(history["closedAfterInput"]!!.jsonPrimitive.boolean, "An old queued page cannot reopen after actual paste input")
    }
}
