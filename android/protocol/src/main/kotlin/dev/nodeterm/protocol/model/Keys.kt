package dev.nodeterm.protocol.model

/** Terminal key encodings the phone produces itself. */
object Keys {
    /**
     * The control byte for Ctrl + [text], when [text] is ONE character that has one: `@`..`_` in
     * either case (Ctrl-A = 0x01, Ctrl-[ = ESC, …) and `?` (DEL). Null otherwise.
     */
    fun ctrl(text: String): String? {
        if (text.length != 1) return null
        val ch = text[0].uppercaseChar()
        return when {
            ch in '@'..'_' -> (ch.code - 64).toChar().toString()
            ch == '?' -> "\u007f"
            else -> null
        }
    }
}
