package dev.nodeterm.protocol.relay

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.E2ee
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A duplex relay connection: text frames carry the plaintext handshake, binary frames E2EE boxes. */
interface RelayTransport {
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
    /** Bytes handed to the socket and not yet flushed — the backpressure signal. */
    fun queuedBytes(): Long
    fun close()
}

/** Inbound side of a [RelayTransport]. The transport must call these in wire order, one at a time. */
interface RelayTransportEvents {
    fun onText(text: String)
    fun onBinary(bytes: ByteArray)
    /** Fired at most once, on a close OR an error. */
    fun onClosed(reason: String?)
}

fun interface RelayTransportFactory {
    fun open(url: String, events: RelayTransportEvents): RelayTransport
}

/** What an application layer sees of a live relay session. */
interface RelaySocketListener {
    /** The E2EE handshake completed. `sas` is the 6-digit code the desktop shows beside the approval. */
    fun onReady(sas: String) {}
    /** A one-way host → phone notification (`canvas:state` today). */
    fun onNotify(method: String, params: JsonElement?) {}
    /** A decoded terminal frame. */
    fun onFrame(frame: Frame) {}
    /** The connection dropped on its own (never fired for [RelaySocket.close]). */
    fun onClosed(reason: String?) {}
}

open class RpcException(message: String) : Exception(message)

/**
 * The request WENT OUT and no answer came: it timed out, or the socket closed while it waited. The
 * host may have acted on it (or still be acting), unlike a request that was never sent or one the
 * host answered with an error, which are plain [RpcException]s.
 */
class RpcUnansweredException(message: String) : RpcException(message)

/**
 * The CLIENT (phone) role of `src/main/remote/relay-socket.ts`, rule for rule:
 *
 *  - the token rides the URL as `?token=` (never a data frame);
 *  - handshake `e2ee_hello → e2ee_ready → e2ee_auth → e2ee_authenticated`; base key =
 *    `box.before(hostPub, ourSecret)`, session key = HKDF(base, hostNonce ‖ clientNonce);
 *  - every box's sealed plaintext is `[role][seq u64 as two LE u32, high then low][tag][body]`;
 *    only boxes carrying the HOST role (1) are accepted (a box with our own role is a relay
 *    reflection) and only with a strictly increasing seq (replay/reorder);
 *  - once ready, a plaintext handshake frame is IGNORED — never re-keyed, never a reason to close
 *    (docs/ios-protocol-migration.md §2.4);
 *  - the host key is pinned: the one passed in is the only identity this session may use.
 *
 * Reconnect is the caller's job: a relay token is single-use, so re-dialing here with the same one
 * would only be refused. Callers mint a fresh token and build a new socket.
 */
