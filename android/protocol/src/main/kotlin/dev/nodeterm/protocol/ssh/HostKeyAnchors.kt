package dev.nodeterm.protocol.ssh

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The computer's SSH host key fingerprints as its pairing handed them over (audit A49-anchor): the
 * desktop reads its `/etc/ssh/ssh_host_*_key.pub` (src/main/ssh-host-keys.ts) and puts the
 * fingerprints in the SEALED `/pair` answer as `sshHostKeyFingerprints`. The first SSH connect to the
 * computer must then present one of them ([SshHostConnection.connect]), instead of pinning whichever
 * key answers at the paired address. With none (an older desktop, a plaintext answer, keys the desktop
 * could not read, a computer added by its SSH address) the first connect pins the key of the first
 * server that accepts the phone's key, as before.
 *
 * The form is OpenSSH's and sshj's (`SshHostConnection.fingerprint`): `SHA256:` and the unpadded
 * standard base64 of the SHA-256 of the key blob, 43 characters. A server presenting a host
 * certificate matches by the key it certifies (`SshHostConnection.hostKeyFingerprint`).
 */
object HostKeyAnchors {
    /** The most fingerprints kept. sshd serves three or four; the desktop sends at most as many. */
    const val MAX = 16

    private val FORMAT = Regex("^SHA256:[A-Za-z0-9+/]{43}$")

    /** Whether [s] is a fingerprint in the form [SshHostConnection.fingerprint] gives. */
    fun isFingerprint(s: String): Boolean = FORMAT.matches(s)

    /**
     * The fingerprints in a `sshHostKeyFingerprints` value (the sealed answer's, or the phone's own
     * record): the well-formed strings, without duplicates, at most [MAX]. Anything that is not an array
     * gives none, which leaves the phone where an older desktop leaves it.
     */
    fun parse(e: JsonElement?): List<String> {
        val array = e as? JsonArray ?: return emptyList()
        return array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            .filter(::isFingerprint)
            .distinct()
            .take(MAX)
    }
}
