package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.SshAuthRefusedException
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.SshIdentity
import java.util.Locale
import java.util.UUID
import javax.net.SocketFactory

/**
 * A computer added by its SSH address instead of a pairing code: "Add SSH server" (audit A27, part b).
 *
 * The computers a pairing code cannot reach: a headless Server Edition (there is no pairing service
 * anywhere in `src/server`), and a dev host the phone reaches only over SSH, where another computer's
 * nodeterm runs sessions (`-L nodeterm-rmt`). The browse is the SSH one ([SshScripts], [HostBrowse]),
 * which already finds a Server Edition's data dir and what a driving desktop leaves on the computer.
 *
 * What differs from pairing, and why:
 *
 *  - **The key.** Pairing has the desktop install the phone's key; here nothing on the computer acts
 *    for the phone, and the phone cannot install its key before it can log in. So the user adds the
 *    line [authorizedKeysLine] to `~/.ssh/authorized_keys` themselves ([installCommand] does it in one
 *    line, idempotently). [SshPasswordBootstrap] also offers memory-only password enrollment after
 *    explicit host fingerprint confirmation. Ordinary connections use the retained phone key.
 *  - **The host key.** No QR carries anything to check it against, so it is trust on first use, by
 *    A49's rule: [connectFirst] pins the key of the first server that ACCEPTS this phone's key, never
 *    of one that merely answered, and the record is made only then. The app shows the pin with
 *    [FINGERPRINT_CHECK_COMMAND], so the user can compare it on the computer.
 *  - **No relay, ever.** A Server Edition has no standing phone host, and a plain SSH host's own
 *    nodeterm (if any) never paired this phone. The record is [PairedHost.manual]; the app fixes its
 *    route to SSH and never adopts a relay for it, and every relay offer says remote access is not set
 *    up for this computer. So no "from anywhere" (beyond whatever reaches its SSH, a VPN say) and no
 *    push: the backend's push fan-out is APNs-only.
 *
 * Pure but for [connectFirst], which dials; all of it is JVM-tested (`ManualHostTest`).
 */
object ManualHost {
    const val DEFAULT_PORT = 22

    /** The comment on the phone's `authorized_keys` line, which is how the user finds it to revoke it. */
    const val KEY_COMMENT = "nodeterm-android"

    /**
     * Prefix of a computer-added-by-address's local id (a paired one's is the desktop's deviceId). The
     * record reads it back as [PairedHost.manual] when an older build's save dropped the key.
     */
    const val ID_PREFIX = PairedHost.MANUAL_ID_PREFIX

    const val MAX_NAME = 60
    private const val MAX_HOST = 253
    private const val MAX_USER = 64

    /** How long the first connect may take: longer than a paired computer's LAN dial, since it may go over a VPN. */
    const val FIRST_CONNECT_TIMEOUT_MS = 15_000

    /**
     * Prints the computer's SSH host key fingerprints in the phone's format (`SHA256:…`), one per key
     * type; the pinned one is among them. Every OpenSSH since 6.8 prints SHA256 by default.
     */
    const val FINGERPRINT_CHECK_COMMAND = "for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf \"\$f\"; done"

    /** What the user types, checked: where to connect, as whom, and what to call it. */
    data class Address(val host: String, val port: Int, val user: String, val name: String)

    sealed interface Check {
        data class Ok(val address: Address) : Check

        /** One message per field that is wrong, null for a field that is fine. */
        data class Invalid(val host: String?, val port: String?, val user: String?) : Check
    }

    /**
     * Check the form. [host] is a host name, an IPv4 address or an IPv6 one (bare or in brackets);
     * [port] blank means 22; [name] blank means the host. Nothing here resolves or dials.
     */
    fun check(host: String, port: String, user: String, name: String = ""): Check {
        val h = host.trim().removeSurrounding("[", "]")
        val hostError = hostError(host.trim(), h)
        val p = port.trim()
        val portNumber = if (p.isEmpty()) DEFAULT_PORT else p.takeIf { it.all(Char::isDigit) && it.length <= 5 }?.toInt()
        val portError = if (portNumber == null || portNumber !in 1..65535) "Enter a port from 1 to 65535 (SSH's is 22)." else null
        val u = user.trim()
        val userError = userError(u)
        if (hostError != null || portError != null || userError != null) return Check.Invalid(hostError, portError, userError)
        val label = name.filterNot(Char::isISOControl).trim().take(MAX_NAME).trim().ifEmpty { h }
        return Check.Ok(Address(h, portNumber!!, u, label))
    }

    private fun hostError(typed: String, h: String): String? {
        if (h.isEmpty()) return "Enter the computer's address, like devbox.local or 192.168.1.20."
        if ("://" in h) return "Enter the address only, without ssh:// or a path, like devbox.local."
        if (h.any(Char::isWhitespace)) return "An address has no spaces."
        if ('@' in h) return "Enter only the address here; the user name goes in User."
        if (h.length > MAX_HOST) return "That address is too long."
        val colons = h.count { it == ':' }
        if (colons == 1 && !typed.startsWith("[")) return "Enter the port in Port, not after the address."
        if (colons >= 1) {
            // IPv6: hex groups, `::`, an embedded IPv4 tail and a `%zone` (fe80::1%wlan0).
            val addr = h.substringBefore('%')
            val zone = h.substringAfter('%', "")
            val ok = addr.isNotEmpty() && addr.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' } &&
                (zone.isEmpty() || zone.all { it.isLetterOrDigit() || it in "._-" })
            return if (ok) null else "That isn't an IPv6 address."
        }
        // A host name or an IPv4 address: letters, digits, `-`, `_` and dots, never starting with `-`
        // or `.`, and no empty label.
        val ok = h.all { it in 'a'..'z' || it in 'A'..'Z' || it.isDigit() || it in "-_." } &&
            h.first() != '-' && h.first() != '.' && ".." !in h
        return if (ok) null else "That isn't a host name or an IP address."
    }

