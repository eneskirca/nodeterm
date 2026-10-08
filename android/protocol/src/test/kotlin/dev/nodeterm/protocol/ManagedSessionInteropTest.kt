package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.*
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.ssh.SshActions
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.*

/** Real TS planner/coordinator/store/PtyManager -> Kotlin -> actual generated POSIX file writer.
 * Native PTY/tmux/CLI execution is an explicit recorder. This is not an actual shell/device proof. */
class ManagedSessionInteropTest {
    private fun fixture(trusted: Boolean = true, body: (InteropHarness, File, SshActions) -> Unit) {
        assumeTrue(System.getProperty("os.name").let { it.startsWith("Linux") || it.startsWith("Mac") },
            "Managed V1 needs the POSIX tmux host contract")
        val home = Files.createTempDirectory("nt-managed-interop-").toFile()
        try {
            val profile = File(home, ".config/node-terminal")
            InteropHarness.start("managed-session", InteropHarness.scratchHomeEnv(home) + mapOf(
                "FIXTURE_USERDATA" to profile.path, "FIXTURE_MANAGED_TRUSTED" to if (trusted) "1" else "0"
            )).use { f ->
                assertEquals("managed-native-recorder", f.ready.s("nativeBoundary"))
                assertEquals(profile.path, f.ready.s("userData"))
                val client = SshActions { script, _, input, uncertain, limit ->
                    if (input != null) { assertTrue(uncertain); assertTrue(limit != null) }
                    execute(script, input)
                }
                try { body(f, profile, client) } catch (failure: Throwable) {
                    System.err.println("[managed fixture proof] " + runCatching { snapshot(f) }.getOrNull())
                    throw failure
                }
            }
        } finally { home.deleteRecursively() }
    }
    private fun execute(script: String, input: String?): Pair<Int, String> {
        val p = ProcessBuilder("/bin/sh", "-c", script).apply {
            environment().clear(); environment()["PATH"] = "/usr/bin:/bin"
        }.start()
        try {
            p.outputStream.use { out -> input?.let { out.write(it.toByteArray(Charsets.UTF_8)) } }
            var raw = ""; var error = ""
            val stdout = thread { raw = p.inputStream.bufferedReader().readText() }
            val stderr = thread { error = p.errorStream.bufferedReader().readText() }
            assertTrue(p.waitFor(22, TimeUnit.SECONDS), "managed request exceeded the generated script deadline")
            stdout.join(); stderr.join(); assertTrue(error.isBlank(), error)
            return p.exitValue() to raw
        } finally { p.destroyForcibly() }
    }
    private fun snapshot(f: InteropHarness): JsonObject { f.command("snapshot"); return f.awaitEvent("snapshot") }
    private fun JsonObject.nodes(): JsonArray = getValue("file").jsonObject.getValue("nodes").jsonArray
    private fun JsonObject.native(name: String): JsonArray = getValue("native").jsonObject.getValue(name).jsonArray
    private fun request(f: InteropHarness, profile: File, client: SshActions, kind: String = "shell", account: String? = null) =
        client.prepareManaged(profile.path, ManagedSessionChoice(f.ready.s("projectId")!!, kind,
            if (kind == "agent") "claude" else null, account, "Kotlin α ' owned")) { true }
    private fun confirmed(client: SshActions, request: PreparedManagedSession): ManagedSessionReceipt =
        runCatching { client.createManaged(request) { true } }.getOrElse {
            fail("The valid fixture creation must produce a confirmed receipt: $it")
        }

    @Test fun `actual shell transaction produces one registered receipt and identical wire retry cannot respawn`() = fixture { f, ud, client ->
        val q = request(f, ud, client)
        val r = confirmed(client, q)
        assertEquals(q.creationId, r.creationId); assertEquals(q.hostInstance, r.hostInstance)
        assertEquals("node-terminal", r.socket); assertEquals("nt-" + r.nodeId, r.session)
        assertEquals(f.ready.getValue("recorderPid").jsonPrimitive.int, r.panePid)
        assertTrue(r.paneBirth.startsWith(if (System.getProperty("os.name").startsWith("Linux")) "linux:" else "darwin:"))
        assertFailsWith<HostUnansweredException> { client.createManaged(q) { true } }
        // Fixture-only adversarial traffic exercises the coordinator's creation-id cache.
        // Android intentionally has no retry/reconciliation API after a dispatched uncertainty.
        assertEquals(r, confirmed(client, q.copy(nonce = UUID.randomUUID().toString())))
        val proof = snapshot(f)
        val node = proof.nodes().single().jsonObject
        assertEquals(r.nodeId, node.s("id")); assertEquals("Kotlin α ' owned", node.s("title"))
        assertNull(node["pendingLaunch"]); assertNull(node["agentId"])
        assertEquals(1, proof.native("created").size); assertEquals(0, proof.native("launched").size)
        assertTrue(proof.native("created").single().jsonObject.getValue("createOnly").jsonPrimitive.boolean)
        assertTrue(proof.getValue("broadcasts").jsonArray.any { it.toString().contains("workspace:server-change") })
    }

