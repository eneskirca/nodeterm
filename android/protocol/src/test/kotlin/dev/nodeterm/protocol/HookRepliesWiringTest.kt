package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertTrue
import java.io.File

class HookRepliesWiringTest {
    @Test fun `native actions use complete structured selections and explicitly selected rule scope`() {
        val source = AppSourcePins.ui("InboxTab.kt")
        assertTrue("ev.pendingId != null && ev.permissionSuggestions.isNotEmpty()" in source)
        assertTrue("Text(suggestion.label)" in source)
        assertTrue("QuickActions.rememberApproval(c, ev, index)" in source)
        assertTrue("is QuestionChoices.Held ->" in source)
        assertTrue("choices.questions.forEachIndexed" in source)
        assertTrue("if (question.multiSelect) Checkbox" in source)
        assertTrue("else RadioButton" in source)
        assertTrue("!busy && selected.all { it.isNotEmpty() }" in source)
        assertTrue("QuickActions.answerQuestions(c, ev, answer)" in source)
        val run = AppSourcePins.blockAfter(source, "fun runOn(")
        AppSourcePins.assertInOrder(run, "val actionKey = from.computer.hostId to eventId", "if (actionKey in pendingActions) return", "pendingActions = pendingActions + actionKey", "scope.launch")
        assertTrue("pendingActions = pendingActions - actionKey" in run)
        AppSourcePins.assertInOrder(run, "catch (e: CancellationException)", "throw e", "catch (e: Exception)")
    }
    @Test fun `SSH sends the bounded original-derived reply over stdin and requires confirmed exit status`() {
        val source = File(InteropHarness.repoRoot, "android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt").readText()
        assertTrue("HookReplies.belongsToNode(event.nodeId, ticket)" in source)
        assertTrue("SshScripts.readHookRequest(event.nodeId, ticket)" in source)
        assertTrue("SshScripts.answerHook(event.nodeId, ticket, checksum), stdin = reply, uncertainWrite = true, outputLimit = 1024" in source)
        assertTrue("cmd.outputStream.use" in source)
        assertTrue("writeCode != 0" in source)
    }
}
