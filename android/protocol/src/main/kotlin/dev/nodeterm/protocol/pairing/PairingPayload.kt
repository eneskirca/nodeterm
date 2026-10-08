package dev.nodeterm.protocol.pairing

import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import kotlinx.serialization.json.JsonObject
import java.net.URI

/** `RelayPairingBlock` (pairing-core.ts): how to reach this host over the relay. */
data class RelayBlock(val hostId: String, val hostPublicKeyB64: String, val relayEndpoint: String)

/**
 * The QR the desktop shows under Settings → Phone (`buildPairingPayload`, pairing-core.ts):
 * `{"v":1,"host":…,"port":22,"user":…,"token":…,"pairPort":N,"nodeterm":true,"name":…,
 *   "hostKey"?:…, "relay"?:{…}, "ssh"?:false}`.
 */
data class PairingPayload(
    val host: String,
    val port: Int,
    val user: String,
    val token: String,
    val pairPort: Int,
    val name: String,
    /** The host's NaCl box key: seal `/pair` to it. Also the relay host key. */
    val hostKey: String?,
    val relay: RelayBlock?,
    /** False on a Windows host: no SSH key is installed; the phone must use the relay. */
    val sshAvailable: Boolean
) {
    companion object {
        /** `@shared/pair-qr` PAIR_URL_PREFIX: the URL envelope a system camera can open. */
        const val PAIR_URL_PREFIX = "nodeterm://pair?code="

        /**
         * The three shapes the desktop can hand over (`@shared/pair-qr`, and what the iOS app's
         * `PairingService.decode` accepts): the raw payload JSON, the `nodeterm://pair?code=`
         * URL wrapping base64url(JSON), or the bare base64url code.
         */
        fun unwrap(text: String): String? {
            val t = text.trim()
            if (t.isEmpty()) return null
            if (t.startsWith("{")) return t
            val code = if (t.contains("://")) {
                val uri = try {
                    URI(t)
                } catch (_: Exception) {
                    return null
                }
                if (uri.scheme != "nodeterm" || uri.host != "pair") return null
                if (!uri.path.isNullOrEmpty() && uri.path != "/") return null
                uri.rawQuery?.split('&')?.firstOrNull { it.startsWith("code=") }?.removePrefix("code=") ?: return null
            } else t
            return B64.decodeUrl(code)?.toString(Charsets.UTF_8)
        }

        /** Null for anything that is not a nodeterm PHONE pairing payload — never throws. (A desktop-peer
         *  relay offer shares the URL envelope but not the payload, and is refused here.) */
        fun parse(text: String): PairingPayload? {
            val o = J.obj(J.parse(unwrap(text) ?: return null)) ?: return null
            if (o.l("v") != 1L || o.b("nodeterm") != true) return null
            val host = o.s("host")?.takeIf { it.isNotBlank() } ?: return null
            val user = o.s("user")?.takeIf { it.isNotBlank() } ?: return null
            val token = o.s("token")?.takeIf { it.isNotBlank() } ?: return null
            val pairPort = o.l("pairPort")?.toInt()?.takeIf { it in 1..65535 } ?: return null
            val port = o.l("port")?.toInt()?.takeIf { it in 1..65535 } ?: 22
            val hostKey = o.s("hostKey")?.takeIf { B64.decode(it)?.size == 32 }
            return PairingPayload(
                host = host,
                port = port,
                user = user,
                token = token,
                pairPort = pairPort,
                name = o.s("name")?.takeIf { it.isNotBlank() } ?: host,
                hostKey = hostKey,
                relay = o.o("relay")?.let(::parseRelayBlock),
                sshAvailable = o.b("ssh") != false
            )
        }

        fun parseRelayBlock(r: JsonObject): RelayBlock? {
            val hostId = r.s("hostId")?.takeIf { it.isNotBlank() } ?: return null
            val pub = r.s("hostPublicKeyB64")?.takeIf { B64.decode(it)?.size == 32 } ?: return null
            val endpoint = r.s("relayEndpoint")?.takeIf(::isAllowedRelayEndpoint) ?: return null
            return RelayBlock(hostId, pub, endpoint)
        }

        /**
         * R5 (pairing.ts): the phone dials the relay endpoint verbatim, so a payload must not point
         * it at plaintext — `wss:` only, `ws:` solely for loopback (a local relay in dev/tests).
         */
        fun isAllowedRelayEndpoint(endpoint: String): Boolean {
            val uri = try {
                URI(endpoint)
            } catch (_: Exception) {
                return false
            }
            return when (uri.scheme) {
                "wss" -> !uri.host.isNullOrEmpty()
                "ws" -> uri.host in setOf("127.0.0.1", "localhost", "::1", "[::1]")
                else -> false
            }
        }
    }
}

/** What `/pair` answered: the host-minted identity plus, when remote access is on, a relay leg. */
data class PairingResult(
    val deviceId: String,
    val agentToken: String,
    val relay: RelayBlock?,
    val relayDeviceToken: String?,
    /** The computer pinned this phone's relay key at pairing (audit A07). Implies [relayApproved]. */
    val relayPinned: Boolean = false,
    /**
     * The computer serves this phone's relay key without its approval dialog (audit A07-late): pinned
     * at the scan, or recorded with this pairing for its standing host to pin on the phone's first
     * relay connect. The second is what a phone paired while remote access was off needs: it adopts
     * the relay later over SSH (late adoption), and its first relay connect then raises no dialog at
     * a desk it has usually left. False from a desktop that predates it, which shows the dialog on
     * the first relay connect. What gates the background worker's relay leg
     * ([dev.nodeterm.protocol.host.RelayApprovalGate]).
     */
    val relayApproved: Boolean = relayPinned,
    /**
     * The fingerprints of the computer's SSH host keys (audit A49-anchor), in the form sshj and OpenSSH
     * print (`SHA256:…`). Taken ONLY from a sealed answer, which is bound to the host key the QR on the
     * computer's screen carries: a plaintext one could have been rewritten on the LAN. Empty from a
     * desktop that predates the field, from a Windows desktop (no SSH leg), when the desktop could not
     * read its keys, and for a plaintext answer; the first SSH connect then pins the key of the first
     * server that accepts the phone's key, as before. See [dev.nodeterm.protocol.ssh.HostKeyAnchors].
     */
    val sshHostKeyFingerprints: List<String> = emptyList()
) {
    /** What the Pair screen says once paired. */
    fun pairedNotice(): String = when {
        relayDeviceToken == null && relayApproved ->
            "Paired. This phone reaches the computer on your network, and is approved for remote access once the computer offers it."
        relayDeviceToken == null -> "Paired. This phone reaches the computer on your network."
        relayApproved -> "Paired, and approved for remote access."
        else -> "Paired. The first time you connect from outside your network, approve this phone on the computer."
    }
}
