package dev.nodeterm.protocol

import dev.nodeterm.protocol.relay.OkHttpRelayTransport
import dev.nodeterm.protocol.relay.RelayApi
import dev.nodeterm.protocol.relay.RelayApiException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Dns
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Real OkHttp HTTP/1 exchanges over in-memory sockets: no localhost listener or network required. */
class RelayApiTest {
    private enum class Reply { SILENT_HEADERS, SILENT_BODY, TRICKLING_BODY, COMPLETE }

    /** A connected socket whose read can stall until OkHttp's timeout or cancellation closes it. */
    private class MemorySocket(reply: Reply, body: String) : Socket() {
        val waiting = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val request = ByteArrayOutputStream()
        private val gate = Object()
        @Volatile private var ended = false
        private var socketTimeout = 0
        private val prefix = when (reply) {
            Reply.SILENT_HEADERS -> byteArrayOf()
            Reply.COMPLETE -> ("HTTP/1.1 200 OK\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body).toByteArray()
            else -> "HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n".toByteArray()
        }
        private var offset = 0
        private val input = object : InputStream() {
            override fun read(): Int {
                val byte = ByteArray(1)
                return if (read(byte, 0, 1) < 0) -1 else byte[0].toInt() and 0xff
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int = synchronized(gate) {
                if (ended) throw IOException("socket closed")
                if (offset < prefix.size) {
                    val n = minOf(len, prefix.size - offset)
                    prefix.copyInto(b, off, offset, offset + n)
                    offset += n
                    return@synchronized n
                }
                if (reply == Reply.COMPLETE) return@synchronized -1
                waiting.countDown()
                while (!ended) {
                    gate.wait(if (reply == Reply.TRICKLING_BODY) 30L else 0L)
                    if (!ended && reply == Reply.TRICKLING_BODY) {
                        b[off] = ' '.code.toByte()
                        return@synchronized 1
                    }
                }
                throw IOException("socket closed")
            }
        }

        override fun connect(endpoint: SocketAddress, timeout: Int) { /* connected entirely in memory */ }
        override fun getInputStream(): InputStream = input
        override fun getOutputStream(): ByteArrayOutputStream = request
        override fun setSoTimeout(timeout: Int) { socketTimeout = timeout }
        override fun getSoTimeout(): Int = socketTimeout
        override fun isConnected(): Boolean = true
        override fun isClosed(): Boolean = ended
        override fun close() {
            synchronized(gate) {
                ended = true
                closed.countDown()
                gate.notifyAll()
            }
        }
    }

    private class Exchange(reply: Reply, body: String = "") : AutoCloseable {
        val socket = MemorySocket(reply, body)
        val client: OkHttpClient = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
            })
            .socketFactory(object : SocketFactory() {
                override fun createSocket(): Socket = socket
                override fun createSocket(host: String, port: Int): Socket = error("unexpected connect overload")
                override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = error("unexpected connect overload")
                override fun createSocket(host: InetAddress, port: Int): Socket = error("unexpected connect overload")
                override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket = error("unexpected connect overload")
            })
            // Reproduce the old WebSocket-derived HTTP client: neither timeout rescues the call.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .build()

        fun api(deadlineMs: Long = 150) = RelayApi("http://memory.test", client, deadlineMs)

        override fun close() {
            socket.close()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdownNow()
        }
    }

    @Test
    fun `HTTP uses finite read and whole call limits while the WebSocket stays long lived`() {
        assertTrue(RelayApi.defaultHttpClient.readTimeoutMillis > 0)
        assertTrue(RelayApi.defaultHttpClient.callTimeoutMillis > 0)
        assertEquals(0, OkHttpRelayTransport.defaultClient.readTimeoutMillis)
        assertFailsWith<IllegalArgumentException> { RelayApi(deadlineMs = 0) }
    }

    @Test
    fun `join and device mint stop when headers body or a trickling body exceed the deadline`() = runBlocking<Unit> {
        for (reply in listOf(Reply.SILENT_HEADERS, Reply.SILENT_BODY, Reply.TRICKLING_BODY)) {
            for (mint in listOf(false, true)) {
                Exchange(reply).use { exchange ->
                    val failure = assertFailsWith<RelayApiException> {
                        // Also bounds the test if the HTTP deadline is removed: cancellation then
                        // closes the in-memory socket, and a timeout assertion fails instead of hangs.
                        withTimeout(3_000) {
                            if (mint) exchange.api().mintDevice("phone", "host-device", "host-key", "Phone", null)
                            else exchange.api().join("device-token", "host-id")
                        }
                    }
                    assertTrue(failure.message!!.startsWith("Couldn't reach the relay:"), failure.message)
                    assertEquals(0L, exchange.socket.closed.count, "the deadline must release the stalled socket")
                }
            }
        }
    }

