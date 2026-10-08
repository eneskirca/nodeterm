package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.ListingFailure
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.NothingFoundException
import dev.nodeterm.protocol.ssh.PhoneTerminals
import dev.nodeterm.protocol.ssh.SshScripts
import kotlinx.coroutines.CancellationException
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ListingFailureTest {
    private val id = "phone-12345678-1234-1234-1234-123456789abc"

    private fun phoneListing(): ProjectsSnapshot {
        val cwd = "/srv/phone fixture"
        val creation = PhoneTerminals.fingerprint(id, cwd)
        val record = listOf(TmuxNames.sessionName(id), id, creation, cwd, creation, cwd).joinToString("\t")
        val raw = "${SshScripts.META_START}\nud=\n${SshScripts.META_END}\n" +
            "${SshScripts.PHONE_MARK}\n$record\n${SshScripts.END_MARK}\n"
        return HostBrowse.assemble(ProjectsSnapshot.EMPTY, HostBrowse.split(raw), 123)
    }

    @Test fun `ending the last phone shell replaces its cached row with the authoritative empty answer`() {
        val previous = phoneListing()
        assertTrue(previous.isLive(id))
        assertTrue(previous.findNode(id) != null)
        val current = ListingFailure.snapshot(previous, NothingFoundException(), now = 456)
        assertEquals(456L, current.fetchedAt, "an authoritative empty answer completed the listing")
        assertTrue(current.projects.isEmpty())
        assertTrue(current.liveSessions.isEmpty())
        assertTrue(current.sockets.isEmpty())
        assertNull(current.findNode(id))
        assertNull(current.status)
        assertTrue(previous.isLive(id), "replacing the current listing must not mutate another cached snapshot")
    }

    @Test fun `the initial empty sentinel stays unlisted until an authoritative answer completes`() {
        val initial = ProjectsSnapshot.EMPTY
        assertEquals(0L, initial.fetchedAt)
        for (error in listOf(HostException("The command was refused."), IOException("The reply was lost."))) {
            assertSame(initial, ListingFailure.snapshot(initial, error, now = 456))
        }
        val listed = ListingFailure.snapshot(initial, NothingFoundException(), now = 789)
        assertEquals(789L, listed.fetchedAt)
        assertTrue(listed.projects.isEmpty())
        assertTrue(listed.liveSessions.isEmpty())
        assertEquals(0L, initial.fetchedAt, "the shared initial sentinel must not be mutated")
        assertTrue(ListingFailure.snapshot(initial, NothingFoundException()).fetchedAt > 0,
            "native refresh uses the default clock and must leave the initial loading state")
    }

    @Test fun `a host refusal or lost transport retains the complete last phone listing`() {
        val previous = phoneListing()
        for (error in listOf(HostException("The command was refused."), IOException("The reply was lost."))) {
            val current = ListingFailure.snapshot(previous, error)
            assertSame(previous, current, "a failed command does not prove the shell ended")
            assertTrue(current.isLive(id))
            assertTrue(current.findNode(id) != null)
            assertTrue(current.socketOf(id) == TmuxNames.PHONE_SOCKET)
        }
    }

    @Test fun `cancellation propagates before a cached listing can be replaced`() {
        val previous = phoneListing()
        var current = previous
        val cancelled = CancellationException("The host screen stopped.")
        val thrown = assertFailsWith<CancellationException> {
            current = ListingFailure.snapshot(current, cancelled)
        }
        assertSame(cancelled, thrown)
        assertSame(previous, current)
        assertTrue(current.isLive(id))
    }

    @Test fun `the host applies the policy after cancellation while preserving its error and connection rules`() {
        val source = AppSourcePins.app("conn/ConnectionManager.kt")
        val refresh = AppSourcePins.blockAfter(source, "suspend fun refreshNow(")
        AppSourcePins.assertInOrder(refresh,
            "} catch (e: kotlinx.coroutines.CancellationException) {",
            "throw e",
            "} catch (e: Exception) {",
            "_snapshot.value = ListingFailure.snapshot(_snapshot.value, e)",
            "_lastError.value = (e as? NothingFoundException)?.said(relayLeg()) ?: e.message ?: e.javaClass.simpleName",
            "if (e !is HostException) disconnect()",
            "return")
        val failure = refresh.substringAfter("} catch (e: Exception) {")
            .substringBefore("// Outside the try:")
        assertFalse(failure.contains("_state.value"), "an authoritative empty answer keeps SSH connected and New terminal available")
        assertFalse(failure.contains("conn ="), "ordinary host answers must not close the current SSH connection")
    }
}
