package dev.nodeterm.protocol.host

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A terminal stream with more than one reason to stay attached (audit A40).
 *
 * The screen showing the stream is one holder (every lease starts with that hold). A session the
 * phone is starting is another, from the moment its attach returns until the launch line is typed
 * and the node is registered ([PhoneLaunch]). The stream is detached when the LAST holder lets go,
 * exactly once, on whichever thread that happens.
 */
class StreamLease(val stream: TerminalStream, private val detach: (TerminalStream) -> Unit) {
    private var holds = 1

    /** Take another hold. False once the stream has been let go of (it is detached, or ended). */
    @Synchronized
    fun acquire(): Boolean {
        if (holds == 0) return false
        holds++
        return true
    }

    /** Let go of one hold. The last one detaches the stream; a release after that does nothing. */
    fun release() {
        val last = synchronized(this) {
            if (holds == 0) return
            holds--
            holds == 0
        }
        if (last) detach(stream)
    }

    /** The stream ended by itself (the pane exited, or the connection went): nothing is left to detach. */
    @Synchronized
    fun ended() {
        holds = 0
    }
}

/**
 * The screen's side of the attach hand-off (audit A40).
 *
 * An attach runs off the main thread and hands its stream over afterwards, by a posted runnable. By
 * the time that runs, the screen may have gone to the background, gone for good, or started a newer
 * attach. So every attach takes a ticket ([begin]); [leave] and [close] invalidate every ticket
 * issued so far, and [accept] installs a lease only for the CURRENT ticket. Any other hand-off lets
 * go of the screen's hold at once, so a stream nobody shows is never left attached. The same ticket
 * tells a superseded attach's output and exit apart from the current one's ([isCurrent], [ended]).
 *
 * Every method is thread-safe; the lease's detach runs outside the lock.
 */
class ViewerSlot {
    private var ticket = 0L
    private var closed = false
    private var lease: StreamLease? = null

    /** The stream the screen is showing, or null. */
    val stream: TerminalStream?
        @Synchronized get() = lease?.stream

    /** A new attach starts. Returns its ticket. A stream still shown is let go of. */
    fun begin(): Long {
        val t: Long
        val old: StreamLease?
        synchronized(this) {
            ticket++
            t = ticket
            old = lease
            lease = null
        }
        old?.release()
        return t
    }

    /** True while [t] is the latest attach and the screen has not left since it began. */
    @Synchronized
    fun isCurrent(t: Long): Boolean = !closed && t == ticket

    /**
     * The attach [t] hands over [lease]. Installed only while [t] is current; otherwise the screen's
     * hold is released here, which detaches the stream unless someone else (a launch) still holds it.
     */
    fun accept(t: Long, lease: StreamLease): Boolean {
        val ok = synchronized(this) {
            val current = !closed && t == ticket && this.lease == null
            if (current) this.lease = lease
            current
        }
        if (!ok) lease.release()
        return ok
    }

    /**
     * The stream of attach [t] ended by itself. True when that was the screen's current stream: it is
     * forgotten (there is nothing to detach) and a hand-off of [t] that has not landed yet will not
     * install it. False for a stream the screen had already let go of.
     */
    fun ended(t: Long): Boolean {
        synchronized(this) {
            if (closed || t != ticket) return false
            ticket++
            lease?.ended()
            lease = null
        }
        return true
    }

    /** The screen went to the background: let go of the stream and of every hand-off still in flight. */
    fun leave() {
        val old = synchronized(this) {
            ticket++
            lease.also { lease = null }
        }
        old?.release()
    }

    /** The screen is gone for good: [leave], and refuse every hand-off from now on. */
    fun close() {
        synchronized(this) { closed = true }
        leave()
    }
}

/**
 * The second half of starting a session from the phone (audits A33, A14, A40). The attach created the
 * tmux session in its project; this types the agent's launch line once the shell has settled (a line
 * delivered across the rc-file tty flush comes out mangled), THEN puts the node on the canvas.
 * Registering first would let the desktop mount it cold and launch the agent too.
 *
 * The request was consumed to get here, so nothing can retry it, and the launch finishes whatever the
 * screen does meanwhile. Leaving the screen is not cancelling the session the user asked for. The
 * other option, aborting and leaving the `nt-<id>` session the attach created, is an unregistered
 * shell that no canvas shows. So [start] takes its own hold on the lease BEFORE the caller hands the
 * stream to the screen, and runs in the caller's long-lived scope, not in the screen's attach job
 * (which the screen cancels when it goes to the background).
 */
object PhoneLaunch {
    /** How long the new shell gets to settle before its launch line is typed. */
    const val SETTLE_MS = 900L

    /** [CANNOT_REGISTER]: the connection has no `projects.registerNode` (nothing was asked). */
    enum class Outcome { REGISTERED, REFUSED, CANNOT_REGISTER }

    /**
     * Start the launch on [lease]'s stream. Call it before the lease is handed to anyone else: it
     * throws if the stream has already been let go of. [then] runs after the hold is released.
     */
    fun start(
        scope: CoroutineScope,
        lease: StreamLease,
        command: String?,
        register: (suspend () -> Boolean)?,
        settle: suspend (Long) -> Unit = { delay(it) },
        then: suspend (Outcome) -> Unit = {}
    ): Job {
        check(lease.acquire()) { "The stream was let go of before its launch started." }
        return scope.launch {
            val outcome = try {
                settle(SETTLE_MS)
                if (command != null) runCatching { lease.stream.write(command + "\r") }
                when {
                    register == null -> Outcome.CANNOT_REGISTER
                    // A refusal is an ANSWER (host-service: the session stays open, just unregistered).
                    runCatching { register() }.getOrDefault(false) -> Outcome.REGISTERED
                    else -> Outcome.REFUSED
                }
            } finally {
                lease.release()
            }
            then(outcome)
        }
    }
}
