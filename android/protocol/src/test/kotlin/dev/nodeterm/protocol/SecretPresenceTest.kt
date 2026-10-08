package dev.nodeterm.protocol

import dev.nodeterm.protocol.secure.SecretStorage
import dev.nodeterm.protocol.secure.SecretStoreCore
import dev.nodeterm.protocol.secure.SecretUnavailableException
import dev.nodeterm.protocol.secure.Sealer
import java.security.ProviderException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Audit A47: the host list decided "From anywhere" by DECRYPTING each computer's relay token — an
 * Android Keystore round trip on the main thread, per row, per recomposition, and one that waited
 * on the store's lock behind any connection decrypting at the same moment. The list only needs to
 * know a token is stored. [SecretStoreCore.contains] answers that from the storage alone, and
 * [SecretStoreCore.revision] tells the list when to ask again.
 *
 * The Compose row itself cannot run on a JVM, so its wiring is pinned in the app's source
 * ([AppSourcePins]); nothing here has run on a device.
 */
class SecretPresenceTest {
    private class MemStorage : SecretStorage {
        val map = HashMap<String, String>()
        override fun get(name: String) = map[name]
        override fun put(name: String, value: String, durable: Boolean) {
            map[name] = value
        }
        override fun remove(name: String) {
            map.remove(name)
        }
    }

    /** A reversible stand-in cipher that counts opens and can fail or block like a busy keystore. */
    private class CountingSealer : Sealer {
        var opens = 0
        var failOpenWith: Exception? = null
        var onOpen: (() -> Unit)? = null
        override fun seal(plain: ByteArray): ByteArray = ByteArray(12) + plain.map { (it.toInt() xor 0x5a).toByte() } + ByteArray(16)
        override fun open(sealed: ByteArray): ByteArray {
            opens++
            onOpen?.invoke()
            failOpenWith?.let { throw it }
            return sealed.copyOfRange(12, sealed.size - 16).map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        }
    }

    private val storage = MemStorage()
    private val sealer = CountingSealer()
    private val store = SecretStoreCore(storage, sealer)
    private val token = "relay.token.h1"

    @Test
    fun `presence is answered without opening the value`() {
        assertFalse(store.contains(token))
        store.putBytes(token, "tok".toByteArray())
        assertTrue(store.contains(token))
        assertEquals(0, sealer.opens, "contains opened the stored value")
        store.remove(token)
        assertFalse(store.contains(token))
        assertEquals(0, sealer.opens)
    }

    @Test
    fun `a token the keystore cannot open right now is still stored`() {
        // The old check read "no relay" during a keystore hiccup; the token is still there.
        store.putBytes(token, "tok".toByteArray())
        sealer.failOpenWith = ProviderException("Keystore operation failed")
        assertFailsWith<SecretUnavailableException> { store.getBytes(token) }
        assertTrue(store.contains(token))
    }

    @Test
    fun `presence does not wait behind a decrypt on another thread`() {
        store.putBytes(token, "tok".toByteArray())
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        sealer.onOpen = {
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
        }
        // A connection decrypting the token, holding the store's lock for as long as the keystore takes.
        val reader = Thread { runCatching { store.getBytes(token) } }.apply { start() }
        val ui = Executors.newSingleThreadExecutor()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS), "the reader never reached the keystore")
            val answer = ui.submit<Boolean> { store.contains(token) }
            // Throws TimeoutException when contains waits for the lock the reader holds.
            assertTrue(answer.get(2, TimeUnit.SECONDS))
        } finally {
            release.countDown()
            reader.join(5_000)
            ui.shutdownNow()
        }
    }

    @Test
    fun `the revision moves when a secret is stored or removed, never when one is read`() {
        val start = store.revision.value
        store.putBytes(token, "tok".toByteArray())
        val afterPut = store.revision.value
        assertTrue(afterPut > start, "storing a token did not move the revision")

        store.getBytes(token)
        store.read(token)
        store.contains(token)
        assertEquals(afterPut, store.revision.value, "a read moved the revision")

        store.remove(token)
        val afterRemove = store.revision.value
        assertTrue(afterRemove > afterPut, "removing a token did not move the revision")

        store.getOrCreate32("box.secret")
        val afterCreate = store.revision.value
        assertTrue(afterCreate > afterRemove, "creating the identity did not move the revision")
        store.getOrCreate32("box.secret")
        assertEquals(afterCreate, store.revision.value, "reading back the identity moved the revision")
    }

    private val hostsScreen get() = AppSourcePins.ui("HostsScreen.kt")

    @Test
    fun `the host list asks whether a token is stored, never for its value`() {
        val src = hostsScreen
        assertFalse(src.contains("secure.getString"), "HostsScreen decrypts a secret")
        assertFalse(src.contains("secure.getBytes"), "HostsScreen decrypts a secret")
        // The row re-asks when the store's revision moves: a late relay adoption can mint a token
        // without changing the host record, so the host list alone would not recompose the row.
        assertTrue(src.contains("val secretsRevision by graph.secure.revision.collectAsState()"))
        assertTrue(src.contains("items(hosts, key = { it.id }) { host ->"))
        val row = AppSourcePins.blockAfter(src, "}) { host ->") // the row's body, not the key lambda
        AppSourcePins.assertInOrder(
            row,
            "val relayTokenStored = remember(host.id, secretsRevision) { graph.secure.hasRelayToken(host.id) }",
            "routeSummary(host, relayTokenStored)"
        )
    }
}
