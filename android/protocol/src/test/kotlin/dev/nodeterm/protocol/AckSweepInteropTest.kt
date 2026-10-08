package dev.nodeterm.protocol

import dev.nodeterm.protocol.ssh.SshScripts
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Actual Android SSH producer + desktop local/remote consumers on their shared .seen contract. */
class AckSweepInteropTest {
    private fun shell(home: File, command: String, input: String = ""): String {
        val builder = ProcessBuilder("/bin/sh", "-c", command).redirectErrorStream(true)
        builder.environment().putAll(InteropHarness.scratchHomeEnv(home))
        val process = builder.start()
        try {
            process.outputStream.bufferedWriter().use { it.write(input) }
            assertTrue(process.waitFor(15, TimeUnit.SECONDS), "ack command timed out")
            val output = process.inputStream.bufferedReader().readText()
            assertEquals(0, process.exitValue(), output)
            return output
        } finally {
            if (process.isAlive) process.destroyForcibly()
        }
    }

    @Test
    fun `ack fixture refuses a home that is not the scratch directory before consumption`() {
        assumeTrue(InteropHarness.available("ack-sweep"), "node + esbuild are needed for ack interop tests")
        val home = Files.createTempDirectory("nt-ack-home-").toFile()
        val other = Files.createTempDirectory("nt-ack-other-").toFile()
        try {
            val ack = File(home, ".nodeterm/acks/owned.seen")
            ack.parentFile.mkdirs()
            ack.writeText("event-owned")
            val failure = assertFailsWith<AssertionError> {
                InteropHarness.start("ack-sweep", InteropHarness.scratchHomeEnv(home) + mapOf(
                    "FIXTURE_HOME" to other.path, "FIXTURE_ACK_INITIAL" to "owned"
                ))
            }
            assertTrue(failure.message.orEmpty().contains("needs os.homedir() to be FIXTURE_HOME"))
            assertEquals("event-owned", ack.readText())
            assertTrue(other.listFiles().isNullOrEmpty())
        } finally {
            home.deleteRecursively()
            other.deleteRecursively()
        }
    }

    @Test
    fun `read acks reach their owner across local and remote desktops without stealing other files`() {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "direct SSH uses a POSIX host shell")
        assumeTrue(InteropHarness.available("ack-sweep"), "node + repo node_modules (npm ci) are needed for interop tests")
        val home = Files.createTempDirectory("nt-ack-interop-").toFile()
        try {
            val ids = listOf("local", "newly-owned", "remote-one", "remote-two", "foreign")
            for (id in ids) {
                shell(home, SshScripts.ackRead(id, "event-$id"))
                assertEquals("event-$id", File(home, ".nodeterm/acks/$id.seen").readText())
            }
            InteropHarness.start("ack-sweep", InteropHarness.scratchHomeEnv(home) + mapOf(
                "FIXTURE_USERDATA" to home.path,
                "FIXTURE_ACK_INITIAL" to "local",
                "FIXTURE_ACK_LATER" to "newly-owned",
                "FIXTURE_ACK_REMOTE" to "remote-one,remote-two"
            )).use { harness ->
                fun values(key: String) = harness.ready[key]!!.jsonArray.map { it.jsonPrimitive.content }
                assertEquals(listOf("local"), values("consumed"))
                assertEquals(listOf("newly-owned"), values("consumedLater"))
                assertEquals(listOf("local", "newly-owned"), values("acked"))
                assertEquals(values("acked"), values("cleared"))
                assertFalse(File(home, ".nodeterm/acks/local.seen").exists())
                assertFalse(File(home, ".nodeterm/acks/newly-owned.seen").exists())
                for (id in listOf("remote-one", "remote-two", "foreign")) {
                    assertEquals("event-$id", File(home, ".nodeterm/acks/$id.seen").readText())
                }
                val outsideAckDir = File(home, ".nodeterm/escape.seen").apply { writeText("keep-outside") }
                val remote = shell(home, harness.ready["remoteCommand"]!!.jsonPrimitive.content,
                    harness.ready["remoteInput"]!!.jsonPrimitive.content + "../escape\n")
                assertEquals(listOf("remote-one", "remote-two"), remote.lines().filter { it.isNotEmpty() })
                assertFalse(File(home, ".nodeterm/acks/remote-one.seen").exists())
                assertFalse(File(home, ".nodeterm/acks/remote-two.seen").exists())
                assertEquals("event-foreign", File(home, ".nodeterm/acks/foreign.seen").readText())
                assertEquals("keep-outside", outsideAckDir.readText())
            }
        } finally {
            home.deleteRecursively()
        }
    }
}
