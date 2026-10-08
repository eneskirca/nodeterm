package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.RelayBlock
import dev.nodeterm.protocol.pairing.RelayPairingProof
import dev.nodeterm.protocol.pairing.RelayPairingProof.Outcome
import dev.nodeterm.protocol.pairing.SshIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.i2p.crypto.eddsa.EdDSAEngine
import java.security.MessageDigest
import kotlin.test.*

/** Real Ed25519 signing with an inert RPC boundary; actual host producer interop is separate. */
class RelayPairingProofTest {
    private val pairingId = "f65a1d12-2577-4190-b528-9cdf9e7bcc35"
    private val challengeId = "79ee12c7-f537-4536-a150-11d093d87f96"
    private val hostKey = B64.encode(ByteArray(32) { 3 })
    private val peerKey = B64.encode(ByteArray(32) { 7 })
    private val seed = ByteArray(32) { it.toByte() }
    private val identity = SshIdentity.fromSeed(seed)
    private val host = PairedHost(pairingId, "Synthetic desktop", "192.0.2.1", 22, "fixture", true,
        hostKey, RelayBlock("fixture-host", hostKey, "wss://relay.nodeterm.dev"), null, 1)

    private fun context(record: PairedHost = host, pinned: String = hostKey, peer: String = peerKey,
        read: () -> ByteArray? = { seed.copyOf() }, current: () -> Unit = {}) =
        RelayPairingProof.Context(record, pinned, peer, read, current)

    private fun challenge(vararg overrides: Pair<String, JsonElement>): JsonObject {
        val fields = buildJsonObject {
            put("version", 1); put("challengeId", challengeId); put("pairingId", pairingId)
            put("hostPublicKeyB64", hostKey); put("peerPublicKeyB64", peerKey)
            put("sshPublicKeyB64", B64.encode(identity.publicKeyBytes)); put("nonceB64", B64.encode(ByteArray(32) { 9 }))
            put("expiresAtMs", 61_000)
        }.toMutableMap().apply { putAll(overrides) }
        return buildJsonObject { put("status", "challenge"); put("challenge", JsonObject(fields)) }
    }

    private fun status(value: String) = buildJsonObject { put("status", value) }

    @Test fun `proof signs the exact domain-separated challenge with the retained Ed25519 identity`() = runBlocking {
        val calls = mutableListOf<Pair<String, JsonObject>>()
        val result = RelayPairingProof.afterApprovedListing(context(), rpc = { method, params ->
            calls += method to params
            if (method == RelayPairingProof.CHALLENGE_METHOD) challenge() else {
                assertEquals(setOf("challengeId", "signatureB64"), params.keys)
                assertEquals(JsonPrimitive(challengeId), params["challengeId"])
                val signature = B64.decode((params["signatureB64"] as JsonPrimitive).content)!!
                assertEquals(64, signature.size)
                val expected = listOf("nodeterm-relay-pairing-v1", "1", challengeId, pairingId, hostKey,
                    peerKey, B64.encode(identity.publicKeyBytes), B64.encode(ByteArray(32) { 9 }), "61000", "").joinToString("\n").toByteArray()
                val verifier = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
                verifier.initVerify(identity.keyPair.public); verifier.update(expected)
                assertTrue(verifier.verify(signature), "Only the exact retained SSH public key may verify this proof")
                status("associated")
            }
        }, now = { 1_000 })
        assertEquals(Outcome.ASSOCIATED, result)
        assertEquals(listOf(RelayPairingProof.CHALLENGE_METHOD, RelayPairingProof.PROOF_METHOD), calls.map { it.first })
        assertEquals(buildJsonObject { put("pairingId", pairingId) }, calls.first().second)
    }