    @Test
    fun `cancelling a join or device mint closes a socket stalled in headers or the body`() = runBlocking<Unit> {
        for (reply in listOf(Reply.SILENT_HEADERS, Reply.SILENT_BODY)) for (mint in listOf(false, true)) {
            Exchange(reply).use { exchange ->
                val request = async {
                    if (mint) exchange.api(10_000).mintDevice("phone", "host-device", "host-key", "Phone", null)
                    else exchange.api(10_000).join("device-token", "host-id")
                }
                // Let the child run before waiting on the socket's callback thread.
                kotlinx.coroutines.yield()
                assertTrue(exchange.socket.waiting.await(2, TimeUnit.SECONDS), "the request must reach the stalled read")
                request.cancel()
                withTimeout(1_000) { request.join() }
                assertTrue(request.isCancelled)
                assertTrue(exchange.socket.closed.await(1, TimeUnit.SECONDS), "coroutine cancellation must cancel OkHttp's call")
            }
        }
    }

    @Test
    fun `join and device mint deadlines include waiting for a busy dispatcher`() = runBlocking<Unit> {
        for (mint in listOf(false, true)) {
            Exchange(Reply.SILENT_HEADERS).use { exchange ->
                exchange.client.dispatcher.maxRequests = 1
                val blocker = exchange.client.newCall(Request.Builder().url("http://memory.test/blocker").build())
                val blockerFinished = CountDownLatch(1)
                blocker.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { blockerFinished.countDown() }
                    override fun onResponse(call: Call, response: Response) {
                        response.close()
                        blockerFinished.countDown()
                    }
                })
                try {
                    assertTrue(exchange.socket.waiting.await(2, TimeUnit.SECONDS), "the blocker must occupy the dispatcher")
                    val failure = assertFailsWith<RelayApiException> {
                        withTimeout(3_000) {
                            if (mint) exchange.api().mintDevice("phone", "host-device", "host-key", "Phone", null)
                            else exchange.api().join("device-token", "host-id")
                        }
                    }
                    assertTrue(failure.message!!.startsWith("Couldn't reach the relay:"), failure.message)
                    val queued = exchange.client.dispatcher.queuedCalls().single()
                    assertTrue(queued.isCanceled(), "the expired queued request must be cancelled before it can run")
                    assertEquals(1, exchange.client.dispatcher.runningCallsCount(), "the blocker must still occupy the dispatcher")
                } finally {
                    blocker.cancel()
                    assertTrue(blockerFinished.await(1, TimeUnit.SECONDS), "the blocker must release the dispatcher")
                }
            }
        }
    }

    @Test
    fun `a caller's shorter deadline remains coroutine cancellation`() = runBlocking<Unit> {
        for (mint in listOf(false, true)) {
            Exchange(Reply.SILENT_HEADERS).use { exchange ->
                assertFailsWith<TimeoutCancellationException> {
                    withTimeout(150) {
                        if (mint) exchange.api(10_000).mintDevice("phone", "host-device", "host-key", "Phone", null)
                        else exchange.api(10_000).join("device-token", "host-id")
                    }
                }
                assertTrue(exchange.socket.closed.await(1, TimeUnit.SECONDS), "the caller's deadline must cancel the active call")
            }
        }
    }

    @Test
    fun `join and device mint keep their request and response shapes`() = runBlocking<Unit> {
        Exchange(Reply.COMPLETE, """{"pairingToken":"join-token","exp":123}""").use { exchange ->
            val result = exchange.api(3_000).join("device-token", "host-id")
            assertEquals("join-token", result.pairingToken)
            assertEquals(123L, result.exp)
            val request = exchange.socket.request.toString(Charsets.UTF_8.name())
            assertTrue(request.startsWith("POST /v1/relay/join HTTP/1.1\r\n"), request)
            assertTrue(request.endsWith("""{"deviceToken":"device-token","hostId":"host-id"}"""), request)
        }
        Exchange(Reply.COMPLETE, """{"deviceToken":"minted","hostId":"host-id","exp":456}""").use { exchange ->
            val result = exchange.api(3_000).mintDevice("phone", "host-device", "host-key", "Phone", "prior")
            assertEquals("minted", result.deviceToken)
            assertEquals("host-id", result.hostId)
            assertEquals(456L, result.exp)
            val request = exchange.socket.request.toString(Charsets.UTF_8.name())
            assertTrue(request.startsWith("POST /v1/relay/device HTTP/1.1\r\n"), request)
            assertTrue(request.endsWith("""{"deviceId":"phone","hostDeviceId":"host-device","hostPublicKeyB64":"host-key","label":"Phone","priorDeviceToken":"prior"}"""), request)
        }
    }
}
