package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.QuestionChoices

/**
 * The Inbox card actions (docs/mobile-usage-inbox.md "Quick approve", docs/hook-reply-approvals.md),
 * shared by every transport:
 *
 *  1. RE-READ the status before acting, and act only if what the card asks is still open (a card
 *     can be minutes old; typing `1` into a pane that moved on is typing into whatever is there now);
 *  2. a held hook-reply approval (it carries a `pendingId`) is answered DETERMINISTICALLY — the
 *     relay verb or the answer file — never with keys: while the hook holds the request, the prompt
 *     is not on screen and a keystroke would land in the agent's composer;
 *  3. keys are typed only for a claude approval with NO ticket (`1` allow / Esc deny), because only
 *     claude's prompt layout is known, and for a single-select question (its digit); anything else is
 *     "open the session" (a multi-select question's options are shown, not answered: [QuestionChoices]).
 *
 * What "still open" means differs by path, on purpose (audit A38). KEYS need the node to show
 * exactly the prompt they answer: `1` on a node whose AskUserQuestion picker is on screen picks
 * option 1 of the question instead of approving anything, so a keyed approval needs [AgentState.BLOCKED]
 * and a keyed question [AgentState.WAITING]. A TICKET does not: the desktop publishes a concurrent
 * approval (a subagent's permission) with its `pendingId` while the node keeps the parent's WAITING
 * badge for a held question (`recordAgentEvent`, src/core/agent-status-mirror.ts; pinned by
 * src/core/pending-question.test.ts), so a ticketed answer is judged by its CARD, and the host
 * refuses it ("gone") once the hook's hold has ended.
 *
 * Keys also need the fresh feed to still LIST the card, unresolved (the review of audit A25). A key
 * carries no identity of the prompt it answers, so a card the feed no longer lists is no evidence
 * that the prompt on screen is still its own: the desktop drops every event after 6 hours and trims
 * its feed to 50 events, keeping only the newest unresolved ask of each node, so a card settled long
 * ago (or an older ask the node has since moved past) disappears while the node blocks on a NEWER
 * prompt in the same state. A notification left in the shade, or a card on a screen that is not
 * re-listed, outlives that, and its `1` would approve the newer prompt. Such a card goes to the
 * session ([Result.OPEN_SESSION]): whether it was handled is not known, and the session shows what is
 * really on screen. A ticket keeps its node-state fallback: the host refuses a ticket whose hold ended.
 *
 * A v2 hook ticket exposes only concrete host-supplied allow-rule suggestions and complete question
 * schemas. These use the original held JSON, not numbered prompt choices. Older and unheld prompts
 * retain the legacy paths above; unsupported schema or an expired hold opens the session.
 */
object QuickActions {
    /**
     * [EXPIRED]: the hook's hold ended before the answer arrived (audit A06) and the request is still
     * open, so the prompt is on screen in the session — open it (with an explanation).
     */
    enum class Result { SENT, ALREADY_HANDLED, OPEN_SESSION, EXPIRED }

    suspend fun rememberApproval(conn: HostConnection, event: InboxEvent, suggestionIndex: Int): Result {
        if (event.kind != InboxKind.APPROVAL || event.pendingId == null || event.permissionSuggestions.none { it.index == suggestionIndex })
            return Result.OPEN_SESSION
        val fresh = freshCard(conn.listProjects(), event) ?: return Result.OPEN_SESSION
        if (fresh.resolved) return Result.ALREADY_HANDLED
        if (fresh.pendingId != event.pendingId || fresh.permissionSuggestions != event.permissionSuggestions) return Result.OPEN_SESSION
        return hookOutcome(conn, event, conn.rememberApproval(event, suggestionIndex))
    }

    suspend fun answerQuestions(conn: HostConnection, event: InboxEvent, selections: List<List<Int>>): Result {
        if (event.kind != InboxKind.QUESTION || event.questionPendingId == null ||
            !dev.nodeterm.protocol.model.HookReplies.validSelections(event.questions, selections)) return Result.OPEN_SESSION
        val fresh = freshCard(conn.listProjects(), event) ?: return Result.OPEN_SESSION
        if (fresh.resolved) return Result.ALREADY_HANDLED
        if (fresh.questionPendingId != event.questionPendingId || fresh.questions != event.questions) return Result.OPEN_SESSION
        return hookOutcome(conn, event, conn.answerQuestions(event, selections))
    }

    private suspend fun hookOutcome(conn: HostConnection, event: InboxEvent, outcome: ApprovalOutcome): Result = when (outcome) {
        ApprovalOutcome.SENT -> Result.SENT
        ApprovalOutcome.GONE -> if (freshCard(conn.listProjects(), event)?.resolved == true) Result.ALREADY_HANDLED else Result.EXPIRED
        ApprovalOutcome.ALREADY_HANDLED, ApprovalOutcome.UNSUPPORTED -> Result.OPEN_SESSION
    }

