package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostLifetime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.InternalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test

class HostLifetimeTest {
    @Test fun `permanent retirement refuses every old and fresh lease`() {
        val lifetime = HostLifetime(); val lease = lifetime.capture(); var writes = 0
        lifetime.retire { }
        assertFalse(lifetime.active); assertFalse(lifetime.isCurrent(lease))
        assertFailsWith<CancellationException> { lifetime.capture() }
        assertFailsWith<CancellationException> { lifetime.publish(lease) { writes++ } }
        assertFalse(lifetime.whenCurrent(lease) { writes++ }); assertEquals(0, writes)
    }

    @Test fun `a lease from another host lifetime never authorizes this host`() {
        val first = HostLifetime(); val second = HostLifetime(); val foreign = first.capture()
        assertFalse(second.isCurrent(foreign))
        assertFailsWith<CancellationException> { second.publish(foreign) { error("must not publish") } }
        assertTrue(second.isCurrent(second.capture()))
    }

    @Test fun `retirement cancels an already awaiting approval dial and closes local transport`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val awaiting = CompletableDeferred<Unit>(); val closed = CompletableDeferred<Unit>()
        val dial = async {
            assertFailsWith<CancellationException> {
                lifetime.dial(lease) {
                    try { awaiting.complete(Unit); awaitCancellation() }
                    finally { closed.complete(Unit) }
                }
            }
        }
        awaiting.await(); lifetime.retire { }
        try { assertTrue(withTimeoutOrNull(1000) { dial.await(); closed.await(); true } == true, "Retirement must cancel local approval promptly") }
        finally { dial.cancelAndJoin() }
        assertTrue(closed.isCompleted)
        assertFalse(lifetime.whenCurrent(lease) { error("old approval must not publish") })
    }

    @OptIn(InternalCoroutinesApi::class)
    @Test fun `dial cancellation callbacks run outside the lifetime monitor`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val entered = CompletableDeferred<Unit>(); val callbackLocked = CompletableDeferred<Boolean>()
        val dial = async {
            assertFailsWith<CancellationException> {
                lifetime.dial(lease) {
                    currentCoroutineContext()[Job]!!.invokeOnCompletion(onCancelling = true, invokeImmediately = true) { callbackLocked.complete(Thread.holdsLock(lifetime)) }
                    entered.complete(Unit); awaitCancellation()
                }
            }
        }
        entered.await(); lifetime.disconnect { }
        try {
            assertTrue(withTimeoutOrNull(1000) { dial.await(); true } == true)
            assertFalse(callbackLocked.await(), "A cancel callback may acquire a native/store monitor")
        } finally { dial.cancelAndJoin() }
    }

    @Test fun `produced relay resource is retained for cleanup when cancellation discards its handoff`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        var produced = false; var closed = false; var callerReceived = false
        try {
            lifetime.dial(lease) {
                produced = true
                lifetime.retire { }
                "produced-local-transport"
            }
            callerReceived = true
        } catch (_: CancellationException) {
            if (produced) closed = true
        }
        assertTrue(produced); assertTrue(closed); assertFalse(callerReceived)
    }

    @Test fun `disconnect invalidates pending work but admits a fresh dial and keeps creation tracking`() {
        val lifetime = HostLifetime(); val old = lifetime.capture(); var closes = 0
        lifetime.disconnect { closes++ }
        assertTrue(lifetime.active, "A reversible disconnect must keep a saved uncertain creation")
        assertFalse(lifetime.isCurrent(old)); assertFailsWith<CancellationException> { lifetime.publish(old) { } }
        val fresh = lifetime.capture(); var published = false
        lifetime.publish(fresh) { published = true }
        assertTrue(published); assertEquals(1, closes)
    }

    @Test fun `suspended old dial closes after forget and same id replacement instead of adopting or minting`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var pairingToken = "original-token"; var closed = false; var adopted = false
        val dial = async {
            entered.complete(Unit); release.await()
            try { lifetime.publish(lease) { adopted = true; pairingToken = "late-old-mint" } }
            catch (_: CancellationException) { closed = true }
        }
        entered.await(); lifetime.retire { }; pairingToken = "same-id-new-pair-token"
        release.complete(Unit); dial.await()
        assertTrue(closed); assertFalse(adopted); assertEquals("same-id-new-pair-token", pairingToken)
    }

    @Test fun `suspended dial cannot reopen after a reversible disconnect`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var closed = false; var adopted = false
        val dial = async {
            entered.complete(Unit); release.await()
            try { lifetime.publish(lease) { adopted = true } } catch (_: CancellationException) { closed = true }
        }
        entered.await(); lifetime.disconnect { }; release.complete(Unit); dial.await()
        assertTrue(closed); assertFalse(adopted); assertTrue(lifetime.active)
    }

    @Test fun `a suspended relay join cannot start a new approval handshake after retirement`() = runBlocking {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val joined = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var connectorCalls = 0
        val dial = async {
            lifetime.requireCurrent(lease); joined.complete(Unit); release.await()
            try { lifetime.requireCurrent(lease); connectorCalls++ } catch (_: CancellationException) { }
        }
        joined.await(); lifetime.retire { }; release.complete(Unit); dial.await()
        assertEquals(0, connectorCalls)
    }

    @Test fun `retirement waits for admitted local publication and invalidates every later callback`() {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val error = AtomicReference<Throwable?>(); val writes = mutableListOf<String>()
        val publisher = thread {
            try { lifetime.publish(lease) { entered.countDown(); assertTrue(release.await(2, TimeUnit.SECONDS)); writes += "old-publication" } }
            catch (e: Throwable) { error.set(e) }
        }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        val retiring = thread { lifetime.retire { writes += "retired" } }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (retiring.isAlive && retiring.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield()
        try { assertEquals(Thread.State.BLOCKED, retiring.state) }
        finally { release.countDown(); publisher.join(2000); retiring.join(2000) }
        assertFalse(publisher.isAlive); assertFalse(retiring.isAlive); assertNull(error.get())
        assertEquals(listOf("old-publication", "retired"), writes)
        assertFalse(lifetime.whenCurrent(lease) { writes += "late-status-or-pin" })
        assertEquals(2, writes.size)
    }

    @Test fun `close failures never revive the forgotten object or its old generation`() {
        val lifetime = HostLifetime(); val lease = lifetime.capture()
        assertFailsWith<IllegalStateException> { lifetime.retire { error("synthetic close failure") } }
        assertFalse(lifetime.active); assertFalse(lifetime.isCurrent(lease))
        assertFailsWith<CancellationException> { lifetime.capture() }
    }

    @Test fun `native dials and callbacks share exact generation and permanent retirement fences`() {
        val source = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "suspend fun ensureConnected("),
            "val lease = lifetime.capture()", "return mutex.withLock", "lifetime.requireCurrent(lease)", "connectLocked(trigger, lease)")
        val dial = AppSourcePins.blockAfter(source, "private suspend fun connectLocked(")
        AppSourcePins.assertInOrder(dial, "SshHostConnection.connect(", "pinFor(host, lease)", "adopt(ssh, lease)")
        assertTrue(dial.contains("lifetime.dial(lease) { withContext(Dispatchers.IO)"))
        assertTrue(dial.contains("dialed?.let { c -> scope.launch(Dispatchers.IO) { runCatching { c.close() } } }"))
        assertTrue(dial.contains("scope.launch(Dispatchers.IO) { runCatching { connected.connection.close() } }"))
        assertTrue(dial.contains("lifetime.publish(lease) { graph.relayGate.onFailed(hostId, e) }"))
        val adopt = AppSourcePins.blockAfter(source, "private fun adopt(")
        AppSourcePins.assertInOrder(adopt, "lifetime.publish(lease)", "connectionLease = lease", "conn = c")
        assertTrue(adopt.contains("lifetime.whenCurrent(lease) { if (conn === c)"))
        assertTrue(adopt.contains("c.setOnChanged { if (lifetime.isCurrent(lease) && conn === c && isWatched)"))
        AppSourcePins.assertInOrder(source.substringAfter("class ConnectionManager("),
            "private val sessions = HostSessionRegistry(", "session?.retire()", "graph.relayGate.forget(hostId)")
        assertTrue(source.contains("fun forget(hostId: String) = sessions.forget(hostId)"))
        assertTrue(source.contains("fun retire() = lifetime.retire { disconnectOwned() }"))
        assertTrue(source.contains("fun disconnect() = lifetime.disconnect { disconnectOwned() }"))
        assertTrue(source.contains("return lifetime.dial(lease)"))
        val join = AppSourcePins.blockAfter(source, "private suspend fun dialRelay(")
        assertEquals(2, Regex("lifetime\\.requireCurrent\\(lease\\)").findAll(join).count())
        AppSourcePins.assertInOrder(join, "lifetime.requireCurrent(lease)", "RelayApi(graph.hosts.apiBase).join", "lifetime.requireCurrent(lease)", "RelayConnector.connect(")
        AppSourcePins.assertInOrder(join, "var dialed: RelayConnector.Connected? = null", "return lifetime.dial(lease)", ").also { dialed = it }", "dialed?.let { connected -> scope.launch(Dispatchers.IO) { runCatching { connected.connection.close() } } }")
        val sideAt = source.indexOf("suspend fun viaRelay(")
        val sideBody = source.indexOf("): HostConnection {", sideAt)
        assertTrue(sideAt >= 0 && sideBody > sideAt)
        val side = AppSourcePins.blockAfter(source.substring(sideBody), "): HostConnection")
        assertTrue(side.contains("val lease = lifetime.capture()")); assertTrue(side.contains("lifetime.requireCurrent(lease)"))
        assertTrue(side.contains("lifetime.publish(lease) { graph.relayGate.onFailed(hostId, e) }"))
        assertTrue(side.contains("lifetime.whenCurrent(lease)")); assertTrue(side.contains("runCatching { c.close() }"))
        assertTrue(side.contains("lifetime.publish(lease) {\n                        graph.relayGate.onConnected(hostId)"))
    }

    @Test fun `native store guards pin LAN adoption and saved creation with the originating lifetime`() {
        val source = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(source.contains("graph.hosts.managedCreationStorage(hostId) { lifetime.active }"))
        val pin = AppSourcePins.blockAfter(source, "private fun pinFor(")
        assertTrue(pin.contains("graph.hosts.currentHost(host.id, host.hostKeyB64) { lifetime.isCurrent(lease) }"))
        assertTrue(pin.contains("graph.hosts.updateCurrent(host.id, host.hostKeyB64, { lifetime.isCurrent(lease) })"))
        val lan = AppSourcePins.blockAfter(source, "private fun refreshLanLeg(")
        assertTrue(lan.contains("lifetime.whenCurrent(lease)")); assertTrue(lan.contains("if (conn !== c) return@whenCurrent"))
        assertTrue(lan.contains("graph.hosts.updateCurrent(hostId, before.hostKeyB64, { lifetime.isCurrent(lease) && conn === c })"))
        val mint = AppSourcePins.blockAfter(source, "private suspend fun adoptRelayIfAdvertised(")
        assertTrue(mint.contains("currentConnection = { lifetime.isCurrent(lease) && conn === ssh }"))
        val refresh = AppSourcePins.blockAfter(source, "suspend fun refreshNow(")
        assertTrue(refresh.contains("lifetime.whenCurrent(operation) { graph.announce(hostId, listed, onScreen.now(), quiet = reachableQuietly()) }"))
        val notifier = AppSourcePins.app("notify/InboxNotifier.kt")
        assertFalse(AppSourcePins.blockAfter(notifier, "private fun build(").contains("connections.session("))
        assertTrue(notifier.contains("build(context, host, snapshot, ev, showDetails, quiet)"))
        val graph = AppSourcePins.app("NodetermApp.kt")
        assertTrue(graph.contains("InboxNotifier.announce(appContext, host, snapshot, onScreen, quiet)"))
        val store = AppSourcePins.app("data/HostStore.kt")
        val current = AppSourcePins.blockAfter(store, "fun currentHost(")
        assertTrue(current.contains("current() && it.hostKeyB64 == expectedHostKey"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(store, "fun updateCurrent("), "currentHost(id, expectedHostKey, current) ?: return false", "save(")
        val storage = AppSourcePins.blockAfter(store, "fun managedCreationStorage(")
        assertTrue(storage.contains("if (!current() || get(hostId) == null) null"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(storage, "override fun write("),
            "synchronized(this@HostStore)", "if (!current() || get(hostId) == null) throw", ".commit()")
    }
}
