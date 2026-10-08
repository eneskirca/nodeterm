package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostLifetime
import dev.nodeterm.protocol.host.HostSessionRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*
import org.junit.jupiter.api.Test

class HostSessionRegistryTest {
    private class Session(val record: String, val lifetime: HostLifetime = HostLifetime())

    private fun blocked(thread: Thread) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (thread.isAlive && thread.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield()
        assertEquals(Thread.State.BLOCKED, thread.state, "Factory admission must wait for local publication")
    }

    private fun admissionDuringPublication(forget: Boolean) {
        val record = AtomicReference<String?>("old")
        val registry = HostSessionRegistry(
            create = { _: String -> Session(checkNotNull(record.get()) { "Computer was forgotten" }) },
            retire = { _: String, session: Session? -> session?.lifetime?.retire {} },
        )
        val old = registry.session("same")
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val attempting = CountDownLatch(1)
        val result = AtomicReference<Session?>(); val failure = AtomicReference<Throwable?>()
        val publicationFailure = AtomicReference<Throwable?>()
        val publisher = Thread {
            try {
                registry.retireAndPublish(listOf("same")) {
                    assertFalse(old.lifetime.active)
                    entered.countDown()
                    assertTrue(release.await(2, TimeUnit.SECONDS))
                    record.set(if (forget) null else "new")
                }
            } catch (e: Throwable) { publicationFailure.set(e) }
        }
        val caller = Thread {
            attempting.countDown()
            try { result.set(registry.session("same")) } catch (e: Throwable) { failure.set(e) }
        }
        publisher.start()
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS)); caller.start()
            assertTrue(attempting.await(2, TimeUnit.SECONDS)); blocked(caller)
            assertNull(result.get()); assertNull(failure.get())
        } finally {
            release.countDown(); publisher.join(3_000); caller.join(3_000)
        }
        assertFalse(publisher.isAlive); assertFalse(caller.isAlive); assertNull(publicationFailure.get())
        if (forget) {
            assertNull(result.get()); assertIs<IllegalStateException>(failure.get()); assertTrue(registry.all().isEmpty())
        } else {
            assertNull(failure.get()); val replacement = assertNotNull(result.get())
            assertNotSame(old, replacement); assertEquals("new", replacement.record)
            assertTrue(replacement.lifetime.active); assertSame(replacement, registry.session("same"))
        }
    }

    @Test fun `same id replacement blocks factory until new saved facts are published`() = admissionDuringPublication(false)

    @Test fun `forget blocks factory until membership is removed`() = admissionDuringPublication(true)

    @Test fun `failed secret publication retires old session and releases admission for retained record`() {
        val registry = HostSessionRegistry(
            create = { _: String -> Session("retained") },
            retire = { _: String, session: Session? -> session?.lifetime?.retire {} },
        )
        val old = registry.session("same")
        assertFailsWith<IllegalStateException> { registry.retireAndPublish(listOf("same")) { error("secret write refused") } }
        assertFalse(old.lifetime.active)
        val replacement = registry.session("same")
        assertNotSame(old, replacement); assertEquals("retained", replacement.record); assertTrue(replacement.lifetime.active)
    }

    @Test fun `duplicate retired ids close once and leave unrelated session unchanged`() {
        val retired = mutableListOf<String>()
        val registry = HostSessionRegistry(
            create = { id: String -> Session(id) },
            retire = { id: String, session: Session? -> retired += id; session?.lifetime?.retire {} },
        )
        val old = registry.session("old"); val incoming = registry.session("incoming"); val other = registry.session("other")
        var published = false
        registry.retireAndPublish(listOf("old", "incoming", "old")) {
            assertFalse(old.lifetime.active); assertFalse(incoming.lifetime.active)
            assertEquals(listOf("other"), registry.all().map { it.record }); published = true
        }
        assertTrue(published); assertEquals(listOf("old", "incoming"), retired)
        assertSame(other, registry.session("other")); assertTrue(other.lifetime.active)
    }

    @Test fun `retirement failure prevents publication and releases factory monitor`() {
        val registry = HostSessionRegistry(
            create = { id: String -> Session(id) },
            retire = { _: String, session: Session? -> session?.lifetime?.retire {}; error("retirement failure") },
        )
        val old = registry.session("old"); var published = false
        assertFailsWith<IllegalStateException> { registry.retireAndPublish(listOf("old")) { published = true } }
        assertFalse(published); assertFalse(old.lifetime.active)
        assertNotSame(old, registry.session("old"))
    }

    @Test fun `native pairing and Forget use same factory barrier including incoming id without prior key`() {
        val manager = AppSourcePins.app("conn/ConnectionManager.kt").substringAfter("class ConnectionManager(")
        assertTrue(manager.contains("private val sessions = HostSessionRegistry("))
        assertTrue(manager.contains("create = { hostId: String -> HostSession(hostId, graph) }"))
        assertTrue(manager.contains("fun session(hostId: String): HostSession = sessions.session(hostId)"))
        assertTrue(manager.contains("@Synchronized\n    fun <T> retireAndPublish("))
        assertTrue(manager.contains("sessions.retireAndPublish(hostIds, publish)"))
        assertTrue(manager.contains("fun all(): List<HostSession> = sessions.all()"))
        assertFalse(manager.contains("getOrPut(")); assertFalse(manager.contains("HashMap<"))
        val pair = AppSourcePins.ui("PairScreen.kt")
        AppSourcePins.assertInOrder(pair,
            "val retiredIds = PairedHostReplacement.retired(graph.hosts.hosts.value, host, previous).map { it.id } + host.id",
            "graph.connections.retireAndPublish(retiredIds)", "graph.hosts.publishPairing(host, previous")
        val publication = AppSourcePins.blockAfter(pair, "graph.connections.retireAndPublish(retiredIds)")
        assertTrue(publication.contains("graph.hosts.publishPairing(host, previous"))
        assertFalse(publication.contains("graph.connections."))
        val hosts = AppSourcePins.ui("HostsScreen.kt")
        assertTrue(AppSourcePins.blockAfter(hosts, "graph.connections.retireAndPublish(listOf(host.id))")
            .contains("graph.hosts.remove(host.id) { graph.secure.remove(SecureStore.relayTokenKey(host.id)) }"))
    }
}
