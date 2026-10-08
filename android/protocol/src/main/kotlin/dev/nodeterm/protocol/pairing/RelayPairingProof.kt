package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.model.PairedHost
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import net.i2p.crypto.eddsa.EdDSAEngine
import java.security.MessageDigest

/** Optional legacy association, only on a relay that just served an approved listing. No identity
 * is created and no unacknowledged proof is replayed. Browsing does not depend on migration. */
object RelayPairingProof {
    const val CHALLENGE_METHOD = "pairing.relayKeyChallengeV1"
    const val PROOF_METHOD = "pairing.relayKeyProofV1"
    const val TIMEOUT_MS = 3_000L
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

    class Context(
        val host: PairedHost,
        val pinnedHostKeyB64: String,
        val peerPublicKeyB64: String,
        /** Reads an existing encrypted SSH seed. Must never get-or-create an identity. */
        val retainedSshSeed: () -> ByteArray?,
        /** The originating connection/paired-record lifetime, checked outside network awaits. */
        val requireCurrent: () -> Unit,
    )

    enum class Outcome { ASSOCIATED, UNPROVABLE, GONE, CONFLICT, EXPIRED }

    data class Challenge(
        val challengeId: String,
        val pairingId: String,
        val hostPublicKeyB64: String,
        val peerPublicKeyB64: String,
        val sshPublicKeyB64: String,
        val nonceB64: String,
        val expiresAtMs: Long,
    ) {
        /** Matches src/shared/relay-pairing-proof.ts including the final newline. */
        fun signingBytes(): ByteArray = listOf("nodeterm-relay-pairing-v1", "1", challengeId,
            pairingId, hostPublicKeyB64, peerPublicKeyB64, sshPublicKeyB64, nonceB64,
            expiresAtMs.toString(), "").joinToString("\n").toByteArray(Charsets.UTF_8)
    }

    private fun text(obj: JsonObject, name: String): String? =
        (obj[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun canonicalKey(text: String): ByteArray? {
        if (text.length != 44) return null
        return B64.decode(text)?.takeIf { it.size == 32 && B64.encode(it) == text }
    }

    /** Strict types, encoding and safe host expiry. The host enforces its own monotonic TTL;
     * comparing its full 60-second window to the phone clock would reject slight clock skew. */
    fun parseChallenge(body: JsonElement?, context: Context, sshPublicKey: ByteArray, now: Long): Challenge? {
        val obj = (body as? JsonObject)?.takeIf { text(it, "status") == "challenge" }?.get("challenge") as? JsonObject ?: return null
        val version = obj["version"] as? JsonPrimitive ?: return null
        if (version.isString || version.intOrNull != 1) return null
        val challengeId = text(obj, "challengeId")?.takeIf(UUID::matches) ?: return null
        val pairingId = text(obj, "pairingId")?.takeIf { UUID.matches(it) && it == context.host.id } ?: return null
        val host = text(obj, "hostPublicKeyB64")?.takeIf { canonicalKey(it) != null && it == context.pinnedHostKeyB64 } ?: return null
        val peer = text(obj, "peerPublicKeyB64")?.takeIf { canonicalKey(it) != null && it == context.peerPublicKeyB64 } ?: return null
        val ssh = text(obj, "sshPublicKeyB64") ?: return null
        val rawSsh = canonicalKey(ssh) ?: return null
        if (!MessageDigest.isEqual(rawSsh, sshPublicKey)) return null
        val nonce = text(obj, "nonceB64")?.takeIf { canonicalKey(it) != null } ?: return null
        val expiry = obj["expiresAtMs"] as? JsonPrimitive ?: return null
        val expires = expiry.takeUnless { it.isString }?.longOrNull ?: return null
        if (now < 0 || expires <= now || expires > MAX_SAFE_INTEGER) return null
        return Challenge(challengeId, pairingId, host, peer, ssh, nonce, expires)
    }

    private fun status(body: JsonElement?): Outcome? = when ((body as? JsonObject)?.let { text(it, "status") }) {
        "associated" -> Outcome.ASSOCIATED
        "unprovable" -> Outcome.UNPROVABLE
        "gone" -> Outcome.GONE
        "conflict" -> Outcome.CONFLICT
        "expired" -> Outcome.EXPIRED
        else -> null
    }

    suspend fun afterApprovedListing(
        context: Context,
        rpc: suspend (String, JsonObject) -> JsonElement?,
        now: () -> Long = System::currentTimeMillis,
        timeoutMs: Long = TIMEOUT_MS,
    ): Outcome {
        suspend fun current() {
            currentCoroutineContext().ensureActive()
            context.requireCurrent()
        }
        try {
            return withTimeoutOrNull(timeoutMs) {
                current()
                val host = context.host
                if (host.manual || !UUID.matches(host.id) || canonicalKey(context.pinnedHostKeyB64) == null ||
                    host.hostKeyB64 != context.pinnedHostKeyB64 || host.relayHostKeyB64 != context.pinnedHostKeyB64 ||
                    canonicalKey(context.peerPublicKeyB64) == null) return@withTimeoutOrNull Outcome.UNPROVABLE
                val seed = context.retainedSshSeed()?.takeIf { it.size == 32 } ?: return@withTimeoutOrNull Outcome.UNPROVABLE
                val identity = SshIdentity.fromSeed(seed)
                current()
                val body = rpc(CHALLENGE_METHOD, buildJsonObject { put("pairingId", host.id) })
                current()
                status(body)?.let { return@withTimeoutOrNull it }
                val challenge = parseChallenge(body, context, identity.publicKeyBytes, now())
                    ?: return@withTimeoutOrNull Outcome.UNPROVABLE
                val signer = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
                signer.initSign(identity.keyPair.private)
                signer.update(challenge.signingBytes())
                val signature = B64.encode(signer.sign())
                current()
                if (now() >= challenge.expiresAtMs) return@withTimeoutOrNull Outcome.EXPIRED
                val answer = rpc(PROOF_METHOD, buildJsonObject {
                    put("challengeId", challenge.challengeId)
                    put("signatureB64", signature)
                })
                current()
                status(answer) ?: Outcome.UNPROVABLE
            } ?: Outcome.UNPROVABLE
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Missing verbs, unavailable Keystore and lost acknowledgements are all optional.
            return Outcome.UNPROVABLE
        }
    }
}
