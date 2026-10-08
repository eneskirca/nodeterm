package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.ssh.HostKeyAnchors
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyNotPairedException
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import net.schmizz.sshj.common.Buffer
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Audit A49-anchor: the computer's SSH host key fingerprints arrive in the sealed pairing answer and
 * anchor the first SSH connect. The desktop's side, the sealed exchange end to end and the connect
 * against a real SSH server are in PairingInteropTest and SshTransportTest; these are the pieces that
 * need neither node nor a server.
 */
class HostKeyAnchorsTest {
    // GitHub publishes its SSH host keys with the fingerprints OpenSSH prints for them (docs.github.com,
    // "GitHub's SSH key fingerprints"). The desktop's reader is checked against the same pair
    // (src/main/ssh-host-keys.test.ts), so both ends print what OpenSSH prints.
    private val githubEd25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
    private val githubEd25519Fp = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
    private val githubEcdsa =
        "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg="
    private val githubEcdsaFp = "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM"

    private fun key(b64: String): java.security.PublicKey {
        // sshj reads ECDSA keys through BouncyCastle, which it registers on first use of its
        // SecurityUtils (an SSHClient does it; the app registers the full provider at startup).
        check(net.schmizz.sshj.common.SecurityUtils.isBouncyCastleRegistered()) { "BouncyCastle is on the test classpath" }
        return Buffer.PlainBuffer(Base64.getDecoder().decode(b64)).readPublicKey()
    }

    @Test
    fun `sshj fingerprints a host key the way OpenSSH prints it, the form the desktop sends`() {
        assertEquals(githubEd25519Fp, SshHostConnection.fingerprint(key(githubEd25519)))
        assertEquals(githubEcdsaFp, SshHostConnection.fingerprint(key(githubEcdsa)))
        assertTrue(HostKeyAnchors.isFingerprint(githubEd25519Fp) && HostKeyAnchors.isFingerprint(githubEcdsaFp))
    }

