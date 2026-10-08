package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.LegRouting.Leg
import dev.nodeterm.protocol.host.LegRouting.RelayLeg
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.SshAuthRefusedException
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.ssh.ManualHost.Check
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import net.schmizz.sshj.common.DisconnectReason
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.config.keys.AuthorizedKeysAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.apache.sshd.server.session.ServerSession
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A27, part b: a computer added by its SSH address ("Add SSH server") instead of a pairing code
 * — a headless Server Edition (no pairing service exists) or a dev host the phone reaches only over
 * SSH. The form's checks, the record and its persisted shape, the one-line key install (run for real
 * under `/bin/sh`), the first connect against a real SSH server that reads that `authorized_keys`, and
 * the routing that keeps such a computer SSH-only with no relay offer anywhere.
 */
class ManualHostTest {
    private val identity = SshIdentity.generate()

    // ---- the form ---------------------------------------------------------------------------------

    private fun ok(host: String, port: String = "", user: String = "dev", name: String = ""): ManualHost.Address =
        assertIs<Check.Ok>(ManualHost.check(host, port, user, name), "$host:$port $user").address

    private fun invalid(host: String, port: String = "", user: String = "dev"): Check.Invalid =
        assertIs<Check.Invalid>(ManualHost.check(host, port, user), "$host:$port $user")

    @Test
    fun `host names, IPv4 and IPv6 addresses are accepted, port 22 by default and the host as the name`() {
        assertEquals(ManualHost.Address("devbox.local", 22, "dev", "devbox.local"), ok("  devbox.local "))
        assertEquals(ManualHost.Address("192.168.1.20", 2222, "dev", "Build box"), ok("192.168.1.20", "2222", name = " Build box "))
        assertEquals("fe80::1%wlan0", ok("fe80::1%wlan0").host)
        assertEquals("2001:db8::7", ok("[2001:db8::7]").host, "brackets are how an IPv6 address is often written")
        assertEquals("my_host-1.example.com.", ok("my_host-1.example.com.").host)
        assertEquals("alice@corp.example", ok("box", user = "alice@corp.example").user, "a domain login is a user name")
        assertEquals("x".repeat(ManualHost.MAX_NAME), ok("box", name = "x".repeat(200)).name)
        assertEquals("box", ok("box", name = "\u0007\n").name, "control characters only: no name, so the host")
    }

    @Test
    fun `each wrong field says what is wrong, and a right one says nothing`() {
        invalid("").let { assertTrue(it.host!!.contains("address")); assertNull(it.port); assertNull(it.user) }
        assertTrue(invalid("alice@devbox").host!!.contains("User"), "the user typed in the address field")
        assertTrue(invalid("devbox:2222").host!!.contains("Port"), "the port typed after the address")
        assertTrue(invalid("ssh://devbox").host!!.contains("ssh://"))
        assertTrue(invalid("dev box").host!!.contains("spaces"))
        assertTrue(invalid("-oProxyCommand=x").host != null, "never something that reads as an option")
        assertTrue(invalid("dev..box").host != null)
        assertTrue(invalid("[zz::1]").host!!.contains("IPv6"))
        assertTrue(invalid("box;rm").host != null)
        for (port in listOf("0", "65536", "22a", "-1", "123456")) assertTrue(invalid("box", port).port != null, port)
        assertEquals(1, ok("box", "1").port)
        assertEquals(65535, ok("box", "65535").port)
        for (user in listOf("", "a b", "-root", "a:b", "x".repeat(65), "a\tb")) assertTrue(invalid("box", user = user).user != null, "[$user]")
        val all = invalid("", "0", "")
        assertTrue(all.host != null && all.port != null && all.user != null, "every field is checked at once")
    }

