package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.o
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.J.strings
import dev.nodeterm.protocol.model.QuestionChoices
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The actions an Inbox notification carries, and what it says once one has run (audit A25).
 *
 * The iOS app gets numbered actions on the APNs push the desktop sends (src/core/push-notify.ts: "The
 * backend renders them as numbered notification actions"). Android has no push leg (the backend's
 * `/v1/push` routes are APNs-only), but the notifications the app posts itself can carry the same
 * answers: Approve / Deny on an approval and an option on a single-select question, sent through
 * [QuickActions] with all its re-checks (still unresolved, the node-state rules, the ticketed path
 * of audit A38), exactly as the Inbox card sends them. This object is the decision: which actions an
 * event gets ([plan]), how an answer runs ([perform]) and what the notification says afterwards
 * ([settled]). It is pure, so the JVM tests it; the app's part (the PendingIntents, the receiver, the
 * expedited worker) is pinned in the app's source.
 *
 * The rules:
 *  - **The card's rule, not a second one.** An approval gets Approve / Deny only when
 *    [QuickActions.answersApproval] says it can be answered from outside the session, and a question
 *    gets its options only when [QuestionChoices] lists them as answers. What the answer path would
 *    turn into "open the session" is not offered; the notification offers Open instead.
 *  - **Three at most** ([MAX_ACTIONS]): Android shows no more. A question with more options than that
 *    offers Open, never its first three: a tap would answer a picker whose other options were never
 *    shown.
 *  - **Never a first relay handshake** ([reachableQuietly]). The user tapped, but is not looking at
 *    the app, so nobody would compare the approval code the desktop shows on a phone's first relay
 *    connect (RelayApprovalGate, audit A05). An answer goes over the SSH leg or over a relay that has
 *    already approved this phone; a computer reachable only otherwise gets Open, which opens the app.
 *  - **No event text in a label unless the user asked for it** (audit A52): a question's options are
 *    "Option 1", "Option 2", … unless "Show details in notifications" is on. Approve and Deny say
 *    nothing about the request.
 *  - **Never retried.** An answer that may or may not have arrived is said to be unconfirmed
 *    ([Outcome.UNCONFIRMED]), never sent again: a second `1` lands in whatever the pane shows by then.
 *    That includes the run WorkManager starts again on its own after an interrupted one ([answerOnce]).
 *  - **Keys only for a card the computer still lists** ([QuickActions]): a notification can stay in the
 *    shade for hours after its card was settled and dropped from the desktop's feed, while the node
 *    blocks on a newer prompt; its Approve must not answer that one.
 */
object InboxNotificationActions {
    /** Android shows at most three actions on a notification. */
    const val MAX_ACTIONS = 3

    /** An option's label is cut to this many characters (only with details on: the label is its text). */
    const val MAX_LABEL_CHARS = 40

    /** How long reaching the computer may take before the notification says it could not be reached. */
    const val CONNECT_BUDGET_MS = 30_000L

    /** How long the answer may take once connected before the notification says it is unconfirmed. */
    const val ANSWER_BUDGET_MS = 30_000L

    /** How long a settled notification ("Approved.") stays before it goes away by itself. */
    const val SETTLED_SHOWN_MS = 10_000L

    /** [Action.option] of an action that is not an option. */
    const val NO_OPTION = -1

    /** The label of the action that opens the session instead of answering. */
    const val OPEN_LABEL = "Open"

    /** The notification id of [eventId] on [hostId]: one notification per event per computer. */
    fun notificationId(hostId: String, eventId: String): Int = "$hostId:$eventId".hashCode()

    enum class Verb(val wire: String) {
        APPROVE("approve"),
        DENY("deny"),
        /** Picks the question's option [Action.option] (0-based; the digit typed is one more). */
        OPTION("option"),
        /** Opens the session; answers nothing. */
        OPEN("open");

        companion object {
            fun of(wire: String?): Verb? = entries.firstOrNull { it.wire == wire }
        }
    }

    data class Action(val verb: Verb, val label: String, val option: Int = NO_OPTION) {
        /**
         * Answers from the notification (a broadcast to the app, which needs an unlocked phone);
         * [Verb.OPEN] opens the session instead.
         */
        val answers: Boolean get() = verb != Verb.OPEN

