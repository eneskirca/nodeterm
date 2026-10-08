package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import kotlin.test.*

class ManagedSessionCreationTest {
    private class Memory : ManagedSessionCreation.Storage {
        var encoded: String? = null
        var fail = false
        override fun read() = encoded
        override fun write(encoded: String) { if (fail) throw java.io.IOException("disk refused commit"); this.encoded = encoded }
    }
    private val instance = "11111111-1111-4111-8111-111111111111"
    private val choice = ManagedSessionChoice("project-1", "shell", title = "Terminal")
    private fun request(c: ManagedSessionChoice = choice, n: Int = 1) = PreparedManagedSession("/profile", instance,
        "22222222-2222-4222-8222-${n.toString().padStart(12, '0')}", 1000,
        "33333333-3333-4333-8333-${n.toString().padStart(12, '0')}", c,
        """{"version":1,"instance":"$instance","pid":1,"updatedAt":1000,"methods":["sessions.createManagedV1"],"remoteProjects":false}""")
    private fun receipt(q: PreparedManagedSession) = ManagedSessionReceipt(q.creationId, "term-abc-${q.creationId.takeLast(12)}", q.choice.projectId,
        q.hostInstance, "node-terminal", "nt-term-abc-${q.creationId.takeLast(12)}", "%0", 123,
        "linux:11111111-1111-1111-1111-111111111111:42", "1000")

