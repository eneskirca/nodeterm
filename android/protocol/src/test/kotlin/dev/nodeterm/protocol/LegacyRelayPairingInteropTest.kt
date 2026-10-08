package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.host.RelayApprovalRequiredException
import dev.nodeterm.protocol.host.RelayApprovalRefusedException
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.RelayConnector
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.RelayPairingProof
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.relay.OkHttpRelayTransport
import dev.nodeterm.protocol.relay.RelaySocket
import dev.nodeterm.protocol.relay.RelaySocketListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import net.i2p.crypto.eddsa.EdDSAEngine
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Real producer/client proof across sealed pairing, encrypted approved relay, attributed public
 * SSH key and guarded host publication. The public pin adapter and SAS decision are fixture seams. */
class LegacyRelayPairingInteropTest {
    private val homes = ArrayList<File>()
    private val harnesses = ArrayList<InteropHarness>()

    @AfterTest fun clean() {
        harnesses.forEach { it.close() }
        homes.forEach { it.deleteRecursively() }
    }

    private fun start(extra: Map<String, String> = emptyMap()): InteropHarness {
        val home = Files.createTempDirectory("nt-legacy-interop-").toFile().also { homes += it }
        return InteropHarness.start("legacy-pairing", InteropHarness.scratchHomeEnv(home) +
            mapOf("FIXTURE_USERDATA" to home.path) + extra).also { harnesses += it }
    }

    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content

    private suspend fun pair(h: InteropHarness, identity: SshIdentity, box: BoxKeyPair? = null, again: Boolean = false): PairedHost {
        val raw = if (again) {
            h.command("start-pair")
            h.awaitEvent("legacy-pair-ready").str("payload")
        } else h.ready.str("payload")
        // The fake OS advertises a synthetic LAN address. Only this fixture's HTTP dial is
        // redirected to loopback; the real sealed exchange and retained host identity remain.
        val payload = assertNotNull(PairingPayload.parse(raw)).copy(host = "127.0.0.1")
        val result = PairingClient().pair(payload, identity.authorizedKeysLine(), "Fixture phone", "fixture-phone",
            boxPublicKeyB64 = box?.publicKeyB64)
        assertEquals("true", h.awaitEvent("legacy-paired").str("ok"))
        assertEquals(box != null, result.relayPinned)
        return assertNotNull(PairedHost.fromJson(PairedHost.from(payload, result).toJson()))
    }

    private fun context(host: PairedHost, box: BoxKeyPair, seed: () -> ByteArray?) =
        RelayPairingProof.Context(host, assertNotNull(host.hostKeyB64), box.publicKeyB64, seed) {}

    private suspend fun connect(h: InteropHarness, box: BoxKeyPair, proof: RelayPairingProof.Context? = null,
        room: String = "subject", requireApproved: Boolean = false,
        statuses: MutableList<RelayConnectStatus>? = null) = RelayConnector.connect(
        relayUrl = h.ready.str("relayUrl"), token = "client-$room", deviceKeys = box,
        hostPublicKeyB64 = h.ready.str("hostPublicKeyB64"), legacyPairing = proof,
        approvalPollMs = 50, approvalTimeoutMs = 2_000, requireApproved = requireApproved,
        onStatus = { statuses?.add(it) })

    private fun state(h: InteropHarness): JsonObject {
        h.command("state")
        return h.awaitEvent("legacy-state")
    }

    private fun association(state: JsonObject, id: String): String? = state["devices"]!!.jsonArray
        .map { it.jsonObject }.single { it.str("id") == id }["relayBoxKey"]?.jsonPrimitive?.content

