package dev.nodeterm.protocol

import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * What the phone takes from the `/pair` answer about relay approval (audits A07, A07-late), and what
 * the Pair screen then says. `relayApproved` is what gates the background check's relay leg, so it
 * must be true exactly when the computer will serve this phone's relay key without its dialog: a
 * desktop that pinned the key (`relayPinned`, A07), or one that recorded it for its standing host to
 * pin on the first relay handshake (`relayApproved`, A07-late). The current desktop's real answers
 * are checked in [PairingInteropTest]; this covers the answers of desktops on either side of it.
 */
class PairingApprovalTest {
    /** Answers ONE plaintext `/pair` POST with [body] (the payload has no hostKey, so nothing is sealed). */
    private fun answer(body: String): PairingResult {
        val server = ServerSocket(0, 5, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            server.use {
                it.accept().use { sock ->
                    drain(sock.getInputStream())
                    val bytes = body.toByteArray()
                    sock.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${bytes.size}\r\n\r\n".toByteArray() + bytes)
                    sock.getOutputStream().flush()
                }
            }
        }
        val payload = PairingPayload(
            host = "127.0.0.1", port = 22, user = "u", token = "t", pairPort = server.localPort, name = "Test",
            hostKey = null, relay = null, sshAvailable = true
        )
        return runBlocking { PairingClient(readTimeoutMs = 5_000).pair(payload, "ssh-ed25519 AAAA test", "Pixel", "android-test") }
    }

    private fun drain(input: InputStream) {
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (last4 != 0x0d0a0d0a) {
            val c = input.read()
            if (c < 0) return
            head.write(c)
            last4 = (last4 shl 8) or c
        }
        val length = head.toString(Charsets.ISO_8859_1.name()).split("\r\n")
            .firstNotNullOfOrNull { if (it.startsWith("Content-Length:", true)) it.substringAfter(':').trim().toInt() else null } ?: 0
        input.readNBytes(length)
    }

    private val ok = """"ok":true,"deviceId":"dev-1","agentToken":"tok""""

    @Test
    fun `a desktop that only says relayPinned (A07) is read as approving the phone`() {
        val r = answer("""{$ok,"relayDeviceToken":"dt","relayPinned":true}""")
        assertTrue(r.relayPinned)
        assertTrue(r.relayApproved)
    }

    @Test
    fun `a key recorded but not pinned (A07-late) is approved, not pinned`() {
        val r = answer("""{$ok,"relayApproved":true}""")
        assertFalse(r.relayPinned)
        assertTrue(r.relayApproved)
    }

    @Test
    fun `an older desktop says neither, and the phone waits for the dialog`() {
        val r = answer("{$ok}")
        assertFalse(r.relayPinned)
        assertFalse(r.relayApproved)
        assertFalse(answer("""{$ok,"relayApproved":"yes"}""").relayApproved, "only a JSON true counts")
    }

    @Test
    fun `the Pair screen's sentence follows the relay leg and the approval`() {
        fun result(token: String?, pinned: Boolean = false, approved: Boolean = pinned) =
            PairingResult("d", "t", null, token, relayPinned = pinned, relayApproved = approved)
        assertEquals("Paired. This phone reaches the computer on your network.", result(null).pairedNotice())
        // Remote access was off at the scan on a current desktop: nothing to approve later.
        assertEquals(
            "Paired. This phone reaches the computer on your network, and is approved for remote access once the computer offers it.",
            result(null, approved = true).pairedNotice()
        )
        assertEquals("Paired, and approved for remote access.", result("dt", pinned = true).pairedNotice())
        assertEquals("Paired, and approved for remote access.", result("dt", approved = true).pairedNotice())
        assertEquals(
            "Paired. The first time you connect from outside your network, approve this phone on the computer.",
            result("dt").pairedNotice()
        )
    }
}
