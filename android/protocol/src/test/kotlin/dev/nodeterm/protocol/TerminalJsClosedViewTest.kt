package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Actual shipped xterm parses native byte fixtures. This is a jsdom component test, not device QA. */
class TerminalJsClosedViewTest {
    @Test
    fun `real xterm preserves closed SSH rows without changing its live parser`() {
        val root = InteropHarness.repoRoot
        val driver = File(root, "android/protocol/src/test/interop/terminal-closed-view-driver.cjs")
        val asset = File(root, "android/app/src/main/assets/terminal/terminal.js")
        val logs = Files.createTempDirectory("nodeterm-closed-view-").toFile()
        val stdout = File(logs, "stdout.json")
        val stderr = File(logs, "stderr.txt")
        // Missing Node/jsdom fails this required regression; it must not become an assumed skip.
        val process = try {
            ProcessBuilder("node", driver.path, asset.path).directory(root)
                .redirectOutput(stdout).redirectError(stderr).start()
        } catch (error: Exception) {
            logs.deleteRecursively()
            throw AssertionError("node + npm ci (jsdom) are required for actual-xterm regressions", error)
        }
        val reply = try {
            assertTrue(process.waitFor(30, TimeUnit.SECONDS), "actual-xterm closed-view driver timed out")
            assertTrue(stdout.length() in 1..1_048_576, "bounded driver stdout")
            assertTrue(stderr.length() <= 65_536, "bounded driver stderr")
            assertEquals(0, process.exitValue(), "actual-xterm closed-view driver failed: ${stderr.readText()}")
            Json.parseToJsonElement(stdout.readText().trim()).jsonObject
        } finally {
            if (process.isAlive) {
                process.destroyForcibly()
                process.waitFor(2, TimeUnit.SECONDS)
            }
            logs.deleteRecursively()
        }
        assertEquals(1, reply["schema"]!!.jsonPrimitive.int)
        assertTrue(reply["passed"]!!.jsonPrimitive.boolean)
        assertEquals("actual shipped xterm5.5", reply["parser"]!!.jsonPrimitive.content)
        assertFalse(reply["physicalAcceptance"]!!.jsonPrimitive.boolean)
        assertFalse(reply["sshRuntimeAcceptance"]!!.jsonPrimitive.boolean)
        assertFalse(reply["transientPaintTimingAcceptance"]!!.jsonPrimitive.boolean)
        val cases = reply["cases"]!!.jsonArray.map { it.jsonObject }
        val names = cases.map { it["name"]!!.jsonPrimitive.content }
        val expected = listOf(
            "immediate real suffix coalesced",
            "immediate real suffix byte splits",
            "delayed real suffix coalesced",
            "delayed real suffix byte splits",
            "relay/native opt-out uses unchanged live parser",
            "queued EOF cancelled by begin",
            "queued EOF cancelled by pagehide",
            "queued EOF cancelled by suspend",
            "live ED2 repaint and later teardown retain current pane",
            "latest blank ED2 replaces an older populated capture",
            "drop without outer mode restore keeps active pane unchanged",
            "Unicode wrap Copy and OSC8/plain URL touch are captured without input",
            "closed user-origin event cannot turn next viewer DA into typed input",
            "closed display invalidates on paint",
            "closed display invalidates on reset",
            "settled closed rows and Copy survive refit",
            "settled closed rows and Copy survive setFontSize",
            "settled closed rows and Copy survive resize",
            "geometry invalidates only a pending EOF promotion",
            "old closed link touch cannot activate a successor snapshot",
            "same-view JS submit keeps separated Enter",
            "same-view delayed Enter survives refit font and resize barriers",
            "delayed JS Enter cannot cross begin",
            "delayed JS Enter cannot cross retire",
            "settled snapshot redraw uses changed layout and font for its owned link touch",
            "stationary closed touch on wrapped plain URL offers the exact complete URL",
            "generated tmux TUI repaint keeps live alternate modes and reports before EOF",
        )
        assertEquals(27, cases.size, "every required case must execute")
        assertEquals(names.size, names.toSet().size, "case names must be unique")
        assertEquals(expected, names, "exact ordered component inventory")
        for (case in cases) assertTrue(case["passed"]!!.jsonPrimitive.boolean,
            "${case["name"]!!.jsonPrimitive.content}: $case")
    }
}