        /** Unique among one notification's actions: what tells their PendingIntents apart. */
        val key: String get() = if (verb == Verb.OPTION) "${verb.wire}-$option" else verb.wire
    }

    /**
     * Whether the computer can be reached without a FIRST relay handshake: over its SSH leg ([sshLeg]:
     * the pairing installed a key and the route allows SSH), or through a relay leg that has already
     * approved this phone ([relayLeg] and [relayApproved]). A notification action uses only these; an
     * open connection may be reused whatever it is, since reusing it makes no handshake.
     *
     * The SSH leg counts whether or not the phone is on the computer's network right now, which it
     * cannot know before it dials. So a computer paired with an SSH key always gets the answers, and
     * one tapped away from its network goes through the relay if that has approved this phone, or
     * else ends as [Outcome.UNREACHABLE] with nothing sent. Only a computer reached through the relay
     * alone, which has not approved this phone, gets Open; but the listing that raised the
     * notification normally came over that relay and so approved it, and in practice the answers are
     * offered and it is the tap that ends as [Outcome.NOT_APPROVED], if the approval was lost since.
     */
    fun reachableQuietly(sshLeg: Boolean, relayLeg: Boolean, relayApproved: Boolean): Boolean =
        sshLeg || (relayLeg && relayApproved)

    /**
     * The actions a notification for [event] carries, at most [MAX_ACTIONS]. None for a finished turn
     * or a settled card (the tap opens the session). [showDetails] is "Show details in notifications";
     * [reachableQuietly] is [InboxNotificationActions.reachableQuietly] for the event's computer.
     */
    fun plan(event: InboxEvent, showDetails: Boolean, reachableQuietly: Boolean): List<Action> {
        if (!event.actionable) return emptyList()
        val open = listOf(Action(Verb.OPEN, OPEN_LABEL))
        if (!reachableQuietly) return open
        return when (event.kind) {
            InboxKind.APPROVAL ->
                if (QuickActions.answersApproval(event)) listOf(Action(Verb.APPROVE, "Approve"), Action(Verb.DENY, "Deny"))
                else open
            InboxKind.QUESTION -> {
                val choices = QuestionChoices.of(event) as? QuestionChoices.Answer
                if (choices == null || choices.rows.size > MAX_ACTIONS) open
                else choices.rows.mapIndexed { i, row ->
                    Action(Verb.OPTION, if (showDetails) cap(row) else "Option ${i + 1}", option = i)
                }
            }
            InboxKind.DONE -> emptyList()
        }
    }

    private fun cap(label: String): String {
        val oneLine = label.replace(Regex("\\s+"), " ").trim()
        return if (oneLine.length <= MAX_LABEL_CHARS) oneLine else oneLine.take(MAX_LABEL_CHARS - 1).trimEnd() + "…"
    }

    /** What happened to an answer given from a notification. */
    enum class Outcome {
        APPROVED,
        DENIED,
        ANSWERED,
        /** The card was settled before the answer arrived (on the computer, or elsewhere). Nothing was sent. */
        ALREADY_HANDLED,
        /** The hook's hold ended before the answer arrived; the prompt is in the session now (audit A06). */
        EXPIRED,
        /** The answer path sends this one to the session after all (QuickActions said so). */
        OPEN_SESSION,
        /** Reaching the computer would take a first relay handshake, whose code nobody would see. Nothing was sent. */
        NOT_APPROVED,
        /** The computer could not be reached. Nothing was sent. */
        UNREACHABLE,
        /** Connected, but the answer was not confirmed: it may or may not have reached the computer. */
        UNCONFIRMED,
        /** The phone was locked (Android 11 and lower, whose system does not ask for the unlock). Nothing was sent. */
        LOCKED,
        /** The computer is no longer paired with this phone. Nothing was sent. */
        NOT_PAIRED
    }

