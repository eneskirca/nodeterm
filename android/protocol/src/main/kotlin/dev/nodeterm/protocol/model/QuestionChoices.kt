package dev.nodeterm.protocol.model

/**
 * What an Inbox question card shows under the question (audit A57), and the one rule
 * [dev.nodeterm.protocol.host.QuickActions.answerQuestion] answers by, so the card never offers an
 * answer the action would refuse.
 *
 * Held v2 questions expose the complete schema and explicit selections to the hook. A malformed
 * held schema never falls back to digits. Legacy unheld single-select prompts retain numbered
 * actions; legacy multi-select prompts remain read-only because their terminal keys are unmeasured.
 */
sealed interface QuestionChoices {
    /** A live held v2 picker: explicit selections for every question, never terminal digits. */
    data class Held(val ticket: String, val questions: List<HookQuestion>) : QuestionChoices
    /** Each row is a quick answer: tapping row i types the digit i + 1 (`QuickActions.answerQuestion`). */
    data class Answer(val rows: List<String>) : QuestionChoices

    /** The picker takes several options: the rows are shown under [SEVERAL_NOTE] and never answered. */
    data class ReadOnly(val rows: List<String>) : QuestionChoices

    /** No options to show: an approval, a finished turn, or a question the desktop sent without a picker. */
    data object None : QuestionChoices

    companion object {
        /** Marks a [ReadOnly] card: its rows are not buttons, and the answer is given in the session. */
        const val SEVERAL_NOTE = "Choose several — answer in the session."

        fun of(event: InboxEvent): QuestionChoices {
            if (event.kind == InboxKind.QUESTION && event.questionPendingId != null)
                return if (event.questions.isNotEmpty()) Held(event.questionPendingId, event.questions) else None
            if (event.kind != InboxKind.QUESTION || event.options.isEmpty()) return None
            // Numbered in the order the question lists them (the desktop keeps that order).
            val rows = event.options.mapIndexed { i, option -> "${i + 1}. $option" }
            return if (event.multiSelect) ReadOnly(rows) else Answer(rows)
        }
    }
}
