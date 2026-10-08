package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import net.i2p.crypto.eddsa.EdDSAPrivateKey
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.KeyPair
import java.security.SecureRandom

/**
 * The phone's SSH identity: an Ed25519 key generated ON the device. Pairing sends only the public
 * half (`ssh-ed25519 AAAA… comment`), which the desktop appends to `~/.ssh/authorized_keys` under
 * its own `nodeterm-ios-<deviceId>` comment (pairing-core.ts `rewriteKeyComment` — the comment the
 * phone sends is replaced, so the Android comment here is cosmetic). The private seed never leaves
 * the phone; the app keeps it encrypted under an Android Keystore key.
 */
class SshIdentity private constructor(val seed: ByteArray) {
    private val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
    private val privateSpec = EdDSAPrivateKeySpec(seed, spec)

    /** The raw 32-byte public point A. */
    val publicKeyBytes: ByteArray = privateSpec.a.toByteArray()

    val keyPair: KeyPair
        get() = KeyPair(EdDSAPublicKey(EdDSAPublicKeySpec(privateSpec.a, spec)), EdDSAPrivateKey(privateSpec))

    /** OpenSSH wire blob: string("ssh-ed25519") ‖ string(A). */
    val publicKeyBlob: ByteArray
        get() {
            val out = ByteArrayOutputStream()
            DataOutputStream(out).use { d ->
                val name = "ssh-ed25519".toByteArray(Charsets.US_ASCII)
                d.writeInt(name.size)
                d.write(name)
                d.writeInt(publicKeyBytes.size)
                d.write(publicKeyBytes)
            }
            return out.toByteArray()
        }

    fun authorizedKeysLine(comment: String = "nodeterm-android"): String =
        "ssh-ed25519 ${B64.encode(publicKeyBlob)} $comment"

    companion object {
        fun generate(random: SecureRandom = SecureRandom()): SshIdentity = SshIdentity(ByteArray(32).also(random::nextBytes))

        fun fromSeed(seed: ByteArray): SshIdentity {
            require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
            return SshIdentity(seed.copyOf())
        }
    }
}
