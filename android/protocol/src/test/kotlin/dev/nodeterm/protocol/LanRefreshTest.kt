package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.RelayBlock
import dev.nodeterm.protocol.ssh.LanRefresh
import dev.nodeterm.protocol.ssh.LanReport
import dev.nodeterm.protocol.ssh.SshFallback
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A74-refresh: a relay listing tells the phone the computer's current LAN address and SSH host
 * keys, and the phone updates the paired record from it, never from anything it got over SSH. The pin
 * gives way only to a key the SSH leg was refused and the computer confirms (review of A74-refresh).
 * The desktop's side and the whole round trip through the relay are in RelayInteropTest; these are the
 * rules, which need neither node nor a server.
 */
class LanRefreshTest {
    // GitHub's published host-key fingerprints (as in HostKeyAnchorsTest): well-formed, nothing more.
    private val fpA = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
    private val fpB = "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM"
    private val fpC = "SHA256:" + "C".repeat(43)

    private val boxKey = java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    private val paired = PairedHost(
        id = "dev-1", name = "Box", host = "192.168.1.5", port = 22, user = "me", sshAvailable = true,
        hostKeyB64 = boxKey, relay = RelayBlock("room", boxKey, "wss://relay.example.test"),
        sshHostKeyFingerprint = fpA, pairedAt = 1, sshHostKeyAnchors = listOf(fpA)
    )

    private fun parse(json: String) = LanReport.parse(Json.parseToJsonElement(json))
    private fun relayListing(report: LanReport?) = ProjectsSnapshot.EMPTY.copy(lan = report)

