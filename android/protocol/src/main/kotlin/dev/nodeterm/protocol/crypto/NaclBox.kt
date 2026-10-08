package dev.nodeterm.protocol.crypto

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** A NaCl box keypair (Curve25519). The secret key is the raw 32 bytes tweetnacl stores. */
class BoxKeyPair(val publicKey: ByteArray, val secretKey: ByteArray) {
    init {
        require(publicKey.size == 32 && secretKey.size == 32) { "box keys are 32 bytes" }
    }

    val publicKeyB64: String get() = B64.encode(publicKey)

    companion object {
        fun generate(random: SecureRandom = SecureRandom()): BoxKeyPair {
            val sk = ByteArray(32).also(random::nextBytes)
            return fromSecretKey(sk)
        }

        /** Recompute the public half, exactly as tweetnacl's `box.keyPair.fromSecretKey`. */
        fun fromSecretKey(secretKey: ByteArray): BoxKeyPair {
            require(secretKey.size == 32) { "secret key must be 32 bytes" }
            val pk = ByteArray(32)
            TweetNacl.scalarmultBase(pk, secretKey)
            return BoxKeyPair(pk, secretKey.copyOf())
        }
    }
}

/** Standard (padded) base64 — what the desktop's `publicKeyToB64` / `Buffer.toString('base64')` emit. */
object B64 {
    fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    /** Strict decode: returns null instead of throwing on malformed input. */
    fun decode(text: String): ByteArray? = try {
        Base64.getDecoder().decode(text.trim())
    } catch (_: IllegalArgumentException) {
        null
    }

    fun encodeUrl(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decodeUrl(text: String): ByteArray? = try {
        Base64.getUrlDecoder().decode(text.trim().trimEnd('='))
    } catch (_: IllegalArgumentException) {
        null
    }
}

/**
 * The desktop's `src/main/remote/e2ee.ts`, one function per function. Every name here maps to the
 * TypeScript one it mirrors so a reader can check them side by side.
 */
object E2ee {
    private val random = SecureRandom()

    /** `publicKeyFromB64`: strict — anything that is not exactly 32 bytes is refused. */
    fun publicKeyFromB64(b64: String): ByteArray {
        val key = B64.decode(b64) ?: throw IllegalArgumentException("Invalid public key: not base64")
        require(key.size == 32) { "Invalid public key: expected 32 bytes, got ${key.size}" }
        return key
    }

    /** `deriveSharedKey`: the STABLE per-device-pair ECDH precompute (`nacl.box.before`). */
    fun deriveSharedKey(theirPubB64: String, ourSecret: ByteArray): ByteArray =
        TweetNacl.boxBefore(publicKeyFromB64(theirPubB64), ourSecret)

    fun deriveSharedKey(theirPub: ByteArray, ourSecret: ByteArray): ByteArray =
        TweetNacl.boxBefore(theirPub, ourSecret)

    /** `randomSessionNonce`: 16 random bytes, exchanged in the handshake (NOT the 24-byte box nonce). */
    fun randomSessionNonce(): ByteArray = ByteArray(16).also(random::nextBytes)

    /**
     * `deriveSessionKey` = HKDF-SHA256(ikm = baseShared, salt = hostNonce ‖ clientNonce,
     * info = "nodeterm-relay-session-v2", L = 32). Host nonce FIRST in both roles.
     */
    fun deriveSessionKey(baseShared: ByteArray, hostNonce: ByteArray, clientNonce: ByteArray): ByteArray =
        Hkdf.sha256(
            ikm = baseShared,
            salt = hostNonce + clientNonce,
            info = "nodeterm-relay-session-v2".toByteArray(Charsets.UTF_8),
            length = 32
        )

    /** `encrypt`: `nonce(24) ‖ box.after(plain)`. */
    fun encrypt(plain: ByteArray, shared: ByteArray): ByteArray {
        val nonce = ByteArray(TweetNacl.NONCE_BYTES).also(random::nextBytes)
        return nonce + TweetNacl.secretbox(plain, nonce, shared)
    }

    /** `decrypt`: null on malformed input or a failed MAC — never throws. */
    fun decrypt(box: ByteArray, shared: ByteArray): ByteArray? {
        if (box.size < TweetNacl.NONCE_BYTES + TweetNacl.OVERHEAD_BYTES) return null
        val nonce = box.copyOfRange(0, TweetNacl.NONCE_BYTES)
        return TweetNacl.secretboxOpen(box.copyOfRange(TweetNacl.NONCE_BYTES, box.size), nonce, shared)
    }

    /**
     * `sasFromSharedKey`: SHA-512 of the BASE key (never the session key), first four bytes read
     * big-endian as an unsigned 32-bit int, mod 1,000,000, zero-padded, "NNN NNN".
     */
    fun sasFromSharedKey(shared: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-512").digest(shared)
        val n = ((h[0].toLong() and 0xff) shl 24) or
            ((h[1].toLong() and 0xff) shl 16) or
            ((h[2].toLong() and 0xff) shl 8) or
            (h[3].toLong() and 0xff)
        val code = (n % 1_000_000L).toString().padStart(6, '0')
        return "${code.substring(0, 3)} ${code.substring(3)}"
    }

    /**
     * `hostIdFromPublicKey` (relay-id.ts): base64url(sha256(raw 32-byte pub)).slice(0, 22) — the
     * relay broker room both ends register under.
     */
    fun hostIdFromPublicKey(pub: ByteArray): String =
        B64.encodeUrl(MessageDigest.getInstance("SHA-256").digest(pub)).take(22)

    fun hostIdFromPublicKeyB64(b64: String): String = hostIdFromPublicKey(publicKeyFromB64(b64))
}

/** RFC 5869 HKDF over HMAC-SHA256 (matches Node's `hkdfSync('sha256', …)`). */
object Hkdf {
    fun sha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32)) { "bad HKDF length" }
        val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            t = hmac(prk, t + info + byteArrayOf(counter.toByte()))
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        return out
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}
