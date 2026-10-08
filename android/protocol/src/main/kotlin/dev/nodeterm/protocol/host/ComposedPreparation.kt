package dev.nodeterm.protocol.host

import kotlinx.coroutines.CompletableDeferred

/** The UI provider may throw synchronously instead of acknowledging momentum cancellation. */
object ComposedPreparation {
    fun cancelMomentum(evaluate: (complete: (Boolean) -> Unit) -> Unit): CompletableDeferred<Boolean> {
        val ready = CompletableDeferred<Boolean>()
        val lock = Any()
        var returned = false
        var early: Boolean? = null
        try { evaluate { value -> synchronized(lock) {
            if (returned) ready.complete(value) else early = value
        } } }
        catch (_: RuntimeException) { ready.complete(false) }
        finally { synchronized(lock) {
            returned = true
            early?.let { ready.complete(it) }
        } }
        return ready
    }
}
