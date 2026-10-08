package dev.nodeterm.protocol

import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingException
import dev.nodeterm.protocol.pairing.PairingPayload
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Audit A54: the `/pair` answer comes from whatever `host:pairPort` the scanned (or linked) code
 * names, so [PairingClient] must bound it — a declared length is checked before anything is
 * allocated, a body with no length stops at the cap, and the whole exchange has a deadline that a
 * trickling server cannot outlast. Each case is a scripted server on a local socket.
 */
class PairingClientBoundsTest {
    private val cleanup = ArrayList<AutoCloseable>()

    @AfterTest
    fun tearDown() = cleanup.asReversed().forEach { runCatching { it.close() } }

    /** Accepts ONE connection, drains the request, then hands the socket to [script]. */
    private inner class ScriptedServer(private val script: ScriptedServer.(Socket) -> Unit) : AutoCloseable {
        private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        private val accepted = CopyOnWriteArrayList<Socket>()
        val port: Int get() = server.localPort
        /** Counted down when the client's end of the connection is seen closed (read hits EOF). */
        val clientClosed = CountDownLatch(1)

        init {
            cleanup += this
            Thread({
                try {
                    val sock = server.accept()
                    accepted += sock
                    sock.use {
                        drainRequest(it.getInputStream())
                        script(it)
                    }
                } catch (_: IOException) {
                    // The client hung up mid-script: expected for every refusal.
                }
            }, "pair-bounds-server").apply { isDaemon = true }.start()
        }

        /** Holds the connection open without sending more, until the client hangs up (or 10 s). */
        fun holdUntilClientCloses(sock: Socket) {
            sock.soTimeout = 10_000
            try {
                while (sock.getInputStream().read() >= 0) Unit
                clientClosed.countDown()
            } catch (_: SocketTimeoutException) {
                // The client never hung up.
            } catch (_: IOException) {
                // A reset is also the client going away.
                clientClosed.countDown()
            }
        }

        override fun close() {
            accepted.forEach { runCatching { it.close() } }
            server.close()
        }
    }

