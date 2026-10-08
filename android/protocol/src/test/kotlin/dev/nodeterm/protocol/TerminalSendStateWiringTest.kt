package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Lexical Android delegation pins; behavioral coverage is in TerminalSendStateTest. */
class TerminalSendStateWiringTest {
    @Test fun `button and IME share entry admission before JS preparation with the accepted modifier`() {
        val screen = AppSourcePins.ui("TerminalScreen.kt")
        val send = AppSourcePins.blockAfter(screen, "val send: () -> Unit = {")
        AppSourcePins.assertInOrder(send, "if (controller.attached)", "val sent = entry.beginSend()",
            "if (sent != null) controller.submit(sent.value.text, enter = true, modifier = sent.ctrl",
            "entry.completeSend(sent.attempt, result, current)", "entry.clearUnchangedDraft(sent.revision)")
        assertTrue(screen.contains("KeyboardActions(onSend = { send() })"))
        assertTrue(screen.contains("IconButton(onClick = send, enabled = controller.attached && editor.pendingSend == null && !controller.submitting)"))
        val submit = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "fun submit(text:")
        AppSourcePins.assertInOrder(submit, "ComposedCompletion(modifier.revision)", "submitting = true",
            "ComposedPreparation.cancelMomentum", "view.evaluateJavascript", "graph.scope.launch",
            "withTimeoutOrNull(3_000)", "actor.submit(input) else ComposedInputResult.refused()", "finally {", "main.post")
    }

    @Test fun `captured entry outcome settles after stale retirement separately from guarded delivery clearing`() {
        val submit = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "fun submit(text:")
        val posted = AppSourcePins.blockAfter(submit, "main.post")
        AppSourcePins.assertInOrder(posted, "val current = webView === view && stream === expected && actions === actor && attached",
            "if (onCompleted(completion, current))", "completionPolicy.complete(completion, current, ctrlModifier.revision, { ctrlArmed = false }, onDelivered)")
        assertFalse(posted.contains("if (current)"), "retained outcome is visible even after the old controller is disposed")
        assertFalse(submit.contains("notice ="), "Send outcome has one retained notice owner")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(submit, "fun refuse("),
            "onCompleted(ComposedInputResult.refused(message), false)", "return false")
    }

    @Test fun `retained Send guidance takes precedence over generic notices and dismisses its exact identity`() {
        val screen = AppSourcePins.ui("TerminalScreen.kt")
        AppSourcePins.assertInOrder(screen, "val editor by entry.state.collectAsState()", "val sendNotice = editor.sendNotice",
            "(sendNotice?.message ?: controller.notice)?.let", "if (sendNotice != null) entry.dismissSendNotice(sendNotice)",
            "else controller.notice = null")
        assertFalse(screen.contains("controller.notice?.let"), "generic notices cannot duplicate or hide the retained Send notice")
    }
}
