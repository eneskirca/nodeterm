package dev.nodeterm.protocol.ssh

/** An explicit remote POSIX profile path. Null retains automatic discovery. */
object SshProfilePath {
    const val MAX_LENGTH = 4096

    fun error(path: String): String? = when {
        !path.startsWith('/') -> "Use the full absolute profile folder path on the computer."
        path.length > MAX_LENGTH -> "The profile folder path is too long."
        path.any { it.isISOControl() } -> "The profile folder path cannot contain control characters."
        path.split('/').any { it == "." || it == ".." } -> "Use the profile folder path without . or .. components."
        else -> null
    }

    /** Form input only: a blank field restores discovery; a saved invalid choice never does. */
    fun fromInput(input: String): String? {
        if (input.isBlank()) return null
        require(error(input) == null) { error(input)!! }
        return input.trimEnd('/').ifEmpty { "/" }
    }

    fun requireValid(path: String?) {
        if (path != null) require(error(path) == null) { error(path)!! }
    }
}