    suspend fun answerApproval(conn: HostConnection, event: InboxEvent, allow: Boolean): Result {
        if (event.kind != InboxKind.APPROVAL) return Result.OPEN_SESSION
        if (event.pendingId != null) return answerTicket(conn, event, allow)
        keysRefusal(conn, event, AgentState.BLOCKED)?.let { return it }
        if (!answersApproval(event)) return Result.OPEN_SESSION
        return typeOrOpen(conn, event, if (allow) "1" else "\u001b")
    }

    /**
     * Whether [answerApproval] can answer [event] from outside its session at all: a held hook-reply
     * ticket, or a claude prompt (the only prompt layout known). Anything else goes to the session.
     * The Inbox notification offers Approve / Deny by this rule (audit A25), so it never offers an
     * answer this path would turn into "open the session".
     */
    fun answersApproval(event: InboxEvent): Boolean =
        event.kind == InboxKind.APPROVAL && (event.pendingId != null || event.agentId == "claude")

    /**
     * Legacy unheld AskUserQuestion: choices are digits on screen. Only a
     * question [QuestionChoices] lists as [QuestionChoices.Answer] is typed, the rule the Inbox card
     * draws its buttons by. A multi-select question is shown read-only and answered in the session
     * (audit A57): how its picker toggles and submits has not been measured, so it gets no keys.
     */
    suspend fun answerQuestion(conn: HostConnection, event: InboxEvent, optionIndex: Int): Result {
        val choices = QuestionChoices.of(event) as? QuestionChoices.Answer ?: return Result.OPEN_SESSION
        if (optionIndex !in choices.rows.indices || optionIndex > 8) return Result.OPEN_SESSION
        keysRefusal(conn, event, AgentState.WAITING)?.let { return it }
        return typeOrOpen(conn, event, (optionIndex + 1).toString())
    }

    /** A held hook-reply approval: answered through its ticket or not at all — never with keys. */
    private suspend fun answerTicket(conn: HostConnection, event: InboxEvent, allow: Boolean): Result {
        if (!ticketStillOpen(conn.listProjects(), event)) return Result.ALREADY_HANDLED
        if (conn.capabilities.answerApprovals) {
            when (conn.answerApproval(event, allow)) {
                ApprovalOutcome.SENT -> return Result.SENT
                // Nothing was written. If the request is STILL open, the hold timed out and the prompt
                // is on screen now: "already handled" would be false — send the user to the session.
                ApprovalOutcome.GONE, ApprovalOutcome.ALREADY_HANDLED ->
                    return if (ticketStillOpen(conn.listProjects(), event)) Result.EXPIRED else Result.ALREADY_HANDLED
                ApprovalOutcome.UNSUPPORTED -> Unit
            }
        }
        // A ticketed approval we could not answer deterministically: its prompt is not on screen
        // while the hook holds it, so keys are wrong. Send the user to the session instead.
        return Result.OPEN_SESSION
    }

    /** Keys the host could not deliver are not "sent": the prompt is on screen, so open it. A
     *  [NeedsRelayException] propagates — the caller retries through the relay. */
    private suspend fun typeOrOpen(conn: HostConnection, event: InboxEvent, keys: String): Result = try {
        conn.sendKeys(event.nodeId, keys)
        Result.SENT
    } catch (e: NeedsRelayException) {
        throw e
    } catch (_: HostException) {
        Result.OPEN_SESSION
    }

    /**
     * The KEYS gate: null when the keys may be typed, else what to answer instead. The node must show
     * exactly [expected] (else [Result.ALREADY_HANDLED]), and the fresh feed must list the card,
     * unresolved: a settled card is [Result.ALREADY_HANDLED], and one the feed no longer lists is
     * [Result.OPEN_SESSION], since the prompt on screen may be a newer one (see the class comment).
     */
    private suspend fun keysRefusal(conn: HostConnection, event: InboxEvent, expected: AgentState): Result? {
        val snap = conn.listProjects()
        val status = snap.statusOf(event.nodeId) ?: return Result.ALREADY_HANDLED
        if (status.state != expected) return Result.ALREADY_HANDLED
        val fresh = freshCard(snap, event) ?: return Result.OPEN_SESSION
        return if (fresh.resolved) Result.ALREADY_HANDLED else null
    }

    /**
     * The TICKET gate: the card decides, whatever the node's badge says (a concurrent approval rides a
     * WAITING node). Only when the fresh feed no longer lists the card (the host trims its feed, and a
     * snapshot may carry none) is the node's state the remaining evidence — either needs-you state,
     * since nothing is typed on this path and the host itself refuses a hold that has ended.
     */
    private fun ticketStillOpen(snap: ProjectsSnapshot, event: InboxEvent): Boolean {
        freshCard(snap, event)?.let { return !it.resolved }
        val state = snap.statusOf(event.nodeId)?.state
        return state == AgentState.BLOCKED || state == AgentState.WAITING
    }

    private fun freshCard(snap: ProjectsSnapshot, event: InboxEvent): InboxEvent? =
        snap.status?.inbox?.events?.firstOrNull { it.id == event.id }
}
