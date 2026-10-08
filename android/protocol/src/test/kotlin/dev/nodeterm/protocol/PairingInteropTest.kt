package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingException
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.ssh.HostKeyAnchors
import dev.nodeterm.protocol.ssh.HostKeyNotPairedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.SshHostConnection
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's `/pair` exchange against the DESKTOP's real `createPairingService`
 * (src/main/pairing-service.ts), with the home dir pointed at a temp dir so the authorized_keys line
 * it writes can be inspected, and so no run pairs a test device into a real profile
 * ([InteropHarness.scratchHomeEnv]: HOME and, for Windows, USERPROFILE). Covers the E2EE-sealed
 * exchange (the QR carries `hostKey`) with and without a relay leg, on the direct-SSH path whatever OS
 * runs it (the fixture pins a non-Windows platform; audit A70).
 */
class PairingInteropTest {
    private val cleanup = ArrayList<AutoCloseable>()

    @AfterTest
    fun tearDown() = cleanup.forEach { it.close() }

    private fun start(withRelay: Boolean, env: Map<String, String> = emptyMap()): Pair<InteropHarness, File> {
        val home = Files.createTempDirectory("nt-pair-home").toFile()
        cleanup += AutoCloseable { home.deleteRecursively() }
        val h = InteropHarness.start(
            "pair",
            InteropHarness.scratchHomeEnv(home) +
                mapOf("FIXTURE_USERDATA" to home.path, "FIXTURE_RELAY" to if (withRelay) "1" else "0") + env
        )
        cleanup += h
        return h to home
    }

    @Test
    fun `pair mode refuses to start unless the home dir is the scratch dir it was given`() {
        // A70: os.homedir() reads HOME on POSIX and USERPROFILE on Windows. A caller that points the
        // wrong variable at its temp dir must fail here, before the service writes agent.json (a live
        // bearer token) and authorized_keys into whatever the real home is.
        assumeTrue(InteropHarness.available(), "node + repo node_modules (npm ci) are needed for interop tests")
        val home = Files.createTempDirectory("nt-pair-home").toFile()
        val other = Files.createTempDirectory("nt-pair-other").toFile()
        cleanup += AutoCloseable { home.deleteRecursively(); other.deleteRecursively() }
        val err = assertFailsWith<AssertionError> {
            InteropHarness.start(
                "pair",
                InteropHarness.scratchHomeEnv(home) + mapOf("FIXTURE_HOME" to other.path, "FIXTURE_USERDATA" to home.path)
            )
        }
        assertTrue(err.message.orEmpty().contains("needs os.homedir() to be FIXTURE_HOME"), err.message)
        assertTrue(home.listFiles().isNullOrEmpty() && other.listFiles().isNullOrEmpty(), "a refused start wrote files")
    }

    private fun payloadOf(h: InteropHarness): PairingPayload =
        assertNotNull(PairingPayload.parse(h.ready["payload"]!!.jsonPrimitive.content), "the desktop's QR must parse")

    @Test
    fun `an E2EE pairing installs our key under the desktop's attributable comment`() = runBlocking<Unit> {
        val (h, home) = start(withRelay = false)
        val payload = payloadOf(h)
        assertEquals(h.ready["hostPublicKeyB64"]!!.jsonPrimitive.content, payload.hostKey, "QR carries the host box key")
        assertTrue(payload.sshAvailable)
        assertNull(payload.relay)
        val identity = SshIdentity.generate()
        val result = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel Test", "android-device-1")
        assertTrue(result.deviceId.isNotBlank())
        assertTrue(result.agentToken.isNotBlank())
        assertNull(result.relayDeviceToken)
        val done = h.awaitEvent("done")
        assertEquals("true", done["ok"]!!.jsonPrimitive.content)
        val keys = File(home, ".ssh/authorized_keys").readText()
        assertTrue(
            keys.contains("ssh-ed25519 ${B64.encode(identity.publicKeyBlob)} nodeterm-mobile-${result.deviceId}"),
            "authorized_keys: $keys"
        )
        val agent = File(home, ".nodeterm/agent.json").readText()
        assertTrue(agent.contains("\"name\": \"Pixel Test\""), agent)
        assertTrue(agent.contains("\"relayDeviceId\": \"android-device-1\""), agent)
        // The fixture's host-key dir does not exist unless a test lays one out: no keys, no anchors.
        assertEquals(emptyList(), result.sshHostKeyFingerprints)
    }

