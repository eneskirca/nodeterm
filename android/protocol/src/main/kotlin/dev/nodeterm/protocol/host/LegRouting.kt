package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.ProjectInfo

/**
 * One thing a connection can do beyond browse + attach, as [HostCapabilities] names it. The verbs
 * under each are the host-service ones the relay serves.
 */
enum class Capability(val what: String) {
    /** `projects.ensureBoard`, `projects.setCardColumn`, `projects.editCardLabels`. */
    BOARD_WRITES("Editing the board"),
    /** `git.*`. */
    GIT("Source control"),
    /** `node.wake`, `node.refresh`, `node.rename`. */
    NODE_ACTIONS("Waking, refreshing and renaming a session"),
    /** `projects.registerNode` (a session the phone starts, put on the canvas). */
    REGISTER_NODE("Starting a new session"),
    /** `approvals.answer` / the `.answer` file. */
    ANSWER_APPROVALS("Answering an approval");

    fun of(c: HostCapabilities): Boolean = when (this) {
        BOARD_WRITES -> c.boardWrites
        GIT -> c.git
        NODE_ACTIONS -> c.nodeActions
        REGISTER_NODE -> c.registerNode
        ANSWER_APPROVALS -> c.answerApprovals
    }
}

/**
 * Which leg of a paired computer answers a verb (audit A26), decided in ONE place so the UI and the
 * call agree. The direct-SSH leg (the LAN one `Auto` picks first) is POSIX sh + tmux on the machine;
 * what needs nodeterm THE APP — board writes, registering a new session and node actions — is the
 * relay's. Before this, a phone on SSH simply had none of it (the New-session button vanished, the
 * board was read-only), although the same computer's relay leg was one tap away.
 *
 * The rule: the primary connection when it can; else the relay leg opened NEXT to it on demand, when
 * this phone holds one; else unavailable, with the reason the UI shows on a disabled control.
 *
 * The relay is opened only for a user's action (a tap): [dev.nodeterm.protocol.host.RelayApprovalGate]
 * still decides, so a background path never makes a first relay handshake.
 */
object LegRouting {
    /** What the relay leg serves: everything host-service has a verb for. */
    val RELAY_CAPABILITIES = HostCapabilities(
        boardWrites = true, git = true, nodeActions = true, registerNode = true, answerApprovals = true
    )

    /** Whether this phone can reach the computer's relay leg next to its primary connection. */
    enum class RelayLeg {
        /**
         * A relay block, its host key and a stored device token, the route allows the relay, and the
         * computer was not seen with remote access off.
         */
        AVAILABLE,
        /** The phone holds no relay leg: remote access was off at pairing and has not been adopted since. */
        NOT_SET_UP,
        /**
         * The phone holds no relay leg yet, but the computer advertises one (remote access is on
         * there): late adoption has not run, or failed, on this connection. A refresh adopts it.
         */
        NOT_PICKED_UP,
        /**
         * The phone holds a relay leg, but the computer is not advertising its relay right now: remote
         * access was turned off on it after the phone got its token. The token is kept (turning remote
         * access back on makes it work again); a dial would only wait out the relay's timeout.
         */
        REMOTE_ACCESS_OFF,
        /** The phone has one, but the user set this computer to "Only on my network". */
        ROUTE_SSH_ONLY,
        /**
         * The computer was added by its SSH address, not paired (audit A27): it has no relay leg and
         * never gets one, so turning remote access on would not help.
         */
        ADDED_OVER_SSH
    }

    sealed interface Leg {
        /** The connection already open does it. */
        data object Primary : Leg
        /** Open (or reuse) the relay connection held next to the primary one. */
        data object Relay : Leg
        /** Neither leg can; [reason] is what a disabled control says. */
        data class Unavailable(val reason: String) : Leg
    }

    /**
     * Facts the relay leg's availability comes from. Pure, so the app and its tests agree.
     * [addedOverSsh] (a computer added by its SSH address, audit A27) wins over the rest: such a
     * computer has no relay leg, whatever else the phone holds.
     *
     * [relayConfigured] is what the phone STORES (a relay block, its host key, a device token — asked
     * by presence, never by decrypting it, so a screen may ask while composing; audit A47).
     * [relayAdvertised] is what the computer said at the last listing over direct SSH (whether its
     * `~/.nodeterm/relay.json` is there), null when unknown (not on SSH, or not listed yet). Unknown
     * never takes a leg away: it is what the relay connection itself, or a first connect, looks like.
     */
    fun relayLeg(
        relayConfigured: Boolean,
        sshOnlyRoute: Boolean,
        addedOverSsh: Boolean = false,
        relayAdvertised: Boolean? = null
    ): RelayLeg = when {
        addedOverSsh -> RelayLeg.ADDED_OVER_SSH
        !relayConfigured && relayAdvertised == true -> RelayLeg.NOT_PICKED_UP
        !relayConfigured -> RelayLeg.NOT_SET_UP
        relayAdvertised == false -> RelayLeg.REMOTE_ACCESS_OFF
        sshOnlyRoute -> RelayLeg.ROUTE_SSH_ONLY
        else -> RelayLeg.AVAILABLE
    }

