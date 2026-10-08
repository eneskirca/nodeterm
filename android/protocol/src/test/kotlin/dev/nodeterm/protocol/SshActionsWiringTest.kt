package dev.nodeterm.protocol

import java.io.File
import kotlin.test.*

/** Native adapter pins supplement executed model/shell/producer tests; no Android runtime required. */
class SshActionsWiringTest {
    private fun source() = File(InteropHarness.repoRoot, "android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt").readText().replace("\r\n", "\n")
    @Test fun `cached capabilities preserve independent Git and never promise cold registration`() {
        val s = source()
        assertTrue(s.contains("actions.capabilities.copy(git = true)"))
        val model = File(InteropHarness.repoRoot, "android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshActions.kt").readText()
        assertTrue(model.contains("registerNode = false"))
        assertTrue(s.contains("registerNode(projectId: String, node: NewNode): Boolean = relayOnly"))
    }
    @Test fun `profile and ownership are one captured listing before a service call`() {
        val s = source()
        assertTrue(s.contains("ActionListing(ud, own.projects.filterNot { it.drivenRemotely })"))
        assertTrue(s.contains("val listing = actionListing"))
        assertTrue(s.contains("actions.call(listing.userData, method, params"))
        assertTrue(s.contains("SshActions.owns(listing.projects, projectId, nodeId, it)"))
        assertFalse(s.contains("actions.call(userData, method"))
    }
    @Test fun `each advertised mutation uses typed service APIs with confirmed replies`() {
        val s = source()
        for (verb in listOf("node.wake", "node.refresh", "node.rename", "projects.ensureBoard", "projects.setCardColumn", "projects.editCardLabels")) assertTrue(s.contains("\"$verb\""), verb)
        assertTrue(s.contains("if (!result.flag(\"delivered\"))"))
        assertTrue(s.contains("result as? JsonObject ?: SshActions.uncertain()"))
        assertTrue(s.contains("}).flag(\"moved\")"))
    }
    @Test fun `stdin write bounded output and honest transport uncertainty reach finalized run`() {
        val s = source()
        assertTrue(s.contains("run(script, timeout, stdin, uncertainWrite = write, outputLimit = limit)"))
        assertTrue(s.contains("SSH output exceeded the ${'$'}outputLimit byte limit"))
        assertTrue(s.contains("if (uncertainWrite && dispatched) throw HostUnansweredException(message)"))
    }
    @Test fun `retired transport and empty listings retire advertised service capabilities`() {
        val s = source()
        val close = s.substringAfter("private fun fireClosed(reason: String?) {").substringBefore("private fun ")
        assertTrue(close.contains("actions.clear()"))
        val missing = s.substringAfter("if (out.nothingFound(now)) {").substringBefore("throw NothingFoundException()")
        assertTrue(missing.contains("ActionListing(null, emptyList())")); assertTrue(missing.contains("actions.clear()"))
    }
}
