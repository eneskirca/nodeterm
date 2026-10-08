package dev.nodeterm.protocol.host

/** An explicit Send from the input bar, never a wheel, emulator reply or ordinary keystroke. */
sealed interface ComposedInput {
    data class Paste(val text: String, val enter: Boolean) : ComposedInput
    data class Control(val text: String) : ComposedInput

    /** Same paste normalization as the pinned xterm clipboard path; tmux owns framing. */
    fun normalized(): ComposedInput = when (this) {
        is Paste -> copy(text = text.replace(Regex("\\r?\\n"), "\r").replace("\u001b", "").replace("\u009b", ""))
        is Control -> this
    }

    fun valid(): Boolean = when (this) {
        is Paste -> !text.contains('\u0000') && text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES
        is Control -> text.length == 1 && (text[0].code in 0..31 || text[0].code == 127)
    }

    val size: Int get() = when (this) { is Paste -> text.length; is Control -> 1 }

    companion object { const val MAX_BYTES = 262_144 }
}

/** Delivery to this pane, not acknowledgement that its application ran the command. */
data class ComposedInputResult(val status: Status, val message: String? = null) {
    enum class Status { DELIVERED, REFUSED, UNCERTAIN }
    companion object {
        val DELIVERED = ComposedInputResult(Status.DELIVERED)
        fun refused(message: String = "This terminal changed before Send. The draft was kept.") = ComposedInputResult(Status.REFUSED, message)
        fun uncertain(message: String = "Send could not be confirmed. The draft was kept; check the terminal before sending it again.") = ComposedInputResult(Status.UNCERTAIN, message)
    }
}
