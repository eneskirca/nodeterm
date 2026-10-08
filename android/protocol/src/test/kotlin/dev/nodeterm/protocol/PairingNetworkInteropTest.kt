package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.ssh.LanRefresh
import dev.nodeterm.protocol.ssh.LanReport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Actual desktop adapter policy → QR builder / LAN reporter → Android parsers and refresh policy.
 * The Node fixture explicitly replaces the OS interface table, not the payload or report. The
 * pairing answer below supplies inert authentication facts at the already-authenticated boundary;
 * HTTP pairing and the encrypted relay handshake have their own Pairing/RelayInteropTest coverage.
 */
class PairingNetworkInteropTest {
    private fun fixture(check: (JsonObject, String) -> Unit) {
        val root = Files.createTempDirectory("nt-pairing-network").toFile()
        try {
            val keys = File(root, "keys").apply { mkdir() }
            // A public-only synthetic SSH key, in the exact sshd .pub wire format. No SSH service.
            val bytes = ByteArrayOutputStream().also { output ->
                DataOutputStream(output).use { data ->
                    val algorithm = "ssh-ed25519".toByteArray(Charsets.US_ASCII)
                    data.writeInt(algorithm.size); data.write(algorithm)
                    data.writeInt(32); data.write(ByteArray(32) { (it + 1).toByte() })
                }
            }.toByteArray()
            File(keys, "ssh_host_ed25519_key.pub").writeText("ssh-ed25519 ${B64.encode(bytes)} fixture\n")
            val expected = "SHA256:" + B64.encode(MessageDigest.getInstance("SHA-256").digest(bytes)).trimEnd('=')
            InteropHarness.start("pairing-network", mapOf("FIXTURE_USERDATA" to root.path,
                "FIXTURE_SSH_HOST_KEY_DIR" to keys.path)).use { check(it.ready, expected) }
        } finally { root.deleteRecursively() }
    }

    private fun cases(ready: JsonObject): Map<String, JsonObject> =
        ready["cases"]!!.jsonArray.map { it.jsonObject }.associateBy { it["name"]!!.jsonPrimitive.content }

    private fun payload(case: JsonObject): PairingPayload =
        assertNotNull(PairingPayload.parse(case["payload"]!!.jsonPrimitive.content), "actual desktop QR must parse")

    private fun report(case: JsonObject): LanReport = assertNotNull(LanReport.parse(case["lan"]))

    @Test
    fun `selected adapter QR and relay report follow DHCP and a changed selection from one live reporter`() = fixture { ready, fingerprint ->
        val cases = cases(ready)
        for ((name, expected) in listOf("selected" to "192.168.1.42", "dhcp-moved" to "192.168.1.77",
            "selection-changed" to "10.7.0.2", "automatic-physical" to "192.168.1.42",
            "automatic-virtual-only" to "10.7.0.2")) {
            val case = cases.getValue(name)
            assertEquals(expected, payload(case).host, name)
            assertEquals(expected, report(case).host, "same policy for the QR and reporter: $name")
            assertEquals(listOf(fingerprint), report(case).sshHostKeyFingerprints, "public anchors are independent of the adapter")
        }
        val choices = cases.getValue("selected")["choices"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("docker0", "wg0", "wlan0"), choices.map { it["interfaceName"]!!.jsonPrimitive.content })
        assertFalse(choices.any { it["address"]!!.jsonPrimitive.content.startsWith("127.") })
    }

    @Test
    fun `authenticated LAN adoption changes only the dial address retaining paired host identity and SSH pins`() = fixture { ready, fingerprint ->
        val cases = cases(ready)
        val qr = payload(cases.getValue("selected"))
        val paired = PairingResult("fixture-device", "inert-agent-token", qr.relay, "inert-device-token",
            relayPinned = true, relayApproved = true, sshHostKeyFingerprints = listOf(fingerprint))
        val initial = PairedHost.from(qr, paired, now = 1234).copy(sshHostKeyFingerprint = fingerprint)
        val listing = ProjectsSnapshot.EMPTY.copy(fetchedAt = 2000, lan = report(cases.getValue("dhcp-moved")))
        assertNull(LanRefresh.afterListing(initial, TransportKind.SSH, listing, refusedHostKey = null), "SSH cannot authenticate its own address report")
        val change = assertNotNull(LanRefresh.afterListing(initial, TransportKind.RELAY, listing, refusedHostKey = null))
        assertEquals(initial.copy(host = "192.168.1.77"), change.host)
        assertTrue(change.addressChanged)
        assertNull(change.confirmedKey, "a DHCP change does not reset authentication")
        assertEquals(fingerprint, change.host.sshHostKeyFingerprint)
        assertEquals(initial, change.previous)
        assertEquals(change.host, PairedHost.fromJson(change.host.toJson()), "normal persisted host retains all identity and pin fields")
        assertEquals("fixture-device", change.host.id)
        assertEquals(qr.hostKey, change.host.hostKeyB64)
        assertEquals(qr.relay, change.host.relay)
    }

    @Test
    fun `a missing selected adapter emits no replacement address despite another usable VPN and Docker network`() = fixture { ready, fingerprint ->
        val cases = cases(ready)
        val missing = cases.getValue("selected-missing")
        assertEquals(JsonNull, missing["payload"], "pairing cannot advertise the wrong adapter")
        assertNull(missing["lan"]!!.jsonObject["host"], "the reporter omits an unknown selected address")
        assertEquals(listOf(fingerprint), report(missing).sshHostKeyFingerprints)
        val paired = PairedHost.from(payload(cases.getValue("selected")),
            PairingResult("fixture-device", "inert-agent-token", null, "inert-device-token",
                sshHostKeyFingerprints = listOf(fingerprint)), now = 1234).copy(sshHostKeyFingerprint = fingerprint)
        assertNull(LanRefresh.afterListing(paired, TransportKind.RELAY,
            ProjectsSnapshot.EMPTY.copy(fetchedAt = 2000, lan = report(missing)), refusedHostKey = null))
        assertEquals("192.168.1.42", paired.host)
        assertEquals(fingerprint, paired.sshHostKeyFingerprint)
    }

    @Test
    fun `Windows QR route hints require a current eligible address and cannot override explicit adapter selection`() = fixture { ready, _ ->
        val windows = ready["windows"]!!.jsonObject
        for ((name, expected) in listOf("currentRoute" to "192.168.1.99", "staleRoute" to "192.168.1.42",
            "explicitAdapter" to "10.7.0.2")) {
            val qr = assertNotNull(PairingPayload.parse(windows[name]!!.jsonPrimitive.content))
            assertEquals(expected, qr.host, name)
            assertFalse(qr.sshAvailable, "Windows is still relay-only")
            assertNotNull(qr.relay)
        }
        assertEquals(JsonNull, windows["lan"], "Windows has no direct SSH leg to refresh")
    }

    @Test
    fun `network interop bundles the actual adapter policy QR builder and LAN reporter`() = fixture { _, _ ->
        val inputs = Json.parseToJsonElement(InteropHarness.bundleMeta.readText()).jsonObject["inputs"]!!.jsonObject.keys
        for (source in listOf("src/shared/pairing-network.ts", "src/main/pairing-core.ts", "src/main/remote/host-lan-report.ts"))
            assertTrue(source in inputs, "actual producer is missing: $source")
    }
}