    private fun drainRequest(input: InputStream) {
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (last4 != 0x0d0a0d0a) {
            val c = input.read()
            if (c < 0) return
            head.write(c)
            last4 = (last4 shl 8) or c
        }
        val length = head.toString(Charsets.ISO_8859_1.name()).split("\r\n")
            .firstNotNullOfOrNull { line ->
                if (line.startsWith("Content-Length:", ignoreCase = true)) line.substringAfter(':').trim().toInt() else null
            } ?: 0
        var left = length
        val buf = ByteArray(4096)
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size, left))
            if (n < 0) return
            left -= n
        }
    }

    private fun payloadFor(port: Int) = PairingPayload(
        host = "127.0.0.1", port = 22, user = "u", token = "t", pairPort = port, name = "Test",
        hostKey = null, relay = null, sshAvailable = true
    )

    private fun pair(port: Int, client: PairingClient = PairingClient(readTimeoutMs = 5_000)) = runBlocking {
        client.pair(payloadFor(port), "ssh-ed25519 AAAA test", "Pixel", "android-test")
    }

    private fun Socket.send(text: String) {
        getOutputStream().write(text.toByteArray(Charsets.ISO_8859_1))
        getOutputStream().flush()
    }

    private val okBody = """{"ok":true,"deviceId":"dev-1","agentToken":"tok"}"""

    /** Every refusal the pairing screen can show must read as a sentence, never a bare token. */
    private fun assertSentence(e: PairingException) {
        val msg = e.message!!
        assertEquals(msg, PairingException.userMessage(e), "PairScreen shows a PairingException's message as it is")
        assertTrue(msg.length > 40 && msg.trim().endsWith("."), "not a sentence: $msg")
    }

    @Test
    fun `a huge declared length is refused before anything is allocated`() {
        // Int.MAX_VALUE used to be `ByteArray(length)` = OutOfMemoryError; the two longer ones did
        // not parse as an Int and fell through to an unbounded read-to-EOF.
        for (declared in listOf("2147483647", "99999999999", "99999999999999999999999999", "65537")) {
            val srv = ScriptedServer { sock ->
                sock.send("HTTP/1.1 200 OK\r\nContent-Length: $declared\r\n\r\n$okBody")
                holdUntilClientCloses(sock)
            }
            val started = System.nanoTime()
            val e = assertFailsWith<PairingException>("Content-Length $declared") { pair(srv.port) }
            val tookMs = (System.nanoTime() - started) / 1_000_000
            assertTrue(e.message!!.contains("larger than any pairing answer"), e.message)
            assertTrue(e.message!!.contains("64 KiB"), e.message)
            assertSentence(e)
            assertTrue(tookMs < 3_000, "refused from the header, not after a read timeout (${tookMs} ms)")
        }
    }

    @Test
    fun `a negative or non-numeric length is refused with a sentence, not the bare number`() {
        // A negative length used to reach PairScreen as NegativeArraySizeException's message: "-1".
        val negative = ScriptedServer { sock -> sock.send("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n$okBody") }
        val e = assertFailsWith<PairingException> { pair(negative.port) }
        assertNotEquals("-1", e.message)
        assertTrue(e.message!!.contains("negative length (-1 bytes)"), e.message)
        assertSentence(e)

        // Not a number at all used to be read as "no length" — and paired on a body RFC 9112 calls
        // an unrecoverable framing error.
        val garbage = ScriptedServer { sock -> sock.send("HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\n$okBody") }
        val g = assertFailsWith<PairingException> { pair(garbage.port) }
        assertTrue(g.message!!.contains("not a number"), g.message)
        assertSentence(g)
    }

    @Test
    fun `a body with no Content-Length stops at the cap instead of reading until EOF`() {
        // Writes until the client hangs up; the 32 MiB bound only keeps a regressed client from
        // reading forever. The deadline is set far away so the CAP is what has to stop it.
        val srv = ScriptedServer { sock ->
            sock.send("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n")
            val chunk = ByteArray(8 * 1024) { 'x'.code.toByte() }
            val out = sock.getOutputStream()
            repeat(32 * 1024 * 1024 / chunk.size) { out.write(chunk) }
        }
        val started = System.nanoTime()
        val e = assertFailsWith<PairingException> { pair(srv.port, PairingClient(readTimeoutMs = 5_000, deadlineMs = 30_000)) }
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue(e.message!!.contains("ran past 64 KiB"), e.message)
        assertSentence(e)
        assertTrue(tookMs < 5_000, "stopped by the cap, not by a timeout (${tookMs} ms)")
    }

    @Test
    fun `an answer exactly at the cap is still read, with or without a length`() {
        // The boundary is inclusive: pad a real answer with JSON whitespace to exactly 64 KiB.
        val padded = okBody + " ".repeat(PairingClient.MAX_RESPONSE_BYTES - okBody.length)
        assertEquals(PairingClient.MAX_RESPONSE_BYTES, padded.toByteArray().size)
        val withLength = ScriptedServer { sock ->
            sock.send("HTTP/1.1 200 OK\r\nContent-Length: ${padded.length}\r\n\r\n$padded")
        }
        assertEquals("dev-1", pair(withLength.port).deviceId)
        val toEof = ScriptedServer { sock -> sock.send("HTTP/1.1 200 OK\r\n\r\n$padded") }
        assertEquals("dev-1", pair(toEof.port).deviceId)
    }

    @Test
    fun `a server that trickles bytes is cut off at the overall deadline`() {
        // One byte every 100 ms never trips the 5 s per-read timeout; only the deadline can end
        // this. The server gives up after 10 s so a regressed client fails instead of hanging.
        val srv = ScriptedServer { sock ->
            sock.send("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (System.nanoTime() < until) {
                sock.send(" ")
                Thread.sleep(100)
            }
        }
        val started = System.nanoTime()
        val e = assertFailsWith<PairingException> {
            pair(srv.port, PairingClient(readTimeoutMs = 5_000, deadlineMs = 1_500))
        }
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue(e.message!!.contains("did not finish answering within 2 seconds"), e.message)
        assertSentence(e)
        assertTrue(tookMs in 1_400..4_500, "cut off by the 1.5 s deadline, not the 5 s read timeout (${tookMs} ms)")
    }

    @Test
    fun `cancelling the caller closes the socket so a blocked read returns at once`() {
        // A silent server: the client is parked in a read. Cancellation alone cannot unblock it;
        // closing the socket can. Without that the call outlives its caller by the read timeout.
        val holder = ScriptedServer { sock -> holdUntilClientCloses(sock) }
        val started = System.nanoTime()
        assertFailsWith<TimeoutCancellationException> {
            runBlocking {
                withTimeout(500) {
                    PairingClient(readTimeoutMs = 5_000, deadlineMs = 30_000)
                        .pair(payloadFor(holder.port), "ssh-ed25519 AAAA test", "Pixel", "android-test")
                }
            }
        }
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue(tookMs < 3_000, "returned with its caller, not after the 5 s read timeout (${tookMs} ms)")
        assertTrue(holder.clientClosed.await(3, TimeUnit.SECONDS), "the server saw the phone hang up")
    }

    @Test
    fun `a refusal body is shown as one bounded line`() {
        // The desktop's own refusals are one plain sentence and reach the screen unchanged.
        val desktop = "remote access is off on the computer. On Windows the phone connects only through remote access."
        val plain = ScriptedServer { sock -> sock.send("HTTP/1.1 409 Conflict\r\nContent-Length: ${desktop.length}\r\n\r\n$desktop") }
        assertEquals("The computer rejected pairing: $desktop", assertFailsWith<PairingException> { pair(plain.port) }.message)

        // Whatever else answers on the pairing port may send anything: line breaks, escape
        // sequences, pages of text. The screen gets one line, cut at the cap.
        val hostile = "line one\r\n\u001b[31mred\u001b[0m\tand " + "x".repeat(10_000)
        val bytes = hostile.toByteArray(Charsets.UTF_8)
        val noisy = ScriptedServer { sock ->
            sock.send("HTTP/1.1 403 Forbidden\r\nContent-Length: ${bytes.size}\r\n\r\n")
            sock.getOutputStream().write(bytes)
            sock.getOutputStream().flush()
        }
        val msg = assertFailsWith<PairingException> { pair(noisy.port) }.message!!
        assertTrue(msg.startsWith("The computer rejected pairing: line one [31mred [0m and xxx"), msg)
        assertTrue(msg.none { it.isISOControl() }, "control characters reached the screen")
        assertTrue(msg.endsWith("…"), msg)
        assertEquals("The computer rejected pairing: ".length + PairingException.MAX_REFUSAL_CHARS + 1, msg.length)

        // Nothing printable left: the status code, not an empty quote.
        val blank = ScriptedServer { sock -> sock.send("HTTP/1.1 403 Forbidden\r\nContent-Length: 3\r\n\r\n\r\n\u0007") }
        assertEquals("The computer rejected pairing (HTTP 403).", assertFailsWith<PairingException> { pair(blank.port) }.message)
    }

    @Test
    fun `anything that is not a PairingException is framed as a sentence`() {
        val framed = PairingException.userMessage(NegativeArraySizeException("-1"))
        assertEquals("Pairing failed unexpectedly (NegativeArraySizeException: -1). Scan the code again.", framed)
        assertEquals(
            "Pairing failed unexpectedly (IllegalStateException). Scan the code again.",
            PairingException.userMessage(IllegalStateException())
        )
        assertEquals("The computer rejected pairing: bad token", PairingException.userMessage(PairingException("The computer rejected pairing: bad token")))
    }
}
