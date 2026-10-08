package dev.nodeterm.protocol.ssh

/**
 * What a connect does after the direct-SSH leg failed (audit A49/A74).
 *
 * The LAN leg dials the address the computer had when it was paired: usually a DHCP lease on a
 * private range. After the lease moved, or with the phone on another network that uses the same
 * range, a DIFFERENT machine running sshd can answer there, and its host key does not match the pin.
 * That machine is never used over SSH. But it is no reason to skip the relay: the relay leg
 * authenticates the computer on its own (the relay host key from pairing, then the SAS approval),
 * so going on to it loses no trust. Before this, a changed key stopped the Auto route outright, and
 * the only way out it named was re-pairing.
 *
 * Only the "Only on my network" route keeps the hard stop, because there is nothing else it may
 * try. Whether the relay leg may DIAL is not decided here: the caller still asks its
 * [dev.nodeterm.protocol.host.RelayApprovalGate], so a background check never makes a first relay
 * handshake because of this.
 *
 * Pure, so it is JVM-tested; the app's `HostSession` applies it.
 */
object SshFallback {
    sealed interface Next {
        /**
         * Go on to the relay leg. [error] joins what is shown if that fails too; [warning] is shown
         * even when it succeeds (a changed host key must not disappear behind a working relay).
         * [refusedHostKey] is the key the SSH server presented when it was refused for it
         * ([HostKeyChangedException.actual]): what the relay's report may confirm as the computer's own
         * ([LanRefresh], review of A74-refresh). Null for any other failure.
         */
        data class TryRelay(val error: String, val warning: String? = null, val refusedHostKey: String? = null) : Next

        /** Try nothing else: fail with [message]. */
        data class Stop(val message: String) : Next
    }

    /** Where the per-computer route setting lives, as Settings names it. */
    const val RELAY_ONLY_SETTING =
        "choose “Only through the relay” for this computer in Settings → How to reach each computer."

    /**
     * A reinstalled computer's new key is trusted again once the computer itself confirms it through the
     * relay ([LanRefresh], audit A74-refresh: a current nodeterm reports its keys on every relay listing,
     * and the relay connect that follows this refusal hands the refused key over as
     * [Next.TryRelay.refusedHostKey]), or by pairing it again. Neither is the only way out, and neither
     * trusts whatever answered at the address.
     */
    const val REPAIR_NOTE = "If the computer was reinstalled, the phone trusts its new key once the computer confirms it " +
        "through the relay (nodeterm on the computer must be up to date), or when you pair it again."

    /** The relay is not an option yet: say how to get one. */
    const val NO_RELAY_ADVICE =
        "This phone has no relay connection to it yet: turn on remote access in nodeterm on the computer " +
            "(Settings → Phone) and pair again, which also trusts the computer's current key."

    /**
     * For a key none of the reported keys name ([HostKeyNotPairedException], audit A49-anchor), in
     * place of [REPAIR_NOTE] (review of A49-anchor). Those keys are what nodeterm on the computer read
     * of its own SSH server, at pairing or since in a relay report ([LanRefresh]), and both read them
     * the same way (`src/main/ssh-host-keys.ts`). So pairing again, or a report, changes which key the
     * phone accepts only when the computer's keys changed since. When its SSH server uses a key that
     * reader cannot see (one named in a config file it cannot open, or with no `.pub` beside it), every
     * pairing and every report names the same keys again: promising otherwise sends the user round a
     * loop that ends where it started, and the relay is the way that works.
     */
    const val NOT_REPORTED_NOTE =
        "Pairing again, or the computer reporting its keys through the relay, changes this only if its SSH " +
            "host keys changed since it reported them: nodeterm on the computer reads them the same way each " +
            "time, so if its SSH server uses a key nodeterm cannot read there, the phone keeps refusing it on " +
            "your network and reaches it only through the relay."

    /**
     * [NO_RELAY_ADVICE] for a [HostKeyNotPairedException]: pair again to GET a relay leg, without the
     * promise that it also trusts the computer's key (see [NOT_REPORTED_NOTE]).
     */
    const val NOT_REPORTED_NO_RELAY_ADVICE =
        "This phone has no relay connection to it yet: turn on remote access in nodeterm on the computer " +
            "(Settings → Phone) and pair again, and the phone reaches it through the relay when your network " +
            "refuses it. Pairing again changes which SSH key the phone accepts only if the computer's keys " +
            "changed since it was paired: nodeterm on the computer reads them the same way each time, so if " +
            "its SSH server uses a key nodeterm cannot read there, the phone keeps refusing it on your network."

    /**
     * A computer added by its SSH address (audit A27) has no relay leg to fall back to, and no pairing
     * to repeat: forgetting it and adding it again is what trusts a new key.
     */
    const val ADDED_OVER_SSH_KEY_ADVICE =
        "This computer was added by its SSH address, so the phone has no other way to reach it. If it was " +
            "reinstalled, forget it on this phone and add it again, which trusts its new key."

    /**
     * @param relayAllowed the route lets this connect use the relay (anything but "Only on my network").
     * @param relayConfigured the phone holds a relay leg for this computer (endpoint, relay host key and
     *   device token), i.e. a relay dial is possible at all.
     * @param addedOverSsh the computer was added by its SSH address ([dev.nodeterm.protocol.ssh.ManualHost]):
     *   SSH is its only route, and the failure is said without "your network" or a relay to turn on.
     */
    fun afterFailure(error: Throwable, relayAllowed: Boolean, relayConfigured: Boolean, addedOverSsh: Boolean = false): Next {
        if (addedOverSsh) {
            val message = error.message ?: error.javaClass.simpleName
            return Next.Stop(if (error is HostKeyChangedException) "$message $ADDED_OVER_SSH_KEY_ADVICE" else message)
        }
        if (error is HostKeyChangedException) {
            val fact = error.message ?: "This computer's SSH host key changed."
            // A changed pin and a key the computer never reported take the same route, but not the same
            // promise: re-reading the computer's keys trusts a regenerated key, never one it cannot read.
            val notReported = error is HostKeyNotPairedException
            val noRelay = if (notReported) NOT_REPORTED_NO_RELAY_ADVICE else NO_RELAY_ADVICE
            val note = if (notReported) NOT_REPORTED_NOTE else REPAIR_NOTE
            return when {
                !relayConfigured -> Next.Stop("$fact $noRelay")
                !relayAllowed -> Next.Stop("$fact To reach it through the relay instead, $RELAY_ONLY_SETTING $note")
                else -> Next.TryRelay(
                    error = "On your network: $fact To reach it through the relay only, $RELAY_ONLY_SETTING $note",
                    warning = "$fact The phone connected through the relay instead, which checks the computer's " +
                        "identity separately. To stop trying your network for it, $RELAY_ONLY_SETTING $note",
                    refusedHostKey = error.actual
                )
            }
        }
        val line = "On your network: ${error.message ?: error.javaClass.simpleName}"
        return if (relayAllowed) Next.TryRelay(line) else Next.Stop(line)
    }
}