    /** [QuickActions]' [result] of [action], as the notification reports it. */
    fun outcomeOf(action: Action, result: QuickActions.Result): Outcome = when (result) {
        QuickActions.Result.SENT -> when (action.verb) {
            Verb.APPROVE -> Outcome.APPROVED
            Verb.DENY -> Outcome.DENIED
            Verb.OPTION -> Outcome.ANSWERED
            Verb.OPEN -> Outcome.OPEN_SESSION
        }
        QuickActions.Result.ALREADY_HANDLED -> Outcome.ALREADY_HANDLED
        QuickActions.Result.EXPIRED -> Outcome.EXPIRED
        QuickActions.Result.OPEN_SESSION -> Outcome.OPEN_SESSION
    }

    /**
     * What the notification says once an answer settled: [text], and how long it stays
     * ([dismissAfterMs]; null = until the user deals with it). Its tap always opens the session. An
     * outcome that leaves something to do says "Tap" and stays; one that is done goes away by itself.
     * No outcome carries the event's own text (audit A52).
     */
    data class Settled(val text: String, val dismissAfterMs: Long?)

    fun settled(outcome: Outcome, action: Action, computerName: String): Settled = when (outcome) {
        Outcome.APPROVED -> Settled("Approved.", SETTLED_SHOWN_MS)
        Outcome.DENIED -> Settled("Denied.", SETTLED_SHOWN_MS)
        Outcome.ANSWERED -> Settled("Answered with option ${action.option + 1}.", SETTLED_SHOWN_MS)
        Outcome.ALREADY_HANDLED -> Settled("Already handled.", SETTLED_SHOWN_MS)
        Outcome.EXPIRED -> Settled("The request timed out on the computer. Tap to answer it in the session.", null)
        Outcome.OPEN_SESSION -> Settled("This one is answered in the session. Tap to open it.", null)
        Outcome.NOT_APPROVED -> Settled(
            "Not sent: this phone reaches $computerName only through the relay, and it has not approved this phone " +
                "yet. Tap to open the app and connect.",
            null
        )
        Outcome.UNREACHABLE -> Settled("Not sent: couldn't reach $computerName. Tap to answer it in the session.", null)
        Outcome.UNCONFIRMED -> Settled("Couldn't confirm that the answer reached $computerName. Tap to check the session.", null)
        Outcome.LOCKED -> Settled("Not sent: unlock the phone first. Tap to answer it in the session.", null)
        Outcome.NOT_PAIRED -> Settled("Not sent: $computerName is no longer paired with this phone.", null)
    }

    /** What the notification says while the answer is on its way (its actions are gone by then). */
    fun sendingText(action: Action): String = when (action.verb) {
        Verb.APPROVE -> "Approving…"
        Verb.DENY -> "Denying…"
        Verb.OPTION -> "Answering with option ${action.option + 1}…"
        Verb.OPEN -> "Opening…"
    }

    /**
     * Runs [action] on [event] through [QuickActions], over [connect] (the computer's connection) and,
     * when the direct-SSH transport sends the node to the relay ([NeedsRelayException], audit A09),
     * over [viaRelay]. Both must never make a first relay handshake: the caller passes the
     * background trigger ([RelayApprovalGate.Trigger.BACKGROUND]). Never throws but for cancellation.
     *
     * A dial that fails or takes longer than [connectBudgetMs] has sent nothing ([Outcome.UNREACHABLE]);
     * an answer that fails or takes longer than [answerBudgetMs] once connected may have
     * ([Outcome.UNCONFIRMED]), and is not retried.
     */
    suspend fun perform(
        action: Action,
        event: InboxEvent,
        connect: suspend () -> HostConnection,
        viaRelay: suspend () -> HostConnection,
        connectBudgetMs: Long = CONNECT_BUDGET_MS,
        answerBudgetMs: Long = ANSWER_BUDGET_MS
    ): Outcome {
        if (!action.answers) return Outcome.OPEN_SESSION
        val primary = dial(connect, connectBudgetMs) ?: return Outcome.UNREACHABLE
        var attempt = attempt(primary, action, event, answerBudgetMs)
        if (attempt is Attempt.NeedsRelay) {
            // The SSH transport refused before sending anything; the node is answered where it lives.
            val relay = dial(viaRelay, connectBudgetMs) ?: return Outcome.UNREACHABLE
            attempt = attempt(relay, action, event, answerBudgetMs)
        }
        return when (attempt) {
            is Attempt.Answered -> outcomeOf(action, attempt.result)
            // The relay leg never refuses a node that way; if it did, it sent nothing.
            Attempt.NeedsRelay -> Outcome.UNREACHABLE
            Attempt.Unconfirmed -> Outcome.UNCONFIRMED
        }
    }