    @Test
    fun `only well-formed fingerprints are kept, once each, at most the cap`() {
        fun parse(json: String) = HostKeyAnchors.parse(Json.parseToJsonElement(json))
        assertEquals(
            listOf(githubEd25519Fp, githubEcdsaFp),
            parse("""["$githubEd25519Fp", 7, null, "MD5:aa:bb", "SHA256:short", "sha256:${githubEcdsaFp.drop(7)}", "$githubEd25519Fp", "$githubEcdsaFp"]""")
        )
        // Not an array (or absent): none, which is what an older desktop gives.
        assertEquals(emptyList(), parse(""""$githubEd25519Fp""""))
        assertEquals(emptyList(), parse("""{"a":"$githubEd25519Fp"}"""))
        assertEquals(emptyList(), HostKeyAnchors.parse(null))
        val many = (0 until HostKeyAnchors.MAX + 5).map { "SHA256:" + it.toString().padStart(43, 'A') }
        assertEquals(many.take(HostKeyAnchors.MAX), HostKeyAnchors.parse(JsonArray(many.map(::JsonPrimitive))))
    }

    private val payload = PairingPayload.parse(
        """{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}"""
    )!!

    @Test
    fun `the paired record keeps them, and a record without them is what it was`() {
        val anchored = PairedHost.from(payload, PairingResult("dev-1", "tok", null, null, sshHostKeyFingerprints = listOf(githubEd25519Fp)), now = 5)
        assertEquals(listOf(githubEd25519Fp), anchored.sshHostKeyAnchors)
        assertEquals(null, anchored.sshHostKeyFingerprint, "nothing is pinned at pairing")
        assertEquals(anchored, PairedHost.fromJson(anchored.toJson()))
        assertEquals(JsonArray(listOf(JsonPrimitive(githubEd25519Fp))), anchored.toJson()["sshHostKeyAnchors"])

        val plain = PairedHost.from(payload, PairingResult("dev-1", "tok", null, null), now = 5)
        assertFalse("sshHostKeyAnchors" in plain.toJson(), "a pairing without keys writes the record it always wrote")
        assertEquals(plain, PairedHost.fromJson(plain.toJson()))

        // A hand-edited or damaged record keeps only what is a fingerprint.
        val edited = Json.parseToJsonElement(
            anchored.toJson().toString().replace("\"$githubEd25519Fp\"", "\"$githubEd25519Fp\",\"not-a-fingerprint\"")
        ).jsonObject
        assertEquals(listOf(githubEd25519Fp), PairedHost.fromJson(edited)!!.sshHostKeyAnchors)
    }

    @Test
    fun `a key the pairing did not name is a host key change to the fallback, with its own words`() {
        val e = HostKeyNotPairedException(listOf(githubEd25519Fp, githubEcdsaFp), "SHA256:whoever-answered")
        assertIs<HostKeyChangedException>(e)
        assertEquals("SHA256:whoever-answered", e.actual)
        val fact = e.message!!
        assertTrue(fact.contains("SHA256:whoever-answered") && fact.contains("none of the 2 keys the computer reported"), fact)
        assertTrue(fact.contains("the computer reported to this phone (when it was paired, or since through the relay)"), fact)
        // The likely causes before the alarming one, as for a changed pin.
        assertTrue(fact.indexOf("network address") in 0 until fact.indexOf("intercepting"), fact)
        assertTrue(HostKeyNotPairedException(listOf(githubEd25519Fp), "x").message!!.contains("not the key the computer reported"))

        // Auto: refused over SSH, the relay still tried, and a warning kept up.
        val auto = SshFallback.afterFailure(e, relayAllowed = true, relayConfigured = true)
        assertIs<SshFallback.Next.TryRelay>(auto)
        assertTrue(auto.warning!!.contains(fact), auto.warning)
        // "Only on my network": the hard stop.
        assertIs<SshFallback.Next.Stop>(SshFallback.afterFailure(e, relayAllowed = false, relayConfigured = true))
    }

    /**
     * The app's side of the anchors (review of A49-anchor), which only a device runs and so is pinned in
     * the source. [dev.nodeterm.protocol.ssh.HostKeyPin.anchors] has a default (none: trust on first use),
     * so an app pin that drops its override, or reads another field, still compiles, type-checks and
     * passes every protocol test, while every phone silently goes back to trust on first use.
     */
    @Test
    fun `the app's pin hands the verifier the keys its record keeps, and every SSH dial uses that pin`() {
        val connections = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "private fun pinFor(host: PairedHost, lease: HostLifetime.Lease)"),
            "graph.hosts.currentHost(host.id, host.hostKeyB64) { lifetime.isCurrent(lease) }",
            "override fun pinned(): String? = current().sshHostKeyFingerprint",
            "graph.hosts.updateCurrent(host.id, host.hostKeyB64, { lifetime.isCurrent(lease) }) { it.copy(sshHostKeyFingerprint = fingerprint) }",
            "override fun anchors(): List<String> = current().sshHostKeyAnchors"
        )
        // The paired computer's SSH dial goes through that pin, read fresh from the record each time.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "private suspend fun connectLocked(trigger: Trigger, lease: HostLifetime.Lease)"),
            "SshHostConnection.connect(",
            "host.host, host.port, host.user, graph.sshIdentity, pinFor(host, lease),"
        )
        assertEquals(1, Regex("""SshHostConnection\.connect\(""").findAll(connections).count(), "one SSH dial, the pinned one")
        // And the record carries what the sealed answer named: pairing stores PairedHost.from's record
        // as it is (a `.copy(...)` on that line could drop the anchors again).
        val pair = AppSourcePins.ui("PairScreen.kt")
        assertTrue(pair.lines().any { it.trim() == "val host = PairedHost.from(p, result)" }, "PairScreen keeps PairedHost.from's record")
        AppSourcePins.assertInOrder(pair, "val host = PairedHost.from(p, result)", "graph.hosts.publishPairing(host, previous")
        val store = AppSourcePins.app("data/HostStore.kt")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(store, "fun publishPairing("), "saveToken()", "upsert(host)")
    }

    @Test
    fun `a plaintext pairing answer's host keys are ignored`() = runBlocking<Unit> {
        // A clear answer could have been rewritten on the LAN; the desktop never sends the field there,
        // and the phone must not take it from one either.
        val answer = """{"ok":true,"deviceId":"dev-1","agentToken":"tok","sshHostKeyFingerprints":["$githubEd25519Fp"]}"""
        val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val thread = Thread {
            server.accept().use { sock ->
                val input = sock.getInputStream()
                val head = ByteArrayOutputStream()
                var last4 = 0
                while (last4 != 0x0d0a0d0a) {
                    val c = input.read()
                    if (c < 0) break
                    head.write(c)
                    last4 = (last4 shl 8) or c
                }
                val length = head.toString(Charsets.ISO_8859_1.name()).lines()
                    .firstNotNullOfOrNull { if (it.startsWith("Content-Length:", true)) it.substringAfter(':').trim().toInt() else null } ?: 0
                input.readNBytes(length)
                val body = answer.toByteArray()
                sock.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray() + body)
                sock.getOutputStream().flush()
            }
        }.apply { isDaemon = true; start() }
        try {
            val result = PairingClient(readTimeoutMs = 5_000).pair(payload.copy(host = "127.0.0.1", pairPort = server.localPort, hostKey = null), "ssh-ed25519 AAAA test", "Pixel", "android-test")
            assertEquals("dev-1", result.deviceId)
            assertEquals(emptyList(), result.sshHostKeyFingerprints)
        } finally {
            server.close()
            thread.join(5_000)
        }
    }
}
