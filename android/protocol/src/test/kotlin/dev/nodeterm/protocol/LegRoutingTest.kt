package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.LegRouting.Leg
import dev.nodeterm.protocol.host.LegRouting.RelayLeg
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.ProjectInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Audit A26: on the LAN connection `Auto` picks first, New session, board edits and node actions
 * were simply unavailable (the button hidden, the board read-only), although the same computer's
 * relay leg could do them. One pure decision says which leg answers each verb.
 */
class LegRoutingTest {
    /** What the direct-SSH transport serves (SshHostConnection.capabilities). */
    private val ssh = HostCapabilities(
        boardWrites = false, git = true, nodeActions = false, registerNode = false, answerApprovals = true
    )
    private val appVerbs = listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS )

    @Test
    fun `on SSH the app's own verbs open the relay leg next to it`() {
        for (cap in appVerbs) {
            assertEquals(Leg.Relay, LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.AVAILABLE), "$cap")
        }
    }

    @Test
    fun `a project another desktop drives over SSH answers only what the machine does (A27)`() {
        val driven = ProjectInfo("project-drv", "Driven", null, "/srv/drv", null, false, emptyList(), null, drivenRemotely = true)
        val own = driven.copy(drivenRemotely = false)
        for (cap in appVerbs) {
            for (leg in listOf(Leg.Primary, Leg.Relay)) {
                val refused = assertIs<Leg.Unavailable>(LegRouting.forProject(cap, driven, leg), "$cap via $leg")
                assertTrue(refused.reason.startsWith(cap.what) && refused.reason.contains("another computer"), refused.reason)
                assertEquals(leg, LegRouting.forProject(cap, own, leg), "a project of this computer keeps the computer's answer")
                assertEquals(leg, LegRouting.forProject(cap, null, leg))
            }
        }
        // A held approval is a file on THIS computer, written over SSH: still the primary leg.
        assertEquals(Leg.Primary, LegRouting.forProject(Capability.ANSWER_APPROVALS, driven, Leg.Primary))
        // Never "turn on remote access": the relay this phone holds is this computer's, not that desktop's.
        assertFalse(LegRouting.drivenElsewhere(Capability.NODE_ACTIONS).contains("remote access"))
    }

    @Test
    fun `what SSH does itself never opens the relay`() {
        assertEquals(Leg.Primary, LegRouting.route(Capability.ANSWER_APPROVALS, TransportKind.SSH, ssh, RelayLeg.AVAILABLE))
        for (relay in RelayLeg.entries) assertEquals(Leg.Primary, LegRouting.route(Capability.GIT, TransportKind.SSH, ssh, relay))
        val driven = ProjectInfo("driven", "Driven", null, "/work/app", null, false, emptyList(), null, drivenRemotely = true)
        assertEquals(Leg.Primary, LegRouting.forProject(Capability.GIT, driven, Leg.Primary))
        assertIs<Leg.Unavailable>(LegRouting.forProject(Capability.GIT, driven, Leg.Relay))
    }

    @Test
    fun `on the relay everything stays on the relay connection`() {
        for (cap in Capability.entries) {
            assertEquals(
                Leg.Primary,
                LegRouting.route(cap, TransportKind.RELAY, LegRouting.RELAY_CAPABILITIES, RelayLeg.NOT_SET_UP),
                "$cap"
            )
        }
    }

    @Test
    fun `with no relay leg the verb is unavailable with the reason, and that reason is not 'turn it on' when it is on`() {
        for (cap in appVerbs) {
            val notSetUp = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.NOT_SET_UP))
            assertTrue(notSetUp.reason.startsWith(cap.what), notSetUp.reason)
            assertTrue(notSetUp.reason.contains("Turn on remote access"), notSetUp.reason)

            // Remote access is on (the phone holds a relay leg); the user chose SSH only. Sending
            // them to turn remote access on would be the A26 error text again.
            val sshOnly = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.ROUTE_SSH_ONLY))
            assertFalse(sshOnly.reason.contains("remote access", ignoreCase = true), sshOnly.reason)
            assertTrue(sshOnly.reason.contains("Only on my network (SSH)"), sshOnly.reason)
            assertTrue(sshOnly.reason.contains("Settings → How to reach each computer"), sshOnly.reason)
        }
    }

    @Test
    fun `not connected yet asks the relay leg when there is one`() {
        // connectionFor connects first, so this only matters for the UI's state before the first
        // listing: a control is not shown as impossible while the phone is still dialing.
        assertEquals(Leg.Relay, LegRouting.route(Capability.REGISTER_NODE, null, null, RelayLeg.AVAILABLE))
        assertIs<Leg.Unavailable>(LegRouting.route(Capability.REGISTER_NODE, null, null, RelayLeg.NOT_SET_UP))
    }

    @Test
    fun `the relay leg's availability`() {
        assertEquals(RelayLeg.AVAILABLE, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false))
        assertEquals(RelayLeg.ROUTE_SSH_ONLY, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = true))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = true))
    }

    /**
     * The review of A26: a token the phone holds outlives the computer's remote-access toggle, so the
     * stored leg alone showed New session and the board enabled after remote access was turned off,
     * and a tap waited out the relay's 20 s handshake before failing. What the computer advertises at
     * the last listing over SSH (`~/.nodeterm/relay.json`) decides it.
     */
    @Test
    fun `what the computer advertises decides a stored relay leg`() {
        assertEquals(RelayLeg.REMOTE_ACCESS_OFF, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, relayAdvertised = false))
        assertEquals(RelayLeg.AVAILABLE, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, relayAdvertised = true))
        // Unknown (on the relay itself, or before the first listing) never takes a leg away.
        assertEquals(RelayLeg.AVAILABLE, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, relayAdvertised = null))
        // No token, but remote access IS on: not "turn it on".
        assertEquals(RelayLeg.NOT_PICKED_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false, relayAdvertised = true))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false, relayAdvertised = false))
        // The computer's side is said first; the phone's own route after it is fixed.
        assertEquals(RelayLeg.REMOTE_ACCESS_OFF, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = true, relayAdvertised = false))
        assertEquals(RelayLeg.ROUTE_SSH_ONLY, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = true, relayAdvertised = true))
        // A computer added by its SSH address has no relay leg, whatever its file says.
        for (advertised in listOf(true, false, null)) {
            assertEquals(RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(true, false, addedOverSsh = true, relayAdvertised = advertised))
        }
    }

    @Test
    fun `each missing relay leg names its own fix`() {
        for (cap in appVerbs) {
            val off = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.REMOTE_ACCESS_OFF)).reason
            assertTrue(off.startsWith(cap.what), off)
            assertTrue(off.contains("remote access is off on the computer"), off)
            assertTrue(off.contains("Settings → Phone"), off)

            val pickingUp = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.NOT_PICKED_UP)).reason
            assertTrue(pickingUp.startsWith(cap.what), pickingUp)
            assertFalse(pickingUp.contains("Turn on remote access", ignoreCase = true), "remote access is on: $pickingUp")
            assertTrue(pickingUp.contains("Refresh"), pickingUp)

            // It promised a pickup "the next time it connects", which a reused connection never did.
            val notSetUp = assertIs<Leg.Unavailable>(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.NOT_SET_UP)).reason
            assertFalse(notSetUp.contains("next time it connects"), notSetUp)
            assertTrue(notSetUp.contains("next refresh"), notSetUp)
        }
    }

    @Test
    fun `a listing adopts the advertised relay on a refresh the user asked for, or when it newly appears`() {
        val missing = listOf(RelayLeg.NOT_SET_UP, RelayLeg.NOT_PICKED_UP)
        for (leg in missing) {
            assertTrue(LegRouting.adoptAfterListing(leg, advertisedBefore = true, advertisedNow = true, userAsked = true), "Refresh / Try again, $leg")
            assertTrue(LegRouting.adoptAfterListing(leg, advertisedBefore = false, advertisedNow = true, userAsked = false), "turned on while watched, $leg")
            // The 8 s poll does not mint again and again while it keeps failing.
            assertFalse(LegRouting.adoptAfterListing(leg, advertisedBefore = true, advertisedNow = true, userAsked = false), "$leg")
            // The connect adopts on its own; the first listing on that connection does not ask twice.
            assertFalse(LegRouting.adoptAfterListing(leg, advertisedBefore = null, advertisedNow = true, userAsked = false), "$leg")
            // Nothing advertised: nothing to adopt.
            for (now in listOf(false, null)) assertFalse(LegRouting.adoptAfterListing(leg, advertisedBefore = false, advertisedNow = now, userAsked = true))
        }
        // A phone that holds a leg, or a computer that cannot have one, never adopts.
        for (leg in RelayLeg.entries - missing.toSet()) {
            assertFalse(LegRouting.adoptAfterListing(leg, advertisedBefore = false, advertisedNow = true, userAsked = true), "$leg")
        }
    }

    @Test
    fun `reach answers every capability from the same rule`() {
        val reach = LegRouting.reach(TransportKind.SSH, ssh, RelayLeg.AVAILABLE)
        assertEquals(Capability.entries.toSet(), reach.keys)
        for (cap in Capability.entries) assertEquals(LegRouting.route(cap, TransportKind.SSH, ssh, RelayLeg.AVAILABLE), reach[cap])
    }

    @Test
    fun `the SSH refusal names the relay, not a setting that may already be on`() {
        val msg = LegRouting.sshRefusal("Editing the board")
        assertTrue(msg.startsWith("Editing the board"))
        assertTrue(msg.contains("through the relay"))
        assertFalse(msg.contains("turn on remote access"))
    }

    /**
     * The app asks this decision instead of the transport kind. What only a device can run (the
     * Compose screens) is pinned in the source, like AppSourcePins does elsewhere.
     */
    @Test
    fun `the app's controls decide from the routing, and write through the leg it names`() {
        val host = AppSourcePins.ui("HostScreen.kt")
        // The FAB used to be gated on `kind == TransportKind.RELAY` and vanished on the LAN.
        assertFalse(host.contains("kind == TransportKind.RELAY"), "HostScreen gates New session on the transport kind")
        assertTrue(host.contains("session.route(Capability.REGISTER_NODE)"))
        assertTrue(host.contains("enabled = false"), "an unavailable New session is shown disabled, not hidden")

        val board = AppSourcePins.ui("BoardTab.kt")
        // Per project since A27: a project another desktop drives over SSH has its own answer.
        assertTrue(board.contains("session.route(Capability.BOARD_WRITES, project)"))
        assertTrue(board.contains("session.connectionFor(Capability.BOARD_WRITES, project = project)"))
        assertFalse(board.contains("ensureConnected().setCardColumn"), "a board write must not go to the SSH leg")
        assertFalse(board.contains("ensureConnected().editCardLabels"), "a label edit must not go to the SSH leg")

        val sessions = AppSourcePins.ui("SessionsTab.kt")
        assertTrue(sessions.contains("session.route(Capability.NODE_ACTIONS, project)"))
        assertFalse(sessions.contains("connectionFor(Capability.NODE_ACTIONS)"), "every node action names its project")
        assertFalse(sessions.contains("capabilities?.nodeActions"), "node actions decided from the primary leg alone")

        // A session the phone starts is created and registered through the leg that can register it.
        val term = AppSourcePins.ui("TerminalController.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(term, "private fun attach()"),
            "PendingLaunches.peek(nodeId) != null -> session.connectionFor(Capability.REGISTER_NODE"
        )

        // The side relay goes through the approval gate with the caller's trigger (never a first
        // handshake from the background), and connectionFor defaults to the user's tap.
        val conn = AppSourcePins.app("conn/ConnectionManager.kt")
        val viaRelay = AppSourcePins.blockAfter(conn.substring(conn.indexOf("suspend fun viaRelay(")), "return sideMutex.withLock")
        assertTrue(viaRelay.contains("graph.relayGate.decide(hostId, trigger)"))
        assertTrue(viaRelay.contains("requireApproved = requireApproved"))
        assertTrue(Regex("""fun connectionFor\(\s*cap: Capability,\s*trigger: Trigger = Trigger\.USER""").containsMatchIn(conn))
        // …and decides with the project's answer, the one the screens show (A27).
        val connectionFor = AppSourcePins.blockAfter(conn.substring(conn.indexOf("suspend fun connectionFor(")), "): HostConnection")
        assertTrue(connectionFor.contains("route(cap, project)"), connectionFor)
    }

    /**
     * The review of A26: [LegRouting.route] is asked while composing (the host screen, the board, the
     * session menu, Source control), on every listing. It used to decrypt the relay token there — a
     * Keystore round trip on the main thread under the store's lock, the A47 pattern — and a keystore
     * hiccup then read as "no relay leg", whose reason tells a user with remote access ON to turn it on.
     */
    @Test
    fun `the routing asks whether a relay token is stored, never for its value`() {
        val conn = AppSourcePins.app("conn/ConnectionManager.kt")
        val configured = conn.substring(conn.indexOf("private fun relayConfigured(")).let { it.substring(0, it.indexOf("\n\n")) }
        assertTrue(configured.contains("graph.secure.hasRelayToken(host.id)"), configured)
        assertFalse(configured.contains("secure.getString") || configured.contains("secure.getBytes"), configured)
        val relayLeg = AppSourcePins.blockAfter(conn, "fun relayLeg(): LegRouting.RelayLeg")
        assertTrue(relayLeg.contains("relayConfigured = relayConfigured(host)"), relayLeg)
        assertFalse(relayLeg.contains("secure."), relayLeg)
        val route = AppSourcePins.blockAfter(conn, "fun route(cap: Capability): LegRouting.Leg")
        assertFalse(route.contains("secure."), route)
        // The screens that ask it never read a secret themselves either.
        for (file in listOf("HostScreen.kt", "BoardTab.kt", "SessionsTab.kt", "SourceControlScreen.kt")) {
            val src = AppSourcePins.ui(file)
            assertFalse(src.contains("secure.getString") || src.contains("secure.getBytes"), "$file decrypts a secret")
        }
    }

    @Test
    fun `the app feeds the computer's advertisement into the routing, and adopts on a listing`() {
        val conn = AppSourcePins.app("conn/ConnectionManager.kt")
        val relayLeg = AppSourcePins.blockAfter(conn, "fun relayLeg(): LegRouting.RelayLeg")
        assertTrue(relayLeg.contains("relayAdvertised = (conn as? SshHostConnection)?.relayAdvertised"), relayLeg)
        val refresh = AppSourcePins.blockAfter(conn, "suspend fun refreshNow(trigger: Trigger = Trigger.AUTO)")
        AppSourcePins.assertInOrder(
            refresh,
            "val advertisedBefore = ssh?.relayAdvertised",
            "c.listProjects()",
            "LegRouting.adoptAfterListing(relayLeg(), advertisedBefore, ssh.relayAdvertised, userAsked = trigger == Trigger.USER)",
            "adoptInBackground(ssh)"
        )
        // The screens re-ask when a late adoption stores the leg, which no listing announces.
        for (file in listOf("HostScreen.kt", "BoardTab.kt")) {
            val src = AppSourcePins.ui(file)
            assertTrue(src.contains("val secretsRevision by graph.secure.revision.collectAsState()"), file)
            assertTrue(src.contains("val hostRecords by graph.hosts.hosts.collectAsState()"), file)
        }
        assertTrue(AppSourcePins.ui("HostScreen.kt").contains("remember(state, snapshot, secretsRevision, hostRecords) { session.route(Capability.REGISTER_NODE) }"))
        assertTrue(AppSourcePins.ui("BoardTab.kt").contains("remember(snapshot, project, secretsRevision, hostRecords) { session.route(Capability.BOARD_WRITES, project) }"))
    }

    /**
     * The review of A26: the disabled New session carried its reason in a floating box of up to
     * 300 dp beside it — five to seven lines over a list that reserves 96 dp for a FAB — covering the
     * last sessions. The reason is the list's first row; the button stays as small as a FAB.
     */
    @Test
    fun `a disabled New session says why at the top of the list, not over its last rows`() {
        val host = AppSourcePins.ui("HostScreen.kt")
        val fab = AppSourcePins.blockAfter(host, "floatingActionButton = {")
        // No text of the reason beside the button (the old box was `Text(blocked.reason, …widthIn(max = 300.dp)…)`).
        assertFalse(fab.contains(".reason") || fab.contains("Text(newBlocked") || fab.contains("widthIn"), fab)
        assertTrue(fab.contains("enabled = false"), fab)
        assertTrue(host.contains("SessionsTab(nav, hostId, session, snapshot, newSessionNote = newBlocked?.takeIf { offersNew })"))
        val sessions = AppSourcePins.ui("SessionsTab.kt")
        AppSourcePins.assertInOrder(
            sessions,
            "newSessionNote?.let { NewSessionNote(it) }", // also when no project has a session yet
            "LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 96.dp)) {",
            "if (newSessionNote != null) item(key = \"new-session-note\") { NewSessionNote(newSessionNote) }",
            "for (project in projects) {"
        )
    }
}
