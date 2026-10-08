package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.E2ee
import dev.nodeterm.protocol.crypto.TweetNacl
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Byte-for-byte agreement with the desktop's crypto. The vectors come from
 * `scripts/gen-crypto-vectors.cjs`, which runs the desktop's own `tweetnacl` (the library
 * `src/main/remote/e2ee.ts` uses) and node's HKDF — so a green run here means a box sealed on the
 * phone opens on the desktop and vice versa.
 */
class CryptoVectorsTest {
    private val vectors: JsonObject = Json.parseToJsonElement(
        javaClass.getResource("/crypto-vectors.json")!!.readText()
    ).jsonObject

    private fun JsonObject.b(key: String): ByteArray = B64.decode(this[key]!!.jsonPrimitive.content)!!
    private fun JsonObject.s(key: String): String = this[key]!!.jsonPrimitive.content

    @Test
    fun `public keys derive exactly as tweetnacl box keyPair fromSecretKey`() {
        for (v in vectors["keypairs"]!!.jsonArray.map { it.jsonObject }) {
            val kp = BoxKeyPair.fromSecretKey(v.b("secretKey"))
            assertEquals(v.s("publicKey"), kp.publicKeyB64)
        }
    }

    @Test
    fun `box before and SAS match the desktop`() {
        for (v in vectors["before"]!!.jsonArray.map { it.jsonObject }) {
            val shared = E2ee.deriveSharedKey(v.s("bPublic"), v.b("aSecret"))
            assertContentEquals(v.b("shared"), shared)
            assertEquals(v.s("sas"), E2ee.sasFromSharedKey(shared))
        }
    }

    @Test
    fun `secretbox seals and opens byte-identically across block boundaries`() {
        for (v in vectors["secretbox"]!!.jsonArray.map { it.jsonObject }) {
            val sealed = TweetNacl.secretbox(v.b("msg"), v.b("nonce"), v.b("key"))
            assertContentEquals(v.b("box"), sealed, "len=${v.b("msg").size}")
            val opened = TweetNacl.secretboxOpen(v.b("box"), v.b("nonce"), v.b("key"))
            assertNotNull(opened)
            assertContentEquals(v.b("msg"), opened)
        }
    }

    @Test
    fun `a tampered box is refused, never partially decrypted`() {
        val v = vectors["secretbox"]!!.jsonArray[10].jsonObject
        val box = v.b("box")
        for (i in box.indices step 7) {
            val bad = box.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
            assertNull(TweetNacl.secretboxOpen(bad, v.b("nonce"), v.b("key")), "flip at $i")
        }
    }

    @Test
    fun `session key is RFC 5869 HKDF with host nonce first`() {
        for (v in vectors["hkdf"]!!.jsonArray.map { it.jsonObject }) {
            val key = E2ee.deriveSessionKey(v.b("base"), v.b("hostNonce"), v.b("clientNonce"))
            assertContentEquals(v.b("sessionKey"), key)
        }
    }

    @Test
    fun `host id is the relay broker room derivation`() {
        for (v in vectors["hostIds"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(v.s("hostId"), E2ee.hostIdFromPublicKeyB64(v.s("publicKey")))
        }
    }

    @Test
    fun `encrypt and decrypt round trip with a random nonce`() {
        val a = BoxKeyPair.generate()
        val b = BoxKeyPair.generate()
        val ab = E2ee.deriveSharedKey(b.publicKey, a.secretKey)
        val ba = E2ee.deriveSharedKey(a.publicKey, b.secretKey)
        assertContentEquals(ab, ba)
        val msg = "héllo nodeterm".toByteArray()
        assertContentEquals(msg, E2ee.decrypt(E2ee.encrypt(msg, ab), ba))
        assertNull(E2ee.decrypt(ByteArray(10), ab))
    }
}
