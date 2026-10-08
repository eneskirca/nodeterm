package dev.nodeterm.protocol.ssh

import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.host.HostException
import java.security.MessageDigest

/** A definitive refusal before this request created or changed a session; a new choice is safe. */
class SshTerminalCreationRefusedException(message: String) : HostException(message)

/** Independently owned plain shells, never managed agent nodes on a desktop canvas. */
object PhoneTerminals {
    const val PROJECT_ID = "host:phone-terminals"
    const val PROJECT_NAME = "Phone terminals"
    const val ID_OPTION = "@nodeterm_phone_id"
    const val CREATION_OPTION = "@nodeterm_phone_creation"
    const val CWD_OPTION = "@nodeterm_phone_cwd"
    const val CREATION_ENV = "NODETERM_PHONE_CREATION"
    const val ID_ENV = "NODETERM_PHONE_ID"
    const val CWD_ENV = "NODETERM_PHONE_CWD"
    const val REQUEST_ENV = "NODETERM_PHONE_REQUEST_CWD"

    private val ID = Regex("^phone-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val FINGERPRINT = Regex("^[0-9a-f]{64}$")

    fun validId(id: String): Boolean = ID.matches(id)
    fun validCwd(cwd: String): Boolean = cwd.startsWith('/') && cwd.length <= 4096 &&
        cwd.none { it.code < 32 || it.code in 127..159 }

    fun fingerprint(nodeId: String, cwd: String?): String {
        require(validId(nodeId)) { "Invalid phone terminal id." }
        require(cwd == null || validCwd(cwd)) { "Choose an absolute folder without control characters." }
        val bytes = (nodeId + "\u0000" + (cwd ?: "\u0000HOME")).toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    data class Entry(val id: String, val cwd: String, val creation: String)

    /** The immutable marker is installed by new-session itself; the options finish its listing. */
    fun parse(line: String): Entry? {
        val parts = line.split('\t')
        if (parts.size != 6) return null
        val (session, id, creation, cwd, marker) = parts
        val request = parts[5]
        if (!validId(id) || session != TmuxNames.sessionName(id) || !FINGERPRINT.matches(creation) ||
            marker != creation || !validCwd(cwd)) return null
        val requestedCwd = if (request == "HOME") null else request.takeIf(::validCwd) ?: return null
        if (requestedCwd != null && requestedCwd != cwd) return null
        if (creation != fingerprint(id, requestedCwd)) return null
        return Entry(id, cwd, creation)
    }
}
