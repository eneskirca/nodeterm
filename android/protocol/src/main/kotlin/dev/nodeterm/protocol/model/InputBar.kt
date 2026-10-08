package dev.nodeterm.protocol.model

/**
 * What the terminal screen's input bar does with the text in it (audits A34, A41). The screen
 * (TerminalController) is only type-checked; this pins the rules it delegates to.
 */
object InputBar {
    sealed interface Send {
        /**
         * No stream is attached (still connecting, disconnected, ended, or awaiting approval): nothing
         * is sent. The caller keeps its draft and an armed Ctrl stays armed, so the same tap works once
         * the terminal is back. Sending anyway reached a null stream, dropped the bytes, and the screen
         * then cleared the draft as if it had gone (A41).
         */
        data object NotAttached : Send

        /**
         * Ctrl armed and ONE character that has a control byte: that byte alone, with no Enter (^Z then
         * Enter is not ^Z). The bar goes through xterm's bracketed paste, so the per-keystroke Ctrl in
         * the bridge would never see a single character (A34).
         */
        data class Control(val bytes: String) : Send

        /** The text through xterm's bracketed paste, then Enter when asked. An armed Ctrl is disarmed. */
        data class Paste(val text: String, val enter: Boolean) : Send
    }

    /** What sending [text] does, given whether a stream is [attached] and whether Ctrl is [ctrlArmed]. */
    fun plan(attached: Boolean, ctrlArmed: Boolean, text: String, enter: Boolean): Send = when {
        !attached -> Send.NotAttached
        ctrlArmed -> Keys.ctrl(text)?.let { Send.Control(it) } ?: Send.Paste(text, enter)
        else -> Send.Paste(text, enter)
    }
}
