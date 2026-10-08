package dev.nodeterm.protocol

import dev.nodeterm.protocol.ssh.SshScripts
import dev.nodeterm.protocol.model.HookReplies
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.*

/** Actual SSH-visible POSIX writers, with stdin deliberately suspended across the hold's timeout. */
class HookReplyScriptsTest {
    private val node = "term-1"
    private val ticket = "term-1-100000-42"
    private fun process(home: File, script: String) = ProcessBuilder("/bin/sh", "-c", script).apply {
        environment().clear(); environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin"))
    }.start()
    @Test fun `suspended stdin cannot publish an answer after a held request is deleted or replaced`() {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "SSH-visible scripts require a POSIX host shell")
        val home = Files.createTempDirectory("nt-held-scripts").toFile()
        val dir = File(home, ".nodeterm/pending").apply { mkdirs() }
        val request = File(dir, "$ticket.json")
        try {
            for (remove in listOf(true, false)) {
                request.writeText("{\"original\":true}")
                val read = process(home, SshScripts.readHookRequest(node, ticket))
                val output = read.inputStream.bufferedReader().readText()
                assertTrue(read.waitFor(5, TimeUnit.SECONDS)); assertEquals(0, read.exitValue())
                val writer = process(home, SshScripts.answerHook(node, ticket, output.substringBefore('\n')))
                try {
                    writer.outputStream.write((HookReplies.MARKER + "\npartial").toByteArray()); writer.outputStream.flush()
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (dir.listFiles()!!.none { it.name.contains(".answer.tmp.") }) {
                        assertTrue(System.nanoTime() < deadline, "writer did not begin its temp")
                        Thread.sleep(5)
                    }
                    if (remove) assertTrue(request.delete()) else request.writeText("{\"original\":false}")
                    writer.outputStream.use { it.write("remaining".toByteArray()) }
                    assertTrue(writer.waitFor(5, TimeUnit.SECONDS))
                    assertEquals(if (remove) 0 else 2, writer.exitValue())
                    assertEquals(if (remove) "gone" else "", writer.inputStream.bufferedReader().readText().trim())
                    assertFalse(File(dir, "$ticket.answer").exists())
                    assertTrue(dir.listFiles()!!.none { it.name.contains(".tmp.") })
                } finally { writer.destroyForcibly() }
            }
        } finally { home.deleteRecursively() }
    }
    @Test fun `oversized held JSON is refused before it can be returned to the client`() {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "SSH-visible scripts require a POSIX host shell")
        val home = Files.createTempDirectory("nt-held-big").toFile()
        try {
            File(home, ".nodeterm/pending").mkdirs()
            File(home, ".nodeterm/pending/$ticket.json").writeText("x".repeat(HookReplies.MAX_BYTES + 1))
            val read = process(home, SshScripts.readHookRequest(node, ticket))
            val output = read.inputStream.bufferedReader().readText()
            assertTrue(read.waitFor(5, TimeUnit.SECONDS)); assertEquals(2, read.exitValue())
            assertEquals("", output)
        } finally { home.deleteRecursively() }
    }
}
