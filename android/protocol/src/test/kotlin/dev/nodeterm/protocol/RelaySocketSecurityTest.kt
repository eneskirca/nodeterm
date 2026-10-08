package dev.nodeterm.protocol

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.crypto.E2ee
import dev.nodeterm.protocol.relay.RelaySocket
import dev.nodeterm.protocol.relay.RelaySocketListener
import dev.nodeterm.protocol.relay.RelayTransport
import dev.nodeterm.protocol.relay.RelayTransportEvents
import dev.nodeterm.protocol.relay.RelayTransportFactory
import dev.nodeterm.protocol.relay.RpcException
import dev.nodeterm.protocol.relay.RpcUnansweredException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The security rules of docs/ios-protocol-migration.md §2.3–2.4 / §7, pinned on the client with a
 * scripted host: no re-key after ready, reflections (our own role) dropped, replays/reorders
 * dropped. A regression in any of these is silent in every other test.
 */
class RelaySocketSecurityTest {
    /** A hand-driven host end: speaks the handshake with real crypto, lets the test forge frames. */
    private class ScriptedHost(private val hostKeys: BoxKeyPair) : RelayTransportFactory {
        lateinit var events: RelayTransportEvents
        val fromClient = CopyOnWriteArrayList<Any>()
        var sessionKey: ByteArray? = null
        private var sendSeq = 0L
        val hostNonce = E2ee.randomSessionNonce()

        override fun open(url: String, events: RelayTransportEvents): RelayTransport {
            this.events = events
            return object : RelayTransport {
                override fun sendText(text: String): Boolean {
                    fromClient += text
                    onClientText(text)
                    return true
                }

                override fun sendBinary(bytes: ByteArray): Boolean {
                    fromClient += bytes
                    onClientBinary(bytes)
                    return true
                }

                override fun queuedBytes(): Long = 0
                override fun close() {}
            }
        }

        private fun onClientText(text: String) {
            val o = Json.parseToJsonElement(text).jsonObject
            if (o["type"]!!.jsonPrimitive.content != "e2ee_hello") return
            val clientPub = o["publicKeyB64"]!!.jsonPrimitive.content
            val clientNonce = B64.decode(o["nonceB64"]!!.jsonPrimitive.content)!!
            val base = E2ee.deriveSharedKey(clientPub, hostKeys.secretKey)
            sessionKey = E2ee.deriveSessionKey(base, hostNonce, clientNonce)
            events.onText("""{"type":"e2ee_ready","nonceB64":"${B64.encode(hostNonce)}"}""")
        }

        private fun onClientBinary(bytes: ByteArray) {
            val plain = E2ee.decrypt(bytes, sessionKey!!) ?: return
            val body = String(plain.copyOfRange(10, plain.size))
            if (body.contains("e2ee_auth")) sendRpc("""{"type":"e2ee_authenticated"}""")
        }

        fun seal(role: Int, seq: Long, tag: Int, body: ByteArray, key: ByteArray = sessionKey!!): ByteArray {
            val b = ByteBuffer.allocate(10 + body.size).order(ByteOrder.LITTLE_ENDIAN)
            b.put(role.toByte()).putInt((seq ushr 32).toInt()).putInt(seq.toInt()).put(tag.toByte()).put(body)
            return E2ee.encrypt(b.array(), key)
        }

        fun sendRpc(json: String, role: Int = 1, seq: Long = sendSeq++) =
            events.onBinary(seal(role, seq, 0x01, json.toByteArray()))
    }

    private class Recorder : RelaySocketListener {
        val notifies = CopyOnWriteArrayList<String>()
        var ready: String? = null
        override fun onReady(sas: String) {
            ready = sas
        }

        override fun onNotify(method: String, params: JsonElement?) {
            notifies += method
        }
    }

    private fun connect(): Triple<RelaySocket, ScriptedHost, Recorder> {
        val hostKeys = BoxKeyPair.generate()
        val host = ScriptedHost(hostKeys)
        val rec = Recorder()
        val socket = RelaySocket("ws://127.0.0.1:1", "t", BoxKeyPair.generate(), hostKeys.publicKeyB64, host, rec)
        assertNotNull(rec.ready, "handshake completes against the scripted host")
        return Triple(socket, host, rec)
    }

