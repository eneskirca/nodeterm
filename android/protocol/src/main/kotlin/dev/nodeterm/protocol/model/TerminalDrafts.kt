package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.host.ComposedCompletion
import dev.nodeterm.protocol.host.ComposedInputResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Full editor values belong to a live navigation entry, not to its current composition. Kept only
 * in this process: no command text goes into the Activity Bundle or a file. Popping/replacing an
 * entry, forgetting its host, or starting a different stack retires it and releases its value.
 */
class TerminalDrafts<V>(private val empty: V) {
    data class State<V>(val value: V, val revision: Long = 0, val ctrl: CtrlModifier = CtrlModifier(),
        val pendingSend: SendAttempt? = null, val sendNotice: SendNotice? = null)

    /** Identity, not a reusable counter: an old entry or callback cannot settle another attempt. */
    class SendAttempt internal constructor(val revision: Long, val ctrl: CtrlModifier)
    class SendNotice internal constructor(val status: ComposedInputResult.Status, val message: String)
    class Submission<V> internal constructor(val value: V, val attempt: SendAttempt) {
        val revision: Long get() = attempt.revision
        val ctrl: CtrlModifier get() = attempt.ctrl
    }

    class Entry<V> internal constructor(val owner: String, private val empty: V) {
        private val lock = Any()
        private var retired = false
        private val current = MutableStateFlow(State(empty))
        val state: StateFlow<State<V>> = current.asStateFlow()

        /** Even an edit away and back to identical text is a new draft. */
        fun edit(value: V): Boolean = synchronized(lock) {
            if (retired) return false
            current.value = current.value.copy(value = value, revision = current.value.revision + 1)
            true
        }

        fun setCtrl(value: CtrlModifier): Boolean = synchronized(lock) {
            if (retired) return false
            current.value = current.value.copy(ctrl = value)
            true
        }

        /** Reserve before JS preparation, from the accepted editor rather than a collected UI value. */
        fun beginSend(): Submission<V>? = synchronized(lock) {
            if (retired || current.value.pendingSend != null) return null
            val before = current.value
            val attempt = SendAttempt(before.revision, before.ctrl)
            current.value = before.copy(pendingSend = attempt)
            Submission(before.value, attempt)
        }

        /** Outcome survives coverage; delivery-side clearing still needs the original current viewer. */
        fun completeSend(attempt: SendAttempt, result: ComposedInputResult, currentViewer: Boolean): Boolean = synchronized(lock) {
            if (retired || current.value.pendingSend !== attempt) return false
            val outcome = if (!currentViewer && result.status == ComposedInputResult.Status.DELIVERED)
                ComposedInputResult.uncertain() else result
            val notice = when (outcome.status) {
                ComposedInputResult.Status.DELIVERED -> current.value.sendNotice
                ComposedInputResult.Status.REFUSED -> current.value.sendNotice?.takeIf {
                    it.status == ComposedInputResult.Status.UNCERTAIN
                } ?: SendNotice(outcome.status, outcome.message ?: "Send was not sent. The draft was kept.")
                ComposedInputResult.Status.UNCERTAIN -> SendNotice(outcome.status,
                    outcome.message ?: "Send could not be confirmed. Check the terminal before sending the retained draft again.")
            }
            current.value = current.value.copy(pendingSend = null, sendNotice = notice)
            true
        }

        /** A delayed dismissal cannot hide guidance from a newer attempt. */
        fun dismissSendNotice(notice: SendNotice): Boolean = synchronized(lock) {
            if (retired || current.value.sendNotice !== notice) return false
            current.value = current.value.copy(sendNotice = null)
            true
        }

        /** The callback reads this entry now, including edits accepted before UI recomposition. */
        fun clearUnchangedDraft(sentRevision: Long): Boolean = synchronized(lock) {
            if (retired) return false
            ComposedCompletion.clearUnchangedDraft(sentRevision, current.value.revision) { edit(empty) }
        }

        internal fun retire() = synchronized(lock) {
            retired = true
            current.value = State(empty, current.value.revision + 1)
        }
    }

    private val entries = mutableMapOf<String, Entry<V>>()

    @Synchronized
    fun entry(key: String, owner: String): Entry<V> {
        val previous = entries[key]
        if (previous != null && previous.owner == owner) return previous
        previous?.retire()
        return Entry(owner, empty).also { entries[key] = it }
    }

    /** Reconcile against the whole live stack, including a newly restored or fresh Activity. */
    @Synchronized
    fun retain(keys: Set<String>) {
        val removed = entries.keys.filter { it !in keys }
        removed.forEach { entries.remove(it)?.retire() }
    }

    @Synchronized
    fun retireOwner(owner: String) {
        val removed = entries.filterValues { it.owner == owner }.keys.toList()
        removed.forEach { entries.remove(it)?.retire() }
    }
}
