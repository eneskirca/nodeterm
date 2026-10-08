package dev.nodeterm.protocol.host

/** An attached viewer's exit alone cannot establish whether its host session is still running. */
object TerminalExit {
    fun closedMessage(code: Int?): String =
        if (code == null) "Disconnected." else "The terminal connection closed (exit $code)."
}