    private fun userError(u: String): String? = when {
        u.isEmpty() -> "Enter the user name the phone logs in as on the computer."
        u.length > MAX_USER -> "That user name is too long."
        u.any { it.isWhitespace() || it.isISOControl() } -> "A user name has no spaces."
        u.startsWith("-") -> "A user name does not start with -."
        ':' in u -> "A user name has no colon."
        else -> null
    }

    /**
     * The computer already in the list under this address — same host (any case), port and user —
     * whether paired or added by address. Adding it again would make a second record for one login.
     */
    fun existing(hosts: List<PairedHost>, address: Address): PairedHost? = hosts.firstOrNull {
        it.host.lowercase(Locale.ROOT) == address.host.lowercase(Locale.ROOT) && it.port == address.port && it.user == address.user
    }

    fun newId(): String = ID_PREFIX + UUID.randomUUID()

    /**
     * The record kept for a computer added by address, made only once [fingerprint] is known — that
     * is, once a connect authenticated ([connectFirst]). No relay, no box key: [PairedHost.manual].
     */
    fun record(address: Address, fingerprint: String, id: String = newId(), now: Long = System.currentTimeMillis()): PairedHost {
        require(fingerprint.startsWith("SHA256:")) { "a computer is added only with its pinned host key" }
        return PairedHost(
            id = id,
            name = address.name,
            host = address.host,
            port = address.port,
            user = address.user,
            sshAvailable = true,
            hostKeyB64 = null,
            relay = null,
            sshHostKeyFingerprint = fingerprint,
            pairedAt = now,
            manual = true
        )
    }

    /** The line the user adds to `~/.ssh/authorized_keys` on the computer. */
    fun authorizedKeysLine(identity: SshIdentity): String = identity.authorizedKeysLine(KEY_COMMENT)

    /**
     * One line that adds [keyLine] to the user's `authorized_keys`, run in a terminal on the computer
     * as that user. Wrapped in `sh -c '…'` so it is the same in bash, zsh and fish, and safe to run
     * twice: the line is added only when it is not there, after a newline when the file's last line
     * has none (appending onto it would break both keys), with the modes sshd's StrictModes wants.
     * [keyLine] must be an OpenSSH public key line (its characters cannot leave the quotes).
     */
    fun installCommand(keyLine: String): String {
        require(KEY_LINE.matches(keyLine)) { "not a public key line: $keyLine" }
        return "sh -c 'mkdir -p \"\$HOME/.ssh\" && chmod 700 \"\$HOME/.ssh\" && f=\"\$HOME/.ssh/authorized_keys\" && " +
            "touch \"\$f\" && chmod 600 \"\$f\" && if ! grep -qxF \"$keyLine\" \"\$f\"; then " +
            "if [ -n \"\$(tail -c 1 \"\$f\")\" ]; then echo >> \"\$f\"; fi; echo \"$keyLine\" >> \"\$f\"; fi'"
    }

    private val KEY_LINE = Regex("""^ssh-ed25519 [A-Za-z0-9+/]+=* [A-Za-z0-9._-]+$""")

    /** Where the user revokes the phone on a computer added by address (there is no Paired devices list). */
    fun revokeHint(user: String): String =
        "To revoke the phone's access on the computer too, remove the line ending in $KEY_COMMENT from " +
            "~/.ssh/authorized_keys of $user there."

    /**
     * The first connect: dial [address] with this phone's key and, only once the server has accepted
     * it, take its host key as the pin (A49's rule; a server that refuses us pins nothing and no record
     * is made). Returns the record to keep, with that pin. The connection is closed: the app's own
     * connect, verified against the pin, does the browsing. Blocking; throws a [HostException] whose
     * message says what to do.
     */
    fun connectFirst(
        address: Address,
        identity: SshIdentity,
        id: String = newId(),
        now: Long = System.currentTimeMillis(),
        connectTimeoutMs: Int = FIRST_CONNECT_TIMEOUT_MS,
        socketFactory: SocketFactory? = null
    ): PairedHost {
        val pin = object : HostKeyPin {
            @Volatile var value: String? = null
            override fun pinned(): String? = value
            override fun pin(fingerprint: String) {
                value = fingerprint
            }
        }
        val conn = try {
            SshHostConnection.connect(address.host, address.port, address.user, identity, pin, connectTimeoutMs, socketFactory)
        } catch (e: SshAuthRefusedException) {
            throw HostException(keyNotAccepted(address))
        } catch (e: HostException) {
            throw HostException("${e.message} $UNREACHABLE_ADVICE")
        }
        conn.close()
        val fingerprint = pin.value ?: throw HostException("The computer answered without a host key the phone could pin.")
        return record(address, fingerprint, id, now)
    }

    fun keyNotAccepted(address: Address): String =
        "${address.user}@${address.host} answered, but did not accept this phone's key. Add the key line above to " +
            "~/.ssh/authorized_keys of ${address.user} on the computer (the command above does it), then connect again."

    const val UNREACHABLE_ADVICE =
        "Check the address and the port, that the phone can reach the computer (the same network, or a VPN), and " +
            "that its SSH server is on (on a Mac: System Settings → General → Sharing → Remote Login)."
}