    /** Writes each key as sshd's `ssh_host_<name>_key.pub` (`<type> <base64 blob> <comment>`) under a new dir. */
    private fun hostKeyDir(vararg keys: Pair<String, java.security.PublicKey>): File {
        val dir = Files.createTempDirectory("nt-etc-ssh").toFile()
        cleanup += AutoCloseable { dir.deleteRecursively() }
        for ((name, key) in keys) {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            File(dir, "ssh_host_${name}_key.pub").writeText("${KeyType.fromKey(key)} ${java.util.Base64.getEncoder().encodeToString(blob)} root@box\n")
        }
        return dir
    }

    private fun ecKey(): java.security.PublicKey =
        java.security.KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair().public

    /** A real SSH server that lets [identity] in as `dev`, and its host key. */
    private fun sshServer(identity: SshIdentity): Pair<SshServer, java.security.PublicKey> {
        val root = Files.createTempDirectory("nt-pair-sshd").toFile()
        cleanup += AutoCloseable { root.deleteRecursively() }
        val server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
        val accepted = identity.keyPair.public.encoded
        server.publickeyAuthenticator = PublickeyAuthenticator { user, key, _ -> user == "dev" && key.encoded.contentEquals(accepted) }
        server.start()
        cleanup += AutoCloseable { server.stop(true) }
        return server to server.keyPairProvider.loadKeys(null).first().public
    }

    private class Pin(private val paired: List<String>) : HostKeyPin {
        var value: String? = null
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
        override fun anchors() = paired
    }

    @Test
    fun `the sealed answer names the computer's SSH host keys, and the first connect must present one (A49-anchor)`() = runBlocking<Unit> {
        // The desktop's real pairing service reads a host-key dir laid out like /etc/ssh, holding the
        // key of a real SSH server and one more (sshd serves one of several keys per connection).
        val identity = SshIdentity.generate()
        val (sshd, serverKey) = sshServer(identity)
        val other = ecKey()
        val keys = hostKeyDir("ecdsa" to serverKey, "other" to other)
        val (h, _) = start(withRelay = false, env = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to keys.path))
        val payload = payloadOf(h)
        assertTrue(!h.ready["payload"]!!.jsonPrimitive.content.contains("SHA256:"), "the QR carries no SSH host key")
        val result = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel", "android-device-7")
        // In the form sshj reports, in the order the desktop read the files.
        val serverFp = SshHostConnection.fingerprint(serverKey)
        assertEquals(listOf(serverFp, SshHostConnection.fingerprint(other)), result.sshHostKeyFingerprints)
        val host = PairedHost.from(payload, result)
        assertEquals(result.sshHostKeyFingerprints, host.sshHostKeyAnchors)
        assertNull(host.sshHostKeyFingerprint, "nothing is pinned before a connect has authenticated")
        assertEquals(host, PairedHost.fromJson(host.toJson()), "the anchors survive the phone's own record")

