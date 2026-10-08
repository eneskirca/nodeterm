package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.E2ee
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.ssh.HostKeyAnchors
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

class PairingException(message: String) : Exception(message) {
    companion object {
        /**
         * What the pairing screen shows for a failed [PairingClient.pair]: a PairingException's own
         * sentence as it is, and anything else framed as one — a bare exception message can be a
         * lone token (audit A54: a negative Content-Length used to reach the screen as "-1").
         */
        fun userMessage(e: Throwable): String {
            val own = e.message?.trim().orEmpty()
            if (e is PairingException && own.isNotEmpty()) return own
            val detail = if (own.isNotEmpty()) "${e.javaClass.simpleName}: ${own.take(200)}" else e.javaClass.simpleName
            return "Pairing failed unexpectedly ($detail). Scan the code again."
        }

        /** The longest refusal text from the computer shown on the pairing screen. The desktop's
         *  own refusals are one sentence (under 200 characters); the endpoint is whatever the
         *  pairing payload names, so what it sends is untrusted and must not fill the screen. */
        const val MAX_REFUSAL_CHARS = 300

        /** A non-2xx body as the pairing screen may show it: control characters dropped (a line
         *  break or an escape sequence has no business in a one-line error), whitespace collapsed,
         *  and cut at [MAX_REFUSAL_CHARS]. Empty when nothing printable is left. */
        fun refusalText(body: String): String {
            val flat = body.map { if (it.isISOControl() || it == '\u2028' || it == '\u2029') ' ' else it }
                .joinToString("").trim().replace(Regex("\\s+"), " ")
            return if (flat.length <= MAX_REFUSAL_CHARS) flat else flat.take(MAX_REFUSAL_CHARS).trimEnd() + "…"
        }
    }
}

/**
 * The phone side of `src/main/pairing-service.ts`'s `/pair` listener.
 *
 * Request body `{token, publicKey, deviceName, deviceId, priorDeviceToken?, boxPublicKey?}`.
 * `boxPublicKey` (the phone's persistent relay identity) is sent ONLY inside the sealed body; a
 * desktop that knows it pins it on its standing host (`relayPinned: true`, audit A07), or records it
 * to pin on the phone's first relay handshake when the pairing had no relay leg (A07-late), and
 * answers `relayApproved: true` either way, so the first relay connect needs no approval at the desk
 * even after a late adoption. An older desktop ignores it. When the QR carried a
 * `hostKey`, the whole body is sealed to it — `{epk: <ephemeral box pubkey>, box: base64(nonce ‖
 * secretbox)}` under `box.before(hostKey, ephemeralSecret)` — and the answer comes back sealed the
 * same way, so the relay device token never crosses the LAN in the clear. A sealed answer may also
 * name the computer's SSH host keys (`sshHostKeyFingerprints`, audit A49-anchor), which the first SSH
 * connect is then checked against; a plaintext answer's are ignored.
 *
 * Spoken over a RAW TCP socket rather than an HTTP client, like the iOS app: a bare-IP `http://`
 * URL is cleartext traffic Android's network security policy blocks by default for HTTP stacks,
 * and the desktop frames every response with an explicit Content-Length precisely so a minimal
 * reader works (pairing-service.ts `send`). A non-2xx body is plain text meant for the user.
 *
 * The endpoint is whatever `host:pairPort` the payload names, and a `nodeterm://pair` link from any
 * web page can supply one, so the answer is read as untrusted (audit A54): its size is capped at
 * [MAX_RESPONSE_BYTES] whether or not it declares a Content-Length, and the whole exchange —
 * connect included — is bounded by [deadlineMs]. Every refusal is a [PairingException] whose
 * message is a sentence, because PairScreen shows the message as it is.
 */
