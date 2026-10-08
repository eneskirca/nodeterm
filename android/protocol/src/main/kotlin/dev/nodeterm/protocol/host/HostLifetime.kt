package dev.nodeterm.protocol.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** Local publication leases and owned pending dials; no network work runs under this monitor. */
class HostLifetime {
    class Lease internal constructor(internal val owner: HostLifetime, internal val generation: Long)
    @Volatile private var generation = 0L
    @Volatile private var retired = false
    private val pending = mutableSetOf<Job>()
    val active: Boolean get() = !retired

    @Synchronized
    fun capture(): Lease {
        if (retired) throw CancellationException("This computer connection was forgotten.")
        return Lease(this, generation)
    }

    /** Nonlocking so a HostStore publication gate never takes this monitor in reverse order. */
    fun isCurrent(lease: Lease): Boolean = lease.owner === this && !retired && generation == lease.generation

    fun requireCurrent(lease: Lease) {
        if (!isCurrent(lease)) throw CancellationException("This computer connection changed.")
    }

    @Synchronized
    fun <T> publish(lease: Lease, block: () -> T): T {
        requireCurrent(lease)
        return block()
    }

    @Synchronized
    fun whenCurrent(lease: Lease, block: () -> Unit): Boolean {
        if (!isCurrent(lease)) return false
        block()
        return true
    }

    /** Cancel the exact pending transport operation, never unrelated user work. A blocking SSH
     * child remains structured until it returns, letting its caller close the returned socket. */
    suspend fun <T> dial(lease: Lease, block: suspend () -> T): T = coroutineScope {
        val operation = async(start = CoroutineStart.LAZY) { block() }
        synchronized(this@HostLifetime) {
            requireCurrent(lease)
            pending += operation
        }
        operation.invokeOnCompletion { synchronized(this@HostLifetime) { pending.remove(operation) } }
        operation.start()
        operation.await()
    }

    /** Disconnect may reconnect, but work admitted before it cannot publish to the next dial. */
    fun disconnect(close: () -> Unit) = invalidate(permanent = false, close)

    /** A forgotten object never reconnects or publishes again, even if its local id is reused. */
    fun retire(close: () -> Unit) = invalidate(permanent = true, close)

    private fun invalidate(permanent: Boolean, close: () -> Unit) {
        var cancel = emptyList<Job>()
        try {
            synchronized(this) {
                if (permanent) retired = true
                generation++
                cancel = pending.toList()
                pending.clear()
                close()
            }
        } finally {
            // Cancellation handlers may re-enter native/store callbacks. Never run them under
            // our monitor. This stops local approval polling; it does not revoke desktop consent.
            for (operation in cancel) operation.cancel(CancellationException("This computer connection changed."))
        }
    }
}
