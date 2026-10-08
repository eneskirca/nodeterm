package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.*
import dev.nodeterm.protocol.ssh.ManagedViewHandshake
import dev.nodeterm.protocol.ssh.SshActions
import dev.nodeterm.protocol.ssh.SshActionsScripts
import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import kotlin.test.*

class ManagedSessionTest {
    private val instance = "11111111-1111-4111-8111-111111111111"
    private val nonce = "22222222-2222-4222-8222-222222222222"
    private val creation = "33333333-3333-4333-8333-333333333333"
    private val stamp = 1_000_000L
    private fun advertisement(method: String = ManagedSessions.METHOD) = """{"version":1,"instance":"$instance","pid":1,"updatedAt":$stamp,"methods":["$method"],"remoteProjects":true}"""
    private fun choice() = ManagedSessionChoice("project-1", "agent", "claude", "account_1", "Claude")
    private fun request() = PreparedManagedSession("/profile", instance, nonce, stamp, creation, choice(), advertisement())
    private fun receipt(request: PreparedManagedSession = request()) = ManagedSessionReceipt(request.creationId, "term-abc-1234", request.choice.projectId,
        request.hostInstance, "node-terminal", "nt-term-abc-1234", "%0", 123, "linux:11111111-1111-1111-1111-111111111111:42", "1234")
    private fun response(request: PreparedManagedSession, result: JsonElement = receipt(request).toJson()) = buildJsonObject {
        put("version", 1); put("instance", request.hostInstance); put("nonce", request.nonce); put("ok", true); put("result", result)
    }.toString()