    @Test
    fun `an address already in the list is found, paired or added, whatever the host name's case`() {
        val paired = PairedHost.from(
            PairingPayload.parse("""{"v":1,"host":"DevBox.local","user":"dev","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!,
            PairingResult("dev-1", "tok", null, null),
            now = 1
        )
        assertEquals(paired, ManualHost.existing(listOf(paired), ok("devbox.local")))
        assertNull(ManualHost.existing(listOf(paired), ok("devbox.local", "2222")), "another port is another login")
        assertNull(ManualHost.existing(listOf(paired), ok("devbox.local", user = "root")), "another user too")
    }

    // ---- the record -------------------------------------------------------------------------------

    @Test
    fun `the record is SSH-only with its pin, and survives a JSON round trip`() {
        val address = ok("srv.example", "2200", "ops", "Server")
        val h = ManualHost.record(address, "SHA256:abc", id = "ssh-1", now = 7)
        assertTrue(h.manual && h.sshAvailable)
        assertNull(h.relay)
        assertNull(h.hostKeyB64)
        assertNull(h.relayHostKeyB64)
        assertEquals("SHA256:abc", h.sshHostKeyFingerprint)
        assertEquals("Over SSH", h.sshLegName)
        assertEquals(h, PairedHost.fromJson(h.toJson()))
        assertEquals(JsonPrimitive(true), h.toJson()["manual"])
        assertTrue(ManualHost.newId().startsWith(ManualHost.ID_PREFIX))
        assertFailsWith<IllegalArgumentException>("no record without the pin the first connect made") {
            ManualHost.record(address, "")
        }
    }

    @Test
    fun `a paired computer's record is what it was, and an older build reads an added one as SSH with no relay`() {
        // A paired record carries no `manual` key, so what a build before A27 wrote and reads is unchanged.
        val paired = PairedHost.from(
            PairingPayload.parse("""{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!,
            PairingResult("dev-1", "tok", null, null),
            now = 5
        )
        assertFalse("manual" in paired.toJson())
        assertFalse(paired.manual)
        assertEquals("On your network", paired.sshLegName)
        // A build that predates the flag ignores the key and reads the rest: SSH available, no relay
        // block, no box key and the same pin — so it connects to it over SSH.
        val added = ManualHost.record(ok("box"), "SHA256:pin", id = "ssh-2", now = 9).toJson()
        assertEquals(JsonPrimitive(true), added["sshAvailable"])
        assertFalse("relay" in added || "hostKeyB64" in added)
        assertEquals(JsonPrimitive("SHA256:pin"), added["sshHostKeyFingerprint"])
        assertEquals(listOf("id", "name", "host", "port", "user", "sshAvailable", "sshHostKeyFingerprint", "pairedAt", "manual"), added.keys.toList())
    }

    @Test
    fun `a computer added by address stays added by address after an older build saved the list without the flag`() {
        // The review of A27b: a build that predates `manual` rewrites the WHOLE list on its next save
        // (pairing or forgetting any computer, a late relay adoption) with no `manual` key, and may have
        // adopted a relay for it meanwhile (its adoption has no host-key check to stop it). Coming back
        // to this build must not turn it into a paired computer: route choices, a relay adoption and
        // "turn on remote access" advice. The id is the one thing that survives the round trip.
        val added = ManualHost.record(ok("box"), "SHA256:pin", now = 9)
        val olderBuildSaved = JsonObject(
            added.toJson() - "manual" + mapOf(
                "hostKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                "relay" to JsonObject(
                    mapOf(
                        "hostId" to JsonPrimitive("h"),
                        "hostPublicKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                        "relayEndpoint" to JsonPrimitive("wss://relay.nodeterm.dev")
                    )
                )
            )
        )
        val back = PairedHost.fromJson(olderBuildSaved)!!
        assertTrue(back.manual, "the id says it was added by address")
        assertNull(back.relay)
        assertNull(back.relayHostKeyB64)
        assertEquals(added, back)
        assertEquals(LegRouting.RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = true, addedOverSsh = back.manual))
        // And the next save writes the flag again.
        assertEquals(JsonPrimitive(true), back.toJson()["manual"])
        // A paired computer's id is the desktop's randomUUID(), which never carries the prefix.
        val paired = PairedHost.from(
            PairingPayload.parse("""{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!,
            PairingResult(java.util.UUID.randomUUID().toString(), "tok", null, null)
        )
        assertFalse(PairedHost.fromJson(paired.toJson())!!.manual)
        assertEquals(PairedHost.MANUAL_ID_PREFIX, ManualHost.ID_PREFIX)
    }

    @Test
    fun `a record added by address never carries a relay leg, even when the stored JSON says one`() {
        val tampered = JsonObject(
            ManualHost.record(ok("box"), "SHA256:pin", id = "ssh-3").toJson() + mapOf(
                "sshAvailable" to JsonPrimitive(false),
                "hostKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                "relay" to JsonObject(
                    mapOf(
                        "hostId" to JsonPrimitive("h"),
                        "hostPublicKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                        "relayEndpoint" to JsonPrimitive("wss://relay.nodeterm.dev")
                    )
                )
            )
        )
        val h = PairedHost.fromJson(tampered)!!
        assertTrue(h.manual)
        assertTrue(h.sshAvailable, "SSH is its only route")
        assertNull(h.relay)
        assertNull(h.relayHostKeyB64)
    }

    // ---- the key install --------------------------------------------------------------------------

    private fun sh(command: String, home: File): Int {
        val pb = ProcessBuilder("/bin/sh", "-c", command).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin"))
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        val code = p.waitFor()
        assertEquals(0, code, out)
        return code
    }

    private fun mode(f: File) = PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath()))

    @Test
    fun `the install line adds the key once, after a newline the file lacked, with the modes sshd wants`() {
        assumeTrue(File("/bin/sh").canExecute())
        val line = ManualHost.authorizedKeysLine(identity)
        assertTrue(line.startsWith("ssh-ed25519 ") && line.endsWith(" ${ManualHost.KEY_COMMENT}"), line)
        val command = ManualHost.installCommand(line)
        assertTrue(command.startsWith("sh -c '") && command.endsWith("'") && command.count { it == '\'' } == 2, command)

        val fresh = Files.createTempDirectory("nt-manual").toFile()
        try {
            sh(command, fresh)
            val keys = File(fresh, ".ssh/authorized_keys")
            assertEquals("$line\n", keys.readText())
            assertEquals("rwx------", mode(File(fresh, ".ssh")))
            assertEquals("rw-------", mode(keys))
            sh(command, fresh)
            assertEquals("$line\n", keys.readText(), "running it again adds nothing")
        } finally {
            fresh.deleteRecursively()
        }

        val existing = Files.createTempDirectory("nt-manual").toFile()
        try {
            val keys = File(existing, ".ssh").apply { mkdirs() }.resolve("authorized_keys")
            keys.writeText("ssh-rsa AAAAother laptop") // no newline at the end
            sh(command, existing)
            assertEquals("ssh-rsa AAAAother laptop\n$line\n", keys.readText(), "the other key's line stays whole")
        } finally {
            existing.deleteRecursively()
        }
        assertFailsWith<IllegalArgumentException>("nothing but a key line goes inside the quotes") {
            ManualHost.installCommand("ssh-ed25519 AAAA x'; rm -rf ~; echo '")
        }
    }

    // ---- the first connect --------------------------------------------------------------------------

    private fun server(home: File, hostKey: File): SshServer = SshServer.setUpDefaultServer().apply {
        host = "127.0.0.1"
        port = 0
        keyPairProvider = SimpleGeneratorHostKeyProvider(hostKey.toPath())
        // What sshd does with the key: read the user's authorized_keys, the file the install line writes.
        publickeyAuthenticator = object : AuthorizedKeysAuthenticator(File(home, ".ssh/authorized_keys").toPath()) {
            override fun isValidUsername(username: String?, session: ServerSession?) = username == "dev"
        }
        start()
    }

    private class MemoryPin(var value: String? = null) : HostKeyPin {
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
    }

    @Test
    fun `connect pins only once the computer accepts the phone's key, and later connects verify that pin`() {
        assumeTrue(File("/bin/sh").canExecute())
        val root = Files.createTempDirectory("nt-manual").toFile()
        val home = File(root, "home").apply { mkdirs() }
        val sshd = server(home, File(root, "hostkey.ser"))
        try {
            val address = ok("127.0.0.1", sshd.port.toString(), "dev", "Server Edition")
            // Before the key is installed: the server answers and refuses us. No record, no pin, and the
            // message says what to do.
            val refused = assertFailsWith<HostException> { ManualHost.connectFirst(address, identity) }
            assertEquals(ManualHost.keyNotAccepted(address), refused.message)
            assertTrue(refused.message!!.contains("authorized_keys"))
            val pin = MemoryPin()
            assertFailsWith<SshAuthRefusedException> {
                SshHostConnection.connect(address.host, address.port, address.user, identity, pin)
            }
            assertNull(pin.value, "a refusing server is never pinned (A49)")

            // The user runs the install line on the computer; now the first connect adds it.
            sh(ManualHost.installCommand(ManualHost.authorizedKeysLine(identity)), home)
            val added = ManualHost.connectFirst(address, identity, id = "ssh-9", now = 3)
            val serverKey = sshd.keyPairProvider.loadKeys(null).first().public
            assertEquals(SshHostConnection.fingerprint(serverKey), added.sshHostKeyFingerprint, "the pin is the key of the server that let us in")
            assertEquals(ManualHost.record(address, added.sshHostKeyFingerprint!!, "ssh-9", 3), added)

            // A later connect verifies against the kept pin…
            val kept = PairedHost.fromJson(added.toJson())!!
            SshHostConnection.connect(kept.host, kept.port, kept.user, identity, MemoryPin(kept.sshHostKeyFingerprint)).close()
            // …and another user on the same computer is refused like a missing key.
            val other = ok("127.0.0.1", sshd.port.toString(), "root")
            assertEquals(ManualHost.keyNotAccepted(other), assertFailsWith<HostException> { ManualHost.connectFirst(other, identity) }.message)
        } finally {
            sshd.stop(true)
        }

        // Another server at that address (a reinstall, or something else answering there): refused,
        // and with no relay to fall back to, the stop says to forget and add it again.
        val impostor = server(home, File(root, "other-hostkey.ser"))
        try {
            val kept = ManualHost.record(ok("127.0.0.1", impostor.port.toString(), "dev"), "SHA256:the-real-one")
            val changed = assertFailsWith<HostKeyChangedException> {
                SshHostConnection.connect(kept.host, kept.port, kept.user, identity, MemoryPin(kept.sshHostKeyFingerprint))
            }
            val next = assertIs<SshFallback.Next.Stop>(SshFallback.afterFailure(changed, false, false, addedOverSsh = kept.manual))
            assertTrue(next.message.contains(SshFallback.ADDED_OVER_SSH_KEY_ADVICE), next.message)
            assertFalse(next.message.contains("remote access"), "nothing on the computer can turn a relay on for it")
        } finally {
            impostor.stop(true)
            root.deleteRecursively()
        }
    }

    @Test
    fun `a computer that does not answer says how to check the address, and adds nothing`() {
        val dead = java.net.ServerSocket(0).use { it.localPort } // closed again: nothing listens there
        val e = assertFailsWith<HostException> {
            ManualHost.connectFirst(ok("127.0.0.1", dead.toString()), identity, connectTimeoutMs = 2_000)
        }
        assertTrue(e.message!!.endsWith(ManualHost.UNREACHABLE_ADVICE), e.message)
    }

    @Test
    fun `an authentication that could not finish is not a refused key`() {
        // The review of A27b, against sshj 0.39's own shapes: SSHClient.auth throws "Exhausted available
        // authentication methods" whenever no method succeeded, with the cause of the last one's
        // failure behind it; UserAuthImpl's promise chains an auth timeout and a transport error
        // delivered while it waited into a UserAuthException. Only the cause-less one is a refusal.
        val exhausted = "Exhausted available authentication methods"
        assertTrue(SshHostConnection.isAuthRefusal(UserAuthException(exhausted, null as Throwable?)))
        val timedOut = UserAuthException(exhausted, UserAuthException(TimeoutException("Timeout expired: 30000 MILLISECONDS")))
        assertFalse(SshHostConnection.isAuthRefusal(timedOut))
        assertIs<TimeoutException>(SshHostConnection.authFailureCause(timedOut))
        val dropped = UserAuthException(exhausted, UserAuthException(TransportException(DisconnectReason.CONNECTION_LOST, "Broken transport")))
        assertFalse(SshHostConnection.isAuthRefusal(dropped))
        assertFalse(SshHostConnection.isAuthRefusal(UserAuthException(java.net.SocketException("Connection reset"))))
        assertFalse(SshHostConnection.isAuthRefusal(java.io.IOException("not an auth failure at all")))
    }

    @Test
    fun `a computer that drops the connection during login is told to check the network, not to add the key`() {
        val root = Files.createTempDirectory("nt-manual-drop").toFile()
        // A server that answers, then goes away while it is deciding about the key: what a VPN dropping
        // or a server giving up mid-login looks like to the phone. sshj reports it as a UserAuthException.
        val sshd = SshServer.setUpDefaultServer().apply {
            host = "127.0.0.1"
            port = 0
            keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
            publickeyAuthenticator = PublickeyAuthenticator { _, _, session ->
                session.close(true)
                false
            }
            start()
        }
        try {
            val address = ok("127.0.0.1", sshd.port.toString())
            val pin = MemoryPin()
            val e = assertFailsWith<HostException> {
                SshHostConnection.connect(address.host, address.port, address.user, identity, pin, connectTimeoutMs = 5_000)
            }
            assertFalse(e is SshAuthRefusedException, "the key was never refused: ${e.message}")
            assertFalse(e.message!!.contains("Exhausted"), "says what stopped it, not sshj's wrapper: ${e.message}")
            assertNull(pin.value, "nothing authenticated, nothing pinned")
            val first = assertFailsWith<HostException> { ManualHost.connectFirst(address, identity, connectTimeoutMs = 5_000) }
            assertTrue(first.message!!.endsWith(ManualHost.UNREACHABLE_ADVICE), first.message)
            assertFalse(first.message!!.contains("authorized_keys"), first.message)
        } finally {
            sshd.stop(true)
            root.deleteRecursively()
        }
    }

    // ---- no relay, anywhere -------------------------------------------------------------------------

    @Test
    fun `a computer added by address has no relay leg, and every relay verb says remote access isn't set up`() {
        assertEquals(RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = true, addedOverSsh = true))
        // Whatever else the phone holds (a token left over, a route set before), it is not a relay leg.
        assertEquals(RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, addedOverSsh = true))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false))
        val ssh = HostCapabilities(boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true)
        for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS, Capability.GIT)) {
            for (primary in listOf(TransportKind.SSH, null)) {
                val leg = assertIs<Leg.Unavailable>(LegRouting.route(cap, primary, ssh.takeIf { primary != null }, RelayLeg.ADDED_OVER_SSH), "$cap")
                assertTrue(leg.reason.contains("remote access isn't set up for this computer"), leg.reason)
                // Not the paired computer's advice: there is no Settings → Phone to turn it on with.
                assertFalse(leg.reason.contains("Settings"), leg.reason)
            }
        }
        // What the machine does itself stays on SSH.
        assertEquals(Leg.Primary, LegRouting.route(Capability.ANSWER_APPROVALS, TransportKind.SSH, ssh, RelayLeg.ADDED_OVER_SSH))
    }

    @Test
    fun `a refusal with no relay to offer says what is in the way for the leg the phone has, and promises no relay`() {
        val e = NeedsRelayException("n1", "It opens through the relay.", fact = "It runs elsewhere.")
        assertNull(e.refusal(RelayLeg.AVAILABLE), "a usable relay leg is offered instead")
        assertEquals("It runs elsewhere. ${NeedsRelayException.NO_RELAY_TO_OFFER}", e.withoutRelay)
        assertEquals(e.withoutRelay, e.refusal(RelayLeg.NOT_SET_UP))
        assertEquals(e.withoutRelay, e.refusal(RelayLeg.ADDED_OVER_SSH))
        assertTrue(NeedsRelayException.NO_RELAY_TO_OFFER.startsWith("Remote access isn't set up for this computer"))
        // The review of A27b: a paired computer with a relay leg, set to "Only on my network", is told
        // which setting is in the way, the way LegRouting's own reason for that leg says it.
        assertEquals(
            "It runs elsewhere. This computer is set to \"Only on my network (SSH)\": choose \"Automatic\" or \"Only " +
                "through the relay\" in Settings → How to reach each computer, or open it in nodeterm on the computer.",
            e.refusal(RelayLeg.ROUTE_SSH_ONLY)
        )
        assertTrue(e.refusal(RelayLeg.REMOTE_ACCESS_OFF)!!.contains("Remote access is off on the computer right now"))
        assertTrue(e.refusal(RelayLeg.NOT_PICKED_UP)!!.contains("tap Refresh"))
        // What a session that is not running asks of the user is to START it there.
        assertTrue(NeedsRelayException("n1", "x", fact = "Not running.", action = "start it").withoutRelay.endsWith("so start it in nodeterm on the computer."))
    }

    @Test
    fun `failures of a computer added by address stop on SSH and are said without your network`() {
        val down = HostException("Couldn't connect over SSH to dev@box:22 (timeout).")
        assertEquals(SshFallback.Next.Stop("Couldn't connect over SSH to dev@box:22 (timeout)."), SshFallback.afterFailure(down, false, false, addedOverSsh = true))
        // Even if a route allowing the relay were somehow stored for it.
        assertIs<SshFallback.Next.Stop>(SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = true, addedOverSsh = true))
    }

    // ---- the app's wiring (only type-checked here, so pinned in its source) ------------------------

    @Test
    fun `the app keeps a computer added by address on SSH, adopts no relay for it and offers it none`() {
        val store = AppSourcePins.app("data/HostStore.kt")
        // Its route is SSH whatever is stored, and the stored route says so too for an older build.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "fun route(id: String)"),
            "if (get(id)?.manual == true) return RoutePreference.SSH_ONLY"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "fun addManual(host: PairedHost)"),
            "ManualHost.existing(", "?.let { return it }",
            "save(_hosts.value + host)",
            "putString(\"route.\${host.id}\", RoutePreference.SSH_ONLY.name)"
        )
        val session = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(session, "private suspend fun adoptRelayIfAdvertised("),
            "if (host.manual) return",
            "ssh.readRelayAdvertisement()"
        )
        AppSourcePins.assertInOrder(session, "private fun relayConfigured(host: PairedHost): Boolean =", "!host.manual &&")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(session, "fun relayLeg()"), "addedOverSsh = host.manual")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(session, "private suspend fun connectLocked("),
            "SshFallback.afterFailure(", "addedOverSsh = host.manual"
        )
        // A08/A09 refusals with no relay leg to open say what is in the way for THAT leg (the review of
        // A27b: by `hasRelay` alone, "Only on my network" was told remote access isn't set up), never
        // the relay offer's text; the leg is read once, so the offer and the refusal cannot disagree.
        AppSourcePins.assertInOrder(
            AppSourcePins.ui("TerminalController.kt"),
            "catch (e: NeedsRelayException)",
            "state = e.refusal(session.relayLeg())?.let { TermState.Ended(it) } ?: TermState.RelayOffer(msg)"
        )
        for (file in listOf("SessionsTab.kt", "InboxTab.kt")) {
            AppSourcePins.assertInOrder(
                AppSourcePins.ui(file),
                "catch (e: NeedsRelayException)",
                "e.refusal(session.relayLeg())?.let { throw HostException(it) }",
                "session.viaRelay()"
            )
        }
        for (file in listOf("TerminalController.kt", "SessionsTab.kt", "InboxTab.kt")) {
            assertFalse(AppSourcePins.ui(file).contains("withoutRelay"), "$file chooses by the relay leg")
        }
        assertFalse(session.contains("val hasRelay"), "one way to ask: relayLeg()")
        // "Nothing found" offers the relay only to a phone that has one to offer.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(session, "suspend fun refreshNow("),
            "c.listProjects()",
            "_lastError.value = (e as? NothingFoundException)?.said(relayLeg()) ?: e.message"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.ui("InboxTab.kt"),
            "(e as? NothingFoundException)?.said(session.relayLeg()) ?: e.message"
        )
    }

    @Test
    fun `the Hosts screen reaches SSH setup and shows public key and fingerprint instructions`() {
        val hosts = AppSourcePins.ui("HostsScreen.kt")
        assertTrue(hosts.split("nav.push(Route.AddSshHost)").size - 1 >= 2, "both the empty list and the list offer it")
        val forget = AppSourcePins.blockAfter(hosts, "removing?.let { host ->")
        AppSourcePins.assertInOrder(forget, "if (host.manual)", "ManualHost.revokeHint(host.user)", "graph.connections.retireAndPublish(listOf(host.id))", "graph.hosts.remove(host.id)")
        val main = AppSourcePins.app("MainActivity.kt")
        AppSourcePins.assertInOrder(main, "Route.AddSshHost -> listOf(\"addssh\")", "\"addssh\" -> Route.AddSshHost", "Route.AddSshHost -> AddSshHostScreen(nav)")
        val screen = AppSourcePins.ui("AddSshHostScreen.kt")
        // Connection/authentication behavior is exercised against SSH servers above and in
        // SshPasswordBootstrapTest. Do not pin that behavior to inline UI source ordering:
        // both setup paths now share checkedAddress(), and source presence proves no execution.
        AppSourcePins.assertInOrder(screen, "ManualHost.authorizedKeysLine(graph.sshIdentity)", "ManualHost.installCommand(keyLine)")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "private fun Added("), "host.sshHostKeyFingerprint", "ManualHost.FINGERPRINT_CHECK_COMMAND")
    }

    @Test
    fun `the revoke hint and the fingerprint check name what the user looks for on the computer`() {
        assertTrue(ManualHost.revokeHint("ops").contains("${ManualHost.KEY_COMMENT} from ~/.ssh/authorized_keys of ops"))
        assertTrue(ManualHost.FINGERPRINT_CHECK_COMMAND.contains("ssh-keygen -lf"))
    }
}
