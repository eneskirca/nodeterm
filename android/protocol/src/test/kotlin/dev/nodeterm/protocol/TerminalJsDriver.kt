package dev.nodeterm.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Runs the app's real `terminal.js` in node against stub xterm/DOM/bridge objects, through
 * `src/test/interop/terminal-js-driver.cjs` (its header documents the request and the reply). Skips
 * the calling test when there is no node.
 */
object TerminalJsDriver {
    fun run(request: JsonObject): JsonObject {
        val nodeOk = runCatching { ProcessBuilder("node", "--version").start().waitFor() == 0 }.getOrDefault(false)
        assumeTrue(nodeOk, "node is needed to run terminal.js")
        val root = InteropHarness.repoRoot
        val script = File(root, "android/app/src/main/assets/terminal/terminal.js")
        val driver = File(root, "android/protocol/src/test/interop/terminal-js-driver.cjs")
        val proc = ProcessBuilder("node", driver.path, script.path).directory(root).start()
        proc.outputStream.bufferedWriter().use { it.write(request.toString()) }
        val out = proc.inputStream.bufferedReader().readText()
        val err = proc.errorStream.bufferedReader().readText()
        assertTrue(proc.waitFor(30, TimeUnit.SECONDS), "driver timed out")
        assertEquals(0, proc.exitValue(), "driver failed: $err")
        val reply = Json.parseToJsonElement(out.trim()).jsonObject
        reply["error"]?.let { fail(it.jsonPrimitive.content) }
        return reply
    }
}