    /**
     * One computer as an answer from a notification reaches it ([answerOnce]): the app's HostSession,
     * whose every dial is the background one ([RelayApprovalGate.Trigger.BACKGROUND]), which never
     * makes a first relay handshake.
     */
    interface QuietRoute {
        /** A connection to the computer is open already: reusing it makes no handshake. */
        val connected: Boolean

        /** [InboxNotificationActions.reachableQuietly] for the computer, now. */
        fun reachableQuietly(): Boolean

        /**
         * Runs [block] holding the computer's connection, which other users share (a second answer, the
         * background check, a screen): it is closed afterwards only when none of them still uses it
         * ([ConnectionUsers]).
         */
        suspend fun hold(block: suspend () -> Outcome): Outcome

        /** The computer's connection ([perform]'s `connect`). */
        suspend fun connect(): HostConnection

        /** The relay leg next to it ([perform]'s `viaRelay`). */
        suspend fun viaRelay(): HostConnection
    }

    /**
     * The whole answer a notification's work gives, in this order:
     *
     *  1. A run that is not the work's first ([runAttempt] > 0, WorkManager's run attempt count) sends
     *     nothing and says the answer is unconfirmed. WorkManager runs work again when it was
     *     interrupted rather than finished: the system stopped the job, or the process died while it
     *     ran (the work is set back to enqueued at the next start, possibly hours later). The first run
     *     may have sent the answer, and nothing records whether it did; a second `1` would land in
     *     whatever the pane shows by then.
     *  2. [route] null: the computer is no longer paired ([Outcome.NOT_PAIRED]).
     *  3. Holding the connection ([QuietRoute.hold]) for the rest: with no connection open and no quiet
     *     reach, [Outcome.NOT_APPROVED] and nothing is dialed; else [perform].
     */
    suspend fun answerOnce(
        action: Action,
        event: InboxEvent,
        runAttempt: Int,
        route: QuietRoute?,
        connectBudgetMs: Long = CONNECT_BUDGET_MS,
        answerBudgetMs: Long = ANSWER_BUDGET_MS
    ): Outcome {
        if (runAttempt > 0) return Outcome.UNCONFIRMED
        if (!action.answers) return Outcome.OPEN_SESSION
        val r = route ?: return Outcome.NOT_PAIRED
        return r.hold {
            if (!r.connected && !r.reachableQuietly()) Outcome.NOT_APPROVED
            else perform(action, event, { r.connect() }, { r.viaRelay() }, connectBudgetMs, answerBudgetMs)
        }
    }

    private sealed interface Attempt {
        data class Answered(val result: QuickActions.Result) : Attempt
        data object NeedsRelay : Attempt
        data object Unconfirmed : Attempt
    }