class PairingClient(
    private val connectTimeoutMs: Int = 8_000,
    /** Bounds SILENCE only: a server that trickles a byte at a time never trips it. */
    private val readTimeoutMs: Int = 20_000,
    /** Bounds the whole exchange. Enforced by closing the socket, the one thing that unblocks a read. */
    private val deadlineMs: Long = DEFAULT_DEADLINE_MS
) {
    companion object {
        /**
         * Largest header block or body accepted. The desktop's biggest real answer — the sealed
         * `{box}` around `{ok, deviceId, agentToken, relay, relayDeviceToken, relayPinned, relayApproved,
         * sshHostKeyFingerprints}` with the most host keys it sends (16) — measured 1,803 bytes, headers
         * included, with the interop fixture's short relay token (634 without the host keys;
         * PairingInteropTest counts it through a proxy and fails past 4 KiB). 64 KiB is also the
         * cap the desktop puts on the request it reads from us (pairing-service.ts `MAX_BODY_BYTES`).
         */
        const val MAX_RESPONSE_BYTES = 64 * 1024

        /**
         * The desktop's slowest honest answer waits behind an in-flight revoke (8 s) and then a
         * relay-device mint (8 s) before it replies; 45 s leaves room for a slow network on top.
         */
        const val DEFAULT_DEADLINE_MS = 45_000L

        private const val SCAN_AGAIN =
            "Make sure the code came from nodeterm on your computer, then scan it again."
    }

    suspend fun pair(
        payload: PairingPayload,
        sshPublicKeyLine: String,
        deviceName: String,
        deviceId: String,
        priorDeviceToken: String? = null,
        boxPublicKeyB64: String? = null
    ): PairingResult = withContext(Dispatchers.IO) {
        val inner = buildJsonObject {
            put("token", payload.token)
            put("publicKey", sshPublicKeyLine)
            put("deviceName", deviceName)
            put("deviceId", deviceId)
            priorDeviceToken?.let { put("priorDeviceToken", it) }
            // Only ever sealed: a plaintext body could be rewritten on the LAN, and the desktop
            // ignores the field there anyway.
            if (payload.hostKey != null) boxPublicKeyB64?.let { put("boxPublicKey", it) }
        }.toString()

        var shared: ByteArray? = null
        val body = if (payload.hostKey != null) {
            val eph = BoxKeyPair.generate()
            val key = E2ee.deriveSharedKey(payload.hostKey, eph.secretKey)
            shared = key
            buildJsonObject {
                put("epk", eph.publicKeyB64)
                put("box", B64.encode(E2ee.encrypt(inner.toByteArray(Charsets.UTF_8), key)))
            }.toString()
        } else {
            inner
        }

        val (status, text) = exchange(payload.host, payload.pairPort, "/pair", body)
        if (status !in 200..299) {
            val said = PairingException.refusalText(text)
            throw PairingException(
                if (said.isNotEmpty()) "The computer rejected pairing: $said"
                else "The computer rejected pairing (HTTP $status)."
            )
        }
        var obj = J.obj(J.parse(text)) ?: throw PairingException("The computer answered with something that is not JSON.")
        if (shared != null) {
            val sealed = obj.s("box")?.let(B64::decode)
                ?: throw PairingException("The computer's answer was not encrypted as expected.")
            val plain = E2ee.decrypt(sealed, shared)
                ?: throw PairingException("Couldn't decrypt the computer's answer — was the QR code from this computer?")
            obj = J.obj(J.parse(String(plain, Charsets.UTF_8)))
                ?: throw PairingException("The computer's answer was not valid JSON.")
        }
        if (obj.b("ok") != true) throw PairingException("The computer did not confirm the pairing.")
        val pinned = obj.b("relayPinned") == true
        // Only from the sealed answer (A49-anchor): a plaintext one could have been rewritten on the
        // LAN, and the desktop never puts the field there.
        val sshHostKeys = if (shared != null) HostKeyAnchors.parse(obj["sshHostKeyFingerprints"]) else emptyList()
        PairingResult(
            deviceId = obj.s("deviceId") ?: throw PairingException("The computer did not assign a device id."),
            agentToken = obj.s("agentToken") ?: "",
            relay = obj.o("relay")?.let(PairingPayload::parseRelayBlock),
            relayDeviceToken = obj.s("relayDeviceToken"),
            relayPinned = pinned,
            // A desktop from before A07-late answers only `relayPinned`, which implies it.
            relayApproved = pinned || obj.b("relayApproved") == true,
            sshHostKeyFingerprints = sshHostKeys
        )
    }

    /**
     * One POST under the overall deadline. A watchdog closes the socket when [deadlineMs] runs out
     * — and when the caller is cancelled (PairScreen left), since cancellation alone does not
     * unblock a thread parked in a socket read.
     */
    private suspend fun exchange(host: String, port: Int, path: String, body: String): Pair<Int, String> = coroutineScope {
        val sock = Socket()
        val expired = AtomicBoolean(false)
        // UNDISPATCHED: the `try` is entered before the socket is used, so even a cancellation that
        // lands before the watchdog would otherwise have been scheduled still closes the socket.
        val watchdog = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                delay(deadlineMs)
                expired.set(true)
            } finally {
                runCatching { sock.close() }
            }
        }
        try {
            postRaw(sock, host, port, path, body)
        } catch (e: IOException) {
            ensureActive() // the caller walked away: report that, not a network failure
            if (expired.get()) {
                throw PairingException(
                    "The computer at $host:$port did not finish answering within ${seconds(deadlineMs)}, " +
                        "so pairing stopped. Check that the phone is on the same network and the pairing code " +
                        "is still on screen, then scan it again."
                )
            }
            throw PairingException(
                "Couldn't reach the computer at $host:$port (${e.message ?: e.javaClass.simpleName}). " +
                    "Is the phone on the same network, and is the pairing code still on screen?"
            )
        } finally {
            watchdog.cancel()
        }
    }

    private fun seconds(ms: Long): String {
        val n = (ms + 999) / 1000
        return if (n == 1L) "1 second" else "$n seconds"
    }

    private fun postRaw(sock: Socket, host: String, port: Int, path: String, body: String): Pair<Int, String> {
        val bytes = body.toByteArray(Charsets.UTF_8)
        sock.use {
            sock.connect(InetSocketAddress(host, port), connectTimeoutMs)
            sock.soTimeout = readTimeoutMs
            val hostHeader = if (host.contains(':')) "[$host]:$port" else "$host:$port"
            val head = "POST $path HTTP/1.1\r\n" +
                "Host: $hostHeader\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            val out = sock.getOutputStream()
            out.write(head.toByteArray(Charsets.US_ASCII))
            out.write(bytes)
            out.flush()
            return readResponse(sock.getInputStream())
        }
    }

    /**
     * Minimal HTTP/1.1 response reader: status line, headers, then a Content-Length (or EOF) body,
     * each capped at [MAX_RESPONSE_BYTES]. A declared length is checked BEFORE anything is
     * allocated for it: a negative one used to surface as the bare "-1" of a
     * NegativeArraySizeException, and a huge one (or none, with an endless body) as an
     * OutOfMemoryError that took the app down.
     */
    internal fun readResponse(input: InputStream): Pair<Int, String> {
        val headBytes = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val c = input.read()
            if (c < 0) break
            headBytes.write(c)
            last4 = (last4 shl 8) or c
            if (last4 == 0x0d0a0d0a) break
            if (headBytes.size() > MAX_RESPONSE_BYTES) {
                throw PairingException("The computer's answer had more than 64 KiB of headers, so pairing stopped. $SCAN_AGAIN")
            }
        }
        val head = headBytes.toString(Charsets.ISO_8859_1.name())
        val lines = head.split("\r\n")
        val status = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull()
            ?: throw IOException("malformed HTTP response")
        val declared = lines.drop(1).firstNotNullOfOrNull { line ->
            val idx = line.indexOf(':')
            if (idx > 0 && line.substring(0, idx).trim().equals("content-length", ignoreCase = true)) {
                line.substring(idx + 1).trim()
            } else null
        }
        val body = if (declared != null) {
            val length = declaredLength(declared)
            val buf = ByteArray(length)
            var off = 0
            while (off < length) {
                val n = input.read(buf, off, length - off)
                if (n < 0) break
                off += n
            }
            buf.copyOf(off)
        } else {
            readToEof(input)
        }
        return status to String(body, Charsets.UTF_8)
    }

    /** A Content-Length value, refused with a sentence unless it is a count from 0 to the cap. */
    private fun declaredLength(raw: String): Int {
        val n = raw.toLongOrNull()
        return when {
            n != null && n < 0 -> throw PairingException(
                "The computer's answer declared a negative length ($n bytes), so pairing stopped. $SCAN_AGAIN"
            )
            n != null && n > MAX_RESPONSE_BYTES -> tooLarge("it declared $n bytes")
            n != null -> n.toInt()
            // Too many digits for a Long is still a length, just an absurd one.
            raw.isNotEmpty() && raw.all { it in '0'..'9' } -> tooLarge("it declared a ${raw.length}-digit length")
            else -> throw PairingException(
                "The computer's answer declared a length that is not a number, so pairing stopped. $SCAN_AGAIN"
            )
        }
    }

    private fun tooLarge(what: String): Nothing = throw PairingException(
        "The computer's answer is larger than any pairing answer ($what; the limit is 64 KiB), so pairing stopped. $SCAN_AGAIN"
    )

    /** No Content-Length: read to EOF, but never past the cap. */
    private fun readToEof(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(8 * 1024)
        while (true) {
            val n = input.read(chunk)
            if (n < 0) return out.toByteArray()
            out.write(chunk, 0, n)
            if (out.size() > MAX_RESPONSE_BYTES) {
                throw PairingException(
                    "The computer's answer ran past 64 KiB without ending, so pairing stopped. $SCAN_AGAIN"
                )
            }
        }
    }
}
