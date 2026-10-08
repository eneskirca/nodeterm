package dev.nodeterm.protocol.host

/** The desktop has not pinned this phone, and the caller asked not to trigger its approval dialog. */
class RelayApprovalRequiredException :
    HostException("This phone is not approved on your computer yet. Open the app and connect once to approve it.")

/** The approval dialog was dismissed (Deny) — the host closed the handshake while we waited. */
class RelayApprovalRefusedException :
    HostException("Your computer did not approve this phone (the request was declined or dismissed).")

/** Nobody answered the approval dialog before the phone stopped waiting. */
class RelayApprovalTimeoutException :
    HostException("Nobody approved this phone on your computer in time.")

/**
 * Who may dial a computer's relay leg, and when (audit A05/A17/A23/A30).
 *
 * The desktop raises its SAS approval dialog the moment a never-pinned phone completes the relay
 * handshake (standing-host.ts `onPeerReady`) — BEFORE the phone learns it is awaiting approval, so
 * "abort on awaiting" cannot keep the dialog off an unattended desktop. The only prevention is not
 * dialing. Two rules:
 *
 *  1. **Background dials only a computer that approves this phone without its dialog.** A background
 *     check (the Inbox worker) dials the relay only when [isApproved] says so: a FOREGROUND relay
 *     connect has already succeeded (the computer pinned this phone's key), or pairing said
 *     `relayApproved` ([dev.nodeterm.protocol.pairing.PairingResult.relayApproved]). The second covers
 *     a key the computer has not pinned yet and has never seen on the relay — a phone paired while
 *     remote access was off, whose background check may then be its FIRST relay handshake — because
 *     the pairing recorded the key and the computer's standing host pins it on that handshake without
 *     the dialog (audit A07-late; the desktop holds the phone's first request until it has decided,
 *     so the check is not told it is awaiting approval meanwhile). Either way the check asks the
 *     connector to give up rather than wait if approval turns out to be needed (the pin was revoked,
 *     the pairing removed, or a desktop that predates the late pin), and forgets the approval so it
 *     does not try again.
 *  2. **A refused or unanswered approval is not retried on its own.** After Deny, or nobody
 *     answering, the automatic dials (the 8 s poll, reconnect-after-drop) skip the relay leg with the
 *     reason, until the user asks again (Try again / opening the computer). Before this, the phone
 *     re-dialed about 8 s after Deny and the dialog came straight back.
 *
 * Pure (state in memory + the two injected accessors for the persisted flag), so it is JVM-tested.
 */
class RelayApprovalGate(
    private val isApproved: (hostId: String) -> Boolean,
    private val setApproved: (hostId: String, approved: Boolean) -> Unit
) {
    /** Why a dial is happening. */
    enum class Trigger {
        /** The user asked (Try again, Refresh, opening the computer): releases a hold. */
        USER,
        /** The app on its own, in the foreground (the poll, a reconnect after a drop). */
        AUTO,
        /**
         * Nobody is looking at the app: the Inbox worker, or an answer given from a notification (audit
         * A25), where the user tapped but would not see an approval code either.
         */
        BACKGROUND
    }

    sealed interface Decision {
        /** Dial. With [requireApproved], abort instead of waiting for an approval dialog. */
        data class Dial(val requireApproved: Boolean) : Decision
        data class Skip(val reason: String) : Decision
    }

    private val holds = HashMap<String, String>()

    @Synchronized
    fun decide(hostId: String, trigger: Trigger): Decision {
        if (trigger == Trigger.USER) holds.remove(hostId)
        holds[hostId]?.let { return Decision.Skip(it) }
        if (trigger == Trigger.BACKGROUND) {
            return if (isApproved(hostId)) Decision.Dial(requireApproved = true)
            else Decision.Skip(NOT_APPROVED_IN_BACKGROUND)
        }
        return Decision.Dial(requireApproved = false)
    }

    /** A relay connect succeeded: the host serves us, so our key is pinned there. */
    @Synchronized
    fun onConnected(hostId: String) {
        holds.remove(hostId)
        setApproved(hostId, true)
    }

    /** A relay connect failed with [error]. */
    @Synchronized
    fun onFailed(hostId: String, error: Throwable) {
        when (error) {
            is RelayApprovalRefusedException -> {
                holds[hostId] = error.message + " Tap Try again to ask again."
                setApproved(hostId, false)
            }
            is RelayApprovalTimeoutException -> {
                holds[hostId] = error.message + " Tap Try again when you are at the computer."
                setApproved(hostId, false)
            }
            is RelayApprovalRequiredException -> setApproved(hostId, false)
            else -> Unit // network, relay, backend: ordinary failures, retried as before
        }
    }

    /** The current hold for [hostId], if automatic dials are suspended. */
    @Synchronized
    fun hold(hostId: String): String? = holds[hostId]

    @Synchronized
    fun forget(hostId: String) {
        holds.remove(hostId)
    }

    companion object {
        const val NOT_APPROVED_IN_BACKGROUND =
            "Not checked in the background: this phone has not been approved on the computer through the relay yet."
    }
}
