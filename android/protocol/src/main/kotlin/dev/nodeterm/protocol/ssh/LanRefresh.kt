package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.serialization.json.JsonElement

/**
 * What the computer says about its own direct-SSH leg beside a relay `projects.list` answer (audit
 * A74-refresh): `{ output, lan: { host?, sshHostKeyFingerprints? } }`, written by
 * `src/main/remote/host-lan-report.ts`. [host] is its current LAN IPv4, picked as the pairing QR
 * picks its `host`; [sshHostKeyFingerprints] are its SSH host keys, in the form the sealed pairing
 * answer carries them ([HostKeyAnchors]). An older desktop sends no `lan`, and a Windows one never
 * does (it pairs relay-only).
 */
data class LanReport(val host: String?, val sshHostKeyFingerprints: List<String>) {
    companion object {
        /**
         * The `lan` value of a `projects.list` answer. A malformed address is dropped and so are
         * malformed fingerprints ([HostKeyAnchors.parse]); null when nothing usable is left, which is
         * what an older desktop gives too.
         */
        fun parse(e: JsonElement?): LanReport? {
            val o = J.obj(e) ?: return null
            val host = o.s("host")?.takeIf(::isDialableIPv4)
            val keys = HostKeyAnchors.parse(o["sshHostKeyFingerprints"])
            if (host == null && keys.isEmpty()) return null
            return LanReport(host, keys)
        }

        private val IPV4 = Regex("^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$")

        /**
         * A dotted IPv4 the LAN leg may dial: the shape `pickLanIPv4` returns (Node's canonical form, no
         * leading zeros), never loopback (the phone would dial itself), `0.0.0.0/8`, link-local
         * (`169.254/16`, which the desktop's pick skips) or multicast and above. The computer said it,
         * over an authenticated channel; this is only so a desktop bug cannot point the phone at itself.
         */
        fun isDialableIPv4(s: String): Boolean {
            if (!IPV4.matches(s)) return false
            val octets = s.split('.').map(String::toInt)
            return when {
                octets[0] == 0 || octets[0] == 127 || octets[0] >= 224 -> false
                octets[0] == 169 && octets[1] == 254 -> false
                else -> true
            }
        }
    }
}

/**
 * Refreshing a paired computer's LAN leg from what the computer itself said over the relay (audit
 * A74-refresh).
 *
 * The LAN leg dials the address the pairing QR carried, a DHCP lease, and checks the SSH host key
 * against the pin (or, before the first pin, the keys the sealed pairing answer named). Both were
 * facts about the moment of pairing. The relay leg authenticates the computer on its own: the session
 * is end-to-end encrypted to the box key this phone pinned at pairing, and served only once approved.
 * So a listing that arrived over it may update the record:
 *
 *  - the address, when the computer reports another one;
 *  - the host keys: they become the anchors (what a first connect, or one after the pin is dropped,
 *    must present one of);
 *  - the pin, only when the computer CONFIRMS the key the phone was refused: this connect's SSH leg met
 *    a key other than the pin at the recorded address ([HostKeyChangedException.actual], handed in as
 *    `refusedHostKey`), and that key is among the ones the computer reports. Then the pin is dropped,
 *    so the next SSH connect must present one of the reported keys and pins it once it has
 *    authenticated. That is how a computer whose sshd keys were regenerated is trusted again without
 *    pairing anew, and one whose sshd stopped serving the pinned key (the `.pub` still on disk, so
 *    still reported) gets past the pin, with no trust on first use in between.
 *
 * A pin is never dropped for being missing from the report alone (review of A74-refresh): the report
 * is what nodeterm on the computer could READ of its sshd's keys, which is not always what sshd serves
 * (a key with no `.pub` beside it, one named in a config file it cannot open), and a pin that the
 * phone has not seen fail is one that works. So without a refusal the pin stays, whatever the report
 * says, and no reported keys (an older desktop, keys it could not read) leave the anchors alone too.
 *
 * Nothing that came over SSH ever does this ([afterListing] refuses any listing that is not a relay
 * one): the SSH leg is what these facts check. A computer added by its SSH address has no relay leg,
 * and one paired relay-only (a Windows desktop) has no SSH leg, so neither is touched.
 *
 * Pure, so it is JVM-tested; the app's `HostSession` applies it after each relay listing.
 */
