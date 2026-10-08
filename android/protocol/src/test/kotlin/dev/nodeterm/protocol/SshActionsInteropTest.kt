package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.ssh.SshActions
import dev.nodeterm.protocol.ssh.SshActionsScripts
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.*

/** Actual TypeScript WorkspaceStore producer ↔ Kotlin consumer ↔ generated POSIX filesystem writer. */
class SshActionsInteropTest {
    private fun fixture(body: (InteropHarness, File, SshActions) -> Unit) {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "Direct SSH actions need a POSIX host")
        val home = Files.createTempDirectory("nt-actions-interop-").toFile()
        try {
            val ud = File(home, ".config/node-terminal")
            InteropHarness.start("ssh-actions", InteropHarness.scratchHomeEnv(home) + mapOf("FIXTURE_USERDATA" to ud.path)).use { f ->
                assertEquals(ud.path, f.ready.s("userData"))
                body(f, ud, SshActions { script, _, input, _, _ -> execute(script, input) })
            }
        } finally { home.deleteRecursively() }
    }
    private fun process(script: String): Process = ProcessBuilder("/bin/sh", "-c", script).apply {
        environment().clear(); environment()["PATH"] = "/usr/bin:/bin"
    }.start()
    private fun execute(script: String, input: String?): Pair<Int, String> {
        val p = process(script)
        try {
            p.outputStream.use { input?.let { text -> it.write(text.toByteArray(Charsets.UTF_8)) } }
            var raw = ""; var error = ""
            val stdout = thread { raw = p.inputStream.bufferedReader().readText() }
            val stderr = thread { error = p.errorStream.bufferedReader().readText() }
            assertTrue(p.waitFor(22, TimeUnit.SECONDS), "generated SSH action exceeded its own deadline")
            stdout.join(); stderr.join(); assertTrue(error.isBlank(), error)
            return p.exitValue() to raw
        } finally { p.destroyForcibly() }
    }
    private fun request(a: SshActions.Advertisement, nonce: String, at: Long = a.updatedAt, method: String = "projects.ensureBoard", params: JsonObject = buildJsonObject { put("projectId", "ssh-actions-project") }) =
        buildJsonObject { put("version", 1); put("instance", a.instance); put("nonce", nonce); put("issuedAt", at); put("method", method); put("params", params) }.toString()
    private fun snapshot(f: InteropHarness): JsonObject { f.command("snapshot"); return f.awaitEvent("snapshot") }

    @Test fun `actual producer accepts typed board schemas and node nudges through the private writer`() = fixture { f, ud, client ->
        fun call(method: String, params: JsonObject) = client.call(ud.path, method, params, "term-ssh-actions") { true }.jsonObject
        val board = call("projects.ensureBoard", buildJsonObject { put("projectId", "ssh-actions-project") })
        val columns = board.getValue("columns").jsonArray
        assertEquals(3, columns.size)
        val column = columns[1].jsonObject.getValue("id").jsonPrimitive.content
        assertTrue(call("projects.setCardColumn", buildJsonObject { put("projectId", "ssh-actions-project"); put("nodeId", "term-ssh-actions"); put("columnId", column) }).getValue("moved").jsonPrimitive.boolean)
        val labeled = call("projects.editCardLabels", buildJsonObject {
            put("projectId", "ssh-actions-project"); put("nodeId", "term-ssh-actions")
            put("create", JsonArray(listOf(buildJsonObject { put("name", "Kotlin α ' scope"); put("color", "blue") })))
        })
        assertTrue(labeled.getValue("edited").jsonPrimitive.boolean)
        assertEquals("Kotlin α ' scope", labeled.getValue("labels").jsonArray.single().jsonObject.s("name"))
        for (verb in listOf("wake", "refresh", "rename")) {
            assertTrue(call("node.$verb", buildJsonObject { put("nodeId", "term-ssh-actions"); if (verb == "rename") put("title", "α ' title") }).getValue("delivered").jsonPrimitive.boolean)
        }
        val proof = snapshot(f)
        val persisted = proof.getValue("file").jsonObject.getValue("kanban").jsonObject
        assertEquals(column, persisted.getValue("assignments").jsonArray.single().jsonObject.s("columnId"))
        assertEquals(labeled.getValue("cardLabelIds"), persisted.getValue("meta").jsonArray.single().jsonObject["labels"])
        assertEquals(listOf("wake", "refresh", "rename"), proof.getValue("nudges").jsonArray.map { it.jsonObject.s("method") })
        assertTrue(proof.getValue("broadcasts").jsonArray.any { it.toString().contains("workspace:server-change") }, "must announce the real save chain")
    }
    @Test fun `actual producer refuses an expired immutable request without changing the board`() = fixture { f, ud, client ->
        val a = client.probe(ud.path)!!; val nonce = UUID.randomUUID().toString()
        val (code, raw) = execute(SshActionsScripts.submit(ud.path, a, nonce), request(a, nonce, at = a.updatedAt - 600001))
        assertEquals(0, code)
        assertFailsWith<HostUnansweredException> { SshActions.parseResponse(raw.substringAfter('\n').trim(), a.instance, nonce) }
        assertNull(snapshot(f).getValue("file").jsonObject["kanban"])
    }
    @Test fun `actual producer restart during stdin is refused before publication into either instance`() = fixture { f, ud, client ->
        val a = client.probe(ud.path)!!; val nonce = UUID.randomUUID().toString()
        val p = process(SshActionsScripts.submit(ud.path, a, nonce))
        try {
            p.outputStream.write("{".toByteArray()); p.outputStream.flush()
            val old = File(ud, "ssh-actions/${a.instance}")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (old.listFiles()!!.none { it.name.endsWith(".upload") }) { assertTrue(System.nanoTime() < deadline); Thread.sleep(5) }
            f.command("restart"); f.awaitEvent("restarted")
            p.outputStream.use { it.write(request(a, nonce).removePrefix("{").toByteArray()) }
            assertTrue(p.waitFor(5, TimeUnit.SECONDS)); assertEquals(3, p.exitValue())
            assertEquals(SshActionsScripts.UNAVAILABLE, p.inputStream.bufferedReader().readText().trim())
            assertFalse(File(old, "$nonce.request").exists())
            assertNull(snapshot(f).getValue("file").jsonObject["kanban"])
        } finally { p.destroyForcibly() }
    }
    @Test fun `actual producer scope refusal is a confirmed answer and never a replay`() = fixture { f, ud, client ->
        val e = assertFailsWith<HostException> {
            client.call(ud.path, "node.wake", buildJsonObject { put("nodeId", "unowned-node") }, "unowned-node") { true }
        }
        assertFalse(e is HostUnansweredException)
        assertTrue(snapshot(f).getValue("nudges").jsonArray.isEmpty())
    }
}