    @Test
    fun `the report is read field by field, and an unusable one is no report`() {
        assertEquals(LanReport("192.168.1.42", listOf(fpA, fpB)), parse("""{"host":"192.168.1.42","sshHostKeyFingerprints":["$fpA","$fpB"]}"""))
        assertEquals(LanReport(null, listOf(fpA)), parse("""{"sshHostKeyFingerprints":["$fpA","junk"]}"""))
        assertEquals(LanReport("10.0.0.9", emptyList()), parse("""{"host":"10.0.0.9","sshHostKeyFingerprints":"$fpA"}"""))
        // An older desktop sends none; a broken field is the same as none.
        assertNull(LanReport.parse(null))
        assertNull(parse("""{}"""))
        assertNull(parse(""""192.168.1.42""""))
        assertNull(parse("""{"host":42,"sshHostKeyFingerprints":[7]}"""))
    }

    @Test
    fun `only an address the LAN leg can dial is taken`() {
        for (ok in listOf("192.168.1.42", "10.0.0.9", "172.16.4.1", "100.64.0.7", "8.8.8.8", "223.255.255.254")) {
            assertTrue(LanReport.isDialableIPv4(ok), ok)
        }
        // Loopback would dial the phone itself; the rest the desktop's own pick never returns.
        for (bad in listOf(
            "127.0.0.1", "127.1.2.3", "0.0.0.0", "0.1.2.3", "169.254.10.2", "224.0.0.1", "255.255.255.255",
            "192.168.001.5", "192.168.1", "192.168.1.256", "1.2.3.4.5", "fe80::1", "::1", "box.local", " 192.168.1.5", ""
        )) {
            assertFalse(LanReport.isDialableIPv4(bad), bad)
            assertNull(parse("""{"host":"$bad"}"""), bad)
        }
    }

    @Test
    fun `a listing that came over SSH never refreshes the facts that check SSH`() {
        val report = LanReport("10.0.0.9", listOf(fpB))
        assertNull(LanRefresh.afterListing(paired, TransportKind.SSH, relayListing(report), refusedHostKey = fpB))
        // Over the relay the same listing does.
        assertNotNull(LanRefresh.afterListing(paired, TransportKind.RELAY, relayListing(report), refusedHostKey = fpB))
        // No report (an older desktop): nothing to do.
        assertNull(LanRefresh.afterListing(paired, TransportKind.RELAY, relayListing(null), refusedHostKey = fpB))
    }

    @Test
    fun `a new address replaces the one the QR carried, and the same address changes nothing`() {
        val moved = assertNotNull(LanRefresh.apply(paired, LanReport("192.168.1.77", emptyList()), refusedHostKey = null))
        assertEquals("192.168.1.77", moved.host.host)
        assertTrue(moved.addressChanged)
        assertNull(moved.confirmedKey)
        // Everything else is what it was: the pin, the anchors, the relay leg, the user and port.
        assertEquals(paired.copy(host = "192.168.1.77"), moved.host)
        assertEquals(paired, moved.previous)
        assertNull(LanRefresh.apply(paired, LanReport("192.168.1.5", emptyList()), refusedHostKey = null))
        assertNull(LanRefresh.apply(paired, LanReport("192.168.1.5", listOf(fpA)), refusedHostKey = null), "the record already says it all")
    }

    @Test
    fun `reported keys that include the pin keep it, and become the anchors`() {
        val r = assertNotNull(LanRefresh.apply(paired, LanReport(null, listOf(fpB, fpA)), refusedHostKey = null))
        assertEquals(fpA, r.host.sshHostKeyFingerprint)
        assertEquals(listOf(fpB, fpA), r.host.sshHostKeyAnchors)
        assertNull(r.confirmedKey)
        assertFalse(r.addressChanged)
        assertNull(LanRefresh.note(r), "nothing the user would act on changed")
    }

    /**
     * Review of A74-refresh: the report is what nodeterm on the computer could READ of its sshd's keys,
     * not what sshd serves. A pin the phone never saw fail works, so a report that does not name it
     * (the reader misses the served key, or the pin is a host certificate's an older build took) must
     * not drop it, nor say that the key changed.
     */
    @Test
    fun `a pin missing from the reported keys stays while the phone was never refused another key`() {
        val r = assertNotNull(LanRefresh.apply(paired, LanReport(null, listOf(fpB, fpC)), refusedHostKey = null))
        assertEquals(fpA, r.host.sshHostKeyFingerprint, "a pin that works is kept")
        assertEquals(listOf(fpB, fpC), r.host.sshHostKeyAnchors)
        assertNull(r.confirmedKey)
        assertNull(LanRefresh.note(r), "nothing changed for the next connect, so nothing is said")
        // Nor when the key the SSH leg was refused is not the computer's: another machine at the address.
        val stranger = "SHA256:" + "Z".repeat(43)
        val other = assertNotNull(LanRefresh.apply(paired, LanReport(null, listOf(fpB, fpC)), refusedHostKey = stranger))
        assertEquals(fpA, other.host.sshHostKeyFingerprint)
        assertNull(other.confirmedKey)
    }

    @Test
    fun `a refused key the computer confirms replaces the pin, so the next connect must present one of the reported keys`() {
        val r = assertNotNull(LanRefresh.apply(paired, LanReport(null, listOf(fpB, fpC)), refusedHostKey = fpB))
        assertNull(r.host.sshHostKeyFingerprint, "the old key is no longer trusted")
        assertEquals(listOf(fpB, fpC), r.host.sshHostKeyAnchors, "and the next connect is anchored, not trust on first use")
        assertEquals(fpB, r.confirmedKey)
        // Survives the phone's own record.
        assertEquals(r.host, PairedHost.fromJson(r.host.toJson()))
        // Said once: the next listing over the same relay connection finds nothing left to change.
        assertNull(LanRefresh.apply(r.host, LanReport(null, listOf(fpB, fpC)), refusedHostKey = fpB))
    }

    /**
     * Review of A74-refresh: the desktop reads every `ssh_host_*_key.pub` on disk, served or not. When
     * sshd stops serving the pinned key (its `HostKey` line removed, `HostKeyAlgorithms` narrowed, a FIPS
     * mode without ed25519) while the `.pub` stays, the pin is still among the reported keys, and the
     * server presents another of them: that is the key the computer confirms, and it must win.
     */
    @Test
    fun `a pin still among the reported keys is replaced when the computer confirms the key it was refused`() {
        val r = assertNotNull(LanRefresh.apply(paired, LanReport(null, listOf(fpA, fpB)), refusedHostKey = fpB))
        assertNull(r.host.sshHostKeyFingerprint)
        assertEquals(listOf(fpA, fpB), r.host.sshHostKeyAnchors)
        assertEquals(fpB, r.confirmedKey)
    }

    @Test
    fun `no reported keys leave the pin and the anchors alone`() {
        assertNull(LanRefresh.apply(paired, LanReport(null, emptyList()), refusedHostKey = fpB))
        val moved = assertNotNull(LanRefresh.apply(paired, LanReport("10.0.0.9", emptyList()), refusedHostKey = fpB))
        assertEquals(fpA, moved.host.sshHostKeyFingerprint)
        assertEquals(listOf(fpA), moved.host.sshHostKeyAnchors)
        assertNull(moved.confirmedKey)
        // A computer paired with an older desktop (trust on first use, no anchors) keeps its pin too.
        val tofu = paired.copy(sshHostKeyAnchors = emptyList())
        assertNull(LanRefresh.apply(tofu, LanReport(null, emptyList()), refusedHostKey = null))
    }

    @Test
    fun `a computer never connected over SSH gets the reported keys as the anchors of its first connect`() {
        val fresh = paired.copy(sshHostKeyFingerprint = null, sshHostKeyAnchors = emptyList())
        val r = assertNotNull(LanRefresh.apply(fresh, LanReport(null, listOf(fpB)), refusedHostKey = null))
        assertNull(r.host.sshHostKeyFingerprint)
        assertEquals(listOf(fpB), r.host.sshHostKeyAnchors)
        assertNull(r.confirmedKey, "no key was refused")
        // A first connect refused a key the pairing did not name (HostKeyNotPairedException), and the
        // computer now names it: the anchors let it in, and the warning may say so.
        val anchored = paired.copy(sshHostKeyFingerprint = null)
        val confirmed = assertNotNull(LanRefresh.apply(anchored, LanReport(null, listOf(fpB)), refusedHostKey = fpB))
        assertNull(confirmed.host.sshHostKeyFingerprint)
        assertEquals(listOf(fpB), confirmed.host.sshHostKeyAnchors)
        assertEquals(fpB, confirmed.confirmedKey)
    }

    @Test
    fun `a computer with no LAN leg is left alone`() {
        val report = LanReport("10.0.0.9", listOf(fpB))
        // Added by its SSH address: no relay, so no report is ever this computer's (audit A27).
        assertNull(LanRefresh.apply(paired.copy(id = "ssh-1", manual = true, relay = null, hostKeyB64 = null), report, refusedHostKey = fpB))
        // Paired relay-only (a Windows desktop): there is no SSH leg to point anywhere.
        assertNull(LanRefresh.apply(paired.copy(sshAvailable = false), report, refusedHostKey = fpB))
    }

    @Test
    fun `the note says what changed for the next connect, both old and new address`() {
        val both = assertNotNull(LanRefresh.apply(paired, LanReport("192.168.1.77", listOf(fpB)), refusedHostKey = fpB))
        val note = assertNotNull(LanRefresh.note(both))
        assertTrue(note.startsWith("Since then, "), note)
        assertTrue(note.contains("192.168.1.77") && note.contains("192.168.1.5"), note)
        assertTrue(note.contains("confirmed through the relay that the host key its SSH server presented ($fpB) is one of its own"), note)
        assertTrue(note.contains("from the next connect"), note)
        val addressOnly = assertNotNull(LanRefresh.note(assertNotNull(LanRefresh.apply(paired, LanReport("192.168.1.77", emptyList()), refusedHostKey = null))))
        assertFalse(addressOnly.contains("host key"), addressOnly)
        // A report that merely does not name the pin claims nothing about the key (review of A74-refresh).
        val unnamed = assertNotNull(LanRefresh.apply(paired, LanReport("192.168.1.77", listOf(fpB)), refusedHostKey = null))
        assertFalse(assertNotNull(LanRefresh.note(unnamed)).contains("host key"))
    }

    @Test
    fun `the changed-key advice names the relay's confirmation, and re-pairing as another way`() {
        assertTrue(SshFallback.REPAIR_NOTE.contains("confirms it through the relay"), SshFallback.REPAIR_NOTE)
        assertTrue(SshFallback.REPAIR_NOTE.contains("pair it again"), SshFallback.REPAIR_NOTE)
    }

    /**
     * The app's `HostSession` applies it, which only a device runs: pinned in the source instead. After
     * the primary relay connect's first listing (once the SSH warning is set, so the note can join it)
     * and after every listing the primary connection makes, always through [LanRefresh.afterListing]
     * with the connection's own kind, and the key that connection's SSH leg was refused. Never from the
     * relay held next to a live SSH connection.
     */
    @Test
    fun `the app refreshes the record after a primary relay listing, and only through the kind check`() {
        val conn = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(conn, "private suspend fun connectLocked(trigger: Trigger, lease: HostLifetime.Lease): HostConnection"),
            "_snapshot.value = connected.first",
            "_sshWarning.value = sshWarning",
            "adopt(connected.connection, lease)",
            "refreshLanLeg(connected.connection, connected.first)"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(conn, "suspend fun refreshNow(trigger: Trigger = Trigger.AUTO)"),
            "c.listProjects()",
            "refreshLanLeg(c, it)",
            "_snapshot.value = it"
        )
        val viaRelay = AppSourcePins.blockAfter(conn.substring(conn.indexOf("suspend fun viaRelay(")), "return sideMutex.withLock")
        assertFalse(viaRelay.contains("refreshLanLeg"), viaRelay)
        val body = AppSourcePins.blockAfter(conn, "private fun refreshLanLeg(c: HostConnection, listed: ProjectsSnapshot)")
        assertTrue(body.contains("LanRefresh.afterListing(before, c.kind, listed, refused)"), body)
        assertTrue(body.contains("graph.hosts.updateCurrent(hostId, before.hostKeyB64, { lifetime.isCurrent(lease) && conn === c }) { current -> LanRefresh.afterListing(current, c.kind, listed, refused)?.host ?: current }"), body)
        assertFalse(body.contains("LanRefresh.apply("), "the kind check must not be skipped")
        // The refused key is this connection's own (review of A74-refresh): the one the SSH leg of the
        // connect that opened it was refused, as SshFallback handed it on, never another connection's.
        assertTrue(body.contains("val refused = sshRefusal?.takeIf { it.connection === c }?.hostKey"), body)
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(conn, "private suspend fun connectLocked(trigger: Trigger, lease: HostLifetime.Lease): HostConnection"),
            "refusedHostKey = next.refusedHostKey",
            "_sshWarning.value = sshWarning",
            "sshRefusal = refusedHostKey?.let { SshRefusal(connected.connection, it) }",
            "refreshLanLeg(connected.connection, connected.first)"
        )
    }
}