    private suspend fun dial(open: suspend () -> HostConnection, budgetMs: Long): HostConnection? = try {
        withTimeoutOrNull(budgetMs) { open() }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private suspend fun attempt(conn: HostConnection, action: Action, event: InboxEvent, budgetMs: Long): Attempt = try {
        withTimeoutOrNull(budgetMs) { Attempt.Answered(answer(conn, action, event)) } ?: Attempt.Unconfirmed
    } catch (_: NeedsRelayException) {
        Attempt.NeedsRelay
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        Attempt.Unconfirmed
    }

    private suspend fun answer(conn: HostConnection, action: Action, event: InboxEvent): QuickActions.Result = when (action.verb) {
        Verb.APPROVE -> QuickActions.answerApproval(conn, event, allow = true)
        Verb.DENY -> QuickActions.answerApproval(conn, event, allow = false)
        Verb.OPTION -> QuickActions.answerQuestion(conn, event, action.option)
        Verb.OPEN -> QuickActions.Result.OPEN_SESSION
    }

    /**
     * One tap on an answering action, as the app hands it from the notification to its receiver and on
     * to the worker (an Intent extra, then the work's input; both are strings, so it is one JSON
     * string, [encode]). It names the notification to update ([notificationId], with the words it
     * shows: [headline], [computerName]), the terminal its tap opens ([sessionTitle]), the [action],
     * and the [event] with the fields [QuickActions] reads. Never the event's title or detail, which
     * nothing after the tap needs (audit A52).
     */
    data class Request(
        val hostId: String,
        val computerName: String,
        val notificationId: Int,
        /** The notification's title ([dev.nodeterm.protocol.model.InboxNotificationText.title]). */
        val headline: String,
        /** The session's name, for the terminal the notification's tap opens. */
        val sessionTitle: String,
        val action: Action,
        val event: InboxEvent
    ) {
        /** One answer per event in flight: a second tap while the first runs is ignored. */
        val workName: String get() = "nodeterm.inbox.answer.$hostId.${event.id}"

        fun encode(): String = JsonObject(
            mapOf(
                "v" to JsonPrimitive(VERSION),
                "hostId" to JsonPrimitive(hostId),
                "computer" to JsonPrimitive(computerName.take(MAX_TEXT)),
                "notificationId" to JsonPrimitive(notificationId),
                "headline" to JsonPrimitive(headline.take(MAX_TEXT)),
                "sessionTitle" to JsonPrimitive(sessionTitle.take(MAX_TEXT)),
                "verb" to JsonPrimitive(action.verb.wire),
                "label" to JsonPrimitive(action.label),
                "option" to JsonPrimitive(action.option),
                "event" to JsonObject(
                    buildMap<String, JsonElement> {
                        put("id", JsonPrimitive(event.id))
                        put("ts", JsonPrimitive(event.ts))
                        put("nodeId", JsonPrimitive(event.nodeId))
                        event.agentId?.let { put("agentId", JsonPrimitive(it)) }
                        event.sessionId?.let { put("sessionId", JsonPrimitive(it)) }
                        put("kind", JsonPrimitive(event.kind.wire))
                        put("options", JsonArray(event.options.take(MAX_OPTIONS).map { JsonPrimitive(it.take(MAX_TEXT)) }))
                        put("multiSelect", JsonPrimitive(event.multiSelect))
                        event.pendingId?.let { put("pendingId", JsonPrimitive(it)) }
                    }
                )
            )
        ).toString()

        companion object {
            private const val VERSION = 1L
            private const val MAX_TEXT = 200
            private const val MAX_OPTIONS = 9

            /** The request [encode] wrote, or null for anything else (a missing or malformed field). */
            fun decode(raw: String?): Request? {
                val o = J.obj(J.parse(raw ?: return null)) ?: return null
                if (o.l("v") != VERSION) return null
                val hostId = o.s("hostId")?.takeIf { it.isNotEmpty() } ?: return null
                val notificationId = o.l("notificationId")?.takeIf { it in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() }?.toInt() ?: return null
                val verb = Verb.of(o.s("verb")) ?: return null
                val option = o.l("option")?.toInt() ?: return null
                if (verb == Verb.OPTION && option !in 0..8) return null
                val e = o.o("event") ?: return null
                val event = InboxEvent(
                    id = e.s("id")?.takeIf { it.isNotEmpty() } ?: return null,
                    ts = e.l("ts") ?: return null,
                    nodeId = e.s("nodeId")?.takeIf { it.isNotEmpty() } ?: return null,
                    agentId = e.s("agentId"),
                    sessionId = e.s("sessionId"),
                    kind = InboxKind.of(e.s("kind")) ?: return null,
                    title = "",
                    detail = null,
                    interrupted = false,
                    resolved = false,
                    options = e.strings("options"),
                    multiSelect = e.b("multiSelect") ?: return null,
                    pendingId = e.s("pendingId")
                )
                return Request(
                    hostId = hostId,
                    computerName = o.s("computer") ?: return null,
                    notificationId = notificationId,
                    headline = o.s("headline") ?: return null,
                    sessionTitle = o.s("sessionTitle") ?: return null,
                    action = Action(verb, o.s("label") ?: return null, option),
                    event = event
                )
            }
        }
    }
}
