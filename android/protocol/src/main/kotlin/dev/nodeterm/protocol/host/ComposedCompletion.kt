package dev.nodeterm.protocol.host

/** Main-thread completion of one Send; admission, uncertainty and later generations clear nothing. */
class ComposedCompletion(private val armedRevision: Long) {
    private var completed = false

    fun complete(result: ComposedInputResult, current: Boolean, ctrlRevision: Long,
        clearCtrl: () -> Unit, onDelivered: () -> Unit): Boolean {
        if (completed) return false
        completed = true
        if (!current || result.status != ComposedInputResult.Status.DELIVERED) return false
        if (ctrlRevision == armedRevision) clearCtrl()
        onDelivered()
        return true
    }

    companion object {
        /** Revision detects an edit away and back to the same text while Send is awaiting receipt. */
        fun clearUnchangedDraft(sentRevision: Long, currentRevision: Long, clear: () -> Unit): Boolean {
            if (sentRevision != currentRevision) return false
            clear()
            return true
        }
    }
}
