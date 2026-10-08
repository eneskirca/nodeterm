package dev.nodeterm.protocol.model

import java.util.concurrent.atomic.AtomicBoolean

/**
 * What of one paired computer the phone is showing right now, for the live notifications (audit A73).
 *
 * The app re-lists the computer whose screen is open every 8 s, and every fresh listing runs the same
 * announce path as the 15-minute background check, except for what the user is looking at:
 *
 * - every event while that computer's Inbox tab is on screen (the tab is where they are listed);
 * - the events of a session whose terminal is attached ([nodes]), because its pane shows them: the
 *   prompt, the question's picker, the finish. Not all of them, though ([inPane]): a held hook-reply
 *   approval is not painted until its hold ends.
 *
 * Those are recorded as seen instead of announced ([SeenLog.claimLive]), so no later check (the next
 * refresh, or the background one) announces what the user already saw. Recording is permanent, so
 * this must never claim more than the screen shows (the A73 review): a session whose terminal is
 * still connecting ([opening]) is neither recorded nor announced, and is decided by a later listing,
 * once its pane shows or an error does instead. Other computers are not polled at all, so nothing
 * here makes their notifications live: theirs still come from the background check only.
 */
data class OnScreen(
    val inbox: Boolean = false,
    /** Sessions open in a terminal that is attached: their pane is in front of the user. */
    val nodes: Set<String> = emptySet(),
    /** Sessions open in a terminal that is still connecting: their pane, or an error, is about to show. */
    val opening: Set<String> = emptySet()
) {
    /** The user is looking at [ev]. */
    fun shows(ev: InboxEvent): Boolean = inbox || (ev.nodeId in nodes && inPane(ev))

    /** [ev] would be in the pane of a terminal that is still connecting: not decided yet. */
    fun waitsFor(ev: InboxEvent): Boolean = !shows(ev) && ev.nodeId in opening && inPane(ev)

    /** [events] (a computer's feed) split by what is on screen; each part keeps the feed's order. */
    fun split(events: List<InboxEvent>): Split {
        val shown = ArrayList<InboxEvent>()
        val offScreen = ArrayList<InboxEvent>()
        val waiting = ArrayList<InboxEvent>()
        for (ev in events) {
            when {
                shows(ev) -> shown += ev
                waitsFor(ev) -> waiting += ev
                else -> offScreen += ev
            }
        }
        return Split(shown, offScreen, waiting)
    }

    data class Split(
        /** On screen: recorded as seen, never announced. */
        val shown: List<InboxEvent>,
        /** Not on screen: announced when new ([SeenLog.claimLive] decides). */
        val offScreen: List<InboxEvent>,
        /** In the pane of a terminal still connecting: left alone, for a later listing to decide. */
        val waiting: List<InboxEvent> = emptyList()
    )

    /** Where a session open in a terminal stands, for [OnScreenTracker.showNode]. */
    enum class Pane {
        /** Attached: the pane is in front of the user. */
        SHOWN,
        /** Connecting: the pane, or an error instead, is about to show. */
        OPENING,
        /** Something else covers the pane (the session ended, an offer, a code to approve, a lost view). */
        HIDDEN
    }

    companion object {
        /** Nothing of this computer on screen: the app is in the background, or shows something else. */
        val NOTHING = OnScreen()

        /**
         * Whether [ev] is painted in its session's pane. Every event is, except a held hook-reply
         * approval (it carries a `pendingId`): Claude Code applies the hook's decision before it ever
         * paints the prompt, and paints it only once the hold ends, 45 s by default
         * (docs/hook-reply-approvals.md; [dev.nodeterm.protocol.host.QuickActions] answers such an
         * approval with its ticket, never with keys, for the same reason). A subagent's concurrent
         * approval is one too, published on the parent node while its pane shows the parent's
         * question. The ticket stays on the event after the hold ends, when the prompt is painted, so
         * such an approval may be announced although it is on screen by then: a notification too many
         * beats one lost.
         */
        fun inPane(ev: InboxEvent): Boolean = !(ev.kind == InboxKind.APPROVAL && ev.pendingId != null)
    }
}

/**
 * The screens showing a computer's Inbox tab or one of its sessions right now. A screen takes a
 * handle when it starts and closes it when it stops. Screens are counted, not flagged, because the
 * next screen can start before the last one stops; closing a handle twice counts once. Thread-safe:
 * the screens register on the main thread and a refresh reads [now] from a background thread.
 */
class OnScreenTracker {
    private var inboxes = 0
    private val terminals = ArrayList<Terminal>()

    private class Terminal(val nodeId: String, val pane: () -> OnScreen.Pane)

    /**
     * What is on screen at this moment. A session is in [OnScreen.nodes] when any of its terminals is
     * [OnScreen.Pane.SHOWN], else in [OnScreen.opening] when one is [OnScreen.Pane.OPENING].
     */
    @Synchronized
    fun now(): OnScreen {
        if (inboxes == 0 && terminals.isEmpty()) return OnScreen.NOTHING
        val shown = HashSet<String>()
        val opening = HashSet<String>()
        for (t in terminals) {
            when (t.pane()) {
                OnScreen.Pane.SHOWN -> shown += t.nodeId
                OnScreen.Pane.OPENING -> opening += t.nodeId
                OnScreen.Pane.HIDDEN -> Unit
            }
        }
        opening -= shown
        return if (inboxes == 0 && shown.isEmpty() && opening.isEmpty()) OnScreen.NOTHING
        else OnScreen(inboxes > 0, shown, opening)
    }

    /** The computer's Inbox tab is on screen until the handle is closed. */
    fun showInbox(): AutoCloseable {
        synchronized(this) { inboxes++ }
        return handle { inboxes-- }
    }

    /**
     * The session [nodeId] is open in a terminal until the handle is closed; [pane] says, whenever a
     * listing asks, whether that terminal shows its pane. It is called from the refresh's thread under
     * this tracker's lock, so it must only read state. Without it the terminal counts as attached.
     */
    fun showNode(nodeId: String, pane: () -> OnScreen.Pane = { OnScreen.Pane.SHOWN }): AutoCloseable {
        val t = Terminal(nodeId, pane)
        synchronized(this) { terminals += t }
        return handle { terminals.remove(t) }
    }

    private fun handle(release: () -> Unit): AutoCloseable {
        val closed = AtomicBoolean(false)
        return AutoCloseable {
            if (closed.compareAndSet(false, true)) synchronized(this@OnScreenTracker) { release() }
        }
    }
}
