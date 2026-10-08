package dev.nodeterm.protocol.relay

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The production [RelayTransport]: an OkHttp WebSocket. Text frames stay text and binary frames
 * stay binary end to end — the relay preserves the distinction and the handshake depends on it.
 * OkHttp queues sends issued before the upgrade completes and delivers messages on one reader
 * thread in wire order, which is the ordering [RelaySocket] relies on.
 */
class OkHttpRelayTransport private constructor(private val ws: WebSocket) : RelayTransport {
    override fun sendText(text: String): Boolean = ws.send(text)
    override fun sendBinary(bytes: ByteArray): Boolean = ws.send(bytes.toByteString())
    override fun queuedBytes(): Long = ws.queueSize()
    override fun close() {
        if (!ws.close(1000, null)) ws.cancel()
    }

    companion object {
        val defaultClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                // Transport-level liveness on top of the E2EE keepalive: a phone that roams between
                // networks otherwise holds a dead socket until the OS gives up on it.
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
        }

        fun factory(client: OkHttpClient = defaultClient) = RelayTransportFactory { url, events ->
            val closed = AtomicBoolean(false)
            val fireClosed = { reason: String? -> if (closed.compareAndSet(false, true)) events.onClosed(reason) }
            val ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) = events.onText(text)
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = events.onBinary(bytes.toByteArray())
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    fireClosed(reason.ifEmpty { "closed ($code)" })
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                    fireClosed(reason.ifEmpty { "closed ($code)" })
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    fireClosed(response?.let { "HTTP ${it.code}" } ?: t.message ?: t.javaClass.simpleName)
            })
            OkHttpRelayTransport(ws)
        }
    }
}
