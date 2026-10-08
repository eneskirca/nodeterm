package dev.nodeterm.protocol.host

/**
 * The terminal screen's page (the WebView running xterm.js), by generation (audit A45).
 *
 * The renderer process behind a WebView can go away on its own: Android kills it to reclaim memory,
 * or it crashes. That WebView can never be used again, so the screen destroys it and builds a new
 * one, which loads a new page. Every page gets a generation from [build], and its bridge callbacks
 * carry it. A callback of a page that is gone (posted to the main thread before the loss, run after
 * it) therefore cannot mark the NEXT page ready ([ready] answers null), and the JavaScript queued for
 * a page that never became ready is dropped with it ([lost]) instead of being replayed into the next.
 *
 * JavaScript for the page goes through [offer]: run it now when the current page is ready, otherwise
 * it waits until that page is. What is offered while there is no page at all (after [lost], before
 * the next [build]) is kept for the next page: a reattach may paint before the replacement exists.
 *
 * Thread-safe. The screen calls it on the main thread; [isCurrent] also from the bridge thread.
 */
class TerminalPage {
    private var generation = 0
    private var ready = false
    private var replacing = false
    private data class Offered(val code: String, val viewer: Long?)
    private val pending = ArrayList<Offered>()
    private var viewer: Long? = null
    val currentGeneration: Int
        @Synchronized get() = generation

    /** The current page has loaded and runs JavaScript as it is offered. */
    val isReady: Boolean
        @Synchronized get() = ready

    /**
     * A page was lost and its replacement has not loaded yet. An attach started now would size the
     * pty from defaults (80×24) instead of from the new page, so the screen waits for [ready].
     */
    val isReplacing: Boolean
        @Synchronized get() = replacing

    /** A new page starts loading (a new WebView). Returns its generation, for its bridge. */
    @Synchronized
    fun build(): Int {
        generation++
        ready = false
        return generation
    }

    /** True while [gen] is the page being shown (or loading): its callbacks count. */
    @Synchronized
    fun isCurrent(gen: Int): Boolean = gen == generation

    /**
     * Page [gen] finished loading. Returns the JavaScript queued for it, in order, to run now (empty
     * when nothing was queued, or when it had already said so), or null when [gen] is a page that is
     * gone: it is not ready, and nothing is handed over.
     */
    @Synchronized
    fun ready(gen: Int): List<String>? {
        if (gen != generation) return null
        if (ready) return emptyList()
        ready = true
        replacing = false
        return pending.filter { it.viewer == null || it.viewer == viewer }.map { it.code }.also { pending.clear() }
    }

    /** JavaScript for the page: true = run it now; false = queued until the page is ready. */
    @Synchronized
    fun offer(code: String): Boolean {
        if (ready) return true
        pending += Offered(code, null)
        return false
    }

    /** Same-page reconnects retire viewer JS too, while keeping page-global font/config setup. */
    @Synchronized
    fun viewerChanged(ticket: Long?) {
        viewer = ticket
        pending.removeAll { it.viewer != null }
    }

    /** Paint, output and input must never be adopted by a later viewer of the same unready page. */
    @Synchronized
    fun offerViewer(ticket: Long, code: String): Boolean {
        if (viewer != ticket) return false
        if (ready) return true
        pending += Offered(code, ticket)
        return false
    }

    /**
     * The current page's renderer is gone. Its generation is retired (its late callbacks are
     * refused), and what was queued for it is dropped: it was meant for a screen that no longer
     * exists, and the reattach that follows paints the whole screen again.
     */
    @Synchronized
    fun lost() {
        generation++
        ready = false
        replacing = true
        viewer = null
        pending.clear()
    }
}

