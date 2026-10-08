package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.pairing.RelayBlock
import dev.nodeterm.protocol.ssh.HostKeyAnchors
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One paired computer, as the phone keeps it. Public facts only — the phone's own secrets (its box
 * key, its SSH seed) live in the app's Keystore-backed store, never in this record — except the
 * relay device token, which is a bearer credential and is therefore persisted by the app through
 * the same encrypted store (see the app's `SecureStore`).
 *
 * A computer added by its SSH address instead of a pairing code ([manual], audit A27) is one of
 * these too: the same fields, no relay, and a host key pinned by the first connect that
 * authenticated ([dev.nodeterm.protocol.ssh.ManualHost]).
 */
data class PairedHost(
    /** Local id for this pairing (the host-assigned deviceId — unique per pairing). */
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val user: String,
    val sshAvailable: Boolean,
    /** The host's box key from the QR (`hostKey`): the relay identity pinned at pairing. */
    val hostKeyB64: String?,
    val relay: RelayBlock?,
    /**
     * `SHA256:…` of the SSH host key, pinned by the first connect that authenticated. When
     * [sshHostKeyAnchors] is not empty that connect had to present one of them; otherwise it was trust
     * on first use. For a host certificate, the key it certifies
     * ([dev.nodeterm.protocol.ssh.SshHostConnection.hostKeyFingerprint]); an older build pinned the
     * certificate itself, which the next connect to that server re-spells.
     */
    val sshHostKeyFingerprint: String?,
    /** When it was paired, or added by address. */
    val pairedAt: Long,
    /**
     * Added by its SSH address ("Add SSH server", audit A27), not paired: reached over SSH only. It
     * has no relay leg, ever — a Server Edition has no pairing service and a plain SSH host no
     * standing phone host — so the app fixes its route to SSH and never adopts a relay for it.
     * Persisted as `"manual": true`, which a build that predates it ignores (it then sees a paired
     * computer with SSH and no relay, which is what this is) — and drops: such a build rewrites the
     * whole list on its next save with no `manual` key. So [fromJson] also reads the flag from the
     * id, which survives that round trip ([MANUAL_ID_PREFIX]).
     */
    val manual: Boolean = false,
    /**
     * The computer's SSH host key fingerprints from its sealed pairing answer (audit A49-anchor,
     * [dev.nodeterm.protocol.ssh.HostKeyAnchors]): the first SSH connect must present one of them before
     * anything is pinned. Empty for a computer whose desktop sent none (older, Windows, keys it could
     * not read) and for one added by its SSH address; that first connect is trust on first use. Kept
     * after the pin is set, which then decides on its own. Persisted as `sshHostKeyAnchors` only when
     * there are some, so a record without them is what it was; a build that predates the key drops it
     * on its next save, which leaves the computer on trust on first use, as that build always had it.
     */
    val sshHostKeyAnchors: List<String> = emptyList(),
    /** Explicit remote Desktop/Server profile folder; null keeps automatic SSH discovery. */
    val sshProfilePath: String? = null
) {
    /** The relay host key: the relay block's when present, else the QR's `hostKey` (same key). */
    val relayHostKeyB64: String? get() = relay?.hostPublicKeyB64 ?: hostKeyB64

    /**
     * How the SSH leg is named on screen. A paired computer's is the LAN one the pairing found; a
     * computer added by address may be reached any way its SSH is (a VPN, a public address), so it is
     * not called "your network".
     */
    val sshLegName: String get() = if (manual) "Over SSH" else "On your network"

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("name", name)
        put("host", host)
        put("port", port)
        put("user", user)
        put("sshAvailable", sshAvailable)
        hostKeyB64?.let { put("hostKeyB64", it) }
        relay?.let { r ->
            put("relay", buildJsonObject {
                put("hostId", r.hostId)
                put("hostPublicKeyB64", r.hostPublicKeyB64)
                put("relayEndpoint", r.relayEndpoint)
            })
        }
        sshHostKeyFingerprint?.let { put("sshHostKeyFingerprint", it) }
        if (sshHostKeyAnchors.isNotEmpty()) put("sshHostKeyAnchors", JsonArray(sshHostKeyAnchors.map(::JsonPrimitive)))
        put("pairedAt", pairedAt)
        // Only when set: a paired computer's record is byte-for-byte what it was before A27.
        if (manual) put("manual", true)
        sshProfilePath?.let { put("sshProfilePath", it) }
    }

    companion object {
        /**
         * The id prefix of a computer added by its SSH address ([dev.nodeterm.protocol.ssh.ManualHost.newId]).
         * A paired computer's id is the desktop's `randomUUID()` (pairing-service.ts), which never
         * starts with it.
         */
        const val MANUAL_ID_PREFIX = "ssh-"

        fun fromJson(o: JsonObject): PairedHost? {
            val id = o.s("id") ?: return null
            // A malformed explicit choice must never silently select another profile.
            if ("sshProfilePath" in o && o.s("sshProfilePath") == null) return null
            // The key, or the id when a build that predates the key saved the record without it: going
            // back to such a build and forward again must not turn this computer into a paired one,
            // with route choices, a relay adoption and "turn on remote access" advice (review of A27b).
            val manual = o.b("manual") == true || id.startsWith(MANUAL_ID_PREFIX)
            return PairedHost(
                id = id,
                name = o.s("name") ?: "Computer",
                host = o.s("host") ?: return null,
                port = o.l("port")?.toInt() ?: 22,
                user = o.s("user") ?: return null,
                // A computer added by address is reached over SSH or not at all.
                sshAvailable = manual || o.b("sshAvailable") != false,
                // No relay leg for one added by address, whatever the record says: nothing pairs it.
                hostKeyB64 = if (manual) null else o.s("hostKeyB64"),
                relay = if (manual) null else o.o("relay")?.let(PairingPayload::parseRelayBlock),
                sshHostKeyFingerprint = o.s("sshHostKeyFingerprint"),
                pairedAt = o.l("pairedAt") ?: 0,
                manual = manual,
                // Nothing pairs a computer added by address, so nothing anchors its first connect.
                sshHostKeyAnchors = if (manual) emptyList() else HostKeyAnchors.parse(o["sshHostKeyAnchors"]),
                sshProfilePath = o.s("sshProfilePath")
            )
        }

        fun from(payload: PairingPayload, result: PairingResult, now: Long = System.currentTimeMillis()) = PairedHost(
            id = result.deviceId,
            name = payload.name,
            host = payload.host,
            port = payload.port,
            user = payload.user,
            sshAvailable = payload.sshAvailable,
            hostKeyB64 = payload.hostKey,
            relay = result.relay ?: payload.relay,
            sshHostKeyFingerprint = null,
            pairedAt = now,
            sshHostKeyAnchors = result.sshHostKeyFingerprints
        )
    }
}