    private suspend fun provenPairing(sharedKey: Boolean) {
        val h = start()
        val identity = SshIdentity.generate()
        val subject = BoxKeyPair.generate()
        val other = if (sharedKey) subject else BoxKeyPair.generate()
        val legacy = pair(h, identity)
        val sibling = pair(h, identity, other, again = true)
        val before = state(h)
        assertEquals(null, association(before, legacy.id))
        assertEquals(other.publicKeyB64, association(before, sibling.id))
        val unaffected = connect(h, other, room = "other")
        try {
            var seedReads = 0
            val connected = connect(h, subject, context(legacy, subject) { seedReads++; identity.seed.copyOf() })
            try {
                assertEquals(1, seedReads, "only the retained identity is used")
                assertTrue(connected.first.projects.isNotEmpty())
                val migrated = state(h)
                assertEquals(subject.publicKeyB64, association(migrated, legacy.id))
                assertEquals(other.publicKeyB64, association(migrated, sibling.id))
                assertTrue(migrated["killed"]!!.jsonArray.isEmpty(), "association never revokes a key")
                assertEquals(RelayPairingProof.Outcome.ASSOCIATED,
                    connected.connection.proveLegacyPairing(context(legacy, subject) { identity.seed.copyOf() }))
                h.command("revoke:${legacy.id}")
                val revoked = h.awaitEvent("legacy-revoked")["result"]!!.jsonObject
                assertEquals(if (sharedKey) "retained" else "ok", revoked.str("relay"))
                val after = h.awaitEvent("legacy-state")
                assertEquals(listOf(sibling.id), after["devices"]!!.jsonArray.map { it.jsonObject.str("id") })
                assertEquals(listOf(other.publicKeyB64), after["pins"]!!.jsonArray.map { it.jsonPrimitive.content })
                assertEquals(if (sharedKey) emptyList() else listOf(subject.publicKeyB64),
                    after["killed"]!!.jsonArray.map { it.jsonPrimitive.content })
                val live = after["live"]!!.jsonArray.map { it.jsonObject }
                assertEquals("true", live.single { it.str("room") == "other" }.str("approved"))
                assertEquals(sharedKey.toString(), live.single { it.str("room") == "subject" }.str("approved"))
                assertTrue(unaffected.connection.listProjects().projects.isNotEmpty(), "another approved session survives")
                if (sharedKey) assertTrue(connected.connection.listProjects().projects.isNotEmpty())
            } finally { connected.connection.close() }
        } finally { unaffected.connection.close() }
    }

    @Test fun `retained SSH proof repairs a legacy entry and revoke cuts only its key (A118)`() = runBlocking {
        provenPairing(sharedKey = false)
    }

    @Test fun `a proven key authorized by another pairing remains retained on revoke (A118)`() = runBlocking {
        provenPairing(sharedKey = true)
    }

    @Test fun `a different retained SSH identity cannot associate but browsing continues (A118)`() = runBlocking {
        val h = start()
        val host = pair(h, SshIdentity.generate())
        val box = BoxKeyPair.generate()
        val wrong = SshIdentity.generate()
        val connected = connect(h, box, context(host, box) { wrong.seed.copyOf() })
        try {
            assertTrue(connected.first.projects.isNotEmpty())
            assertEquals(null, association(state(h), host.id))
        } finally { connected.connection.close() }
    }

    @Test fun `an older host refuses migration without preventing approved browsing (A118)`() = runBlocking {
        val h = start(mapOf("FIXTURE_LEGACY_UNSUPPORTED" to "1"))
        val identity = SshIdentity.generate()
        val host = pair(h, identity)
        val box = BoxKeyPair.generate()
        val connected = connect(h, box, context(host, box) { identity.seed.copyOf() })
        try {
            assertTrue(connected.first.projects.isNotEmpty())
            assertEquals(null, association(state(h), host.id))
        } finally { connected.connection.close() }
    }

    @Test fun `an unapproved encrypted session never reads the retained identity (A118)`() = runBlocking {
        val h = start(mapOf("FIXTURE_LEGACY_APPROVE" to "0"))
        val identity = SshIdentity.generate()
        val host = pair(h, identity)
        val box = BoxKeyPair.generate()
        var reads = 0
        assertFailsWith<RelayApprovalRequiredException> {
            connect(h, box, context(host, box) { reads++; identity.seed.copyOf() }, requireApproved = true)
        }
        assertEquals(0, reads)
        val after = state(h)
        assertEquals(null, association(after, host.id))
        assertTrue(after["pins"]!!.jsonArray.isEmpty())
        assertFalse(after["live"]!!.jsonArray.any { it.jsonObject.str("approved") == "true" })
    }

