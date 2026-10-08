package dev.nodeterm.protocol.relay

import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.s
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

class RelayApiException(message: String, val status: Int? = null) : Exception(message)

data class RelayJoin(val pairingToken: String, val exp: Long)

data class RelayDevice(val deviceToken: String, val hostId: String, val exp: Long)

/**
 * The two backend calls a phone makes for the relay leg (`api.nodeterm.dev`, a separate repo):
 *
 *  - `POST /v1/relay/join` — trade the device token minted at pairing for a SINGLE-USE, short-lived
 *    (~120 s) relay token for this host's room. A new one per connect: relay-socket never re-dials
 *    on an old token (standing-host.ts manual smoke test, step 3; docs/ios-protocol-migration.md §8.5).
 *  - `POST /v1/relay/device` — the free-tier TOFU mint, for LATE ADOPTION: a phone paired while
 *    remote access was off reads `~/.nodeterm/relay.json` over its SSH bootstrap and mints its own
 *    device token (src/main/remote/relay-advertise.ts). Same body the desktop sends for a free mint.
 *
 * The join body/response shape is not documented in this repo (the backend lives elsewhere); it is
 * read tolerantly — `pairingToken`, `token` or `joinToken` — and every failure says what happened.
 */
class RelayApi(
    val apiBase: String = DEFAULT_API_BASE,
    private val client: OkHttpClient = defaultHttpClient,
    /** Bounds the entire request, including a response body that keeps trickling bytes. */
    private val deadlineMs: Long = DEFAULT_DEADLINE_MS
) {
    init {
        require(deadlineMs > 0) { "the relay HTTP deadline must be positive" }
    }

    suspend fun join(deviceToken: String, hostId: String): RelayJoin {
        val body = post("/v1/relay/join", buildJsonObject {
            put("deviceToken", deviceToken)
            put("hostId", hostId)
        })
        val token = body.s("pairingToken") ?: body.s("token") ?: body.s("joinToken")
            ?: throw RelayApiException("The relay did not hand out a connection token.")
        return RelayJoin(token, body.l("exp") ?: 0)
    }

    suspend fun mintDevice(
        deviceId: String,
        hostDeviceId: String,
        hostPublicKeyB64: String,
        label: String,
        priorDeviceToken: String?
    ): RelayDevice {
        val body = post("/v1/relay/device", buildJsonObject {
            put("deviceId", deviceId)
            put("hostDeviceId", hostDeviceId)
            put("hostPublicKeyB64", hostPublicKeyB64)
            put("label", label)
            priorDeviceToken?.let { put("priorDeviceToken", it) }
        })
        val token = body.s("deviceToken") ?: throw RelayApiException("The relay did not mint a device token.")
        return RelayDevice(token, body.s("hostId") ?: "", body.l("exp") ?: 0)
    }

    private suspend fun post(path: String, json: JsonObject): JsonObject =
        // OkHttp's call timeout begins after Dispatcher queueing. Start the phone's deadline here
        // so a busy dispatcher cannot leave a token request waiting indefinitely before it runs.
        withTimeoutOrNull(deadlineMs) { enqueuePost(path, json) }
            ?: throw unreachable(IOException("request timed out"))

    private suspend fun enqueuePost(path: String, json: JsonObject): JsonObject = suspendCancellableCoroutine { cont ->
        val req = Request.Builder()
            .url(apiBase.trimEnd('/') + path)
            .post(json.toString().toRequestBody(JSON))
            .build()
        val call = client.newCall(req)
        // The WebSocket client deliberately has no read deadline. HTTP needs its own finite one,
        // including when a caller supplies a client: otherwise roaming can wedge token minting.
        call.timeout().timeout(deadlineMs, TimeUnit.MILLISECONDS)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(unreachable(e))
            }

            override fun onResponse(call: Call, response: Response) {
                // Keep cancellation tied to the call until the body has been consumed and closed.
                // Reading in OkHttp's callback also keeps blocking I/O off the phone's main thread.
                cont.resumeWith(runCatching {
                    try {
                        response.use { res ->
                            val text = res.body?.string().orEmpty()
                            if (!res.isSuccessful) {
                                val msg = J.obj(J.parse(text))?.let { it.s("error") ?: it.s("message") }
                                throw RelayApiException(
                                    "The relay refused the request (HTTP ${res.code})" + (msg?.let { ": $it" } ?: "."),
                                    res.code
                                )
                            }
                            J.obj(J.parse(text)) ?: throw RelayApiException("The relay answered with something that is not JSON.")
                        }
                    } catch (e: IOException) {
                        throw unreachable(e)
                    }
                })
            }
        })
    }

    private fun unreachable(e: IOException) =
        RelayApiException("Couldn't reach the relay: ${e.message ?: e.javaClass.simpleName}")

    companion object {
        const val DEFAULT_API_BASE = "https://api.nodeterm.dev"
        const val DEFAULT_RELAY_URL = "wss://relay.nodeterm.dev"
        const val DEFAULT_DEADLINE_MS = 30_000L

        /** Finite HTTP timeouts; the long-lived WebSocket keeps its separate client. */
        internal val defaultHttpClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .callTimeout(DEFAULT_DEADLINE_MS, TimeUnit.MILLISECONDS)
                .build()
        }
        private val JSON = "application/json".toMediaType()
    }
}
