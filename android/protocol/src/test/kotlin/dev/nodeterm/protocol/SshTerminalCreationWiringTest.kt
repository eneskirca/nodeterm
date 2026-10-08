package dev.nodeterm.protocol

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Native lifecycle/main-thread pins complement the executable operation tests. */
class SshTerminalCreationWiringTest {
    @Test fun `plain terminal is available on SSH without relying on registered desktop projects`() {
        val source = AppSourcePins.ui("HostScreen.kt")
        assertTrue(source.contains("val offersSshTerminal = (state as? ConnState.Connected)?.kind == TransportKind.SSH"))
        val fab = AppSourcePins.blockAfter(source, "floatingActionButton =")
        assertTrue(fab.contains("tab == 0 && (offersSshTerminal || offersNew)"))
        assertTrue(fab.contains("terminalTicket = creation.show()"))
        assertTrue(fab.contains("Text(\"New terminal\")"))
        assertTrue(source.contains("PendingLaunches.put(request)"), "The existing relay New session path remains")
    }

    @Test fun `host owns durable creation and background hold includes relisting after failure`() {
        val source = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(source.contains("val sshTerminalCreation = SshTerminalCreation(graph.scope"))
        val create = AppSourcePins.blockAfter(source, "suspend fun createAndRefreshSshTerminal")
        AppSourcePins.assertInOrder(create, "ensureConnected(Trigger.BACKGROUND) as? SshHostConnection", "ssh.createTerminal(nodeId, cwd)", "finally", "refreshNow(Trigger.BACKGROUND)")
        assertTrue(source.contains("suspend fun createAndRefreshSshTerminal(nodeId: String, cwd: String?) = inBackground"))
        assertFalse(create.contains("REGISTER_NODE"))
        assertTrue(source.contains("it is SshTerminalCreationRefusedException"))
    }

    @Test fun `late success switches to Main and checks visible entry before ordinary navigation`() {
        val source = AppSourcePins.ui("HostScreen.kt")
        val open = AppSourcePins.blockAfter(source, "fun openCreated(ticket: Long)")
        AppSourcePins.assertInOrder(open, "!hostStarted", "terminalTicket != ticket", "nav.top.key != screenKey", "creation.takeReady(ticket)", "nav.push")
        assertTrue(source.contains("withContext(Dispatchers.Main) { openCreated(ticket) }"))
        val plain = AppSourcePins.blockAfter(source, "terminalTicket?.let { ticket ->")
        assertFalse(plain.contains("PendingLaunches"))
        assertTrue(plain.contains("creation.submit(ticket, cwd)"))
        val life = AppSourcePins.blockAfter(source, "LifecycleStartEffect(hostId)")
        assertTrue(life.contains("hostStarted = false"))
        assertTrue(life.contains("terminalTicket?.let(creation::hide)"))
        val dispose = AppSourcePins.blockAfter(source, "DisposableEffect(creation)")
        assertTrue(dispose.contains("terminalTicket?.let(creation::hide)"))
    }

    @Test fun `dialog freezes uncertain request but allows correcting a definitive refusal`() {
        val source = AppSourcePins.ui("SshTerminalDialog.kt")
        assertTrue(source.contains("state is SshTerminalCreation.State.Failed && state.canChangeFolder"))
        assertTrue(source.contains("enabled = !busy && valid"))
        assertTrue(source.contains("onCreate(if (editable) selected else request?.cwd)"))
        assertTrue(source.contains("PhoneTerminals.validCwd(selected)"))
        assertTrue(source.contains("SshTerminalFolders.choices(snapshot)"))
    }

    @Test fun `phone rows expose only relevant actions and their starting folder`() {
        val source = AppSourcePins.ui("SessionsTab.kt")
        val noCanvasActions = AppSourcePins.blockAfter(source, "if (!PhoneTerminals.validId(node.id))")
        assertTrue(noCanvasActions.contains("Refresh view on computer"))
        assertTrue(noCanvasActions.contains("Rename…"))
        assertTrue(source.contains("if (project.id != PhoneTerminals.PROJECT_ID)"))
        assertTrue(source.contains("if (PhoneTerminals.validId(node.id)) node.cwd?.let { add(it) }"))
        assertTrue(source.contains("removes it from the phone terminals list"))
        assertTrue(source.contains("PhoneTerminals.validId(node.id) && c !is SshHostConnection"))
    }
}
