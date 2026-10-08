package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.LanRefresh
import dev.nodeterm.protocol.ssh.LanReport
import dev.nodeterm.protocol.ssh.SshHostConnection
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import org.apache.sshd.certificate.OpenSshCertificateBuilder
import org.apache.sshd.common.NamedFactory
import org.apache.sshd.common.config.keys.OpenSshCertificate
import org.apache.sshd.common.keyprovider.HostKeyCertificateProvider
import org.apache.sshd.common.keyprovider.KeyPairProvider
import org.apache.sshd.common.signature.Signature
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import java.security.KeyPairGenerator
import java.security.PublicKey
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

/**
 * Review of A74-refresh: a computer whose sshd offers a host certificate (`HostCertificate`). sshj
 * negotiates the certificate whenever the server offers one, and the phone used to pin the
 * CERTIFICATE's own fingerprint: a key the desktop never reports (it reads the plain `.pub` files), so
 * every relay report seemed to say the key had changed, and a certificate reissued for the same key
 * would have been a changed key. The pin is the key the certificate certifies, which is also how
 * OpenSSH fingerprints a certificate. Against a real MINA sshd that presents the certificate.
 */
class HostCertificatePinTest {
    private val servers = ArrayList<SshServer>()
    private val identity = SshIdentity.generate()
    private val hostKeys = net.i2p.crypto.eddsa.KeyPairGenerator().generateKeyPair()
    private val ca = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()

    /** What the desktop reports for this computer: the plain key, from its `.pub` file. */
    private val reportedFp = SshHostConnection.fingerprint(hostKeys.public)

    @AfterTest
    fun tearDown() {
        servers.forEach { it.stop(true) }
    }

    private fun certificate(serial: Long): OpenSshCertificate =
        OpenSshCertificateBuilder.hostCertificate().publicKey(hostKeys.public).serial(serial).id("box-$serial")
            .principals(listOf("127.0.0.1")).validAfter(0L).validBefore(-1L).sign(ca)

    /** An sshd that presents [cert] for its host key and lets the phone in as `dev`. */
    private fun server(cert: OpenSshCertificate): Int {
        val server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = KeyPairProvider.wrap(hostKeys)
        server.hostKeyCertificateProvider = HostKeyCertificateProvider { listOf(cert) }
        // MINA 2.14 names the CERTIFICATE algorithm inside the key-exchange signature, where OpenSSH's
        // sshd (and what sshj expects) names the plain one: sshj otherwise refuses with "Expected
        // 'ssh-ed25519' key algorithm, but got: ssh-ed25519-cert-v01@openssh.com" (measured). Make the
        // test server say what sshd says.
        server.signatureFactories = server.signatureFactories.map { f ->
            object : NamedFactory<Signature> {
                override fun getName(): String = f.name
                override fun create(): Signature {
                    val s = f.create()
                    return object : Signature by s {
                        override fun getSshAlgorithmName(algo: String): String =
                            s.getSshAlgorithmName(algo).replace("-cert-v01@openssh.com", "")
                    }
                }
            }
        }
        val accepted = identity.keyPair.public.encoded
        server.publickeyAuthenticator = PublickeyAuthenticator { user, key, _ -> user == "dev" && key.encoded.contentEquals(accepted) }
        server.start()
        servers += server
        return server.port
    }

    private class MemoryPin(var value: String? = null, private val paired: List<String> = emptyList()) : HostKeyPin {
        var pinCalls = 0
        override fun pinned(): String? = value
        override fun pin(fingerprint: String) {
            pinCalls++
            value = fingerprint
        }
        override fun anchors(): List<String> = paired
    }

    private fun connect(port: Int, pin: HostKeyPin) = SshHostConnection.connect("127.0.0.1", port, "dev", identity, pin).close()

    /** What sshj hands a host-key verifier from this server, fingerprinted as the phone did before this review. */
    private fun certificateOwnFingerprint(port: Int): String {
        var seen: String? = null
        val client = SSHClient()
        client.addHostKeyVerifier(object : HostKeyVerifier {
            override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                seen = SshHostConnection.fingerprint(key)
                return false
            }
            override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
        })
        runCatching { client.connect("127.0.0.1", port) }
        runCatching { client.disconnect() }
        return seen ?: error("the server presented no host key")
    }

    @Test
    fun `a host certificate is pinned as the key it certifies, which is the key the computer reports`() {
        val port = server(certificate(1))
        val ownFp = certificateOwnFingerprint(port)
        assertNotEquals(reportedFp, ownFp, "the server presents a certificate, not the plain key")

        // Anchored to what the pairing named: the plain key.
        val anchored = MemoryPin(paired = listOf(reportedFp))
        connect(port, anchored)
        assertEquals(reportedFp, anchored.value)
        // Trust on first use (an older desktop, or a computer added by its SSH address, whose screen
        // compares the pin with `ssh-keygen -lf` of the plain `.pub`): the same key.
        val tofu = MemoryPin()
        connect(port, tofu)
        assertEquals(reportedFp, tofu.value)

        // A relay report names the plain key, which is the pin: nothing to drop, nothing to say.
        val record = PairedHost(
            id = "dev-1", name = "Box", host = "192.168.1.5", port = 22, user = "dev", sshAvailable = true,
            hostKeyB64 = null, relay = null, sshHostKeyFingerprint = anchored.value, pairedAt = 1,
            sshHostKeyAnchors = listOf(reportedFp)
        )
        assertNull(LanRefresh.apply(record, LanReport(null, listOf(reportedFp)), refusedHostKey = null))
    }

    @Test
    fun `a certificate reissued for the same key is not a changed key`() {
        val pin = MemoryPin(paired = listOf(reportedFp))
        connect(server(certificate(1)), pin)
        assertEquals(reportedFp, pin.value)
        // The computer's sshd now presents a renewed certificate (another serial, another signature).
        val renewed = server(certificate(2))
        connect(renewed, pin)
        assertEquals(reportedFp, pin.value)
        assertEquals(1, pin.pinCalls, "a connect that matched the pin pins nothing again")
    }

    @Test
    fun `a pin an older build took from the certificate itself still connects, and is re-spelled as the key`() {
        val port = server(certificate(1))
        val legacy = MemoryPin(value = certificateOwnFingerprint(port), paired = listOf(reportedFp))
        connect(port, legacy)
        assertEquals(reportedFp, legacy.value, "the same key, now named as the computer names it")
        // Another server's certificate never matches a pin by its own fingerprint.
        val stranger = MemoryPin(value = "SHA256:" + "A".repeat(43))
        val refused = assertFailsWith<HostKeyChangedException> { connect(port, stranger) }
        assertEquals(reportedFp, refused.actual, "a refused certificate is named by its key, as the computer would report it")
        assertEquals("SHA256:" + "A".repeat(43), stranger.value)
    }

    @Test
    fun `a certificate is named by its key, and a plain key by itself`() {
        val cert = com.hierynomus.sshj.userauth.certificate.Certificate.getBuilder<PublicKey>().publicKey(hostKeys.public).build()
        assertEquals(reportedFp, SshHostConnection.hostKeyFingerprint(cert))
        assertEquals(reportedFp, SshHostConnection.hostKeyFingerprint(hostKeys.public))
    }
}