/**
 * What the terminal screen does once its page's renderer is gone (audit A45). The page is replaced
 * either way; the question is what the screen shows meanwhile, and who reattaches the terminal. The
 * screen builds the replacement at once only for an automatic reattach of a visible screen, which
 * the bound below limits; otherwise it waits for whatever asks for the next attach (a button, or the
 * screen being started again), so a page that dies as it loads is not rebuilt with nobody asking.
 *
 * It depends first on what the screen was [Showing]:
 * - An ANSWER with its own button ([Showing.SETTLED]: the session ended or the connection dropped,
 *   the session opens through the relay, or the view was already lost) is kept as it was, and its
 *   button drives the next attach. Nothing reattaches unasked: over the relay an attach to a pane that
 *   has exited creates a new, empty session, and after a crash offer an automatic reattach would repaint
 *   the screen the user was asked about.
 * - Otherwise ([Showing.ATTACHED] or [Showing.OPENING]) the attach the loss retired is replaced:
 *   - the system KILLED the renderer (`didCrash` false): nothing is wrong with what the page showed,
 *     so the screen reattaches by itself once the new page is ready. With the renderer's priority
 *     waived while the screen is not visible, this is the normal way a backgrounded terminal loses its
 *     page;
 *   - the renderer CRASHED: the cause may be what the pane printed, and a reattach paints the same
 *     screen again, so reattaching unasked could crash it over and over. The screen offers "Reopen
 *     terminal" and the user decides;
 *   - a kill also falls back to the offer after [maxAutomatic] automatic reattaches within [windowMs]:
 *     a device that keeps killing a visible renderer should not have the app fight it in a loop. A
 *     kill while the screen is not visible does not count (the review of A45): the renderer's priority
 *     is waived then, so that kill is expected, and the screen reattaches only when it comes back.
 *
 * The offer says the session is still running only when a stream was attached ([Showing.ATTACHED]):
 * that is the only case in which the screen knew. While it was still opening the terminal, it knew
 * nothing about the session yet (it may not exist, or not on this host).
 *
 * Thread-safe. [onGone]'s `now` is a MONOTONIC millisecond clock supplied by the caller
 * (`SystemClock.elapsedRealtime()` on the phone): with a wall clock, one set back would keep old
 * kills in the window, and one set forward would clear them.
 */
class RendererRecovery(private val windowMs: Long = 60_000L, private val maxAutomatic: Int = 2) {
    /** What the terminal screen was showing when its renderer went away. */
    enum class Showing {
        /** A stream was attached: the session was running a moment ago. */
        ATTACHED,

        /**
         * Opening the terminal: connecting, waiting for the computer to approve this phone, waiting
         * for a page, or in the background. The loss retires the attach in flight.
         */
        OPENING,

        /** An answer with its own button (ended, disconnected, relay offer, view lost). Nothing in flight. */
        SETTLED
    }

    sealed interface Outcome {
        /** Keep what the screen shows; its own button drives the next attach. */
        data object Keep : Outcome

        /** Reattach by itself once the new page is ready. */
        data object Reattach : Outcome

        /** Offer "Reopen terminal" with [message]; the user decides when to reattach. */
        data class Offer(val message: String) : Outcome
    }

    private val automatic = ArrayDeque<Long>()

    /**
     * The renderer went away: [didCrash] as Android reports it, [now] on a monotonic clock, what the
     * screen was [showing], and whether the screen was [visible] (started, in front of the user).
     */
    @Synchronized
    fun onGone(didCrash: Boolean, now: Long, showing: Showing, visible: Boolean): Outcome {
        // Not counted against the automatic reattaches: none happens.
        if (showing == Showing.SETTLED) return Outcome.Keep
        if (!didCrash) {
            // Expected while the screen is not visible, and not counted: the bound is for a device
            // that keeps killing a renderer the user is looking at. The screen reattaches when it is
            // started again, and a kill after that counts.
            if (!visible) return Outcome.Reattach
            while (automatic.isNotEmpty() && now - automatic.first() >= windowMs) automatic.removeFirst()
            if (automatic.size < maxAutomatic) {
                automatic.addLast(now)
                return Outcome.Reattach
            }
        }
        return Outcome.Offer(offerMessage(didCrash, showing))
    }

    private fun offerMessage(didCrash: Boolean, showing: Showing): String {
        val what = if (didCrash) "The terminal view crashed." else "Android keeps closing the terminal view to free memory."
        return if (showing == Showing.ATTACHED) "$what The session is still running on the computer." else what
    }
}
