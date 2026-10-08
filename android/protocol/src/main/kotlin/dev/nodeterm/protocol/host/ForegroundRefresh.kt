package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * One computer's foreground listing loop, shared by every visible screen. The app supplies its real
 * refresh and 8-second delay. All computers starts with AUTO; opening an individual computer starts
 * with USER. Subsequent ticks always use AUTO, preserving refused or timed-out approval holds.
 *
 * [serial] covers the entire connect/list/publish/announce operation, including manual and pushed
 * refreshes. It also counts the in-flight listing, so stopping a watcher never closes a connection
 * under a background answer. Cancellation releases both the listing lock and its ownership count.
 */
class ForegroundRefresh(
    private val scope: CoroutineScope,
    private val users: ConnectionUsers,
    private val close: () -> Unit,
    private val refresh: suspend (Trigger) -> Unit,
    private val pause: suspend () -> Unit,
) {
    private val listing = Mutex()
    private var pollJob: Job? = null

    suspend fun <T> serial(block: suspend () -> T): T = users.hold(null) {
        listing.withLock { block() }
    }

    @Synchronized
    fun start(initialTrigger: Trigger = Trigger.USER) {
        users.watch()
        if (pollJob == null) {
            val starting = scope.launch(start = CoroutineStart.LAZY) {
                var trigger = initialTrigger
                while (isActive) {
                    refresh(trigger)
                    trigger = Trigger.AUTO
                    pause()
                }
            }
            pollJob = starting
            starting.start()
        }
    }

    /** A push or reconnect belongs to the current watcher, including its delay and queued listing. */
    @Synchronized
    fun changed(stillCurrent: () -> Boolean = { true }, beforeRefresh: suspend () -> Unit = {}): Job? {
        val parent = pollJob ?: return null
        if (!users.watched || !parent.isActive) return null
        return scope.launch(parent) {
            beforeRefresh()
            if (isActive && users.watched && stillCurrent()) refresh(Trigger.AUTO)
        }
    }

    /** Cancel immediately; the last in-flight user delivers a deferred close when it finishes. */
    @Synchronized
    fun stop(closeWhenUnused: Boolean = false): Job? {
        if (!users.unwatch(if (closeWhenUnused) close else null)) return null
        val stopped = pollJob
        pollJob = null
        stopped?.cancel()
        return stopped
    }
}