    /**
     * Whether a listing over direct SSH should run late adoption now: the phone holds no relay leg
     * and the computer advertises one, and either the user asked (Refresh, Try again, opening the
     * computer) or the advertisement has just appeared on this connection (remote access was turned
     * on while the phone watched). Not on every poll: each attempt mints a token against the API.
     */
    fun adoptAfterListing(relay: RelayLeg, advertisedBefore: Boolean?, advertisedNow: Boolean?, userAsked: Boolean): Boolean =
        (relay == RelayLeg.NOT_SET_UP || relay == RelayLeg.NOT_PICKED_UP) && advertisedNow == true &&
            (userAsked || advertisedBefore == false)

    /**
     * Where [cap] goes. [primary] is the open connection's transport (null: not connected yet), with
     * its [primaryCaps].
     */
    fun route(cap: Capability, primary: TransportKind?, primaryCaps: HostCapabilities?, relay: RelayLeg): Leg {
        if (primary != null && primaryCaps != null && cap.of(primaryCaps)) return Leg.Primary
        if (primary == TransportKind.RELAY) {
            // The relay itself refused: nothing else to open.
            return Leg.Unavailable("${cap.what} isn't available on this computer.")
        }
        return when (relay) {
            RelayLeg.AVAILABLE -> Leg.Relay
            RelayLeg.NOT_SET_UP -> Leg.Unavailable(notSetUp(cap))
            RelayLeg.NOT_PICKED_UP -> Leg.Unavailable(notPickedUp(cap))
            RelayLeg.REMOTE_ACCESS_OFF -> Leg.Unavailable(remoteAccessOff(cap))
            RelayLeg.ROUTE_SSH_ONLY -> Leg.Unavailable(sshOnly(cap))
            RelayLeg.ADDED_OVER_SSH -> Leg.Unavailable(addedOverSsh(cap))
        }
    }

    /**
     * Where [cap] goes for something in [project], given where it goes for the computer ([leg],
     * from [route]). A project a desktop ELSEWHERE drives over SSH ([ProjectInfo.drivenRemotely],
     * audit A27) is that desktop's: its sessions run on this computer, but its canvas, board and node
     * actions are nodeterm the app's on the OTHER computer, which neither leg of this one reaches —
     * this computer's relay would answer for its own canvas. So everything but what the machine does
     * itself (answering a held approval, or direct-SSH Git in a listed local folder) is unavailable, with that reason.
     */
    fun forProject(cap: Capability, project: ProjectInfo?, leg: Leg): Leg =
        if (project?.drivenRemotely == true && cap != Capability.ANSWER_APPROVALS &&
            !(cap == Capability.GIT && leg == Leg.Primary)) Leg.Unavailable(drivenElsewhere(cap)) else leg

    fun drivenElsewhere(cap: Capability) =
        "${cap.what} isn't available for this project from the phone: it belongs to nodeterm on another computer, " +
            "which runs its sessions here over SSH. Use nodeterm on that computer."

    /** What each capability can reach right now, for a screen deciding several controls at once. */
    fun reach(primary: TransportKind?, primaryCaps: HostCapabilities?, relay: RelayLeg): Map<Capability, Leg> =
        Capability.entries.associateWith { route(it, primary, primaryCaps, relay) }

    /**
     * The pickup it promises is real: every listing over direct SSH (the host screen's 8 s refresh,
     * and Refresh) reads whether the computer advertises its relay, and adopts it when it newly does
     * ([adoptAfterListing]).
     */
    private fun notSetUp(cap: Capability) =
        "${cap.what} goes through nodeterm on the computer, which this phone reaches through the relay, and " +
            "this phone has no relay connection to it yet. Turn on remote access in nodeterm → Settings → Phone; " +
            "the phone picks it up on its next refresh on your network."

    /** Remote access IS on: telling the user to turn it on would be the A26 error text again. */
    private fun notPickedUp(cap: Capability) =
        "${cap.what} goes through nodeterm on the computer, which this phone reaches through the relay. Remote " +
            "access is on there, but this phone has not picked up its relay connection yet: tap Refresh on the " +
            "computer's screen to try again."

    /**
     * The phone holds a token, but the computer stopped advertising its relay. Without this the
     * controls showed enabled and a tap waited out the relay's handshake timeout before failing.
     */
    private fun remoteAccessOff(cap: Capability) =
        "${cap.what} goes through nodeterm on the computer, which this phone reaches through the relay, and " +
            "remote access is off on the computer right now. Turn it on in nodeterm → Settings → Phone; the phone " +
            "notices on its next refresh."

    /**
     * A computer added by its SSH address: unlike [notSetUp], nothing on the computer can switch the
     * relay on for it (a Server Edition has no pairing service), so the text names no setting.
     */
    fun addedOverSsh(cap: Capability) =
        "${cap.what} goes through nodeterm on the computer over the relay, and remote access isn't set up for " +
            "this computer: it was added by its SSH address, so the phone reaches it over SSH only."

    private fun sshOnly(cap: Capability) =
        "${cap.what} goes through the relay, and this computer is set to \"Only on my network (SSH)\". Choose " +
            "\"Automatic\" or \"Only through the relay\" in Settings → How to reach each computer."

    /**
     * What the direct-SSH transport says when a relay verb is called on it anyway. The app routes
     * those to the relay ([route]), so this is the message of a caller that skipped the routing — and
     * it must not tell a user whose remote access is ON to turn it on (the phone merely picked SSH).
     */
    fun sshRefusal(what: String) =
        "$what isn't done over your network: it goes through nodeterm on the computer, which the phone " +
            "reaches through the relay."
}
