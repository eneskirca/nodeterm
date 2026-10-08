package dev.nodeterm.protocol.model

/**
 * What an Inbox notification says (audit A52).
 *
 * An event's own text is the sensitive part. For an approval, [InboxEvent.title] and
 * [InboxEvent.detail] are the desktop's tool summary: the command's first line, a file path with its
 * diff size, a fetched URL (`buildApprovalSummary`, src/core/agent-status-mirror.ts). Without that
 * summary the title is the first line of the agent's last message. For a question it is the question
 * itself, and for a finished turn the detail is the agent's last message. Android shows a
 * notification's full content on a secure lock screen unless the user has turned on "hide sensitive
 * content", and that is not the default. A public version alone therefore hides nothing in the
 * default case. So by default the notification carries none of that text: the title names the
 * session and whether it needs you or completed, and the text names the kind of event. The event's
 * own text is added only when the user opts in ("Show details in notifications").
 *
 * The public version (what a lock screen that hides sensitive content shows) is built here too, and
 * never carries the event's text, whatever the setting.
 *
 * The iOS app does get the detail: the desktop sends the same title and detail in the APNs push body
 * (src/core/push-notify.ts), and what iOS then shows on its lock screen is up to iOS's own preview
 * setting. That is a difference in platform defaults, not an Android-only leak; this app does not
 * copy it.
 */
data class InboxNotificationText(
    val title: String,
    val text: String,
    /** The expanded text (BigTextStyle), or null when the notification has none. */
    val bigText: String?,
    /** The public version's title: [title]'s session and kind, nothing from the event. */
    val publicTitle: String,
    /** The public version's text: the computer's name. */
    val publicText: String
) {
    companion object {
        /** The session's name when the listing has none. */
        const val FALLBACK_SESSION = "Session"

        /**
         * [sessionName] is the session's name as the listing gives it (null or blank = unknown),
         * [computerName] the paired computer's. [showDetails] is the user's opt-in; off by default.
         */
        fun of(event: InboxEvent, sessionName: String?, computerName: String, showDetails: Boolean): InboxNotificationText {
            val session = sessionName?.trim()?.takeIf { it.isNotEmpty() } ?: FALLBACK_SESSION
            val headline = when (event.kind) {
                InboxKind.APPROVAL, InboxKind.QUESTION -> "Needs you — $session"
                InboxKind.DONE -> "Completed — $session"
            }
            val kind = kindLabel(event)
            val own = if (showDetails) listOf(event.title, event.detail.orEmpty()).map { it.trim() }.filter { it.isNotEmpty() } else emptyList()
            return InboxNotificationText(
                title = headline,
                text = own.joinToString(" — ").ifEmpty { kind },
                bigText = own.takeIf { it.isNotEmpty() }?.joinToString("\n"),
                publicTitle = headline,
                publicText = computerName
            )
        }

        /**
         * The kind of event in words, close to the Inbox card's chip but not always the same words
         * (the chip says QUESTION). Never the event's own text.
         */
        fun kindLabel(event: InboxEvent): String = when (event.kind) {
            InboxKind.APPROVAL -> "Needs approval"
            InboxKind.QUESTION -> "Has a question"
            InboxKind.DONE -> if (event.interrupted) "Interrupted" else "Finished"
        }
    }
}
