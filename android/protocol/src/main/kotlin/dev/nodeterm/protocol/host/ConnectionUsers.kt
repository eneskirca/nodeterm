package dev.nodeterm.protocol.host

/**
 * Who is using one computer's connection (the review of audit A25): the screens that show the
 * computer ([watch]) and the background jobs that run on it ([hold]), the periodic Inbox check and an
 * answer given from a notification.
 *
 * They all share ONE connection, and the relay leg opened next to it. A background job closes it when
 * it ends, so the socket is not held open for a screen nobody looks at; but only the LAST user may do
 * that. Each job used to close it whenever no screen watched, under another job still sending on it:
 * two answers to one computer a few seconds apart, or an answer and the background check, and the
 * first to finish cut the other off, which then reported its answer unconfirmed (or never sent it).
 *
 * A computer's own screen leaves the connection for a quick return. All computers instead requests
 * closure when its last watcher leaves, after any in-flight listing or background job finishes. The app's HostSession owns one of these per computer; this is the
 * counting, kept pure so the JVM tests it.
 */
class ConnectionUsers {
    private var watchers = 0
    private var holders = 0
    private var closeWhenIdle: (() -> Unit)? = null

    /** A screen shows the computer now. */
    val watched: Boolean
        @Synchronized get() = watchers > 0

    /** A screen started showing the computer. True when it is the first (start re-listing). */
    @Synchronized
    fun watch(): Boolean {
        // A new screen supersedes a stopped screen's deferred close, even if its cancelled listing
        // has not returned yet. That old listing must never close the new screen's connection.
        closeWhenIdle = null
        return ++watchers == 1
    }

    /** A screen stopped showing the computer. True when none is left (stop re-listing). */
    @Synchronized
    fun unwatch(close: (() -> Unit)? = null): Boolean {
        watchers = (watchers - 1).coerceAtLeast(0)
        if (watchers == 0 && close != null) {
            closeWhenIdle = close
            closeIfIdle()
        }
        return watchers == 0
    }

    /** Called under this object's lock; closure detaches the old socket without suspending. */
    private fun closeIfIdle() {
        if (holders == 0 && watchers == 0) {
            val closing = closeWhenIdle
            closeWhenIdle = null
            closing?.invoke()
        }
    }

    /**
     * Runs [block] as a background user of the connection. When it ends (normally, by an error or by
     * cancellation), [close] runs if nothing else uses the connection: no other background user and
     * no screen. A null [close] protects a foreground listing without changing quick-return policy;
     * it still delivers a close requested by a stopped All computers screen or a background job. [close] runs under this object's lock and must not block or suspend: a user that
     * arrives meanwhile is either counted before the decision, or finds the connection already closed
     * and dials its own, never one closed under it.
     */
    suspend fun <T> hold(close: (() -> Unit)?, block: suspend () -> T): T {
        synchronized(this) { holders++ }
        try {
            return block()
        } finally {
            synchronized(this) {
                holders--
                if (watchers == 0 && close != null) closeWhenIdle = close
                closeIfIdle()
            }
        }
    }
}