    @Test fun `encrypted proof rejects a wrong signature and consumes it only on its owning session (A118)`() = runBlocking {
        val h = start()
        val identity = SshIdentity.generate()
        val host = pair(h, identity)
        val box = BoxKeyPair.generate()
        suspend fun socket(room: String): RelaySocket {
            val ready = CompletableDeferred<Unit>()
            val socket = RelaySocket(h.ready.str("relayUrl"), "client-$room", box, h.ready.str("hostPublicKeyB64"),
                OkHttpRelayTransport.factory(), object : RelaySocketListener {
                    override fun onReady(sas: String) { ready.complete(Unit) }
                    override fun onClosed(reason: String?) { ready.completeExceptionally(AssertionError("fixture connection closed")) }
                })
            try { withTimeout(3_000) { ready.await() }; socket.call("projects.list"); return socket }
            catch (e: Throwable) { socket.close(); throw e }
        }
        val subject = socket("subject")
        val other = socket("other")
        fun signature(challenge: RelayPairingProof.Challenge, signer: SshIdentity): String {
            val engine = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
            engine.initSign(signer.keyPair.private)
            engine.update(challenge.signingBytes())
            return B64.encode(engine.sign())
        }
        suspend fun challenge() = assertNotNull(RelayPairingProof.parseChallenge(subject.call(
            RelayPairingProof.CHALLENGE_METHOD, buildJsonObject { put("pairingId", host.id) }),
            context(host, box) { identity.seed.copyOf() }, identity.publicKeyBytes, System.currentTimeMillis()))
        suspend fun submit(socket: RelaySocket, challenge: RelayPairingProof.Challenge, signer: SshIdentity) =
            assertNotNull(socket.call(RelayPairingProof.PROOF_METHOD, buildJsonObject {
                put("challengeId", challenge.challengeId); put("signatureB64", signature(challenge, signer))
            })).jsonObject.str("status")
        try {
            val held = challenge()
            assertEquals("unprovable", submit(other, held, identity), "a second session cannot consume another session's proof")
            assertEquals("unprovable", submit(subject, held, SshIdentity.generate()), "a validly encoded foreign signature is refused")
            assertEquals(null, association(state(h), host.id))
            assertEquals("unprovable", submit(subject, held, identity), "a failed signature consumes the challenge")
            val fresh = challenge()
            assertEquals("associated", submit(subject, fresh, identity))
            assertEquals(box.publicKeyB64, association(state(h), host.id))
        } finally { subject.close(); other.close() }
    }

    @Test fun `a socket closed during optional migration is never handed off as connected (A118)`() = runBlocking {
        val h = start(mapOf("FIXTURE_LEGACY_CLOSE_DURING_PROOF" to "1", "FIXTURE_LEGACY_APPROVE_AFTER_MS" to "500"))
        val identity = SshIdentity.generate()
        val host = pair(h, identity)
        val box = BoxKeyPair.generate()
        var returned: RelayConnector.Connected? = null
        val statuses = ArrayList<RelayConnectStatus>()
        try {
            val error = assertFailsWith<HostException> {
                // Socket close resumes pending RPCs before its listener callback. Unconfined
                // dispatch exercises that ordering instead of relying on callback timing.
                withContext(Dispatchers.Unconfined) {
                    returned = connect(h, box, context(host, box) { identity.seed.copyOf() }, statuses = statuses)
                }
            }
            assertTrue(statuses.any { it is RelayConnectStatus.AwaitingApproval }, "the human approval wait was actually displayed")
            assertFalse(error is RelayApprovalRefusedException, "a network close after proved approval is not Deny")
            h.awaitEvent("legacy-mid-proof-close")
            assertEquals(null, association(state(h), host.id))
        } finally { returned?.connection?.close() }
    }
}
