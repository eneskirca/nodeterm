package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyNotPairedException
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshFallback.Next
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Audit A49/A74: what a connect does after the direct-SSH leg failed. */
class SshFallbackTest {
    private val changed = HostKeyChangedException("SHA256:paired", "SHA256:whoever-has-the-address-now")
    private val relaySetting = "“Only through the relay”"

    @Test
    fun `in Auto a changed host key goes on to the relay, and says so even when the relay works`() {
        val next = SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true)
        assertIs<Next.TryRelay>(next)
        // Shown if the relay fails as well…
        assertTrue(next.error.startsWith("On your network: "))
        assertTrue(next.error.contains("SHA256:whoever-has-the-address-now"))
        // …and while connected through it, so the change never disappears behind a working relay.
        val warning = assertNotNull(next.warning)
        assertTrue(warning.contains("SHA256:paired") && warning.contains("SHA256:whoever-has-the-address-now"))
        assertTrue(warning.contains("through the relay instead"))
        assertTrue(warning.contains(relaySetting), warning)
        // A changed pin keeps the changed-pin advice: re-reading the computer's keys trusts new ones.
        assertTrue(warning.contains(SshFallback.REPAIR_NOTE), warning)
        assertTrue(next.error.contains(SshFallback.REPAIR_NOTE), next.error)
    }

    /**
     * Review of A74-refresh: the key the server presented goes on with the relay leg, so that relay
     * connection's report can confirm it as the computer's own ([dev.nodeterm.protocol.ssh.LanRefresh]).
     * Text alone dropped it, and a pin still among the reported keys then never gave way.
     */
    @Test
    fun `the relay leg is handed the key the SSH server was refused for, and only that`() {
        val next = assertIs<Next.TryRelay>(SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true))
        assertEquals("SHA256:whoever-has-the-address-now", next.refusedHostKey)
        val notReported = HostKeyNotPairedException(listOf("SHA256:reported"), "SHA256:presented")
        assertEquals(
            "SHA256:presented",
            assertIs<Next.TryRelay>(SshFallback.afterFailure(notReported, relayAllowed = true, relayConfigured = true)).refusedHostKey
        )
        // Any other failure says nothing about the computer's key.
        val down = HostException("Couldn't connect over SSH to dev@10.0.0.2:22 (timeout).")
        assertNull(assertIs<Next.TryRelay>(SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = true)).refusedHostKey)
    }

    @Test
    fun `Only on my network keeps the hard stop, and names the way out`() {
        val next = SshFallback.afterFailure(changed, relayAllowed = false, relayConfigured = true)
        assertIs<Next.Stop>(next)
        assertTrue(next.message.contains("SHA256:whoever-has-the-address-now"))
        assertTrue(next.message.contains(relaySetting), next.message)
        assertTrue(next.message.contains("Settings → How to reach each computer"))
    }

    @Test
    fun `with no relay leg a changed key stops, and says how to get one`() {
        for (allowed in listOf(true, false)) {
            val next = SshFallback.afterFailure(changed, relayAllowed = allowed, relayConfigured = false)
            assertIs<Next.Stop>(next)
            // The relay-only setting would not help here: do not send the user to it.
            assertFalse(next.message.contains(relaySetting), next.message)
            assertTrue(next.message.contains("turn on remote access"))
            assertTrue(next.message.endsWith(SshFallback.NO_RELAY_ADVICE), next.message)
        }
    }

    /**
     * Review of A49-anchor: a key none of the computer's reported keys name. Those keys are what
     * nodeterm on the computer reads of its own SSH server, at every pairing and in every relay report,
     * so neither is a way out when that server uses a key nodeterm cannot read: the advice must not
     * promise one, and must name the relay, which is.
     */
    @Test
    fun `a key the computer never reported is sent to the relay, without the promise that pairing again trusts it`() {
        val notReported = HostKeyNotPairedException(listOf("SHA256:reported"), "SHA256:a-key-nodeterm-cannot-read")
        val auto = assertIs<Next.TryRelay>(SshFallback.afterFailure(notReported, relayAllowed = true, relayConfigured = true))
        val lanOnly = assertIs<Next.Stop>(SshFallback.afterFailure(notReported, relayAllowed = false, relayConfigured = true))
        val noRelay = listOf(true, false).map {
            assertIs<Next.Stop>(SshFallback.afterFailure(notReported, relayAllowed = it, relayConfigured = false)).message
        }
        val withRelay = listOf(auto.error, assertNotNull(auto.warning), lanOnly.message)
        for (t in withRelay + noRelay) {
            assertTrue(t.contains(notReported.message!!), t)
            // The changed-pin advice says pairing again (or the relay's report) trusts the key. Not here.
            assertFalse(t.contains(SshFallback.REPAIR_NOTE), t)
            assertFalse(t.contains(SshFallback.NO_RELAY_ADVICE), t)
            assertFalse(t.contains("trusts the computer's current key"), t)
            assertFalse(t.contains("trusts its new key"), t)
            // When pairing again helps, and that otherwise SSH stays refused.
            assertTrue(t.contains("only if"), t)
            assertTrue(t.contains("changed since"), t)
            assertTrue(t.contains("keeps refusing it on your network"), t)
        }
        // With a relay leg: the route that works, named as Settings names it.
        for (t in withRelay) {
            assertTrue(t.contains(relaySetting), t)
            assertTrue(t.contains("reaches it only through the relay"), t)
        }
        // With none: how to get one, and not the relay-only setting, which would not help yet.
        for (t in noRelay) {
            assertTrue(t.contains("turn on remote access"), t)
            assertTrue(t.contains("reaches it through the relay"), t)
            assertFalse(t.contains(relaySetting), t)
        }
    }

    @Test
    fun `re-pairing is offered as one way out, not as the only one`() {
        val texts = listOf(
            SshFallback.afterFailure(changed, relayAllowed = true, relayConfigured = true).let { it as Next.TryRelay }
                .let { listOf(it.error, it.warning!!) },
            listOf((SshFallback.afterFailure(changed, relayAllowed = false, relayConfigured = true) as Next.Stop).message)
        ).flatten()
        for (t in texts) {
            assertFalse(t.contains("remove and re-pair", ignoreCase = true), t)
            assertTrue(t.contains(relaySetting), t)
        }
        // The bare exception names the likely causes before the alarming one.
        val fact = changed.message!!
        val causes = fact.indexOf("network address")
        assertTrue(causes >= 0, fact) // indexOf answers -1 for a missing text, which is "earlier"
        assertTrue(causes < fact.indexOf("intercepting"), fact)
    }

    @Test
    fun `an ordinary SSH failure falls through in Auto and stops on the SSH-only route, as before`() {
        val down = HostException("Couldn't connect over SSH to dev@10.0.0.2:22 (timeout).")
        assertEquals(
            Next.TryRelay("On your network: Couldn't connect over SSH to dev@10.0.0.2:22 (timeout)."),
            SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = true)
        )
        assertNull((SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = false) as Next.TryRelay).warning)
        assertEquals(
            Next.Stop("On your network: Couldn't connect over SSH to dev@10.0.0.2:22 (timeout)."),
            SshFallback.afterFailure(down, relayAllowed = false, relayConfigured = true)
        )
        // No message at all still says what failed.
        assertEquals(
            Next.TryRelay("On your network: IllegalStateException"),
            SshFallback.afterFailure(IllegalStateException(), relayAllowed = true, relayConfigured = true)
        )
    }
}
