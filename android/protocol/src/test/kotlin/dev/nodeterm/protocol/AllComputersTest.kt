package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.AgentNodeStatus
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.AllComputers
import dev.nodeterm.protocol.model.ComputerLabel
import dev.nodeterm.protocol.model.ComputerListing
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxFeed
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.InboxNodeNow
import dev.nodeterm.protocol.model.MirrorInbox
import dev.nodeterm.protocol.model.MirrorUsage
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.UsageAccount
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Audit A55: iOS merges the Inbox ("merged events across connections, newest first") and Usage ("one
 * section per paired connection that reports `usage`") across every paired computer
 * (docs/mobile-usage-inbox.md), where Android showed one computer's, inside that computer's screen,
 * and the computers list showed no needs-you count at all. The rules are [AllComputers] and
 * [InboxFeed]; the screens are only type-checked, so what they rely on is pinned in their source.
 */
class AllComputersTest {
    private fun event(
        id: String,
        ts: Long,
        nodeId: String = "n1",
        kind: InboxKind = InboxKind.APPROVAL,
        resolved: Boolean = false
    ) = InboxEvent(
        id = id, ts = ts, nodeId = nodeId, agentId = "claude", sessionId = "s", kind = kind,
        title = "t-$id", detail = null, interrupted = false, resolved = resolved,
        options = emptyList(), multiSelect = false, pendingId = null
    )

    private fun now(activity: String?, context: Double? = null, updatedAt: Long = 1) =
        InboxNodeNow(activity = activity, tool = null, contextPercent = context, prompt = null, updatedAt = updatedAt)

    private fun status(
        events: List<InboxEvent> = emptyList(),
        states: Map<String, AgentState?> = emptyMap(),
        inboxNodes: Map<String, InboxNodeNow> = emptyMap(),
        usage: MirrorUsage? = null
    ) = AgentStatusFile(
        updatedAt = 1,
        nodes = states.mapValuesTo(LinkedHashMap()) { (_, st) -> AgentNodeStatus(st, "claude", "s", null, false, 1, null) },
        settings = null,
        usage = usage,
        inbox = MirrorInbox(events, inboxNodes),
        server = null
    )

    private fun snapshot(status: AgentStatusFile?) = ProjectsSnapshot(emptyList(), emptySet(), status, 1)

    private fun listing(hostId: String, status: AgentStatusFile?, label: String = "Computer $hostId") =
        ComputerListing(ComputerLabel(hostId, label), snapshot(status))

    private fun host(id: String, name: String, user: String = "me", address: String = "10.0.0.$id") = PairedHost(
        id = id, name = name, host = address, port = 22, user = user, sshAvailable = true,
        hostKeyB64 = null, relay = null, sshHostKeyFingerprint = null, pairedAt = 0
    )

    private fun usage(updatedAt: Long, vararg accountIds: String?) = MirrorUsage(
        updatedAt,
        accountIds.map { UsageAccount(it, null, null, "claude", "ok", updatedAt, emptyList()) }
    )

    // ---- the count on each computer's row --------------------------------------------------------

    @Test
    fun `a computer needs you for its open approvals and questions, not for finished or resolved cards`() {
        val s = snapshot(
            status(
                listOf(
                    event("a", 1, kind = InboxKind.APPROVAL),
                    event("q", 2, kind = InboxKind.QUESTION),
                    event("d", 3, kind = InboxKind.DONE),
                    event("r", 4, kind = InboxKind.APPROVAL, resolved = true)
                )
            )
        )
        assertEquals(2, AllComputers.needsYou(s))
        // A computer not listed yet (no mirror) needs nothing, rather than failing the row.
        assertEquals(0, AllComputers.needsYou(ProjectsSnapshot.EMPTY))
        assertEquals(0, AllComputers.needsYou(snapshot(null)))
    }

    @Test
    fun `the merged screen is offered once a second computer is paired`() {
        assertFalse(AllComputers.offered(0))
        assertFalse(AllComputers.offered(1))
        assertTrue(AllComputers.offered(2))
        assertTrue(AllComputers.offered(5))
    }

    // ---- what each computer is called ------------------------------------------------------------

    @Test
    fun `computers are called by their pairing names, in pairing order`() {
        val labels = AllComputers.labels(listOf(host("1", "Studio"), host("2", "  Laptop "), host("3", "")))
        assertEquals(
            listOf(ComputerLabel("1", "Studio"), ComputerLabel("2", "Laptop"), ComputerLabel("3", "Computer")),
            labels
        )
    }

    @Test
    fun `two computers with one name are told apart by their address, and the same address by a number`() {
        val labels = AllComputers.labels(
            listOf(
                host("1", "MacBook Pro", user = "ann", address = "10.0.0.5"),
                host("2", "macbook pro", user = "bob", address = "10.0.0.9"),
                host("3", "Studio"),
                // The same computer paired twice: name and address agree.
                host("4", "Mini", user = "me", address = "mini.local"),
                host("5", "Mini", user = "me", address = "mini.local")
            )
        ).map { it.label }
        assertEquals(
            listOf(
                "MacBook Pro (ann@10.0.0.5)",
                "macbook pro (bob@10.0.0.9)",
                "Studio",
                "Mini (me@mini.local) #1",
                "Mini (me@mini.local) #2"
            ),
            labels
        )
        assertEquals(labels.size, labels.map { it.lowercase() }.toSet().size, "every label is distinct")
    }

    // ---- the merged Inbox -------------------------------------------------------------------------

    @Test
    fun `events of every computer are merged newest first, each card keeping its computer`() {
        val a = listing("a", status(listOf(event("a1", 100), event("a2", 300), event("a3", 500))))
        val b = listing("b", status(listOf(event("b1", 200), event("b2", 400))))
        val feed = AllComputers.feed(listOf(a, b))
        // Interleaved by time, not one computer's cards then the other's.
        assertEquals(listOf("a3", "b2", "a2", "b1", "a1"), feed.actionable.map { it.event.id })
        assertEquals(listOf("a", "b", "a", "b", "a"), feed.actionable.map { it.hostId })
        // Each card carries its own computer's listing (its titles, context ring and answers).
        for (item in feed.actionable) {
            assertEquals(if (item.hostId == "a") a else b, item.from)
            assertEquals("Computer ${item.hostId}", item.from.computer.label)
        }
    }

    @Test
    fun `open cards come first and the archive under them, each newest first across computers`() {
        val a = listing(
            "a",
            status(listOf(event("a-done", 900, kind = InboxKind.DONE), event("a-q", 100, kind = InboxKind.QUESTION)))
        )
        val b = listing(
            "b",
            status(listOf(event("b-old", 50, resolved = true), event("b-new", 700, kind = InboxKind.APPROVAL)))
        )
        val feed = AllComputers.feed(listOf(a, b))
        assertEquals(listOf("b-new", "a-q"), feed.actionable.map { it.event.id })
        assertEquals(listOf("a-done", "b-old"), feed.archived.map { it.event.id })
        // The count on the merged Inbox tab is every row's count, added up.
        assertEquals(feed.actionable.size, listOf(a, b).sumOf { AllComputers.needsYou(it.snapshot) })
    }

    @Test
    fun `event identity keeps different computers and requests on the same node separate`() {
        val a = listing("a", status(listOf(event("e1", 10), event("e2", 30))))
        val b = listing("b", status(listOf(event("e1", 20))))
        val feed = AllComputers.feed(listOf(a, b))
        assertEquals(3, feed.actionable.size)
        assertEquals(listOf("a/e2", "b/e1", "a/e1"), feed.actionable.map { it.key })
        assertEquals(listOf("a" to "e2", "b" to "e1", "a" to "e1"),
            feed.actionable.map { it.from.computer.hostId to it.event.id })
        assertEquals(setOf("n1"), feed.actionable.map { it.event.nodeId }.toSet(),
            "admission must distinguish events even when every request targets the same node")
    }

    @Test
    fun `cards at the same moment keep the computers' order, then each mirror's own`() {
        val a = listing("a", status(listOf(event("a1", 10), event("a2", 10))))
        val b = listing("b", status(listOf(event("b1", 10))))
        assertEquals(listOf("a1", "a2", "b1"), AllComputers.feed(listOf(a, b)).actionable.map { it.event.id })
        assertEquals(listOf("b1", "a1", "a2"), AllComputers.feed(listOf(b, a)).actionable.map { it.event.id })
    }

    @Test
    fun `a card's context ring is read from its own computer, even when another has the same node`() {
        // A canvas committed to a repo cloned on two computers has the same node ids on both.
        val a = listing("a", status(listOf(event("a1", 10, nodeId = "n1")), inboxNodes = mapOf("n1" to now(null, context = 12.0))))
        val b = listing("b", status(listOf(event("b1", 20, nodeId = "n1")), inboxNodes = mapOf("n1" to now(null, context = 87.0))))
        val byId = AllComputers.feed(listOf(a, b)).actionable.associateBy { it.event.id }
        assertEquals(12.0, byId.getValue("a1").contextPercent)
        assertEquals(87.0, byId.getValue("b1").contextPercent)
    }

    @Test
    fun `working sessions of every computer are listed in the computers' order, not reshuffled by time`() {
        val a = listing(
            "a",
            status(
                states = linkedMapOf("w1" to AgentState.WORKING, "idle" to AgentState.DONE, "quiet" to AgentState.WORKING),
                inboxNodes = mapOf(
                    "w1" to now("Editing a.kt", updatedAt = 5),
                    "idle" to now("Reading b.kt", updatedAt = 9),
                    // Working, but reporting nothing it is doing: no live card (as on a computer's own Inbox).
                    "quiet" to now(null, updatedAt = 9)
                )
            )
        )
        val b = listing(
            "b",
            status(
                states = linkedMapOf("w2" to AgentState.WORKING, "w1" to AgentState.WORKING),
                inboxNodes = mapOf("w2" to now("Running npm test", updatedAt = 99), "w1" to now("Using Grep", updatedAt = 1))
            )
        )
        val feed = AllComputers.feed(listOf(a, b))
        assertEquals(listOf("a/w1", "b/w2", "b/w1"), feed.working.map { it.key })
        assertEquals(listOf("Editing a.kt", "Running npm test", "Using Grep"), feed.working.map { it.now.activity })
    }

    @Test
    fun `a computer not listed yet adds nothing, and the feed of none is empty`() {
        val a = listing("a", status(listOf(event("a1", 10))))
        val unlisted = ComputerListing(ComputerLabel("b", "B"), ProjectsSnapshot.EMPTY)
        val feed = AllComputers.feed(listOf(a, unlisted))
        assertEquals(listOf("a/a1"), feed.actionable.map { it.key })
        assertTrue(AllComputers.feed(emptyList()).isEmpty)
        assertTrue(AllComputers.feed(listOf(unlisted)).isEmpty)
        assertFalse(feed.isEmpty)
    }

    @Test
    fun `one computer's Inbox is the same rule as the merged one`() {
        // The computer's own tab draws InboxFeed.of(that computer): sorted newest first like before.
        val a = listing(
            "a",
            status(listOf(event("old", 1), event("done", 3, kind = InboxKind.DONE), event("new", 2, kind = InboxKind.QUESTION)))
        )
        val feed = InboxFeed.of(listOf(a))
        assertEquals(listOf("new", "old"), feed.actionable.map { it.event.id })
        assertEquals(listOf("done"), feed.archived.map { it.event.id })
        assertEquals(AllComputers.feed(listOf(a)), feed)
    }

    // ---- the merged Usage ------------------------------------------------------------------------

    @Test
    fun `one usage section per computer that reports usage, in the computers' order`() {
        val a = listing("a", status(usage = usage(1_000, null, "acct-1")), label = "Studio")
        val none = listing("b", status(usage = null), label = "Old desktop")
        val empty = listing("c", status(usage = usage(2_000)), label = "Nothing cached")
        val unlisted = ComputerListing(ComputerLabel("d", "Not listed"), ProjectsSnapshot.EMPTY)
        val e = listing("e", status(usage = usage(3_000, null)), label = "Laptop")
        val sections = AllComputers.usage(listOf(a, none, empty, unlisted, e))
        assertEquals(listOf("Studio", "Laptop"), sections.map { it.computer.label })
        assertEquals(listOf(1_000L, 3_000L), sections.map { it.usage.updatedAt })
        assertEquals(listOf(listOf(null, "acct-1"), listOf(null)), sections.map { s -> s.usage.accounts.map { it.accountId } })
        // Each section names its accounts from its own computer's mirror.
        assertEquals(a.snapshot.status, sections[0].status)
        assertEquals(e.snapshot.status, sections[1].status)
    }

    // ---- what the type-checked screens rely on -----------------------------------------------------

    @Test
    fun `each computer's row counts from the session's cached listing and dials nothing`() {
        val src = AppSourcePins.ui("HostsScreen.kt")
        val row = AppSourcePins.blockAfter(src, "}) { host ->")
        AppSourcePins.assertInOrder(
            row,
            "val snapshot by session.snapshot.collectAsState()",
            "val needsYou = AllComputers.needsYou(snapshot)",
            "NeedsYouBadge(needsYou)"
        )
        // Listing the computers must not connect to them: no connect, refresh or watch from this screen.
        for (dial in listOf("ensureConnected", ".refresh(", "refreshNow", "startWatching", "connectionFor", "viaRelay")) {
            assertFalse(src.contains(dial), "HostsScreen dials a computer ($dial)")
        }
        // The entry to the merged screen, offered by the rule, with the total from the same cached listings.
        AppSourcePins.assertInOrder(
            src,
            "if (AllComputers.offered(hosts.size))",
            "rememberListings(hosts).sumOf { AllComputers.needsYou(it.snapshot) }",
            "nav.push(Route.AllComputers)"
        )
        // The Inbox tab's count is the same definition.
        assertTrue(AppSourcePins.ui("HostScreen.kt").contains("val needsYou = AllComputers.needsYou(snapshot)"))
        // And the listings the screens read are the sessions' cached snapshots.
        val listings = AppSourcePins.blockAfter(AppSourcePins.ui("AllComputersScreen.kt"), "internal fun rememberListings(")
        assertTrue(listings.contains(".snapshot"), listings)
        for (dial in listOf("ensureConnected", "refresh", "startWatching")) assertFalse(listings.contains(dial), listings)
    }

    @Test
    fun `opening the merged screen re-lists every computer through the gate, without lifting a held refusal`() {
        val screen = AppSourcePins.ui("AllComputersScreen.kt")
        // Every computer, through HostSession.refresh: refreshNow, its normal connect path, whose relay
        // dial asks RelayApprovalGate. As the app's foreground refresh (AUTO): a first approval may show
        // its code, but a computer whose approval was refused or unanswered keeps its hold.
        assertTrue(screen.contains("fun refreshAll() = hostIds.forEach { graph.connections.session(it).refresh(Trigger.AUTO) }"))
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(screen, "LifecycleStartEffect(hostId)"),
            "val starting = uiScope.launch",
            "yield()",
            "session.startWatching(Trigger.AUTO)",
            "onStopOrDispose",
            "starting.cancel()",
            "session.stopWatching(closeWhenUnused = true)"
        )
        val connections = AppSourcePins.app("conn/ConnectionManager.kt")
        assertTrue(connections.contains("fun refresh(trigger: Trigger = Trigger.USER) {\n        scope.launch { refreshNow(trigger) }"))
        // A computer's own Try again is the user asking about it: USER lifts its hold.
        val status = AppSourcePins.blockAfter(screen, "private fun ComputerStatus(")
        AppSourcePins.assertInOrder(
            status,
            "is ConnState.AwaitingApproval -> ApprovalFor(computer, s.sas)",
            "is ConnState.Failed -> Problem(\"${'$'}{computer.label}: ${'$'}{s.message}\") { session.refresh(Trigger.USER) }",
            "relayApproval?.let"
        )
        assertFalse(screen.contains("refresh()"), "a refresh on this screen with no trigger says nothing about who asked")
        // Each visible host now shares the same lifecycle-bound 8 s loop as its own screen.
        assertTrue(screen.contains("for (hostId in hostIds) key(hostId)"))
    }

    @Test
    fun `a computer whose last listing failed says so, also once the failure dropped its connection`() {
        // Review of A55: a listing that fails with an unexpected error drops the connection, which
        // leaves the session Idle (refreshNow -> disconnect), and the strip drew nothing for Idle. This
        // screen re-lists nothing on its own, so the computer's cached cards stayed, looking current.
        val connections = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "suspend fun refreshNow("),
            "} catch (e: Exception) {",
            // Never a null error: an exception without a message still says the listing failed ("nothing
            // found" picks its ending by the relay leg first, review of A27b).
            "_lastError.value = (e as? NothingFoundException)?.said(relayLeg()) ?: e.message ?: e.javaClass.simpleName",
            "if (e !is HostException) disconnect()"
        )
        assertTrue(connections.contains("fun disconnect() = lifetime.disconnect { disconnectOwned() }"))
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(connections, "private fun disconnectOwned()"),
            "conn = null", "scope.launch(Dispatchers.IO)", "runCatching { c?.close() }",
            "_state.value = ConnState.Idle"
        )
        // One rule for which states leave a failed listing to the screen: Connected AND Idle.
        assertTrue(connections.contains("val showsListError: Boolean get() = this is Connected || this == Idle"))

        // The merged screen's strip: the error with a Try again of its own (USER), under that rule.
        val status = AppSourcePins.blockAfter(AppSourcePins.ui("AllComputersScreen.kt"), "private fun ComputerStatus(")
        AppSourcePins.assertInOrder(
            status,
            "val listError by session.lastError.collectAsState()",
            "is ConnState.Failed -> Problem(",
            "if (state.showsListError) listError?.let { Problem(\"${'$'}{computer.label}: ${'$'}it\") { session.refresh(Trigger.USER) } }",
            "relayApproval?.let"
        )
        assertFalse(
            Regex("""is ConnState\.Connected ->[^\n]*listError""").containsMatchIn(status),
            "the strip shows a failed listing only while connected"
        )
        // A computer's own screen reads the same rule.
        val host = AppSourcePins.ui("HostScreen.kt")
        assertTrue(host.contains("if (state.showsListError && err != null) {"))
        assertFalse(host.contains("state is ConnState.Connected && err != null"), "HostScreen shows a failed listing only while connected")
    }

    @Test
    fun `the merged Inbox shows every computer's Inbox while started, and draws through the shared list`() {
        val screen = AppSourcePins.ui("AllComputersScreen.kt")
        val inbox = AppSourcePins.blockAfter(screen, "private fun AllInbox(")
        AppSourcePins.assertInOrder(
            inbox,
            "LifecycleStartEffect(hostIds)",
            "hostIds.map { graph.connections.session(it).onScreen.showInbox() }",
            "onStopOrDispose { showing.forEach { it.close() } }",
            "InboxFeedList(nav, feed, showComputer = true"
        )
        assertTrue(screen.contains("val feed = AllComputers.feed(listings)"))
        assertTrue(screen.contains("AllUsage(AllComputers.usage(listings))"))
        // The card composables are InboxTab's, not copies (no second EventCard, UsageCard or quick answer).
        for (copy in listOf("fun EventCard(", "fun UsageCard(", "QuickActions.answer")) {
            assertFalse(screen.contains(copy), "AllComputersScreen copies $copy")
        }
        assertTrue(AppSourcePins.blockAfter(screen, "private fun AllUsage(").contains("UsageCard(account, section.status)"))
        val tab = AppSourcePins.ui("InboxTab.kt")
        assertTrue(tab.contains("InboxFeedList(nav, feed, showComputer = false"))
        assertTrue(tab.contains("val feed = InboxFeed.of(listOf(ComputerListing(ComputerLabel(hostId, name), snapshot)))"))
    }

    @Test
    fun `a merged card opens and answers on its own computer`() {
        val list = AppSourcePins.blockAfter(AppSourcePins.ui("InboxTab.kt"), "internal fun InboxFeedList(")
        // Open: the card's computer and the title from that computer's listing.
        AppSourcePins.assertInOrder(
            list,
            "fun openOn(from: ComputerListing, nodeId: String) =",
            "nav.push(Route.Terminal(from.computer.hostId, nodeId, feedTitle(from.snapshot, nodeId)))",
            "fun runOn("
        )
        // Answer: that computer's session, its connection, and its relay leg for a node of its SSH projects.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(list, "fun runOn("),
            "val session = graph.connections.session(from.computer.hostId)",
            "block(session.ensureConnected())",
            "block(session.viaRelay())",
            "session.refreshNow()"
        )
        // Every card binds its actions to ITS listing: the list takes no screen-wide computer or session.
        assertTrue(
            AppSourcePins.ui("InboxTab.kt").contains(
                "internal fun InboxFeedList(nav: Navigator, feed: InboxFeed, showComputer: Boolean, emptyText: String)"
            )
        )
        AppSourcePins.assertInOrder(
            list,
            "items(feed.actionable",
            "onOpen = { openOn(item.from, ev.nodeId) }",
            "open = { nodeId -> openOn(item.from, nodeId) }",
            "run = { label, block, nodeId -> runOn(item.from, label, block, nodeId, ev.id) }",
            "items(feed.working",
            "openOn(live.from, nodeId)",
            "items(feed.archived",
            "onOpen = { openOn(item.from, ev.nodeId) }"
        )
    }

    @Test
    fun `merged answers admit and retire only their own host and event before launching work`() {
        val list = AppSourcePins.blockAfter(AppSourcePins.ui("InboxTab.kt"), "internal fun InboxFeedList(")
        assertTrue(list.contains("var pendingActions by remember { mutableStateOf(emptySet<Pair<String, String>>()) }"))
        val run = AppSourcePins.blockAfter(list, "fun runOn(")
        AppSourcePins.assertInOrder(
            run,
            "val actionKey = from.computer.hostId to eventId",
            "if (actionKey in pendingActions) return",
            "pendingActions = pendingActions + actionKey",
            "val session = graph.connections.session(from.computer.hostId)",
            "scope.launch {",
            "block(session.ensureConnected())",
            "catch (e: CancellationException)",
            "throw e",
            "catch (e: Exception)",
            "finally {",
            "pendingActions = pendingActions - actionKey"
        )
        val cards = AppSourcePins.blockAfter(list.substringAfter("items(feed.actionable,"), ") { item ->")
        AppSourcePins.assertInOrder(
            cards,
            "val ev = item.event",
            "busy = (item.from.computer.hostId to ev.id) in pendingActions",
            "run = { label, block, nodeId -> runOn(item.from, label, block, nodeId, ev.id) }"
        )
    }

    @Test
    fun `the route is saved in the back stack under a name of its own`() {
        val main = AppSourcePins.app("MainActivity.kt")
        assertTrue(main.contains("data object AllComputers : Route"))
        assertTrue(main.contains("Route.AllComputers -> listOf(\"all\")"))
        assertTrue(main.contains("\"all\" -> Route.AllComputers"))
        assertTrue(main.contains("Route.AllComputers -> AllComputersScreen(nav)"))
        // Every earlier route keeps its saved form, so a stack saved before this one decodes unchanged
        // (and BackStack drops, with its key, an entry a build does not know: BackStackTest).
        for (line in listOf(
            "Route.Hosts -> listOf(\"hosts\")",
            "is Route.PairHost -> listOfNotNull(\"pair\", r.code)",
            "Route.Settings -> listOf(\"settings\")",
            "is Route.Host -> listOf(\"host\", r.hostId, r.tab.toString())",
            "is Route.Terminal -> listOf(\"terminal\", r.hostId, r.nodeId, r.title)",
            "is Route.SourceControl -> listOf(\"git\", r.hostId, r.projectId)"
        )) assertTrue(main.contains(line), "the saved form of a route changed: $line")
    }
}
