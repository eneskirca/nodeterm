package dev.nodeterm.android.conn

import dev.nodeterm.android.AppGraph
import dev.nodeterm.android.data.RoutePreference
import dev.nodeterm.android.data.SecureStore
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.ConnectionUsers
import dev.nodeterm.protocol.host.ForegroundRefresh
import dev.nodeterm.protocol.host.HostLifetime
import dev.nodeterm.protocol.host.HostSessionRegistry
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.InboxNotificationActions
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.ListingFailure
import dev.nodeterm.protocol.host.ManagedSessionCreation
import dev.nodeterm.protocol.host.ManagedSessionRefusedException
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import dev.nodeterm.protocol.host.RelayConnectStatus
import dev.nodeterm.protocol.host.RelayConnector
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.OnScreenTracker
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.SshTerminalCreation
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.RelayBlock
import dev.nodeterm.protocol.pairing.RelayPairingProof
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.relay.RelayApi
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.LanRefresh
import dev.nodeterm.protocol.ssh.NothingFoundException
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshTerminalCreationRefusedException
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean

sealed interface ConnState {
    data object Idle : ConnState
    data class Connecting(val detail: String) : ConnState
    /** The desktop is showing its approval dialog; the human compares this code. */
    data class AwaitingApproval(val sas: String) : ConnState
    data class Connected(val kind: TransportKind) : ConnState
    data class Failed(val message: String) : ConnState

    /**
     * Whether this state leaves a failed listing ([HostSession.lastError]) to the screen to show. Not
     * while connecting or waiting for approval (an attempt is under way) and not [Failed] (it carries
     * its own message). [Idle] does: a listing that fails with an unexpected error drops the connection
     * ([HostSession.refreshNow]) and a background check closes it when it ends, and both leave Idle
     * with the error standing and the cached cards on screen (the review of A55).
     */
    val showsListError: Boolean get() = this is Connected || this == Idle
}

/**
 * One paired computer's live connection and latest listing. Route choice mirrors the iOS app: the
 * direct-SSH leg first when the computer installed a key for us (it is the LAN, it is fast, and it
 * needs no relay), the E2EE relay when that fails or the computer is relay-only (Windows).
 */
class HostSession(val hostId: String, private val graph: AppGraph) {
    private val scope: CoroutineScope get() = graph.scope
    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()
    private val _snapshot = MutableStateFlow(ProjectsSnapshot.EMPTY)
    val snapshot: StateFlow<ProjectsSnapshot> = _snapshot.asStateFlow()
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()
    private val _sshWarning = MutableStateFlow<String?>(null)

    /**
     * Why the current connection is NOT the direct-SSH one although the route would have preferred
     * it: the server at the paired address presented a different host key, so the Auto route went on
     * to the relay (audit A49/A74). Set per connect; shown while connected, so a changed key never
     * disappears behind a relay that worked.
     */
    val sshWarning: StateFlow<String?> = _sshWarning.asStateFlow()

    private val lifetime = HostLifetime()
    @Volatile private var connectionLease: HostLifetime.Lease? = null
    private val mutex = Mutex()
    @Volatile private var conn: HostConnection? = null

    /** The screens that show this computer and the background jobs on its connection (review of A25). */
    private val users = ConnectionUsers()
    private val foreground = ForegroundRefresh(
        scope, users, { disconnect() },
        refresh = { trigger -> refreshNow(trigger) },
        pause = { delay(POLL_MS) },
    )

    val connection: HostConnection? get() = conn

    // Host-owned, rather than dialog-owned: dismissal/background must not cancel a sent creation.
    val sshTerminalCreation = SshTerminalCreation(graph.scope, { request ->
        createAndRefreshSshTerminal(request.nodeId, request.cwd)
    }, definitiveFailure = { it is IllegalArgumentException || it is SshTerminalCreationRefusedException })

    val managedSessionCreation = ManagedSessionCreation(graph.scope, graph.hosts.managedCreationStorage(hostId) { lifetime.active },
        prepare = { choice -> inBackground {
            val ssh = ensureConnected(Trigger.USER) as? SshHostConnection
                ?: throw ManagedSessionRefusedException("Connect over SSH to create this managed session.")
            ssh.prepareManagedSession(choice)
        } },
        create = { request -> inBackground {
            try {
                val ssh = ensureConnected(Trigger.BACKGROUND) as? SshHostConnection
                    ?: throw ManagedSessionRefusedException("The SSH route changed before creation was sent. Refresh and try again.")
                ssh.createManagedSession(request)
            } finally { refreshNow(Trigger.BACKGROUND) }
        } })