class RelaySocket(
    url: String,
    token: String,
    private val ourKeys: BoxKeyPair,
    private val hostPublicKeyB64: String,
    transportFactory: RelayTransportFactory,
    private val listener: RelaySocketListener,
    private val scheduler: ScheduledExecutorService = sharedScheduler
) {
    private enum class State { HANDSHAKING, READY, CLOSED }

    private class Pending(val onResult: (Result<JsonElement?>) -> Unit, val timeout: ScheduledFuture<*>?)

    private val lock = Any()
    private var state = State.HANDSHAKING
    private var intentionallyClosed = false
    private val baseKey: ByteArray = E2ee.deriveSharedKey(hostPublicKeyB64, ourKeys.secretKey)
    private val ourNonce: ByteArray = E2ee.randomSessionNonce()
    private var sessionKey: ByteArray? = null
    private var sendSeq = 0L
    private var recvSeq = -1L
    private var readyFired = false
    private var requestCounter = 0
    private val pending = HashMap<String, Pending>()
    private var keepalive: ScheduledFuture<*>? = null
    private val transport: RelayTransport

    /** The SAS for this channel. Derived from the pinned host key, so it is known before `ready`. */
    val sas: String = E2ee.sasFromSharedKey(baseKey)

    init {
        val events = object : RelayTransportEvents {
            override fun onText(text: String) = handleControl(text)
            override fun onBinary(bytes: ByteArray) = handleBinary(bytes)
            override fun onClosed(reason: String?) = handleClose(reason)
        }
        transport = transportFactory.open(withToken(url, token), events)
        val hello = buildJsonObject {
            put("type", "e2ee_hello")
            put("publicKeyB64", ourKeys.publicKeyB64)
            put("nonceB64", B64.encode(ourNonce))
        }
        transport.sendText(hello.toString())
    }

    val isReady: Boolean get() = synchronized(lock) { state == State.READY }

    // ---- inbound --------------------------------------------------------------------------

    private fun handleControl(raw: String) {
        synchronized(lock) {
            // SECURITY: after ready (or once a session key exists) a plaintext control frame is a
            // re-key attempt. Drop it without re-keying and without closing.
            if (readyFired || sessionKey != null || state == State.CLOSED) return
            val msg = parseObject(raw) ?: return
            if (msg.str("type") != "e2ee_ready") return
            val hostNonce = msg.str("nonceB64")?.let(B64::decode) ?: return
            if (hostNonce.size != 16) return
            val key = E2ee.deriveSessionKey(baseKey, hostNonce, ourNonce)
            sessionKey = key
            sendSealedLocked(TAG_RPC, """{"type":"e2ee_auth"}""".toByteArray())
        }
    }

    private fun handleBinary(bytes: ByteArray) {
        val effects = ArrayList<() -> Unit>()
        synchronized(lock) {
            if (state == State.CLOSED) return
            val key = sessionKey ?: return
            val sealed = E2ee.decrypt(bytes, key) ?: return
            if (sealed.size < HEADER_BYTES) return
            if (sealed[0].toInt() != HOST_ROLE) return
            val b = ByteBuffer.wrap(sealed).order(ByteOrder.LITTLE_ENDIAN)
            val seq = ((b.getInt(1).toLong() and 0xffffffffL) shl 32) or (b.getInt(5).toLong() and 0xffffffffL)
            if (seq <= recvSeq) return
            recvSeq = seq
            if (sealed.size < HEADER_BYTES + 1) return
            val tag = sealed[HEADER_BYTES].toInt() and 0xff
            val body = sealed.copyOfRange(HEADER_BYTES + 1, sealed.size)
            if (state == State.HANDSHAKING) {
                if (tag != TAG_RPC) return
                val msg = parseObject(String(body, Charsets.UTF_8)) ?: return
                if (msg.str("type") == "e2ee_authenticated") {
                    state = State.READY
                    readyFired = true
                    startKeepaliveLocked()
                    effects += { listener.onReady(sas) }
                }
                return@synchronized
            }
            when (tag) {
                TAG_FRAME -> Framing.decode(body)?.let { f -> effects += { listener.onFrame(f) } }
                TAG_RPC -> handleEnvelopeLocked(String(body, Charsets.UTF_8), effects)
                // TAG_TUNNEL_* belong to the rpc.ts dialect the standing phone host does not speak.
                else -> Unit
            }
        }
        for (e in effects) e()
    }

    private fun handleEnvelopeLocked(raw: String, effects: MutableList<() -> Unit>) {
        val env = parseObject(raw) ?: return
        when (env.str("kind")) {
            "res" -> {
                val id = env.str("id") ?: return
                val waiter = pending.remove(id) ?: return
                waiter.timeout?.cancel(false)
                val ok = (env["ok"] as? JsonPrimitive)?.contentOrNull == "true"
                val body = env["body"]
                val result = if (ok) Result.success(body) else Result.failure(RpcException(errorMessage(body)))
                effects += { waiter.onResult(result) }
            }
            "notify" -> {
                val method = env.str("method") ?: return
                val params = env["params"]
                effects += { listener.onNotify(method, params) }
            }
            // "keepalive" and host→client "req" (the legacy dialect never sends one) are ignored.
            else -> Unit
        }
    }

    private fun handleClose(reason: String?) {
        val waiters: List<Pending>
        val notify: Boolean
        synchronized(lock) {
            if (state == State.CLOSED) return
            state = State.CLOSED
            keepalive?.cancel(false)
            keepalive = null
            sessionKey = null
            waiters = pending.values.toList()
            pending.clear()
            notify = !intentionallyClosed
        }
        for (w in waiters) {
            w.timeout?.cancel(false)
            w.onResult(Result.failure(RpcUnansweredException("Relay connection closed.")))
        }
        if (notify) listener.onClosed(reason)
    }

    // ---- outbound -------------------------------------------------------------------------

    private fun sendSealedLocked(tag: Int, body: ByteArray): Boolean {
        val key = sessionKey ?: return false
        val seq = sendSeq++
        val plain = ByteBuffer.allocate(HEADER_BYTES + 1 + body.size).order(ByteOrder.LITTLE_ENDIAN)
        plain.put(CLIENT_ROLE.toByte())
        plain.putInt((seq ushr 32).toInt())
        plain.putInt(seq.toInt())
        plain.put(tag.toByte())
        plain.put(body)
        return transport.sendBinary(E2ee.encrypt(plain.array(), key))
    }

    private fun startKeepaliveLocked() {
        keepalive?.cancel(false)
        keepalive = scheduler.scheduleWithFixedDelay({
            synchronized(lock) {
                if (state == State.READY) sendSealedLocked(TAG_RPC, """{"kind":"keepalive"}""".toByteArray())
            }
        }, KEEPALIVE_MS, KEEPALIVE_MS, TimeUnit.MILLISECONDS)
    }

    /**
     * Send an RPC request. `onResult` runs on the transport's reader thread for a response —
     * BEFORE any later message is processed, which is what lets `pty.attach` register its stream
     * before the snapshot frames that follow the response arrive — or on a timer / closing thread
     * for a timeout or a closed socket.
     */
    fun request(
        method: String,
        params: JsonElement? = null,
        timeoutMs: Long = RPC_TIMEOUT_MS,
        onResult: (Result<JsonElement?>) -> Unit
    ) {
        val failure: RpcException?
        synchronized(lock) {
            if (state != State.READY) {
                failure = RpcException("Relay socket is not connected.")
            } else {
                requestCounter += 1
                val id = "client-rpc-$requestCounter-${System.currentTimeMillis()}"
                val timer = scheduler.schedule({
                    val w = synchronized(lock) { pending.remove(id) }
                    w?.onResult?.invoke(Result.failure(RpcUnansweredException("RPC timed out: $method")))
                }, timeoutMs, TimeUnit.MILLISECONDS)
                pending[id] = Pending(onResult, timer)
                val env = buildJsonObject {
                    put("kind", "req")
                    put("id", id)
                    put("method", method)
                    put("params", params ?: JsonObject(emptyMap()))
                }
                if (sendSealedLocked(TAG_RPC, env.toString().toByteArray(Charsets.UTF_8))) {
                    failure = null
                } else {
                    pending.remove(id)
                    timer.cancel(false)
                    failure = RpcException("Relay socket is not connected.")
                }
            }
        }
        if (failure != null) onResult(Result.failure(failure))
    }

    suspend fun call(method: String, params: JsonElement? = null, timeoutMs: Long = RPC_TIMEOUT_MS): JsonElement? =
        suspendCancellableCoroutine { cont ->
            request(method, params, timeoutMs) { r ->
                r.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }
        }

    /** Send a terminal frame. False when not ready or over the buffered-bytes ceiling. */
    fun sendFrame(op: Int, streamId: Long, seq: Long, payload: ByteArray): Boolean = synchronized(lock) {
        if (state != State.READY) return false
        if (transport.queuedBytes() > MAX_BINARY_BUFFERED_BYTES) return false
        sendSealedLocked(TAG_FRAME, Framing.encode(op, streamId, seq, payload))
    }

    /** Intentional, final close: pending requests fail, [RelaySocketListener.onClosed] is NOT fired. */
    fun close() {
        synchronized(lock) {
            if (state == State.CLOSED) return
            intentionallyClosed = true
        }
        handleClose("closed")
        transport.close()
    }

    private fun parseObject(raw: String): JsonObject? = try {
        Json.parseToJsonElement(raw) as? JsonObject
    } catch (_: Exception) {
        null
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun errorMessage(body: JsonElement?): String {
        val o = body as? JsonObject ?: return "RPC failed."
        return o.str("message") ?: o.str("error") ?: "RPC failed."
    }

    companion object {
        const val HOST_ROLE = 1
        const val CLIENT_ROLE = 2
        const val HEADER_BYTES = 9
        const val TAG_RPC = 0x01
        const val TAG_FRAME = 0x02
        const val RPC_TIMEOUT_MS = 30_000L
        const val KEEPALIVE_MS = 25_000L
        const val MAX_BINARY_BUFFERED_BYTES = 8L * 1024 * 1024

        val sharedScheduler: ScheduledExecutorService by lazy {
            Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "nodeterm-relay-timer").apply { isDaemon = true } }
        }

        /** `?token=` exactly as `encodeURIComponent` would write it (`&` when a query already exists). */
        fun withToken(url: String, token: String): String {
            val sep = if (url.contains('?')) '&' else '?'
            return "$url${sep}token=${encodeUriComponent(token)}"
        }

        fun encodeUriComponent(s: String): String {
            val unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
            val sb = StringBuilder()
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = (b.toInt() and 0xff).toChar()
                if (b >= 0 && unreserved.indexOf(c) >= 0) sb.append(c)
                else sb.append('%').append("0123456789ABCDEF"[(b.toInt() shr 4) and 0xf]).append("0123456789ABCDEF"[b.toInt() and 0xf])
            }
            return sb.toString()
        }

        internal val JsonElement?.isJsonNull: Boolean get() = this == null || this is JsonNull
        internal fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
        internal fun JsonElement?.primitiveContent(): String? = (this as? JsonPrimitive)?.jsonPrimitive?.contentOrNull
    }
}
