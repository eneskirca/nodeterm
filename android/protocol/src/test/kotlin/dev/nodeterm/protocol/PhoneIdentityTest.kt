package dev.nodeterm.protocol

import dev.nodeterm.protocol.secure.PhoneIdentity
import dev.nodeterm.protocol.secure.PlainStorage
import dev.nodeterm.protocol.secure.SecretStorage
import dev.nodeterm.protocol.secure.SecretStoreCore
import dev.nodeterm.protocol.secure.SecretUnavailableException
import dev.nodeterm.protocol.secure.Sealer
import java.security.ProviderException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Audit A51: an Android 12+ device-to-device transfer copied the phone's plain preferences (the
 * paired computers and the relay `deviceId`) but not its Keystore key, so the new phone regenerated
 * its box key and went on presenting the OLD deviceId beside it. [PhoneIdentity] keeps the two
 * together: a deviceId never outlives the box secret it was minted with. The manifest half (the data
 * extraction rules) is [BackupRulesTest].
 */
class PhoneIdentityTest {
    /** Both stores write into one journal, so the ORDER across the two preference files is visible. */
    private val journal = ArrayList<String>()

    private inner class SecretMem : SecretStorage {
        val map = HashMap<String, String>()
        override fun get(name: String) = map[name]
        override fun put(name: String, value: String, durable: Boolean) {
            map[name] = value
            journal += "secret.put $name durable=$durable"
        }
        override fun remove(name: String) {
            map.remove(name)
            journal += "secret.remove $name"
        }
    }

    private inner class PlainMem : PlainStorage {
        val map = HashMap<String, String>()
        override fun get(name: String) = map[name]
        override fun put(name: String, value: String, durable: Boolean) {
            map[name] = value
            journal += "plain.put $name durable=$durable"
        }
        override fun remove(name: String, durable: Boolean) {
            map.remove(name)
            journal += "plain.remove $name durable=$durable"
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

    private val secretMem = SecretMem()
    private val plainMem = PlainMem()
    private val sealer = GcmSealer()
    private var minted = 0

    /** A fresh process over the same storage (what an app restart is). */
    private fun process() = PhoneIdentity(SecretStoreCore(secretMem, sealer), plainMem) { "device-${++minted}" }

    @Test
    fun `a fresh phone creates the box key first, then its deviceId, both durably`() {
        val id = process().deviceId()
        assertEquals("device-1", id)
        assertEquals(
            listOf(
                "plain.remove deviceId durable=true", // nothing to drop, but the rule runs before any key
                "secret.put box.secret durable=true",
                "plain.put deviceId durable=true"
            ),
            journal
        )
    }

    @Test
    fun `an ordinary restart keeps the deviceId and the key`() {
        val first = process()
        val id = first.deviceId()
        val box = first.boxSecret()
        val again = process()
        assertEquals(id, again.deviceId())
        assertContentEquals(box, again.boxSecret())
        assertEquals(1, minted)
    }

    @Test
    fun `a deviceId stored by an earlier build is kept while its key still opens`() {
        val box = process().boxSecret() // an earlier build created the key ...
        plainMem.map[PhoneIdentity.DEVICE_ID] = "legacy-id" // ... and minted its id without this class
        val later = process()
        assertEquals("legacy-id", later.deviceId())
        assertContentEquals(box, later.boxSecret())
    }

    @Test
    fun `a transferred phone (the Keystore key stayed behind) gets a new deviceId with its new key`() {
        val old = process()
        val oldId = old.deviceId()
        val oldBox = old.boxSecret()
        // The new phone: the same preference files, a different Keystore key. The sealed box secret
        // no longer authenticates, which is positive evidence it is gone.
        sealer.key = GcmSealer.newKey()
        val moved = process()
        val newBox = moved.boxSecret()
        val newId = moved.deviceId()
        assertNotEquals(oldBox.toList(), newBox.toList())
        assertNotEquals(oldId, newId)
        assertEquals(newId, process().deviceId(), "and the new pair is kept from then on")
    }

    @Test
    fun `plain preferences without the sealed ones (the key is absent) also mean a new deviceId`() {
        val oldId = process().deviceId()
        secretMem.map.clear() // only nodeterm.hosts came across
        assertNotEquals(oldId, process().deviceId())
    }

    @Test
    fun `the old deviceId is off disk before the new key is written`() {
        process().deviceId()
        sealer.key = GcmSealer.newKey()
        journal.clear()
        process().deviceId()
        // A process that dies between the two writes leaves NO deviceId, never the old one beside a
        // new key; the next deviceId() mints one then.
        val drop = journal.indexOf("plain.remove deviceId durable=true")
        val create = journal.indexOf("secret.put box.secret durable=true")
        assertTrue(drop in 0 until create, "journal: $journal")
    }

    @Test
    fun `asking for the deviceId before the key never hands out an id that is then dropped`() {
        // PairScreen evaluates deviceId before boxKeys: the key must already exist by then.
        val identity = process()
        val id = identity.deviceId()
        identity.boxSecret()
        assertEquals(id, process().deviceId())
        assertEquals(1, minted)
    }

    @Test
    fun `a keystore that cannot answer right now changes nothing`() {
        process().deviceId()
        val before = HashMap(plainMem.map)
        val sealedBefore = HashMap(secretMem.map)
        sealer.failOpenWith = ProviderException("Keystore operation failed")
        assertFailsWith<SecretUnavailableException> { process().deviceId() }
        assertFailsWith<SecretUnavailableException> { process().boxSecret() }
        assertEquals(before, plainMem.map, "the deviceId is not dropped over a transient error")
        assertEquals(sealedBefore, secretMem.map)
        sealer.failOpenWith = null
        assertEquals("device-1", process().deviceId())
    }

    @Test
    fun `if the deviceId cannot be dropped, no new key is written`() {
        process().deviceId()
        sealer.key = GcmSealer.newKey()
        val sealedBefore = HashMap(secretMem.map)
        val failing = object : PlainStorage by plainMem {
            override fun remove(name: String, durable: Boolean) = throw IllegalStateException("disk full")
        }
        val identity = PhoneIdentity(SecretStoreCore(secretMem, sealer), failing) { "never" }
        assertFailsWith<IllegalStateException> { identity.deviceId() }
        assertEquals(sealedBefore, secretMem.map)
        assertFalse(plainMem.map[PhoneIdentity.DEVICE_ID] == "never")
    }
}