    @Test
    fun `hello carries our key and a 16-byte session nonce, and the token rides the URL`() {
        val (_, host, _) = connect()
        val hello = Json.parseToJsonElement(host.fromClient.first() as String).jsonObject
        assertEquals("e2ee_hello", hello["type"]!!.jsonPrimitive.content)
        assertEquals(16, B64.decode(hello["nonceB64"]!!.jsonPrimitive.content)!!.size)
        assertEquals("wss://r/x?a=1&token=a%2Fb%3D", RelaySocket.withToken("wss://r/x?a=1", "a/b="))
    }

    @Test
    fun `a plaintext re-key after ready is ignored and the session keeps working`() {
        val (socket, host, rec) = connect()
        val sasBefore = socket.sas
        val sentBefore = host.fromClient.size
        // A MITM re-sends e2ee_ready with its own nonce: must not re-derive or answer.
        host.events.onText("""{"type":"e2ee_ready","nonceB64":"${B64.encode(ByteArray(16) { 7 })}"}""")
        assertEquals(sentBefore, host.fromClient.size, "no new e2ee_auth was sent")
        assertEquals(sasBefore, socket.sas)
        host.sendRpc("""{"kind":"notify","method":"canvas:state","params":{}}""")
        assertEquals(listOf("canvas:state"), rec.notifies.toList(), "the original session key still decrypts")
    }

    @Test
    fun `a box carrying our own role is a reflection and is dropped`() {
        val (_, host, rec) = connect()
        host.sendRpc("""{"kind":"notify","method":"reflected","params":{}}""", role = 2)
        assertTrue(rec.notifies.isEmpty())
    }

    @Test
    fun `a replayed or reordered seq is dropped`() {
        val (_, host, rec) = connect()
        host.sendRpc("""{"kind":"notify","method":"first","params":{}}""", seq = 5)
        host.sendRpc("""{"kind":"notify","method":"replay","params":{}}""", seq = 5)
        host.sendRpc("""{"kind":"notify","method":"older","params":{}}""", seq = 3)
        host.sendRpc("""{"kind":"notify","method":"newer","params":{}}""", seq = 6)
        assertEquals(listOf("first", "newer"), rec.notifies.toList())
    }

    @Test
    fun `a box sealed under another key never reaches the application`() {
        val (_, host, rec) = connect()
        val forged = host.seal(1, 99, 0x01, """{"kind":"notify","method":"forged","params":{}}""".toByteArray(), key = ByteArray(32) { 1 })
        host.events.onBinary(forged)
        assertTrue(rec.notifies.isEmpty())
    }

    /**
     * Review of A29: a request that went OUT and got no answer (it timed out, or the socket closed
     * while it waited) is told apart from one the host answered with an error, and from one that was
     * never sent. The host may have acted on the first (a git commit whose hooks outlasted the wait),
     * so the phone must not report it as a failure; the second is the host's own sentence.
     */
    @Test
    fun `an unanswered request is told apart from an error the host answered`() {
        val (socket, host, _) = connect()
        fun send(method: String, timeoutMs: Long = 60_000): CompletableFuture<Result<JsonElement?>> {
            val f = CompletableFuture<Result<JsonElement?>>()
            socket.request(method, null, timeoutMs) { f.complete(it) }
            return f
        }
        fun lastRequestId(): String {
            val plain = E2ee.decrypt(host.fromClient.last() as ByteArray, host.sessionKey!!)!!
            return Json.parseToJsonElement(String(plain.copyOfRange(10, plain.size))).jsonObject["id"]!!.jsonPrimitive.content
        }

        val timedOut = send("git.commit", timeoutMs = 50).get(5, TimeUnit.SECONDS).exceptionOrNull()
        assertIs<RpcUnansweredException>(timedOut)
        assertEquals("RPC timed out: git.commit", timedOut.message)

        val refused = send("git.status")
        host.sendRpc("""{"kind":"res","id":"${lastRequestId()}","ok":false,"body":{"message":"cwd is outside the shared project roots."}}""")
        val answered = refused.get(5, TimeUnit.SECONDS).exceptionOrNull()
        assertIs<RpcException>(answered)
        assertFalse(answered is RpcUnansweredException, "the host answered it")
        assertEquals("cwd is outside the shared project roots.", answered.message)

        val waiting = send("git.push")
        host.events.onClosed("gone")
        val dropped = waiting.get(5, TimeUnit.SECONDS).exceptionOrNull()
        assertIs<RpcUnansweredException>(dropped)
        assertEquals("Relay connection closed.", dropped.message)

        val neverSent = send("git.pull").get(5, TimeUnit.SECONDS).exceptionOrNull()
        assertIs<RpcException>(neverSent)
        assertFalse(neverSent is RpcUnansweredException, "nothing went out")
    }
}
