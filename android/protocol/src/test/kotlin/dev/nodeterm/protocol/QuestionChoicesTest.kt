package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.QuestionChoices
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * A57: a multi-select AskUserQuestion card showed only "Open session", so the Inbox did not say what
 * was being asked. Its options are now shown, numbered and read-only, under a line that says the
 * question takes several and is answered in the session; a single-select question keeps its answer
 * buttons. The rule is pure and tested here. The card itself cannot run on a JVM, so what it draws for
 * each case is pinned in the app's source ([AppSourcePins]); how it looks is a device check.
 */
class QuestionChoicesTest {
    private fun event(
        kind: InboxKind = InboxKind.QUESTION,
        options: List<String> = listOf("Red", "Green", "Blue"),
        multiSelect: Boolean = false
    ) = InboxEvent(
        id = "e1", ts = 1, nodeId = "term-1", agentId = "claude", sessionId = "s", kind = kind,
        title = "Which colours?", detail = null, interrupted = false, resolved = false,
        options = options, multiSelect = multiSelect, pendingId = null
    )

    @Test
    fun `a single-select question is answered from the card, one numbered row per option`() {
        assertEquals(
            QuestionChoices.Answer(listOf("1. Red", "2. Green", "3. Blue")),
            QuestionChoices.of(event())
        )
    }

    @Test
    fun `a multi-select question shows its options read-only, numbered in the question's order`() {
        assertEquals(
            QuestionChoices.ReadOnly(listOf("1. Red", "2. Green", "3. Blue")),
            QuestionChoices.of(event(multiSelect = true))
        )
    }

    @Test
    fun `nothing is shown without options, or on a card that is not a question`() {
        assertEquals(QuestionChoices.None, QuestionChoices.of(event(options = emptyList())))
        assertEquals(QuestionChoices.None, QuestionChoices.of(event(options = emptyList(), multiSelect = true)))
        assertEquals(QuestionChoices.None, QuestionChoices.of(event(kind = InboxKind.APPROVAL)))
        assertEquals(QuestionChoices.None, QuestionChoices.of(event(kind = InboxKind.DONE)))
    }

    private val inbox get() = AppSourcePins.ui("InboxTab.kt")

    @Test
    fun `the card draws its options by this rule, not by its own`() {
        // The pre-fix gate (`!ev.multiSelect`) dropped a multi-select question's options entirely.
        assertFalse(inbox.contains("ev.multiSelect"), "InboxTab decides by QuestionChoices.of, not by the flag")
        AppSourcePins.assertInOrder(inbox, "when (val choices = QuestionChoices.of(ev))")
    }

    @Test
    fun `a single-select row answers through QuickActions`() {
        val answer = AppSourcePins.blockAfter(inbox, "is QuestionChoices.Answer ->")
        AppSourcePins.assertInOrder(answer, "choices.rows.forEachIndexed", "OutlinedButton(", "QuickActions.answerQuestion(c, ev, i)")
    }

    @Test
    fun `a multi-select card says it is answered in the session, shows the rows as text, and offers the session`() {
        val readOnly = AppSourcePins.blockAfter(inbox, "is QuestionChoices.ReadOnly ->")
        AppSourcePins.assertInOrder(
            readOnly,
            "QuestionChoices.SEVERAL_NOTE",
            "choices.rows.forEach",
            "Text(",
            "TextButton(onClick = { open(ev.nodeId) })",
            "Open session"
        )
        // No answer path: nothing in the branch types a key or draws a button per option.
        assertFalse(readOnly.contains("answerQuestion"), readOnly)
        assertFalse(readOnly.contains("OutlinedButton"), readOnly)
        assertFalse(readOnly.contains("clickable"), readOnly)
    }
}