    suspend fun createAndRefreshSshTerminal(nodeId: String, cwd: String?) = inBackground {
        try {
            val ssh = ensureConnected(Trigger.BACKGROUND) as? SshHostConnection
                ?: throw HostException("Connect over SSH to create a plain terminal.")
            ssh.createTerminal(nodeId, cwd)
        } finally {
            // Also re-list after a lost reply, and when the user has already closed the dialog.
            // Cancellation still propagates; refreshNow handles ordinary listing errors itself.
            refreshNow(Trigger.BACKGROUND)
        }
    }


    /** A screen is showing this computer right now (so its connection is worth keeping open). */
    val isWatched: Boolean get() = users.watched

    /**
     * Runs [block] as a background user of this computer's connection: the periodic Inbox check, or an
     * answer given from a notification (the review of audit A25). They share the connection with each
     * other and with the screens, so it is closed when [block] ends only if no screen shows this
     * computer and no other background job still runs on it ([ConnectionUsers]): don't hold a socket
     * open in the background for a screen nobody is looking at, but never close it under another job.
     */
    suspend fun <T> inBackground(block: suspend () -> T): T = users.hold({ disconnect() }, block)

    /**
     * What of this computer is on screen: its Inbox tab, and the sessions open in a terminal, as far
     * as each terminal shows its pane. Each listing announces its new Inbox events except those
     * (audit A73, see [refreshNow]).
     */
    val onScreen = OnScreenTracker()

    suspend fun ensureConnected(trigger: Trigger = Trigger.AUTO): HostConnection {
        val lease = lifetime.capture()
        conn?.let { return it }
        return mutex.withLock {
            lifetime.requireCurrent(lease)
            conn ?: connectLocked(trigger, lease)
        }
    }

