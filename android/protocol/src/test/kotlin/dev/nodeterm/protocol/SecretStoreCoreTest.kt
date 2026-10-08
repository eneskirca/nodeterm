package dev.nodeterm.protocol

import dev.nodeterm.protocol.secure.SecretStorage
import dev.nodeterm.protocol.secure.SecretStoreCore
import dev.nodeterm.protocol.secure.SecretUnavailableException
import dev.nodeterm.protocol.secure.Sealer
import java.security.ProviderException
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals

/** Audit A24: the phone's identity is replaced only on positive evidence it is gone. */
class SecretStoreCoreTest {
    private class MemStorage : SecretStorage {
        val map = HashMap<String, String>()
        val durableWrites = ArrayList<String>()
        override fun get(name: String) = map[name]
        override fun put(name: String, value: String, durable: Boolean) {
            map[name] = value
            if (durable) durableWrites += name
        }
        override fun remove(name: String) {
            map.remove(name)
        }
    }

    /** Real AES-GCM (the Keystore does the same), plus a switch to fail like a busy keystore. */
    private class GcmSealer(var key: SecretKey = newKey()) : Sealer {
        var failOpenWith: Exception? = null
        override fun seal(plain: ByteArray): ByteArray {
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            return iv + c.doFinal(plain)
        }
        override fun open(sealed: ByteArray): ByteArray {
            failOpenWith?.let { throw it }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, 12))
            return c.doFinal(sealed, 12, sealed.size - 12)
        }
        companion object {
            fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }

    private val storage = MemStorage()
    private val sealer = GcmSealer()
    private val store = SecretStoreCore(storage, sealer)

    @Test
    fun `the identity is created once, durably, and then kept`() {
        val a = store.getOrCreate32("box.secret")
        assertEquals(listOf("box.secret"), storage.durableWrites)
        assertContentEquals(a, store.getOrCreate32("box.secret"))
    }

    @Test
    fun `a transient keystore failure never overwrites the identity`() {
        val a = store.getOrCreate32("box.secret")
        val before = storage.map["box.secret"]
        sealer.failOpenWith = ProviderException("Keystore operation failed")
        assertFailsWith<SecretUnavailableException> { store.getOrCreate32("box.secret") }
        sealer.failOpenWith = IllegalStateException("keystore locked")
        assertFailsWith<SecretUnavailableException> { store.getBytes("box.secret") }
        assertEquals(before, storage.map["box.secret"], "the stored identity was not touched")
        sealer.failOpenWith = null
        assertContentEquals(a, store.getOrCreate32("box.secret"), "and it reads back once the keystore answers")
    }

    @Test
    fun `a value sealed under a key that is gone is replaced (positive evidence)`() {
        val a = store.getOrCreate32("ssh.seed")
        sealer.key = GcmSealer.newKey() // the Keystore key was wiped and regenerated
        assertIs<SecretStoreCore.Read.Lost>(store.read("ssh.seed"))
        assertNotEquals(a.toList(), store.getOrCreate32("ssh.seed").toList())
    }

    @Test
    fun `a malformed blob is lost, not unavailable`() {
        storage.map["x"] = "%%%not base64%%%"
        assertIs<SecretStoreCore.Read.Lost>(store.read("x"))
        storage.map["y"] = java.util.Base64.getEncoder().encodeToString(ByteArray(5))
        assertIs<SecretStoreCore.Read.Lost>(store.read("y"))
        assertEquals(32, store.getOrCreate32("x").size)
    }

    @Test
    fun `strings round-trip and absence is absence`() {
        assertIs<SecretStoreCore.Read.Absent>(store.read("relay.token.h"))
        store.putBytes("relay.token.h", "tok".toByteArray())
        assertEquals("tok", store.getBytes("relay.token.h")!!.toString(Charsets.UTF_8))
        assertIs<AEADBadTagException>(runCatching { sealer.key = GcmSealer.newKey(); sealer.open(java.util.Base64.getDecoder().decode(storage.map["relay.token.h"])) }.exceptionOrNull())
    }
}
