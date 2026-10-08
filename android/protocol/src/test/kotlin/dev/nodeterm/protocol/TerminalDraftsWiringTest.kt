package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Compose/navigation need a device; these pin delegation to the tested process-owned entry store. */
class TerminalDraftsWiringTest {
    @Test fun `the real navigation entry owns the editor and pending UI work is not restored`() {
        val activity = AppSourcePins.app("MainActivity.kt")
        val screen = AppSourcePins.ui("TerminalScreen.kt")
        assertTrue(AppSourcePins.app("NodetermApp.kt").contains("val terminalDrafts = TerminalDrafts(TextFieldValue())"))
        assertTrue(activity.contains("TerminalScreen(nav, top.key, r.hostId, r.nodeId, r.title)"))
        AppSourcePins.assertInOrder(screen, "graph.terminalDrafts.entry(entryKey, hostId)", "entry.state.collectAsState()",
            "remember(hostId, nodeId, entry)", "entry.state.value.ctrl", "entry::setCtrl")
        assertFalse(screen.contains("var draft by remember"))
        assertFalse(screen.contains("rememberSaveable"), "full command text must not be copied into a saved Activity Bundle")
        val stop = AppSourcePins.blockAfter(screen, "LifecycleStartEffect(controller)")
        assertTrue(stop.contains("controller.onStop()"))
        assertTrue(AppSourcePins.blockAfter(screen, "DisposableEffect(controller)").contains("controller.dispose()"))
    }

    @Test fun `Send captures the current accepted editor and clears through its entry revision`() {
        val send = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalScreen.kt"), "val send: () -> Unit = {")
        AppSourcePins.assertInOrder(send, "val sent = entry.beginSend()", "controller.submit(sent.value.text, enter = true,",
            "entry.clearUnchangedDraft(sent.revision)", "dictation.edited()")
        assertFalse(send.contains("controller.submit(draft.text"), "a collected UI value can lag a just accepted edit")
    }

    @Test fun `all live entries survive coverage and removed owners and stacks retire their drafts`() {
        val content = AppSourcePins.blockAfter(AppSourcePins.app("MainActivity.kt"), "private fun AppContent(")
        AppSourcePins.assertInOrder(content, "SideEffect {", "nav.takeRetired()", "graph.terminalDrafts.retain(nav.entries.filter",
            "route is Route.Terminal", "graph.hosts.get(route.hostId) != null", "it.key")
        assertFalse(content.contains("terminalDrafts.retain(setOf(top.key))"), "covered entries are still alive")
        val retirement = AppSourcePins.blockAfter(AppSourcePins.app("conn/ConnectionManager.kt"), "retire = { hostId, session ->")
        AppSourcePins.assertInOrder(retirement, "session?.retire()", "graph.terminalDrafts.retireOwner(hostId)")
    }
}