    private suspend fun connectLocked(trigger: Trigger, lease: HostLifetime.Lease): HostConnection {
        val host = graph.hosts.get(hostId) ?: throw HostException("This computer is no longer paired.")
        val route = graph.hosts.route(hostId)
        val errors = ArrayList<String>()
        var sshWarning: String? = null
        var refusedHostKey: String? = null

        if (route != RoutePreference.RELAY_ONLY && host.sshAvailable) {
            _state.value = ConnState.Connecting(if (host.manual) "Connecting over SSH…" else "Connecting on your network…")
            // The blocking dial finishes even when this coroutine is cancelled meanwhile (the poll
            // job stops when a screen goes away), and withContext then drops its result: close it,
            // or it stays open, keep-alive and all, for the life of the process (audit A20).
            var dialed: SshHostConnection? = null
            try {
                val ssh = lifetime.dial(lease) { withContext(Dispatchers.IO) {
                    SshHostConnection.connect(
                        host.host, host.port, host.user, graph.sshIdentity, pinFor(host, lease),
                        connectTimeoutMs = if (route == RoutePreference.AUTO) 4_000 else 10_000,
                        profilePath = host.sshProfilePath
                    ).also { dialed = it }
                } }
                lifetime.publish(lease) {
                    _sshWarning.value = null
                    sshRefusal = null
                }
                adopt(ssh, lease)
                adoptInBackground(ssh)
                return ssh
            } catch (e: kotlinx.coroutines.CancellationException) {
                dialed?.let { c -> scope.launch(Dispatchers.IO) { runCatching { c.close() } } }
                lifetime.whenCurrent(lease) { _state.value = ConnState.Idle }
                throw e
            } catch (e: Exception) {
                lifetime.requireCurrent(lease)
                // A changed host key is refused for SSH and said out loud, but in Auto it does not
                // stop the relay leg, which authenticates the computer on its own (audit A49/A74):
                // most often another machine simply has the paired address now. "Only on my
                // network" has nothing else to try, so there it stops.
                // A computer added by its SSH address has nothing else to try either (audit A27).
                when (val next = SshFallback.afterFailure(e, route != RoutePreference.SSH_ONLY, relayConfigured(host), addedOverSsh = host.manual)) {
                    is SshFallback.Next.Stop -> {
                        _sshWarning.value = null
                        _state.value = ConnState.Failed(next.message)
                        throw HostException(next.message)
                    }
                    is SshFallback.Next.TryRelay -> {
                        errors += next.error
                        sshWarning = next.warning
                        refusedHostKey = next.refusedHostKey
                    }
                }
            }
        }

        if (route != RoutePreference.SSH_ONLY) {
            val relay = host.relay
            val token = graph.secure.getString(SecureStore.relayTokenKey(host.id))
            val hostKey = host.relayHostKeyB64
            val decision = if (relay != null && token != null && hostKey != null) lifetime.publish(lease) { graph.relayGate.decide(hostId, trigger) } else null
            if (decision is RelayApprovalGate.Decision.Skip) {
                errors += "Through the relay: ${decision.reason}"
            } else if (relay != null && token != null && hostKey != null) {
                val requireApproved = (decision as? RelayApprovalGate.Decision.Dial)?.requireApproved == true
                _state.value = ConnState.Connecting("Connecting through the relay…")
                try {
                    val connected = dialRelay(host, relay, token, hostKey, requireApproved, lease) { st ->
                        lifetime.whenCurrent(lease) { when (st) {
                            is RelayConnectStatus.AwaitingApproval -> _state.value = ConnState.AwaitingApproval(st.sas)
                            RelayConnectStatus.Handshaking -> _state.value = ConnState.Connecting("Verifying your computer…")
                            RelayConnectStatus.MintingToken -> Unit
                        } }
                    }
                    try {
                        lifetime.publish(lease) {
                            graph.relayGate.onConnected(hostId)
                                    _snapshot.value = connected.first
                            _sshWarning.value = sshWarning
                            sshRefusal = refusedHostKey?.let { SshRefusal(connected.connection, it) }
                        }
                        adopt(connected.connection, lease)
                        refreshLanLeg(connected.connection, connected.first)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        scope.launch(Dispatchers.IO) { runCatching { connected.connection.close() } }
                        throw e
                    }
                    return connected.connection
                } catch (e: kotlinx.coroutines.CancellationException) {
                    // A cancelled dial is not a failed one: no "offline", no error text (A20).
                    lifetime.whenCurrent(lease) { _state.value = ConnState.Idle }
                    throw e
                } catch (e: Exception) {
                    lifetime.publish(lease) { graph.relayGate.onFailed(hostId, e) }
                    errors += "Through the relay: ${e.message ?: e.javaClass.simpleName}"
                }
            } else if (route == RoutePreference.RELAY_ONLY || !host.sshAvailable) {
                errors += "Remote access isn't set up for this computer yet. In nodeterm on the computer, open " +
                    "Settings → Phone and turn on remote access, then pair again — or connect once on the same network."
            }
        }

        val msg = errors.joinToString("\n").ifEmpty { "Couldn't connect." }
        lifetime.publish(lease) {
            _sshWarning.value = null // the failure message already carries it
            _state.value = ConnState.Failed(msg)
        }
        throw HostException(msg)
    }

    /**
     * The phone holds a relay leg for [host]: the same three facts the relay block needs to dial. Never
     * for a computer added by its SSH address, which has none (audit A27).
     *
     * The token is asked by PRESENCE ([SecureStore.hasRelayToken]: the preferences alone, no Keystore
     * decrypt, no waiting on the store's lock), never by reading it: the screens ask [route] while
     * composing, on every listing (audit A47). Reading it there also answered "no relay leg" during a
     * keystore hiccup, and the controls then told a user whose remote access is on to turn it on.
     * What dials ([connectLocked], [viaRelay]) still reads the token itself.
     */
    private fun relayConfigured(host: PairedHost): Boolean =
        !host.manual && host.relay != null && host.relayHostKeyB64 != null && graph.secure.hasRelayToken(host.id)