    @Test fun `admission serializes rapid taps and dispatch commits its original transaction first`() = runBlocking {
        val disk = Memory(); val ready = CompletableDeferred<Unit>(); var prepares = 0; var calls = 0; var shown = 0
        val creation = ManagedSessionCreation(this, disk, { prepares++; ready.await(); request(it) }, { q ->
            calls++; val saved = Json.parseToJsonElement(disk.encoded!!).jsonObject.getValue("pending").jsonObject
            assertEquals("sent", saved.getValue("phase").jsonPrimitive.content)
            assertEquals(q, ManagedSessions.prepared(saved.getValue("request").jsonObject)); receipt(q)
        })
        val ticket = creation.show()
        assertTrue(creation.submit(ticket, choice) { shown++ })
        assertFalse(creation.submit(ticket, choice) { shown++ })
        yield(); assertEquals(1, prepares); assertEquals(0, calls)
        creation.hide(ticket); ready.complete(Unit); yield()
        assertEquals(1, calls); assertEquals(0, shown)
        val result = assertIs<ManagedSessionCreation.State.Ready>(creation.state.value)
        assertNotNull(creation.receiptFor(result.adoption.receipt.nodeId))
        assertNull(creation.takeReady(ticket), "A stale dialog may not navigate")
    }
    @Test fun `process recovery after dispatch blocks any replay and new nonce until user checks`() = runBlocking {
        val disk = Memory(); var calls = 0
        val creation = ManagedSessionCreation(this, disk, { request(it) }, { calls++; throw HostUnansweredException("Lost reply") })
        val ticket = creation.show(); assertTrue(creation.submit(ticket, choice) {}); yield()
        assertIs<ManagedSessionCreation.State.Uncertain>(creation.state.value)
        assertFalse(creation.submit(ticket, choice) {})
        val recovered = ManagedSessionCreation(this, disk, { error("Must not re-prepare") }, { error("Must not re-send") })
        val t = recovered.show(); assertIs<ManagedSessionCreation.State.Uncertain>(recovered.state.value)
        assertFalse(recovered.submit(t, choice.copy(projectId = "other")) {})
        assertEquals(1, calls)
        assertFalse(recovered.acknowledgeChecked(ticket + 999))
        assertTrue(recovered.acknowledgeChecked(t)); assertIs<ManagedSessionCreation.State.Idle>(recovered.state.value)
    }
    @Test fun `a failed durable commit cannot dispatch`() = runBlocking {
        val disk = Memory().apply { fail = true }; var sent = 0
        val creation = ManagedSessionCreation(this, disk, { request(it) }, { sent++; receipt(it) })
        creation.submit(creation.show(), choice) {}; yield()
        assertEquals(0, sent); assertIs<ManagedSessionCreation.State.Uncertain>(creation.state.value)
    }
    @Test fun `only a confirmed pre mutation refusal permits changing choices`() = runBlocking {
        val disk = Memory(); val choices = ArrayList<ManagedSessionChoice>(); var fail = true
        val creation = ManagedSessionCreation(this, disk, { choices += it; request(it, choices.size) }, {
            if (fail) throw ManagedSessionRefusedException("Folder disappeared before creation") else receipt(it)
        })
        val ticket = creation.show(); creation.submit(ticket, choice) {}; yield()
        assertIs<ManagedSessionCreation.State.Refused>(creation.state.value); fail = false
        assertTrue(creation.submit(ticket, choice.copy(projectId = "changed")) {}); yield()
        assertEquals(listOf("project-1", "changed"), choices.map { it.projectId })
        assertIs<ManagedSessionCreation.State.Ready>(creation.state.value)
    }
    @Test fun `a ready result survives process death and consuming navigation retains attachment proof`() = runBlocking {
        val disk = Memory()
        val creation = ManagedSessionCreation(this, disk, { request(it) }, { receipt(it) })
        creation.submit(creation.show(), choice) {}; yield()
        val recovered = ManagedSessionCreation(this, disk, { error("No second preparation") }, { error("No second creation") })
        assertIs<ManagedSessionCreation.State.Ready>(recovered.state.value)
        val adoption = assertNotNull(recovered.takeReady(recovered.show()))
        val afterNavigation = ManagedSessionCreation(this, disk, { error("No preparation") }, { error("No creation") })
        assertIs<ManagedSessionCreation.State.Idle>(afterNavigation.state.value)
        assertEquals(adoption, afterNavigation.receiptFor(adoption.receipt.nodeId))
        afterNavigation.adopted(adoption.receipt.nodeId)
        assertNull(ManagedSessionCreation(this, disk, { request(it) }, { receipt(it) }).receiptFor(adoption.receipt.nodeId))
    }
    @Test fun `adopting an older receipt preserves another ready phase across restart`() = runBlocking {
        val disk = Memory(); var n = 0
        val creation = ManagedSessionCreation(this, disk, { request(it, ++n) }, { receipt(it) })
        var ticket = creation.show(); creation.submit(ticket, choice) {}; yield()
        val first = assertNotNull(creation.takeReady(ticket))
        ticket = creation.show(); creation.submit(ticket, choice) {}; yield()
        val second = assertIs<ManagedSessionCreation.State.Ready>(creation.state.value).adoption
        creation.adopted(first.receipt.nodeId)
        val recovered = ManagedSessionCreation(this, disk, { error("No creation") }, { error("No creation") })
        assertEquals(second, assertIs<ManagedSessionCreation.State.Ready>(recovered.state.value).adoption)
        assertNull(recovered.receiptFor(first.receipt.nodeId)); assertEquals(second, recovered.receiptFor(second.receipt.nodeId))
    }
    @Test fun `eight unadopted receipts cannot be silently evicted by a ninth creation`() = runBlocking {
        val disk = Memory(); var n = 0
        val creation = ManagedSessionCreation(this, disk, { request(it, ++n) }, { receipt(it) })
        val nodes = ArrayList<String>()
        repeat(8) {
            val ticket = creation.show(); assertTrue(creation.submit(ticket, choice) {}); yield()
            nodes += assertNotNull(creation.takeReady(ticket)).receipt.nodeId
        }
        assertFalse(creation.submit(creation.show(), choice) {}); assertEquals(8, n)
        for (node in nodes) assertNotNull(creation.receiptFor(node))
        creation.adopted(nodes.first()); assertTrue(creation.submit(creation.show(), choice) {}); yield(); assertEquals(9, n)
    }
    @Test fun `a conflicting host node identity cannot overwrite an earlier unadopted receipt`() = runBlocking {
        val disk = Memory(); var n = 0; var original: ManagedSessionAdoption? = null
        val creation = ManagedSessionCreation(this, disk, { request(it, ++n) }, { q ->
            val answer = receipt(q)
            original?.let { old -> answer.copy(nodeId = old.receipt.nodeId, session = old.receipt.session) } ?: answer
        })
        var ticket = creation.show(); creation.submit(ticket, choice) {}; yield()
        original = assertNotNull(creation.takeReady(ticket))
        ticket = creation.show(); creation.submit(ticket, choice) {}; yield()
        assertIs<ManagedSessionCreation.State.Uncertain>(creation.state.value)
        assertEquals(original, creation.receiptFor(original!!.receipt.nodeId))
        assertEquals(original, ManagedSessionCreation(this, disk, { error("No prepare") }, { error("No create") }).receiptFor(original!!.receipt.nodeId))
    }
    @Test fun `cancelled owner after dispatch leaves durable uncertainty without replay`() = runBlocking {
        val disk = Memory(); val scope = CoroutineScope(coroutineContext.minusKey(Job) + SupervisorJob())
        val dispatched = CompletableDeferred<Unit>(); var sent = 0
        val creation = ManagedSessionCreation(scope, disk, { request(it) }, { sent++; dispatched.complete(Unit); awaitCancellation() })
        val ticket = creation.show(); creation.submit(ticket, choice) {}; dispatched.await()
        scope.coroutineContext.cancelChildren(); yield()
        assertIs<ManagedSessionCreation.State.Uncertain>(creation.state.value)
        assertFalse(creation.submit(ticket, choice) {}); assertEquals(1, sent)
        assertIs<ManagedSessionCreation.State.Uncertain>(ManagedSessionCreation(this, disk, { request(it) }, { receipt(it) }).state.value)
        scope.cancel()
    }
    @Test fun `an already cancelled application scope cannot admit a creation`() = runBlocking {
        val scope = CoroutineScope(coroutineContext.minusKey(Job) + SupervisorJob()); scope.cancel()
        val creation = ManagedSessionCreation(scope, Memory(), { error("No preparation") }, { error("No dispatch") })
        assertFalse(creation.submit(creation.show(), choice) {})
        assertIs<ManagedSessionCreation.State.Idle>(creation.state.value)
    }
    @Test fun `a ready checkpoint without its retained adoption cannot downgrade into an ordinary open`() = runBlocking {
        val disk = Memory()
        val creation = ManagedSessionCreation(this, disk, { request(it) }, { receipt(it) })
        creation.submit(creation.show(), choice) {}; yield()
        val saved = Json.parseToJsonElement(disk.encoded!!).jsonObject
        disk.encoded = JsonObject(saved + ("receipts" to JsonArray(emptyList()))).toString()
        val restored = ManagedSessionCreation(this, disk, { error("No prepare") }, { error("No create") })
        assertIs<ManagedSessionCreation.State.Uncertain>(restored.state.value)
        assertNull(restored.takeReady(restored.show()))
    }
    @Test fun `unreadable saved checkpoint does not authorize a new session`() = runBlocking {
        val disk = Memory().apply { encoded = "not JSON" }
        val creation = ManagedSessionCreation(this, disk, { error("No new request") }, { error("No new creation") })
        assertIs<ManagedSessionCreation.State.Uncertain>(creation.state.value)
        assertFalse(creation.submit(creation.show(), choice) {})
    }
}