object LanRefresh {
    /**
     * The record after a refresh. [addressChanged] and [confirmedKey] are what the user may want to
     * hear about; anchors that changed alone are not. [confirmedKey] is the key the SSH leg was refused,
     * when the computer confirmed it as its own and the next connect accepts it where the record before
     * did not (the pin was dropped, or the anchors now name it); null otherwise.
     */
    data class Result(val host: PairedHost, val previous: PairedHost, val addressChanged: Boolean, val confirmedKey: String?)

    /**
     * What [listed] changes about [host], or null when nothing changes: [kind] is not the relay (a
     * direct-SSH listing never refreshes the facts that check it), the listing carries no report, the
     * computer has no LAN leg to refresh, or the record already says what the computer said.
     *
     * [refusedHostKey] is the host key the SSH leg of the connect that opened this relay connection was
     * refused at the recorded address ([HostKeyChangedException.actual], which [SshFallback] hands on as
     * [SshFallback.Next.TryRelay.refusedHostKey]), or null when that leg was not refused for its key.
     */
    fun afterListing(host: PairedHost, kind: TransportKind, listed: ProjectsSnapshot, refusedHostKey: String?): Result? {
        if (kind != TransportKind.RELAY) return null
        return apply(host, listed.lan ?: return null, refusedHostKey)
    }

    /** [afterListing] for a report known to have come over the relay. */
    fun apply(host: PairedHost, report: LanReport, refusedHostKey: String?): Result? {
        if (host.manual || !host.sshAvailable) return null
        val address = report.host?.takeIf { it != host.host }
        val keys = report.sshHostKeyFingerprints
        val anchors = if (keys.isEmpty()) host.sshHostKeyAnchors else keys
        val pin = host.sshHostKeyFingerprint
        val confirmed = refusedHostKey?.takeIf { it in keys }
        val dropPin = confirmed != null && pin != null && pin != confirmed
        val updated = host.copy(
            host = address ?: host.host,
            sshHostKeyAnchors = anchors,
            sshHostKeyFingerprint = if (dropPin) null else pin
        )
        if (updated == host) return null
        return Result(
            updated, host,
            addressChanged = address != null,
            confirmedKey = confirmed?.takeIf { !accepts(host, it) && accepts(updated, it) }
        )
    }

    /** Whether a connect with [host]'s record accepts a server presenting [fingerprint] (the verifier's rule). */
    private fun accepts(host: PairedHost, fingerprint: String): Boolean {
        val pin = host.sshHostKeyFingerprint ?: return host.sshHostKeyAnchors.isEmpty() || fingerprint in host.sshHostKeyAnchors
        return pin == fingerprint
    }

    /**
     * One sentence for the host screen's SSH warning (the one up while the phone is on the relay
     * because the SSH leg failed), saying what the refresh changed for the next connect; null when it
     * changed nothing the user would act on. It is added to that warning, never instead of it: the
     * warning still describes what answered at the old address.
     */
    fun note(result: Result): String? {
        val parts = ArrayList<String>()
        if (result.addressChanged) {
            parts += "the computer reported through the relay that its address on your network is now " +
                "${result.host.host} (it was ${result.previous.host})"
        }
        result.confirmedKey?.let { key ->
            parts += "the computer confirmed through the relay that the host key its SSH server presented " +
                "($key) is one of its own, so the phone will accept it"
        }
        if (parts.isEmpty()) return null
        return "Since then, " + parts.joinToString(", and ") + ". The phone uses this from the next connect on your network."
    }
}