    private suspend fun dialRelay(
        host: PairedHost,
        relay: RelayBlock,
        token: String,
        hostKey: String,
        requireApproved: Boolean,
        lease: HostLifetime.Lease,
        onStatus: (RelayConnectStatus) -> Unit
    ): RelayConnector.Connected {
        // Keep the produced resource before the cancellable async handoff: cancellation may
        // discard a successful result before the caller has a reference it can close.
        var dialed: RelayConnector.Connected? = null
        try {
            return lifetime.dial(lease) {
                lifetime.requireCurrent(lease)
                val join = RelayApi(graph.hosts.apiBase).join(token, relay.hostId)
                lifetime.requireCurrent(lease)
                val deviceKeys = graph.boxKeys
                RelayConnector.connect(
                    relayUrl = relay.relayEndpoint,
                    token = join.pairingToken,
                    deviceKeys = deviceKeys,
                    hostPublicKeyB64 = hostKey,
                    requireApproved = requireApproved,
                    legacyPairing = legacyRelayPairing(host, hostKey, deviceKeys, lease),
                    onStatus = onStatus
                ).also { dialed = it }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            dialed?.let { connected -> scope.launch(Dispatchers.IO) { runCatching { connected.connection.close() } } }
            throw e
        }
    }

    /** No get-or-create: a relay-only upgrade cannot replace a missing SSH identity to prove it. */
    private fun legacyRelayPairing(host: PairedHost, hostKey: String, keys: BoxKeyPair, lease: HostLifetime.Lease): RelayPairingProof.Context {
        return RelayPairingProof.Context(host, hostKey, keys.publicKeyB64,
            retainedSshSeed = { graph.secure.getBytes(SecureStore.SSH_SEED) },
            requireCurrent = {
                lifetime.requireCurrent(lease)
                val current = graph.hosts.currentHost(host.id, host.hostKeyB64) { lifetime.isCurrent(lease) }
                    ?: throw kotlinx.coroutines.CancellationException("This computer pairing changed.")
                if (current.manual || current.relayHostKeyB64 != hostKey || graph.boxKeys.publicKeyB64 != keys.publicKeyB64) {
                    throw kotlinx.coroutines.CancellationException("This computer's relay identity changed.")
                }
            })
    }

    /** A relay connection held NEXT TO a direct-SSH one, for what SSH must not do (see [viaRelay]). */
    @Volatile private var sideRelay: HostConnection? = null
    private val sideMutex = Mutex()

    /**
     * Whether the relay leg can be opened next to the primary connection. Read fresh each time: a
     * late adoption ([adoptRelayIfAdvertised]) mints the token while connected over SSH, and each
     * listing over SSH says whether the computer advertises its relay right now (remote access may
     * have been turned off since the phone got its token). Cheap enough to ask while composing: no
     * secret is decrypted (see [relayConfigured]).
     */
    fun relayLeg(): LegRouting.RelayLeg {
        val host = graph.hosts.get(hostId) ?: return LegRouting.RelayLeg.NOT_SET_UP
        return LegRouting.relayLeg(
            relayConfigured = relayConfigured(host),
            sshOnlyRoute = graph.hosts.route(hostId) == RoutePreference.SSH_ONLY,
            addedOverSsh = host.manual,
            relayAdvertised = (conn as? SshHostConnection)?.relayAdvertised
        )
    }

    /**
     * This computer can be reached without a FIRST relay handshake (audit A25): over its SSH leg, or
     * through a relay that has already approved this phone. What a notification's answer may use: the
     * user tapped, but is not looking at the app to compare the desktop's approval code (audit A05).
     */
    fun reachableQuietly(): Boolean {
        val host = graph.hosts.get(hostId) ?: return false
        return InboxNotificationActions.reachableQuietly(
            sshLeg = host.sshAvailable && graph.hosts.route(hostId) != RoutePreference.RELAY_ONLY,
            relayLeg = relayLeg() == LegRouting.RelayLeg.AVAILABLE,
            relayApproved = graph.hosts.relayApproved(hostId)
        )
    }

    /** Which leg answers [cap] right now ([LegRouting.route]): the one decision the UI and [connectionFor] share. */
    fun route(cap: Capability): LegRouting.Leg {
        val c = conn
        return LegRouting.route(cap, c?.kind, c?.capabilities, relayLeg())
    }

    /**
     * [route] for something in [project]: a project another desktop drives over SSH is that
     * desktop's, which neither leg of this computer reaches ([LegRouting.forProject], audit A27).
     */
    fun route(cap: Capability, project: ProjectInfo?): LegRouting.Leg = LegRouting.forProject(cap, project, route(cap))

    /**
     * A connection that can do [cap] (audit A26): the primary one when it can, else the relay leg
     * opened next to it. For a USER's action — the relay dial goes through [RelayApprovalGate] with
     * [trigger], so a background caller never makes a first relay handshake. Throws a
     * [HostException] carrying the reason when neither leg can, which includes a [project] another
     * desktop drives over SSH (A27).
     */
    suspend fun connectionFor(
        cap: Capability,
        trigger: Trigger = Trigger.USER,
        onStatus: (RelayConnectStatus) -> Unit = {},
        project: ProjectInfo? = null
    ): HostConnection {
        val primary = ensureConnected(trigger)
        return when (val leg = route(cap, project)) {
            LegRouting.Leg.Primary -> primary
            LegRouting.Leg.Relay -> viaRelay(trigger, onStatus)
            is LegRouting.Leg.Unavailable -> throw HostException(leg.reason)
        }
    }

    private val _relayApproval = MutableStateFlow<String?>(null)

    /**
     * The approval code while the relay leg next to an SSH connection waits for the desktop's
     * dialog (its first dial on a desktop that has not pinned this phone): the host screen shows it,
     * since the board or New session that asked has no screen of its own for it.
     */
    val relayApproval: StateFlow<String?> = _relayApproval.asStateFlow()

    /**
     * A relay connection for one action the direct-SSH transport refuses
     * ([dev.nodeterm.protocol.host.NeedsRelayException]): a session that is not running (creating it
     * over SSH would leave it without its hook environment — audit A08), a node of the desktop's
     * SSH projects, which the desktop reaches on its host (audit A09), or a verb only nodeterm the
     * app serves (board writes, a new session, node actions, git — audit A26, via [connectionFor]).
     * The primary connection when it already IS the relay; otherwise one opened next to it and kept
     * until [disconnect]. [trigger] goes to [RelayApprovalGate]: a user's tap releases a held
     * approval and, the first time, the desktop's approval code is reported through [onStatus] (and
     * [relayApproval]); a background caller never makes a first handshake that would raise the
     * dialog (only one with a computer whose pairing answered `relayApproved`, audit A07-late).
     */
    suspend fun viaRelay(trigger: Trigger = Trigger.USER, onStatus: (RelayConnectStatus) -> Unit = {}): HostConnection {
        val lease = lifetime.capture()
        conn?.takeIf { it.kind == TransportKind.RELAY }?.let { return it }
        sideRelay?.let { return it }
        return sideMutex.withLock {
            lifetime.requireCurrent(lease)
            sideRelay ?: run {
                val host = graph.hosts.get(hostId) ?: throw HostException("This computer is no longer paired.")
                val relay = host.relay
                val token = graph.secure.getString(SecureStore.relayTokenKey(host.id))
                val hostKey = host.relayHostKeyB64
                if (relay == null || token == null || hostKey == null || graph.hosts.route(hostId) == RoutePreference.SSH_ONLY) {
                    throw HostException("Remote access isn't set up for this computer. Open the session in nodeterm on the computer instead.")
                }
                val requireApproved = when (val d = lifetime.publish(lease) { graph.relayGate.decide(hostId, trigger) }) {
                    is RelayApprovalGate.Decision.Skip -> throw HostException(d.reason)
                    is RelayApprovalGate.Decision.Dial -> d.requireApproved
                }
                val connected = try {
                    dialRelay(host, relay, token, hostKey, requireApproved = requireApproved, lease = lease) { st ->
                        lifetime.whenCurrent(lease) {
                            _relayApproval.value = (st as? RelayConnectStatus.AwaitingApproval)?.sas
                            onStatus(st)
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    lifetime.publish(lease) { graph.relayGate.onFailed(hostId, e) }
                    throw e
                } finally {
                    lifetime.whenCurrent(lease) { _relayApproval.value = null }
                }
                val c = connected.connection
                try {
                    lifetime.publish(lease) {
                        graph.relayGate.onConnected(hostId)
                        c.setOnClosed { lifetime.whenCurrent(lease) { if (sideRelay === c) sideRelay = null } }
                        sideRelay = c
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    scope.launch(Dispatchers.IO) { runCatching { c.close() } }
                    throw e
                }
                c
            }
        }
    }

    private fun adopt(c: HostConnection, lease: HostLifetime.Lease) {
        lifetime.publish(lease) {
            connectionLease = lease
            conn = c
            _lastError.value = null
            _state.value = ConnState.Connected(c.kind)
        }
        c.setOnClosed { reason ->
            var reconnect = false
            lifetime.whenCurrent(lease) { if (conn === c) {
                conn = null
                _state.value = ConnState.Failed("Disconnected" + (reason?.let { " ($it)" } ?: "") + ".")
                reconnect = true
            } }
            // ForegroundRefresh/ConnectionUsers can close us under their own monitors. Never
            // acquire those monitors while holding the lifetime publication monitor in reverse.
            if (reconnect && isWatched) foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn == null }) {
                delay(1_500)
            }
        }
        // A change the computer pushes is re-listed, and so announced, only while a screen shows this
        // computer, like the reconnect above (the review of A73). The connection outlives that screen
        // (until it drops or the background check closes it), and its pushes used to go on announcing
        // live for a computer the user had left, which the Settings text does not promise. What such a
        // push carried is not recorded as seen, so the background check announces it.
        c.setOnChanged { if (lifetime.isCurrent(lease) && conn === c && isWatched) foreground.changed(stillCurrent = { lifetime.isCurrent(lease) && conn === c }) }
    }

    private fun pinFor(host: PairedHost, lease: HostLifetime.Lease) = object : HostKeyPin {
        private fun current(): PairedHost = graph.hosts.currentHost(host.id, host.hostKeyB64) { lifetime.isCurrent(lease) }
            ?: throw kotlinx.coroutines.CancellationException("This computer connection changed.")
        override fun pinned(): String? = current().sshHostKeyFingerprint
        override fun pin(fingerprint: String) {
            lifetime.publish(lease) {
                graph.hosts.updateCurrent(host.id, host.hostKeyB64, { lifetime.isCurrent(lease) }) { it.copy(sshHostKeyFingerprint = fingerprint) }
            }
        }
        // A handshake keeps the exact pairing it began with, never a same-id successor's anchors.
        override fun anchors(): List<String> = current().sshHostKeyAnchors
    }

    /** The host key the SSH leg was refused in the connect that opened [connection] (review of A74-refresh). */
    private class SshRefusal(val connection: HostConnection, val hostKey: String)

    /**
     * Set by [connectLocked] when the SSH leg was refused for its host key and the relay leg then
     * connected: the key that server presented, which that relay connection's listings may confirm as
     * the computer's own ([LanRefresh]). Tied to the connection, so a later one never inherits it.
     */
    @Volatile private var sshRefusal: SshRefusal? = null

    /**
     * Update this computer's LAN leg from what it said beside a RELAY listing (audit A74-refresh,
     * [LanRefresh]): its current address and SSH host keys, and, when this connect's SSH leg was
     * refused a key the computer now names as its own, a pin that no longer lets it in.
     * [LanRefresh.afterListing] refuses a listing that came over SSH, which is the leg these facts
     * check. Recomputed inside the store's update so it applies to the record as it is then (a late
     * adoption may be writing the relay block at the same moment). Takes effect at the next SSH dial:
     * [connectLocked] and [pinFor] read the record fresh. When the relay is in use because the SSH leg
     * failed, the warning that says so gains a sentence about what changed. Never throws: a record that
     * could not be saved is not a failed listing.
     *
     * Only for the PRIMARY connection, never for the relay held next to a live SSH one ([viaRelay]):
     * there the LAN leg as recorded has just authenticated, which says more than a report does (a
     * computer with two adapters may report the other one).
     */
    private fun refreshLanLeg(c: HostConnection, listed: ProjectsSnapshot) {
        val lease = connectionLease ?: return
        runCatching { lifetime.whenCurrent(lease) {
            if (conn !== c) return@whenCurrent
            val before = graph.hosts.get(hostId) ?: return@whenCurrent
            val refused = sshRefusal?.takeIf { it.connection === c }?.hostKey
            val result = LanRefresh.afterListing(before, c.kind, listed, refused) ?: return@whenCurrent
            graph.hosts.updateCurrent(hostId, before.hostKeyB64, { lifetime.isCurrent(lease) && conn === c }) { current -> LanRefresh.afterListing(current, c.kind, listed, refused)?.host ?: current }
            val warning = _sshWarning.value
            val note = LanRefresh.note(result)
            if (warning != null && note != null && !warning.contains(note)) _sshWarning.value = "$warning $note"
        } }
    }

    /** One late adoption at a time: a connect and a listing may both ask for it. */
    private val adopting = AtomicBoolean(false)

    /** [adoptRelayIfAdvertised] over [ssh], in the background, unless one is already running. */
    private fun adoptInBackground(ssh: SshHostConnection) {
        val lease = connectionLease?.takeIf { lifetime.isCurrent(it) && conn === ssh } ?: return
        val host = graph.hosts.get(hostId) ?: return
        if (!adopting.compareAndSet(false, true)) return
        scope.launch {
            try {
                runCatching { adoptRelayIfAdvertised(ssh, host, lease) }
            } finally {
                adopting.set(false)
            }
        }
    }

    /**
     * LATE ADOPTION (relay-advertise.ts): a phone paired while remote access was off has no relay leg.
     * While the standing host is up, the computer advertises its relay identity in
     * `~/.nodeterm/relay.json`; read it over this TOFU-verified SSH connection and mint our own device
     * token, so the phone can reach the computer from anywhere without re-pairing.
     */
    private suspend fun adoptRelayIfAdvertised(ssh: SshHostConnection, host: PairedHost, lease: HostLifetime.Lease) {
        // A computer added by its SSH address never gets a relay leg (audit A27): no pairing anchors
        // the relay key such a file names, and its relay would not be one this phone was paired with.
        if (host.manual) return
        lifetime.requireCurrent(lease)
        val tokenKey = SecureStore.relayTokenKey(host.id)
        if (host.relay != null && graph.secure.getString(tokenKey) != null) return
        val ad = ssh.readRelayAdvertisement() ?: return
        lifetime.requireCurrent(lease)
        val hostIdAd = J.str(ad["hostId"]) ?: return
        val pub = J.str(ad["hostPublicKeyB64"]) ?: return
        val endpoint = J.str(ad["relayEndpoint"])?.takeIf(PairingPayload::isAllowedRelayEndpoint) ?: return
        val hostDeviceId = J.str(ad["hostDeviceId"]) ?: return
        // The QR's host key is the identity we paired with: an advertisement naming another key is
        // not this computer's relay identity.
        if (host.hostKeyB64 != null && host.hostKeyB64 != pub) return
        val minted = RelayApi(graph.hosts.apiBase).mintDevice(
            deviceId = graph.identity.deviceId(),
            hostDeviceId = hostDeviceId,
            hostPublicKeyB64 = pub,
            label = graph.hosts.deviceName,
            priorDeviceToken = graph.secure.getString(tokenKey)
        )
        // A mint may finish after Forget/re-pair/disconnect. Publish neither its token nor its
        // relay to a retired connection/identity; the store fences both writes with retirement.
        graph.hosts.adoptRelay(host.id, host.hostKeyB64,
            RelayBlock(minted.hostId.ifEmpty { hostIdAd }, pub, endpoint),
            currentConnection = { lifetime.isCurrent(lease) && conn === ssh },
            saveToken = { graph.secure.putString(tokenKey, minted.deviceToken) })
    }

    /**
     * Re-list now. Connects first when needed; failures land in [state]/[lastError], never throw.
     * [trigger] says who asked: a [Trigger.USER] refresh releases a held relay approval, a
     * [Trigger.BACKGROUND] one never makes a first relay handshake (see [RelayApprovalGate]).
     *
     * A listing that arrives announces its new Inbox events, minus what [onScreen] shows (audit A73):
     * the 8 s poll of the computer on screen, a change that computer pushed, and the background check
     * all come through here. All computers watches every paired host while visible; an individual
     * computer or terminal watches only its own host. Unwatched computers are not re-listed on a
     * push over a connection retained for a quick return ([adopt]).
     */
    suspend fun refreshNow(trigger: Trigger = Trigger.AUTO) {
        val operation = lifetime.capture()
        foreground.serial {
            lifetime.requireCurrent(operation)
            val listed = try {
                val c = ensureConnected(trigger)
                val lease = connectionLease ?: throw kotlinx.coroutines.CancellationException("This computer connection changed.")
                val ssh = c as? SshHostConnection
                val advertisedBefore = ssh?.relayAdvertised
                c.listProjects().also { lifetime.publish(lease) {
                    if (conn !== c) throw kotlinx.coroutines.CancellationException("This computer connection changed.")
                    // A listing over SSH says whether the computer advertises its relay right now. A
                    // phone without a relay leg adopts it on the user's refresh, or as soon as remote
                    // access is turned on while this connection watches (audit A26: the reason on a
                    // disabled control promises that pickup).
                    if (ssh != null && LegRouting.adoptAfterListing(relayLeg(), advertisedBefore, ssh.relayAdvertised, userAsked = trigger == Trigger.USER)) {
                        adoptInBackground(ssh)
                    }
                    // A listing over the relay says where the computer is on the LAN now (A74-refresh).
                    refreshLanLeg(c, it)
                    _snapshot.value = it
                    _lastError.value = null
                } }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                lifetime.whenCurrent(operation) {
                _snapshot.value = ListingFailure.snapshot(_snapshot.value, e)
                // Never null: an exception without a message must still say that the listing failed.
                // "Nothing found" offers the relay only when this phone has one to offer (review of A27b).
                _lastError.value = (e as? NothingFoundException)?.said(relayLeg()) ?: e.message ?: e.javaClass.simpleName
                // A HostException is an ANSWER (the host refused, or the connection already reported its
                // own drop). Anything else is an unexpected transport failure: drop the connection so the
                // next refresh dials a fresh one instead of reusing a dead socket.
                if (e !is HostException) disconnect()
                }
                return@serial
            }
            // Outside the try: a notification the system refused is not a failed listing, and must not
            // drop a working connection. No network here — the listing just arrived.
            runCatching { lifetime.whenCurrent(operation) { graph.announce(hostId, listed, onScreen.now(), quiet = reachableQuietly()) } }
        }
    }

    /**
     * A terminal of this computer just attached, so the pane of [nodeId] is in front of the user (the
     * A73 review). The listing that arrived while it was connecting left that session's events
     * waiting ([OnScreen.opening]), and the next listing is up to 8 s away: record what the pane
     * shows of the latest listing as seen now, so a user who looks and leaves before then is not told
     * about it afterwards. Records only, announces nothing, and costs no network call.
     */
    fun notePaneShown(nodeId: String) {
        val events = _snapshot.value.status?.inbox?.events ?: return
        val lease = connectionLease ?: return
        runCatching { lifetime.whenCurrent(lease) { graph.hosts.claimLive(hostId, events, OnScreen(nodes = setOf(nodeId)), notify = false) } }
    }

    /**
     * A refresh the USER asked for (Refresh, Try again), by default. The All computers screen re-lists
     * every computer as the app's own foreground refresh instead ([Trigger.AUTO], audit A55): it may
     * show a first approval code, but it does not lift a computer's held refusal; that computer's own
     * Try again does.
     */
    fun refresh(trigger: Trigger = Trigger.USER) {
        scope.launch { refreshNow(trigger) }
    }

    /**
     * While a screen shows this computer, re-list every 8 s (the iOS foreground cadence); each listing
     * announces what is new and not on screen ([refreshNow]).
     */
    fun startWatching(initialTrigger: Trigger = Trigger.USER) {
        lifetime.capture()
        foreground.start(initialTrigger)
    }

    fun stopWatching(closeWhenUnused: Boolean = false) {
        foreground.stop(closeWhenUnused)
    }

    /**
     * Drop the connection. Callers include click handlers on the MAIN thread (Forget, a route change,
     * re-pairing), so the close itself runs on [Dispatchers.IO]: a socket write there throws
     * `NetworkOnMainThreadException` and would leak the socket (audit A01).
     */
    fun disconnect() = lifetime.disconnect { disconnectOwned() }

    /** Change the browse/adoption profile under the same fence that retires old transport work. */
    fun changeSshProfile(path: String?) {
        dev.nodeterm.protocol.ssh.SshProfilePath.requireValid(path)
        lifetime.disconnect {
            if (!lifetime.active) return@disconnect
            graph.hosts.update(hostId) { it.copy(sshProfilePath = path) }
            disconnectOwned()
            _snapshot.value = ProjectsSnapshot.EMPTY
            _lastError.value = null
            _sshWarning.value = null
        }
    }

    /** Removed from ConnectionManager permanently; a new pairing gets a new HostSession object. */
    fun retire() = lifetime.retire { disconnectOwned() }

    private fun disconnectOwned() {
        val c = conn
        conn = null
        connectionLease = null
        val side = sideRelay
        sideRelay = null
        if (c != null || side != null) scope.launch(Dispatchers.IO) {
            runCatching { c?.close() }
            runCatching { side?.close() }
        }
        _state.value = ConnState.Idle
    }

    companion object {
        const val POLL_MS = 8_000L
    }
}

class ConnectionManager(private val graph: AppGraph) {
    private val sessions = HostSessionRegistry(
        create = { hostId: String -> HostSession(hostId, graph) },
        retire = { hostId, session ->
            session?.retire()
            graph.relayGate.forget(hostId)
            graph.terminalDrafts.retireOwner(hostId)
        },
    )

    @Synchronized
    fun session(hostId: String): HostSession = sessions.session(hostId)

    @Synchronized
    fun forget(hostId: String) = sessions.forget(hostId)

    /** Local store/secret publication only; connection closes are dispatched by retire(). */
    @Synchronized
    fun <T> retireAndPublish(hostIds: Collection<String>, publish: () -> T): T =
        sessions.retireAndPublish(hostIds, publish)

    @Synchronized
    fun all(): List<HostSession> = sessions.all()
}
