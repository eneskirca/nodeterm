package dev.nodeterm.protocol.model

/** One immutable Ctrl arm: the bridge must capture its flag and revision together. */
data class CtrlModifier(val armed: Boolean = false, val revision: Long = 0L) {
    fun withArmed(value: Boolean): CtrlModifier =
        if (value == armed) this else copy(armed = value, revision = revision + 1)

    /** A delayed input callback may consume only its original arm on its original viewer. */
    fun consume(captured: CtrlModifier, current: Boolean): CtrlModifier =
        if (!current || !captured.armed || this != captured) this else withArmed(false)
}