        // The first connect presents a key the pairing named: it connects and pins exactly that one.
        val pin = Pin(host.sshHostKeyAnchors)
        SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, pin).close()
        assertEquals(serverFp, pin.value)

        // Had the pairing named only the other key, the same server is refused and nothing is pinned.
        val elsewhere = Pin(listOf(SshHostConnection.fingerprint(other)))
        assertFailsWith<HostKeyNotPairedException> {
            SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, elsewhere).close()
        }
        assertNull(elsewhere.value)
    }

    @Test
    fun `sealed anchors discover a served SSH key through recursive external Includes (A49-anchor)`() = runBlocking<Unit> {
        // Windows desktops advertise relay-only. This fixture models POSIX sshd paths and its
        // /etc/ssh include root with an injected scratch directory, never the machine's config.
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "POSIX sshd configuration")
        val identity = SshIdentity.generate()
        val (sshd, serverKey) = sshServer(identity)
        val root = hostKeyDir("fixture" to serverKey)
        val external = Files.createTempDirectory("nt-ssh include-").toFile()
        cleanup += AutoCloseable { external.deleteRecursively() }
        val nested = File(external, "nested").apply { mkdir() }
        val public = File(external, "custom-key.pub")
        assertTrue(File(root, "ssh_host_fixture_key.pub").renameTo(public))
        File(external, "custom-key").writeText("PRIVATE HOSTKEY SENTINEL — never read for its fingerprint\n")
        File(root, "sshd_config").writeText("Include \"${external.path}/outer*.conf\"\n")
        // Even an Include in an external file resolves its relative value under the original
        // config root, not that external file's parent directory.
        File(external, "outer.conf").writeText("Include nested/*.conf\n")
        val correctNested = File(root, "nested").apply { mkdir() }
        File(correctNested, "key.conf").writeText("HostKey \"${File(external, "custom-key").path}\"\n")
        File(nested, "wrong.conf").writeText("HostKey /no-such-fixture-key\n")

        val (h, _) = start(withRelay = false, env = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to root.path))
        val payload = payloadOf(h)
        assertTrue(!h.ready["payload"]!!.jsonPrimitive.content.contains("SHA256:"), "anchors stay inside the sealed answer")
        val paired = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel", "android-include-device")
        val expected = SshHostConnection.fingerprint(serverKey)
        assertEquals(listOf(expected), paired.sshHostKeyFingerprints)
        val host = PairedHost.from(payload, paired)
        assertEquals(listOf(expected), assertNotNull(PairedHost.fromJson(host.toJson())).sshHostKeyAnchors)
        val pin = Pin(host.sshHostKeyAnchors)
        SshHostConnection.connect("127.0.0.1", sshd.port, "dev", identity, pin).close()
        assertEquals(expected, pin.value, "the included key authenticates the phone's first SSH connect")
    }

    @Test
    fun `relative private HostKey names never add anchors through an Include (A117)`() = runBlocking<Unit> {
        assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "POSIX sshd configuration")
        val identity = SshIdentity.generate()
        val (served, servedKey) = sshServer(identity)
        val (unpaired, unpairedKey) = sshServer(identity)
        val root = hostKeyDir("fixture" to servedKey)
        val external = hostKeyDir("rogue" to unpairedKey)
        val roguePublic = File(external, "rogue.pub")
        assertTrue(File(external, "ssh_host_rogue_key.pub").renameTo(roguePublic))
        // A synthetic private-file sentinel deliberately contains a valid config directive. If
        // Include opens it, the real producer incorrectly seals the unpaired server's public key.
        // Nothing here contains or reads an actual private host key.
        val privateSentinel = File(external, "custom-host")
        privateSentinel.writeText("HostKey \"${roguePublic.path}\"\n")
        Files.createSymbolicLink(File(external, "alias.conf").toPath(), privateSentinel.toPath())
        File(root, "sshd_config").writeText("HostKey ../keys/custom-host\nInclude \"${external.path}/*\"\n")

        val (h, _) = start(withRelay = false, env = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to root.path))
        val payload = payloadOf(h)
        assertTrue(!h.ready["payload"]!!.jsonPrimitive.content.contains("SHA256:"), "anchors remain sealed")
        val paired = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel", "android-relative-key")
        val expected = SshHostConnection.fingerprint(servedKey)
        assertEquals(listOf(expected), paired.sshHostKeyFingerprints, "a private Include cannot advertise another server")
        val host = assertNotNull(PairedHost.fromJson(PairedHost.from(payload, paired).toJson()))
        assertEquals(listOf(expected), host.sshHostKeyAnchors)
        val pin = Pin(host.sshHostKeyAnchors)
        SshHostConnection.connect("127.0.0.1", served.port, "dev", identity, pin).close()
        assertEquals(expected, pin.value)
        val refused = Pin(host.sshHostKeyAnchors)
        assertFailsWith<HostKeyNotPairedException> {
            SshHostConnection.connect("127.0.0.1", unpaired.port, "dev", identity, refused).close()
        }
        assertNull(refused.value, "the excluded server must never pin")
    }

    @Test
    fun `a plaintext answer carries no SSH host keys, whatever the computer has (A49-anchor)`() = runBlocking<Unit> {
        // No `hostKey` in the QR: the phone pairs in the clear, and a clear answer could have been
        // rewritten on the LAN, so the desktop leaves the keys out of it.
        val keys = hostKeyDir("ecdsa" to ecKey())
        val (h, _) = start(withRelay = false, env = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to keys.path))
        val result = PairingClient().pair(payloadOf(h).copy(hostKey = null), SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-8")
        assertTrue(result.deviceId.isNotBlank())
        assertEquals(emptyList(), result.sshHostKeyFingerprints)
    }

    @Test
    fun `on a Windows host the fixture still pairs over the direct-SSH path`() = runBlocking<Unit> {
        // A70: on win32 the desktop pairs relay-only (no key, the QR says ssh:false; covered by
        // src/main/pairing-service.windows.test.ts), so without the fixture pinning a non-Windows
        // platform every test here that expects an SSH key would fail on Windows. The fixture and the
        // service read process.platform at call time, which FIXTURE_PROCESS_PLATFORM stands in for.
        val (h, home) = start(withRelay = false, env = mapOf("FIXTURE_PROCESS_PLATFORM" to "win32"))
        val payload = payloadOf(h)
        assertTrue(payload.sshAvailable, "the QR must offer SSH")
        val identity = SshIdentity.generate()
        val result = PairingClient().pair(payload, identity.authorizedKeysLine(), "Pixel", "android-device-6")
        assertEquals("true", h.awaitEvent("done")["ok"]!!.jsonPrimitive.content)
        assertTrue(
            File(home, ".ssh/authorized_keys").readText().contains("nodeterm-mobile-${result.deviceId}"),
            "the key must land in the scratch home's authorized_keys"
        )
    }

    @Test
    fun `with remote access on, the sealed answer carries the relay leg`() = runBlocking<Unit> {
        val (h, _) = start(withRelay = true)
        val payload = payloadOf(h)
        val relay = assertNotNull(payload.relay, "QR relay block")
        assertEquals("wss://relay.example.test", relay.relayEndpoint)
        val result = PairingClient().pair(payload, SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-2", priorDeviceToken = "old-token")
        assertEquals("device-token-xyz", result.relayDeviceToken)
        assertEquals("minted-host-id", result.relay?.hostId)
        val api = h.awaitEvent("api")
        val body = api["body"]!!.jsonObject
        assertEquals("android-device-2", body["deviceId"]!!.jsonPrimitive.content, "the backend row is keyed by OUR id")
        assertEquals("old-token", body["priorDeviceToken"]!!.jsonPrimitive.content)
        assertEquals("Pixel", body["label"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a wrong token is refused with the desktop's own words`() = runBlocking<Unit> {
        val (h, home) = start(withRelay = false)
        val forged = payloadOf(h).copy(token = "not-the-token")
        val e = assertFailsWith<PairingException> {
            PairingClient().pair(forged, SshIdentity.generate().authorizedKeysLine(), "x", "y")
        }
        assertTrue(e.message!!.contains("bad token"), e.message)
        assertTrue(!File(home, ".ssh/authorized_keys").exists())
    }

    @Test
    fun `the phone's relay key rides the sealed body and the desktop pins it`() = runBlocking<Unit> {
        // A07: approving at the scan, so the first remote connect needs nobody at the desk.
        val (h, _) = start(withRelay = true)
        val box = dev.nodeterm.protocol.crypto.BoxKeyPair.generate()
        val result = PairingClient().pair(
            payloadOf(h), SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-3", boxPublicKeyB64 = box.publicKeyB64
        )
        assertTrue(result.relayPinned)
        assertTrue(result.relayApproved)
        assertEquals(box.publicKeyB64, h.awaitEvent("pin")["pub"]!!.jsonPrimitive.content)
    }

    @Test
    fun `the desktop's largest real answer sits far below the client's response cap`() = runBlocking<Unit> {
        // A54 caps the /pair answer at PairingClient.MAX_RESPONSE_BYTES. This measures the biggest
        // answer the desktop's real service gives — sealed, with the relay leg, the pin and as many
        // SSH host keys as it sends (A49-anchor) — through a byte-counting proxy, so a desktop change
        // that grows it toward the cap is caught here.
        val keys = hostKeyDir(*Array(HostKeyAnchors.MAX + 2) { "k%02d".format(it) to ecKey() })
        val (h, _) = start(withRelay = true, env = mapOf("FIXTURE_SSH_HOST_KEY_DIR" to keys.path))
        val payload = payloadOf(h)
        val proxy = CountingProxy(payload.host, payload.pairPort)
        cleanup += proxy
        val result = PairingClient().pair(
            payload.copy(host = "127.0.0.1", pairPort = proxy.port),
            SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-5",
            boxPublicKeyB64 = BoxKeyPair.generate().publicKeyB64
        )
        assertTrue(result.relayPinned)
        assertEquals(HostKeyAnchors.MAX, result.sshHostKeyFingerprints.size, "the desktop sends at most as many keys as the phone keeps")
        val answered = proxy.awaitDownstreamBytes()
        println("[pair] the desktop's sealed answer with relay leg + pin + SSH host keys: $answered bytes, headers included")
        assertTrue(answered in 1..(PairingClient.MAX_RESPONSE_BYTES / 16).toLong(), "answer was $answered bytes")
    }

    /** Forwards one connection to [host]:[targetPort] and counts the bytes coming back. */
    private class CountingProxy(host: String, targetPort: Int) : AutoCloseable {
        private val server = ServerSocket(0, 5, InetAddress.getLoopbackAddress())
        private val downstream = AtomicLong()
        private val done = CountDownLatch(1)
        private val sockets = CopyOnWriteArrayList<Socket>()
        val port: Int get() = server.localPort

        init {
            Thread({
                try {
                    val client = server.accept().also { sockets += it }
                    val upstream = Socket(host, targetPort).also { sockets += it }
                    Thread({ pump(client.getInputStream(), upstream.getOutputStream(), null) }, "proxy-up")
                        .apply { isDaemon = true }.start()
                    pump(upstream.getInputStream(), client.getOutputStream(), downstream)
                } catch (_: IOException) {
                } finally {
                    sockets.forEach { runCatching { it.close() } }
                    done.countDown()
                }
            }, "proxy-down").apply { isDaemon = true }.start()
        }

        private fun pump(from: InputStream, to: OutputStream, count: AtomicLong?) {
            val buf = ByteArray(8192)
            try {
                while (true) {
                    val n = from.read(buf)
                    if (n < 0) break
                    to.write(buf, 0, n)
                    to.flush()
                    count?.addAndGet(n.toLong())
                }
            } catch (_: IOException) {
            }
        }

        fun awaitDownstreamBytes(): Long {
            done.await(10, TimeUnit.SECONDS)
            return downstream.get()
        }

        override fun close() {
            sockets.forEach { runCatching { it.close() } }
            server.close()
        }
    }

    @Test
    fun `without a relay leg the key is recorded, not pinned, and approved on the first relay handshake`() = runBlocking<Unit> {
        // A07-late: paired while remote access is off, the phone adopts the relay later over SSH
        // (relay.json), and its first relay connect is usually made away from the desk. The desktop's
        // real service answers what the standing host asks on that handshake, for the key this client
        // sent and for a stranger's, and again once the device is revoked.
        val box = BoxKeyPair.generate()
        val stranger = BoxKeyPair.generate()
        val (h, home) = start(
            withRelay = false,
            env = mapOf("FIXTURE_LATE_PIN_KEYS" to "${box.publicKeyB64},${stranger.publicKeyB64}")
        )
        val result = PairingClient().pair(
            payloadOf(h), SshIdentity.generate().authorizedKeysLine(), "Pixel", "android-device-4", boxPublicKeyB64 = box.publicKeyB64
        )
        assertNull(result.relayDeviceToken)
        assertTrue(!result.relayPinned)
        assertTrue(result.relayApproved, "the phone may let its background check use a relay it adopts later")
        // Not pinned at the scan: a pin is written before the answer, and `done` follows the answer.
        val first = h.await { it["event"]?.jsonPrimitive?.content in setOf("pin", "done") }
        assertEquals("done", first["event"]!!.jsonPrimitive.content)
        assertTrue(File(home, ".nodeterm/agent.json").readText().contains("\"relayBoxKey\": \"${box.publicKeyB64}\""))

        fun approved(stage: String, pub: String): Boolean = h.await {
            it["event"]?.jsonPrimitive?.content == "late-approval" &&
                it["when"]?.jsonPrimitive?.content == stage && it["pub"]?.jsonPrimitive?.content == pub
        }["approved"]!!.jsonPrimitive.content.toBooleanStrict()
        assertTrue(approved("paired", box.publicKeyB64), "the handshake from the phone's key is approved")
        assertTrue(!approved("paired", stranger.publicKeyB64), "a key no pairing recorded gets the dialog")
        assertEquals(box.publicKeyB64, h.awaitEvent("late-pin")["pub"]!!.jsonPrimitive.content)
        assertEquals(box.publicKeyB64, h.awaitEvent("revoke-relay-key")["pub"]!!.jsonPrimitive.content)
        assertTrue(!approved("revoked", box.publicKeyB64), "a revoked pairing approves nothing")
        assertTrue(!approved("revoked", stranger.publicKeyB64))
    }
}
