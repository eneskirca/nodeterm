package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.host.RelayApprovalGate.Decision
import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import dev.nodeterm.protocol.host.RelayApprovalRefusedException
import dev.nodeterm.protocol.host.RelayApprovalRequiredException
import dev.nodeterm.protocol.host.RelayApprovalTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Audit A05/A17/A23/A30: who may dial the relay, and when. */
class RelayApprovalGateTest {
    private val approved = HashMap<String, Boolean>()
    private val gate = RelayApprovalGate({ approved[it] == true }, { id, v -> approved[id] = v })

    @Test
    fun `the background worker never makes a first relay handshake`() {
        assertIs<Decision.Skip>(gate.decide("h", Trigger.BACKGROUND))
        // The foreground may: that is where the code is shown.
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("h", Trigger.AUTO))
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("h", Trigger.USER))
    }

    @Test
    fun `after a foreground connect succeeds the worker may dial, but never waits for approval`() {
        gate.onConnected("h")
        assertTrue(approved["h"]!!)
        assertEquals(Decision.Dial(requireApproved = true), gate.decide("h", Trigger.BACKGROUND))
    }

    @Test
    fun `a revoked pin found in the background is forgotten so the worker stops trying`() {
        gate.onConnected("h")
        gate.onFailed("h", RelayApprovalRequiredException())
        assertFalse(approved["h"]!!)
        assertIs<Decision.Skip>(gate.decide("h", Trigger.BACKGROUND))
    }

    @Test
    fun `Deny holds automatic dials until the user asks again`() {
        gate.onFailed("h", RelayApprovalRefusedException())
        val auto = gate.decide("h", Trigger.AUTO)
        assertIs<Decision.Skip>(auto)
        assertTrue(auto.reason.contains("declined"))
        assertIs<Decision.Skip>(gate.decide("h", Trigger.BACKGROUND))
        // Only the user releases it.
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("h", Trigger.USER))
        assertNull(gate.hold("h"))
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("h", Trigger.AUTO))
    }

    @Test
    fun `an unanswered approval holds too, and holds are per computer`() {
        gate.onFailed("h", RelayApprovalTimeoutException())
        assertIs<Decision.Skip>(gate.decide("h", Trigger.AUTO))
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("other", Trigger.AUTO))
    }

    @Test
    fun `ordinary failures are retried as before`() {
        gate.onFailed("h", HostException("relay unreachable"))
        assertEquals(Decision.Dial(requireApproved = false), gate.decide("h", Trigger.AUTO))
    }
}
