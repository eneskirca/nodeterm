package dev.nodeterm.protocol

import kotlin.test.*

/** Native lifecycle/persistence calls are pinned; request, receipt and admission behavior run on JVM. */
class ManagedSessionWiringTest {
    @Test fun `each host owns a durable creation store which commits before any remote mutation`() {
        val store = AppSourcePins.app("data/HostStore.kt")
        val storage = AppSourcePins.blockAfter(store, "fun managedCreationStorage(")
        assertTrue(storage.contains("managedCreation.\$hostId"), "a receipt must not be shared across host profiles")
        assertTrue(storage.contains(".commit()"), "apply() may lose a sent checkpoint on process death")
        assertTrue(storage.contains("throw java.io.IOException"), "failed durable admission must fail creation")
        assertTrue(store.contains("remove(\"managedCreation.\$id\")"), "forget removes only that host's creation journal")
        val session = AppSourcePins.app("conn/ConnectionManager.kt")
        val creation = session.substringAfter("val managedSessionCreation =").substringBefore("private val")
        assertTrue(creation.contains("ManagedSessionCreation(graph.scope"), "dialog dismissal must not cancel an accepted host transaction")
        assertTrue(creation.contains("managedCreationStorage(hostId)"))
        assertTrue(creation.contains("as? SshHostConnection"), "managed creation cannot fall through to relay registration")
        assertTrue(creation.contains("prepareManagedSession(choice)")); assertTrue(creation.contains("createManagedSession(request)"))
    }
    @Test fun `managed New freezes typed choices before any phone launch command or registration`() {
        val dialog = AppSourcePins.blockAfter(AppSourcePins.ui("SessionsTab.kt"), "fun NewSessionDialog(")
        val branch = AppSourcePins.blockAfter(dialog, "if (onManagedCreate != null)")
        AppSourcePins.assertInOrder(branch, "ManagedSessionChoice(projectId = p.id", "kind = if (a == null)", "agentId = a?.id", "accountId = acct", "return@start")
        assertFalse(branch.contains("Launch.launchCommand")); assertFalse(branch.contains("Launch.newNodeId"))
        AppSourcePins.assertInOrder(dialog, "if (onManagedCreate != null)", "return@start", "Launch.launchCommand")
        val host = AppSourcePins.ui("HostScreen.kt")
        AppSourcePins.assertInOrder(host, "val managedNew = offersSshTerminal", "capabilities?.managedCreate == true")
        assertTrue(host.contains("managedCreation.submit(ticket, choice)"))
        assertTrue(host.contains("ManagedSessionCreation.State.Uncertain")); assertTrue(host.contains("managedTicket?.let(managedCreation::acknowledgeChecked)"))
        AppSourcePins.assertInOrder(host, "managedCreation.takeReady(ticket)", "ready.receipt.nodeId")
    }
    @Test fun `a retained receipt always adopts over SSH and suppresses PhoneLaunch and cold resume`() {
        val attach = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "private fun attach()")
        AppSourcePins.assertInOrder(attach, "receiptFor(nodeId)", "managed != null -> session.ensureConnected()", "it.kind != TransportKind.SSH", "conn.attachManagedSession(managed", "session.managedSessionCreation.adopted(nodeId)")
        assertTrue(attach.contains("if (managed == null && hint != null) PendingLaunches.take(nodeId)"))
        assertTrue(attach.contains("if (managed == null && launch == null && slot.isCurrent(ticket)) afterAttach"))
        assertTrue(attach.contains("if (launch != null || managed != null) resumeOffer = null"))
        assertTrue(attach.contains("managedReceiptBlocked = managed != null"))
        val discard = AppSourcePins.blockAfter(AppSourcePins.ui("TerminalController.kt"), "fun discardManagedReceipt()")
        AppSourcePins.assertInOrder(discard, "if (!managedReceiptBlocked || attached)", "managedSessionCreation.adopted(nodeId)", "session.refresh()")
        assertFalse(discard.contains("attach(")); assertFalse(discard.contains("PendingLaunches"))
        val screen = AppSourcePins.ui("TerminalScreen.kt")
        assertTrue(screen.contains("I checked the computer"))
        AppSourcePins.assertInOrder(screen, "controller.discardManagedReceipt()", "nav.pop()")
    }
    @Test fun `accepted managed creation cannot navigate a stopped superseded or forgotten screen`() {
        val host = AppSourcePins.ui("HostScreen.kt")
        val open = AppSourcePins.blockAfter(host, "fun openManaged(")
        AppSourcePins.assertInOrder(open, "!hostStarted", "managedTicket != ticket", "nav.top.key != screenKey", "graph.hosts.get(hostId) == null", "takeReady(ticket)", "nav.push(")
        val life = AppSourcePins.blockAfter(host, "LifecycleStartEffect(hostId)")
        assertTrue(life.contains("managedTicket = managedCreation.show()"))
        assertTrue(life.contains("managedTicket?.let(managedCreation::hide)"))
    }
}