    @Test fun `actual trusted agent uses host policy shell account and stdin launch then clears inert recovery intent`() = fixture { f, ud, client ->
        val q = request(f, ud, client, "agent", "fixture-account")
        val r = confirmed(client, q)
        assertFailsWith<HostUnansweredException> { client.createManaged(q) { true } }
        assertEquals(r, confirmed(client, q.copy(nonce = UUID.randomUUID().toString())))
        val proof = snapshot(f)
        assertEquals(1, proof.native("launched").size)
        val launch = proof.native("launched").single().jsonObject
        val text = launch.s("body")!!
        assertTrue(text.startsWith("trusted-wrapper claude ")); assertTrue(text.contains("--permission-mode auto"))
        assertFalse(text.contains("bypassPermissions")); assertTrue(text.contains("--session-id "))
        assertEquals("/bin/sh", launch.s("shell")); assertEquals("trusted", launch.s("projectEnv"))
        assertEquals(File(ud, "claude-accounts/fixture-account").path, launch.s("accountDir"))
        assertTrue(launch.getValue("textOnStdin").jsonPrimitive.boolean)
        val node = proof.nodes().single().jsonObject
        assertEquals(r.nodeId, node.s("id")); assertEquals("fixture-account", node.s("accountId"))
        assertEquals("#123abc", node.s("color")); assertNull(node["pendingLaunch"])
        assertEquals(1, proof.native("created").size)
        assertFalse(proof.getValue("broadcasts").toString().contains("trusted-wrapper"),
            "expanded launch text must stay out of shared recovery nodes and renderer broadcasts")
        assertFalse(q.wireRequest().contains("command")); assertFalse(q.wireRequest().contains("cwd"))
    }

    @Test fun `actual untrusted shared launch uses global command and System ignores the configured account default`() = fixture(false) { f, ud, client ->
        val q = request(f, ud, client, "agent")
        val r = confirmed(client, q)
        val proof = snapshot(f); assertEquals(1, proof.native("launched").size)
        val launch = proof.native("launched").single().jsonObject
        assertTrue(launch.s("body")!!.startsWith("global-wrapper claude "))
        assertEquals("/bin/bash", launch.s("shell")); assertEquals(JsonNull, launch["projectEnv"])
        assertEquals(JsonNull, launch["accountDir"])
        assertNull(proof.nodes().single().jsonObject["accountId"])
        assertEquals(r.nodeId, proof.nodes().single().jsonObject.s("id"))
    }

    @Test fun `actual service restart cannot adopt a journal receipt or replay a prior agent launch`() = fixture { f, ud, client ->
        val q = request(f, ud, client, "agent")
        confirmed(client, q)
        f.command("restart"); f.awaitEvent("restarted")
        assertFailsWith<ManagedSessionRefusedException> { client.createManaged(q) { true } }
        val newInstance = request(f, ud, client, "agent").copy(creationId = q.creationId)
        assertNotEquals(q.hostInstance, newInstance.hostInstance)
        assertFailsWith<HostUnansweredException> { client.createManaged(newInstance) { true } }
        val proof = snapshot(f)
        assertEquals(1, proof.nodes().size); assertEquals(1, proof.native("created").size)
        assertEquals(1, proof.native("launched").size)
    }

    @Test fun `actual changed choice with the same creation identity stays uncertain without another pane`() = fixture { f, ud, client ->
        val q = request(f, ud, client)
        val r = confirmed(client, q)
        val changed = q.copy(nonce = UUID.randomUUID().toString(), choice = q.choice.copy(title = "Different"))
        assertFailsWith<HostUnansweredException> { client.createManaged(changed) { true } }
        val proof = snapshot(f)
        assertEquals(1, proof.native("created").size); assertEquals(0, proof.native("launched").size)
        assertEquals(r.nodeId, proof.nodes().single().jsonObject.s("id"))
        assertEquals(q.choice.title, proof.nodes().single().jsonObject.s("title"))
    }
}