    @Test fun `choice is typed and does not accept executable payload or unsupported identities`() {
        for (change in listOf<() -> Unit>(
            { choice().copy(kind = "command") }, { choice().copy(agentId = "custom") },
            { choice().copy(kind = "shell") }, { choice().copy(accountId = "../account") },
            { choice().copy(title = "x".repeat(121)) }, { choice().copy(title = "bad\u001b") },
            { choice().copy(cols = 1) }, { choice().copy(rows = 501) }, { choice().copy(projectId = "bad\nproject") }
        )) assertFailsWith<IllegalArgumentException> { change() }
        val wire = Json.parseToJsonElement(request().wireRequest()).jsonObject
        assertEquals(setOf("version", "instance", "nonce", "issuedAt", "method", "params"), wire.keys)
        assertEquals(setOf("creationId", "projectId", "kind", "agentId", "accountId", "title", "cols", "rows"), wire.getValue("params").jsonObject.keys)
        assertFalse(wire.toString().contains("command")); assertFalse(wire.toString().contains("cwd"))
        assertEquals(ManagedSessionChoice("p", "shell", cols = 500, rows = 500), ManagedSessions.choice(ManagedSessionChoice("p", "shell", cols = 500, rows = 500).params(creation)))
    }
    @Test fun `receipt binds request profile generation and exact host minted node without numeric coercion`() {
        val q = request(); val r = receipt(q)
        assertEquals(r, ManagedSessions.receipt(r.toJson(), q))
        assertEquals(q, ManagedSessions.prepared(q.toJson()))
        for ((key, value) in listOf(
            "creationId" to JsonPrimitive(nonce), "hostInstance" to JsonPrimitive(nonce), "projectId" to JsonPrimitive("other"),
            "socket" to JsonPrimitive("nodeterm-rmt"), "session" to JsonPrimitive("nt-other"), "paneId" to JsonPrimitive("%1;run-shell"),
            "nodeId" to JsonPrimitive("phone-$creation"), "nodeId" to JsonPrimitive("term-abc-$(evil)"),
            "panePid" to JsonPrimitive("123"), "panePid" to JsonPrimitive(4294967419L), "panePid" to JsonPrimitive(0),
            "paneBirth" to JsonPrimitive("linux:not-a-boot-id:42"), "paneBirth" to JsonPrimitive("darwin:unverified\n"),
            "sessionCreated" to JsonPrimitive("0"), "sessionCreated" to JsonPrimitive(1234), "version" to JsonPrimitive("1")
        )) assertFailsWith<IllegalArgumentException>(key) { ManagedSessions.receipt(JsonObject(r.toJson() + (key to value)), q) }
    }
    @Test fun `managed creation advertisement is separate from legacy registration and old hosts`() {
        for ((method, available) in listOf("node.wake" to false, ManagedSessions.METHOD to true)) {
            val client = SshActions { _, _, _, _, _ -> 0 to "NT-ACTIONS-1\t$stamp\n${advertisement(method)}" }
            client.probe("/profile")
            assertEquals(available, client.capabilities.managedCreate)
            assertFalse(client.capabilities.registerNode)
        }
        assertFalse(HostCapabilities(true, true, true, true, true).managedCreate)
    }
    @Test fun `one dispatch carries the original nonce choices and confirmed mutation flags`() {
        val q = request(); var writes = 0
        val client = SshActions { script, timeout, input, uncertain, limit ->
            if (input == null) 0 to "NT-ACTIONS-1\t$stamp\n${advertisement()}" else {
                writes++; assertTrue(script.contains("/${q.nonce}.request"), "submission path must retain the original nonce"); assertEquals(q.wireRequest(), input); assertEquals(20L, timeout)
                assertTrue(uncertain); assertEquals(SshActionsScripts.MAX_BYTES + 128, limit)
                0 to "NT-ACTIONS-REPLY\n${response(q)}\n"
            }
        }
        assertEquals(receipt(q), client.createManaged(q) { true }); assertEquals(1, writes)
        assertFailsWith<IllegalArgumentException> { client.call("/profile", ManagedSessions.METHOD, q.choice.params(q.creationId), "new") { true } }
        assertEquals(1, writes, "Creation must not enter the generic fresh-nonce method")
    }
    @Test fun `changed service or ownership refuses before publication and sent failures remain uncertain`() {
        val q = request()
        for (changed in listOf("instance", "ownership")) {
            var writes = 0
            val client = SshActions { _, _, input, _, _ ->
                if (input != null) writes++
                0 to "NT-ACTIONS-1\t$stamp\n${advertisement().let { if (changed == "instance") it.replace(instance, nonce) else it }}"
            }
            assertFailsWith<ManagedSessionRefusedException> { client.createManaged(q) { changed != "ownership" } }
            assertEquals(0, writes)
        }
        for ((exit, raw) in listOf(null to "", null to "NT-ACTIONS-REPLY\n${response(q)}", 4 to "NT-ACTIONS-UNCERTAIN", 0 to "NT-ACTIONS-REPLY\n${response(q, receipt(q).copy(panePid = 0).toJson())}")) {
            val client = SshActions { _, _, input, _, _ -> if (input == null) 0 to "NT-ACTIONS-1\t$stamp\n${advertisement()}" else exit to raw }
            assertFailsWith<HostUnansweredException> { client.createManaged(q) { true } }
        }
    }
    @Test fun `confirmation requires exactly the private first line without consuming terminal output`() {
        val bytes = "NT-MANAGED-VIEW /dev/pts/123\r\n\u001b[2JUnicode α".toByteArray()
        val input = ByteArrayInputStream(bytes)
        assertEquals("/dev/pts/123", ManagedViewHandshake.read(input))
        assertEquals("\u001b[2JUnicode α", String(input.readBytes(), Charsets.UTF_8))
        for (bad in listOf("/dev/pts/1\n", "NT-MANAGED-VIEW /etc/passwd\n", "NT-MANAGED-VIEW /dev/pts/1;evil\n", "x".repeat(257), "")) {
            assertFailsWith<java.io.IOException> { ManagedViewHandshake.read(ByteArrayInputStream(bad.toByteArray())) }
        }
        assertEquals("/dev/ttys002", ManagedViewHandshake.read(ByteArrayInputStream("NT-MANAGED-VIEW /dev/ttys002\n".toByteArray())))
    }
}