    @Test fun `challenge never overrides captured pairing host relay peer or retained SSH public key`() = runBlocking {
        val wrong = B64.encode(ByteArray(32) { 4 })
        val changes = listOf("pairingId" to JsonPrimitive(challengeId), "hostPublicKeyB64" to JsonPrimitive(wrong),
            "peerPublicKeyB64" to JsonPrimitive(wrong), "sshPublicKeyB64" to JsonPrimitive(wrong))
        for (change in changes) {
            var proofs = 0
            val result = RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
                if (method == RelayPairingProof.PROOF_METHOD) proofs++
                challenge(change)
            }, now = { 1_000 })
            assertEquals(Outcome.UNPROVABLE, result, change.first); assertEquals(0, proofs, change.first)
        }
    }

    @Test fun `strict wire types UUIDs canonical padding nonce and safe expiry refuse signing`() = runBlocking {
        val invalid = listOf(
            "version" to JsonPrimitive("1"), "version" to JsonPrimitive(2),
            "challengeId" to JsonPrimitive(challengeId.uppercase()), "challengeId" to JsonPrimitive("arbitrary\nidentifier"),
            "pairingId" to JsonPrimitive("not-a-uuid"),
            "hostPublicKeyB64" to JsonPrimitive(hostKey.trimEnd('=')),
            "peerPublicKeyB64" to JsonPrimitive(" $peerKey"),
            "sshPublicKeyB64" to JsonPrimitive(B64.encode(ByteArray(31))),
            "nonceB64" to JsonPrimitive(B64.encode(ByteArray(33))),
            "nonceB64" to JsonPrimitive("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="),
            "expiresAtMs" to JsonPrimitive("61000"), "expiresAtMs" to JsonPrimitive(1_000),
            "expiresAtMs" to JsonPrimitive(0), "expiresAtMs" to JsonPrimitive(9_007_199_254_740_992L),
        )
        for (field in invalid) {
            var proofs = 0
            val result = RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
                if (method == RelayPairingProof.PROOF_METHOD) proofs++
                challenge(field)
            }, now = { 1_000 })
            assertEquals(Outcome.UNPROVABLE, result, field.toString()); assertEquals(0, proofs, field.toString())
        }
        assertNull(RelayPairingProof.parseChallenge(challenge(), context(), identity.publicKeyBytes, -1))
    }

    @Test fun `host expiry does not require the phone clock to share the hosts exact TTL origin`() = runBlocking {
        var proofs = 0
        assertEquals(Outcome.ASSOCIATED, RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
            if (method == RelayPairingProof.CHALLENGE_METHOD) challenge() else { proofs++; status("associated") }
        }, now = { 900 }))
        assertEquals(1, proofs, "The host, which consumes the proof once, enforces its monotonic sixty-second deadline")
    }

    @Test fun `manual unpinned conflicting and invalid pairing contexts never read or create identity`() = runBlocking {
        val wrong = B64.encode(ByteArray(32) { 6 })
        val cases = listOf(context(host.copy(manual = true)), context(host.copy(hostKeyB64 = null)),
            context(host.copy(hostKeyB64 = wrong)), context(host.copy(relay = host.relay!!.copy(hostPublicKeyB64 = wrong))),
            context(host.copy(id = "legacy-invalid-id")), context(pinned = "not-a-key"), context(peer = "not-a-key"))
        for (case in cases) {
            var reads = 0; var calls = 0
            val captured = context(case.host, case.pinnedHostKeyB64, case.peerPublicKeyB64, read = { reads++; seed })
            assertEquals(Outcome.UNPROVABLE, RelayPairingProof.afterApprovedListing(captured, rpc = { _, _ -> calls++; challenge() }, now = { 1_000 }))
            assertEquals(0, reads); assertEquals(0, calls)
        }
    }

    @Test fun `missing wrong-sized or unavailable retained seed stays unprovable without any RPC`() = runBlocking {
        for (read in listOf<() -> ByteArray?>({ null }, { ByteArray(31) }, { throw IllegalStateException("Synthetic unavailable secret") })) {
            var calls = 0
            assertEquals(Outcome.UNPROVABLE, RelayPairingProof.afterApprovedListing(context(read = read), rpc = { _, _ -> calls++; challenge() }, now = { 1_000 }))
            assertEquals(0, calls)
        }
    }

    @Test fun `terminal host statuses never send a proof or repeat the challenge`() = runBlocking {
        for ((name, expected) in listOf("associated" to Outcome.ASSOCIATED, "unprovable" to Outcome.UNPROVABLE,
            "gone" to Outcome.GONE, "conflict" to Outcome.CONFLICT, "expired" to Outcome.EXPIRED)) {
            val calls = mutableListOf<String>()
            assertEquals(expected, RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ -> calls += method; status(name) }, now = { 1_000 }))
            assertEquals(listOf(RelayPairingProof.CHALLENGE_METHOD), calls)
        }
    }

    @Test fun `old host and unacknowledged proof preserve browsing without replaying a write`() = runBlocking {
        var calls = 0
        assertEquals(Outcome.UNPROVABLE, RelayPairingProof.afterApprovedListing(context(), rpc = { _, _ -> calls++; throw HostException("Unknown method") }, now = { 1_000 }))
        assertEquals(1, calls)
        var proofs = 0
        assertEquals(Outcome.UNPROVABLE, RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
            if (method == RelayPairingProof.CHALLENGE_METHOD) challenge() else { proofs++; throw HostException("Synthetic lost acknowledgement") }
        }, now = { 1_000 }))
        assertEquals(1, proofs)
    }

    @Test fun `malformed challenge and unknown or negative proof response never report association`() = runBlocking {
        for (body in listOf<JsonElement?>(null, JsonPrimitive(true), buildJsonObject { put("status", "challenge") }, status("unsupported"))) {
            var calls = 0
            assertEquals(Outcome.UNPROVABLE, RelayPairingProof.afterApprovedListing(context(), rpc = { _, _ -> calls++; body }, now = { 1_000 }))
            assertEquals(1, calls)
        }
        for ((name, expected) in listOf("gone" to Outcome.GONE, "conflict" to Outcome.CONFLICT, "expired" to Outcome.EXPIRED, "unknown" to Outcome.UNPROVABLE)) {
            assertEquals(expected, RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
                if (method == RelayPairingProof.CHALLENGE_METHOD) challenge() else status(name)
            }, now = { 1_000 }))
        }
    }

    @Test fun `retired lifetime after challenge before signing or after proof always propagates cancellation`() = runBlocking {
        for (retireAt in listOf(1, 2)) {
            var current = true; var calls = 0
            val captured = context(current = { if (!current) throw CancellationException("Synthetic retired pairing") })
            assertFailsWith<CancellationException> {
                RelayPairingProof.afterApprovedListing(captured, rpc = { _, _ ->
                    calls++; if (calls == retireAt) current = false
                    if (calls == 1) challenge() else status("associated")
                }, now = { 1_000 })
            }
            assertEquals(retireAt, calls)
        }
    }

    @Test fun `final current check after signing prevents a stale proof write`() = runBlocking {
        var checks = 0; var proofs = 0
        assertFailsWith<CancellationException> {
            RelayPairingProof.afterApprovedListing(context(current = { if (++checks == 4) throw CancellationException("Synthetic retired while signing") }), rpc = { method, _ ->
                if (method == RelayPairingProof.PROOF_METHOD) proofs++
                challenge()
            }, now = { 1_000 })
        }
        assertEquals(4, checks); assertEquals(0, proofs)
    }

    @Test fun `expiry between verification and submission refuses the proof`() = runBlocking {
        var clockReads = 0; var proofs = 0
        assertEquals(Outcome.EXPIRED, RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
            if (method == RelayPairingProof.PROOF_METHOD) proofs++
            challenge()
        }, now = { if (++clockReads == 1) 1_000 else 61_000 }))
        assertEquals(0, proofs)
    }

    @Test fun `internal deadline bounds an unanswered challenge without failing approved browsing`() = runBlocking {
        var cancelled = false
        val result = withTimeoutOrNull(500) {
            RelayPairingProof.afterApprovedListing(context(), rpc = { _, _ ->
                try { awaitCancellation() } finally { cancelled = true }
            }, timeoutMs = 25)
        }
        assertEquals(Outcome.UNPROVABLE, result, "The internal deadline must finish before this bounded test window")
        assertTrue(cancelled)
    }

    @Test fun `outer cancellation propagates and releases a suspended proof without a retry`() = runBlocking {
        val pending = CompletableDeferred<Unit>(); var calls = 0; var cancelled = false
        val job = async {
            assertFailsWith<CancellationException> {
                RelayPairingProof.afterApprovedListing(context(), rpc = { method, _ ->
                    calls++
                    if (method == RelayPairingProof.CHALLENGE_METHOD) challenge() else {
                        pending.complete(Unit)
                        try { awaitCancellation() } finally { cancelled = true }
                    }
                }, now = { 1_000 })
            }
        }
        pending.await(); job.cancelAndJoin()
        assertEquals(2, calls); assertTrue(cancelled)
    }

    @Test fun `outer timeout is not mistaken for the optional migration deadline`() = runBlocking<Unit> {
        assertFailsWith<CancellationException> {
            withTimeout(20) { RelayPairingProof.afterApprovedListing(context(), rpc = { _, _ -> awaitCancellation() }, timeoutMs = 500) }
        }
    }

}
