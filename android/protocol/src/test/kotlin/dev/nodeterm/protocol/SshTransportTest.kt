package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ManagedSessionAdoption
import dev.nodeterm.protocol.host.ManagedSessionChoice
import dev.nodeterm.protocol.host.ManagedSessionReceipt
import dev.nodeterm.protocol.host.PreparedManagedSession
import dev.nodeterm.protocol.host.ManagedSessions
import dev.nodeterm.protocol.ssh.SshActions
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import dev.nodeterm.protocol.host.ApprovalOutcome
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.NewNode
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.git.SourceControl
import dev.nodeterm.protocol.git.GitReplies
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.ResumeOffer
import dev.nodeterm.protocol.host.TerminalActions
import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.host.ComposedInputResult
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.model.AgentState
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.NewSessionChoice
import dev.nodeterm.protocol.model.Pane
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyNotPairedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.NothingFoundException
import dev.nodeterm.protocol.ssh.SshHostConnection
import dev.nodeterm.protocol.ssh.SshScripts
import dev.nodeterm.protocol.ssh.SshInputViewer
import dev.nodeterm.protocol.ssh.PhoneTerminals
import dev.nodeterm.protocol.ssh.SshTerminalCreationRefusedException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.coroutines.async
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.assertIs
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.TestInstance
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The direct-SSH transport end to end: a real SSH server (Apache MINA) running every command
 * through a shell as the phone would get from sshd, against a fake HOME laid out like a desktop's
 * (a v3 workspace index + project files + agent-status.json) and a REAL tmux — on a private
 * `TMUX_TMPDIR`, so no test ever touches a tmux server a developer is using (issue #629's rule).
 *
 * An exec without a pty runs as `/bin/sh -c`. A pty-requesting exec runs under `script`, standing in
 * for sshd's pty allocation (MINA's process bridge has none of its own); that wrapper is harness, the
 * scripts it runs are the product's. Linux's util-linux `script` (which runs the command through
 * `$SHELL`) and macOS's BSD one take different arguments, and the macOS temp dir is too long for a
 * tmux socket: [PtyScript] and [ShortTmuxRoot] handle both (audit A62).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SshTransportTest {
    private lateinit var root: File
    private lateinit var home: File
    private lateinit var tmuxDir: File
    private lateinit var server: SshServer
    private lateinit var ptyScript: PtyScript
    private val identity = SshIdentity.generate()
    private var port = 0
    // An explicit non-login POSIX shell: a developer's login profiles can install a slow command-
    // not-found handler, and their Readline config can change how the tested bytes are interpreted.
    private val paneShell = arrayOf("/usr/bin/env", "ENV=", "BASH_ENV=", "INPUTRC=/dev/null", "/bin/sh")
    /** Every public key the server was asked to accept, ours or not. */
    private val authAttempts = java.util.concurrent.atomic.AtomicInteger()

    private fun actionsFixture(host: SshTestHost) = InteropHarness.start("ssh-actions", InteropHarness.scratchHomeEnv(host.home) +
        mapOf("FIXTURE_USERDATA" to File(host.home, ".config/node-terminal").path))

    private fun relayAdvertisementFixture(host: SshTestHost): InteropHarness {
        val nonce = java.util.UUID.randomUUID().toString().replace("-", "")
        java.nio.file.Files.setPosixFilePermissions(host.home.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"))
        val marker = File(host.home, ".relay-advertisement-fixture").apply { writeText(nonce) }
        java.nio.file.Files.setPosixFilePermissions(marker.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"))
        val fixture = InteropHarness.start("relay-advertisement", mapOf("FIXTURE_HOME" to host.home.path, "FIXTURE_NONCE" to nonce))
        try {
            assertEquals(true, fixture.ready.getValue("homeRestored").jsonPrimitive.boolean)
            return fixture
        } catch (failure: Throwable) {
            fixture.close()
            throw failure
        }
    }

    private fun publicAdvertisement(suffix: String) = buildJsonObject {
        put("v", 1)
        put("hostId", "public host α '$suffix")
        put("hostPublicKeyB64", java.util.Base64.getEncoder().encodeToString(ByteArray(32) { (it + suffix.length).toByte() }))
        put("relayEndpoint", "wss://relay.nodeterm.dev/$suffix")
        put("hostDeviceId", "public device Ω \"$suffix\"")
    }

    /** The producer seeds a whole workspace, so it must never use this class's desktop profile. */
    private inner class SshTestHost : AutoCloseable {
        private val ownedRoot = ShortTmuxRoot.create("nt-actions", "tmux", "node-terminal")
        val home = File(ownedRoot, "home").apply { mkdirs() }
        private val tmuxDir = File(ownedRoot, "tmux").apply { mkdirs() }
        private val server = SshServer.setUpDefaultServer()
        @Volatile var onCommand: ((String, ShCommand) -> Unit)? = null
        @Volatile var commandPath: String? = null
        val privateTmuxDirectory: String get() = tmuxDir.path

        init {
            try {
                server.host = "127.0.0.1"
                server.port = 0
                server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(ownedRoot, "hostkey.ser").toPath())
                val expected = identity.keyPair.public.encoded
                server.publickeyAuthenticator = org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator { user, key, _ ->
                    user == "dev" && key.encoded.contentEquals(expected)
                }
                server.commandFactory = org.apache.sshd.server.command.CommandFactory { _, command ->
                    ShCommand(command, home, childEnv(home, tmuxDir) + (commandPath?.let { mapOf("PATH" to it) } ?: emptyMap())).also { onCommand?.invoke(command, it) }
                }
                server.start()
            } catch (e: Exception) {
                runCatching { server.stop(true) }
                ownedRoot.deleteRecursively()
                throw e
            }
        }

        fun connect(profilePath: String? = null) = SshHostConnection.connect("127.0.0.1", server.port, "dev", identity, MemoryPin(), profilePath = profilePath)

        fun tmux(vararg args: String): Pair<Int, String> {
            val p = ProcessBuilder(listOf("tmux", "-L", "node-terminal") + args).redirectErrorStream(true).apply {
                environment().clear(); environment().putAll(childEnv(home, tmuxDir))
            }.start()
            val text = p.inputStream.bufferedReader().readText(); return p.waitFor() to text
        }
        fun execute(script: String): Pair<Int, String> {
            val p = ProcessBuilder("/bin/sh", "-c", script).directory(home).redirectErrorStream(true).apply {
                environment().clear(); environment().putAll(childEnv(home, tmuxDir) + (commandPath?.let { mapOf("PATH" to it) } ?: emptyMap()))
            }.start()
            val text = p.inputStream.bufferedReader().readText(); return p.waitFor() to text
        }
        fun advertisement(instance: String): SshActions.Advertisement {
            val ud = File(home, ".config/node-terminal").apply { mkdirs() }
            val root = File(ud, "ssh-actions").apply { mkdirs(); setReadable(false, false); setWritable(false, false); setExecutable(false, false); setReadable(true, true); setWritable(true, true); setExecutable(true, true) }
            File(root, instance).apply { mkdirs(); setReadable(false, false); setWritable(false, false); setExecutable(false, false); setReadable(true, true); setWritable(true, true); setExecutable(true, true) }
            val stamp = System.currentTimeMillis()
            val raw = buildJsonObject { put("version", 1); put("instance", instance); put("pid", ProcessHandle.current().pid()); put("updatedAt", stamp); put("remoteProjects", false); put("methods", JsonArray(listOf(JsonPrimitive(ManagedSessions.METHOD)))) }.toString()
            File(root, "advertisement.json").apply { writeText(raw); setReadable(false, false); setWritable(false, false); setReadable(true, true); setWritable(true, true) }
            return assertNotNull(SshActions.parseAdvertisement("NT-ACTIONS-1\t$stamp\n$raw"))
        }
        override fun close() {
            try { server.stop(true) } finally { runCatching { tmux("kill-server") }; ownedRoot.deleteRecursively() }
        }
    }

    /** Genuine Server services publish under resolveConfig(--data-dir); native fixture is explicit. */
    private fun serverProfileFixture(host: SshTestHost, profile: File): InteropHarness {
        val lookup = ProcessBuilder("/bin/sh", "-c", "command -v tmux").start()
        val tmux = lookup.inputStream.bufferedReader().readText().trim()
        assertEquals(0, lookup.waitFor()); assertTrue(File(tmux).isFile)
        return InteropHarness.start("server-profile", mapOf(
            "FIXTURE_HOME" to host.home.path, "FIXTURE_USERDATA" to profile.path,
            "FIXTURE_TMUX_DIR" to host.privateTmuxDirectory, "FIXTURE_TMUX_BIN" to tmux
        ))
    }

    @Test fun `actual account advertisement writer reaches the SSH parser and replaces every public field`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            relayAdvertisementFixture(host).use { fixture ->
                host.connect().use { connection ->
                    assertNull(connection.readRelayAdvertisement(), "no advertisement before the real writer runs")
                    for (value in listOf(publicAdvertisement("first"), publicAdvertisement("replacement"))) {
                        fixture.command("write $value")
                        fixture.awaitEvent("written")
                        assertEquals(value, connection.readRelayAdvertisement(), "the actual writer's public file reaches the real SSH parser")
                        val file = File(host.home, ".nodeterm/relay.json")
                        assertEquals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"), java.nio.file.Files.getPosixFilePermissions(file.toPath()))
                        assertEquals(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"), java.nio.file.Files.getPosixFilePermissions(file.parentFile.toPath()))
                    }
                    fixture.command("remove")
                    fixture.awaitEvent("removed")
                    assertNull(connection.readRelayAdvertisement(), "the actual remover makes late-adoption material absent")
                    assertFalse(File(host.home, ".nodeterm/relay.json").exists())
                    fixture.command("remove")
                    fixture.awaitEvent("removed")
                    assertNull(connection.readRelayAdvertisement(), "removing an absent advertisement remains harmless")
                }
            }
        }
    }

    @Test fun `relay advertisement stays account scoped across explicit and absent SSH profiles`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val profile = File(host.home, "profiles/custom α ' folder").apply { mkdirs() }
            val decoy = publicAdvertisement("unrelated-profile")
            File(profile, "relay.json").writeText(decoy.toString())
            relayAdvertisementFixture(host).use { fixture ->
                val profiles = listOf(null, profile.path, File(host.home, "profiles/missing").path)
                for (choice in profiles) host.connect(choice).use { assertNull(it.readRelayAdvertisement(), "a profile file is never an account advertisement") }
                val value = publicAdvertisement("account-level")
                fixture.command("write $value")
                fixture.awaitEvent("written")
                for (choice in profiles) host.connect(choice).use {
                    assertEquals(value, it.readRelayAdvertisement(), "profile selection affects browse, not the account-level public advertisement")
                }
                fixture.command("remove")
                fixture.awaitEvent("removed")
                for (choice in profiles) host.connect(choice).use { assertNull(it.readRelayAdvertisement()) }
                assertEquals(decoy.toString(), File(profile, "relay.json").readText(), "removal must not touch unrelated profile files")
            }
        }
    }

    @Test fun `explicit Server profile reads actual custom publication and Board instead of coexisting desktop`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val profile = File(host.home, "profiles/Server α ' quoted")
            serverProfileFixture(host, profile).use { fixture ->
                host.connect().use { automatic ->
                    assertEquals(listOf("server-default"), automatic.listProjects().projects.map { it.id })
                    assertFalse(automatic.capabilities.boardWrites, "a different profile's service is never borrowed")
                }
                host.connect(profile.path).use { conn ->
                    val listed = conn.listProjects()
                    assertEquals(listOf("server-custom"), listed.projects.map { it.id })
                    assertEquals(AgentState.DONE, listed.statusOf("term-server-seed")?.state)
                    assertEquals("fixture-custom", listed.status?.server?.version)
                    assertTrue(conn.capabilities.boardWrites)
                    assertTrue(conn.capabilities.managedCreate)
                    assertFalse(conn.capabilities.nodeActions, "Server still has no Desktop renderer nudge")
                    val board = conn.ensureBoard("server-custom")
                    assertEquals(3, assertNotNull(board).size)
                    fixture.command("snapshot")
                    val proof = fixture.awaitEvent("snapshot")
                    assertEquals(3, proof.getValue("file").jsonObject.getValue("kanban").jsonObject.getValue("columns").jsonArray.size)
                    assertNull(proof.getValue("defaultFile").jsonObject["kanban"], "the checked default project stays unchanged")
                }
            }
        }
    }

    @Test fun `custom Server profile creates actual owned shell and all three receipt view stages adopt it`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val profile = File(host.home, "profiles/custom managed")
            serverProfileFixture(host, profile).use { fixture ->
                var adoption: ManagedSessionAdoption? = null
                val stages = java.util.concurrent.atomic.AtomicInteger()
                host.onCommand = { command, _ -> if (command.contains("NT-MANAGED-VERIFIED") || command.contains("NT-MANAGED-VIEW")) stages.incrementAndGet() }
                host.connect(profile.path).use { conn ->
                    conn.listProjects()
                    val prepared = conn.prepareManagedSession(ManagedSessionChoice("server-custom", "shell", title = "Custom owned shell"))
                    assertEquals(profile.path, prepared.profile)
                    val receipt = conn.createManagedSession(prepared)
                    assertEquals("server-custom", receipt.projectId)
                    assertEquals("node-terminal", receipt.socket)
                    adoption = ManagedSessionAdoption(prepared, receipt)
                    val sink = Sink()
                    val stream = try { conn.attachManagedSession(adoption!!, 56, 25, sink) }
                    catch (e: HostException) { throw AssertionError("All three managed view stages must adopt the explicitly selected custom Server profile", e) }
                    try {
                        stream.write("printf 'custom_%s\\n' profile_input\r")
                        sink.waitFor("custom_profile_input")
                        assertFalse(stream.fresh)
                        assertEquals(receipt.panePid.toString(), host.tmux("display-message", "-p", "-t", receipt.paneId, "#{pane_pid}").second.trim())
                    } finally { stream.detach() }
                    fixture.command("snapshot")
                    val proof = fixture.awaitEvent("snapshot")
                    assertEquals(1, proof.getValue("created").jsonArray.size, "one request creates exactly one actual pane")
                    assertTrue(proof.getValue("file").jsonObject.getValue("nodes").jsonArray.any { it.jsonObject.getValue("id").jsonPrimitive.content == receipt.nodeId })
                    assertEquals(listOf("term-server-default"), proof.getValue("defaultFile").jsonObject.getValue("nodes").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content })
                }
                assertEquals(3, stages.get(), "initial proof, actual viewer and matching tty acknowledgement all use custom selection")
                host.onCommand = null
                host.connect(profile.path).use { reopened ->
                    val sink = Sink(); val stream = reopened.attachManagedSession(adoption!!, 52, 20, sink)
                    try { stream.write("printf 'custom_%s\\n' reopened\r"); sink.waitFor("custom_reopened") }
                    finally { stream.detach() }
                }
                fixture.command("snapshot")
                assertEquals(1, fixture.awaitEvent("snapshot").getValue("created").jsonArray.size, "reconnect never recreates the pane")
            }
        }
    }

    @Test fun `missing explicit profile never falls back and loss clears custom actions before subsequent writes`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val profile = File(host.home, "profiles/explicit")
            serverProfileFixture(host, profile).use { fixture ->
                host.connect(File(host.home, "missing explicit").path).use { absent ->
                    assertFailsWith<HostException> { absent.listProjects() }
                    assertFalse(absent.capabilities.boardWrites)
                }
                host.connect(profile.path).use { conn ->
                    assertEquals(listOf("server-custom"), conn.listProjects().projects.map { it.id })
                    assertTrue(conn.capabilities.boardWrites)
                    val held = File(host.home, "profiles/held")
                    assertTrue(profile.renameTo(held))
                    try {
                        assertFailsWith<HostException> { conn.listProjects() }
                        assertFalse(conn.capabilities.boardWrites)
                        assertFalse(conn.capabilities.managedCreate)
                        assertFailsWith<HostException> { conn.ensureBoard("server-custom") }
                        assertFailsWith<HostException> { conn.prepareManagedSession(ManagedSessionChoice("server-custom", "shell")) }
                    } finally { assertTrue(held.renameTo(profile)) }
                    assertEquals(listOf("server-custom"), conn.listProjects().projects.map { it.id })
                    fixture.command("snapshot")
                    val proof = fixture.awaitEvent("snapshot")
                    assertNull(proof.getValue("file").jsonObject["kanban"])
                    assertNull(proof.getValue("defaultFile").jsonObject["kanban"])
                    assertTrue(proof.getValue("created").jsonArray.isEmpty())
                }
            }
        }
    }

    /** Native tmux fixture facts are setup only; the product verifies them over actual SSH. */
    private fun managedAdoption(host: SshTestHost): ManagedSessionAdoption {
        val ud = File(host.home, ".config/node-terminal").apply { mkdirs() }
        val cwd = File(host.home, "managed-project").apply { mkdirs() }
        val id = "term-managed-1234"
        val creation = java.util.UUID.randomUUID().toString()
        val instance = java.util.UUID.randomUUID().toString()
        val ad = host.advertisement(instance)
        val hidden = File(cwd, ".nodeterm").apply { mkdirs() }
        File(hidden, "project.json").writeText(buildJsonObject {
            put("version", 1); put("rev", 1); put("savedAt", "fixture"); put("name", "Managed")
            put("color", "blue"); put("viewport", buildJsonObject { put("x", 0); put("y", 0); put("zoom", 1) })
            put("nodes", JsonArray(listOf(buildJsonObject {
                put("id", id); put("kind", "terminal"); put("title", "Managed"); put("color", "blue"); put("cwd", cwd.path)
                put("position", buildJsonObject { put("x", 0); put("y", 0) }); put("size", buildJsonObject { put("width", 640); put("height", 440) })
            })))
        }.toString())
        File(ud, "workspace.json").writeText(buildJsonObject {
            put("version", 3); put("activeProjectId", "managed-project")
            put("entries", JsonArray(listOf(buildJsonObject { put("id", "managed-project"); put("name", "Managed"); put("cwd", cwd.path); put("color", "blue") })))
        }.toString())
        val (exit, out) = host.tmux("-f", "/dev/null", "new-session", "-d", "-s", "nt-$id", "-c", cwd.path,
            "-e", "NODETERM_MANAGED_CREATION_ID=$creation", *paneShell)
        assertEquals(0, exit, out)
        val identity = host.tmux("list-panes", "-s", "-t", "=nt-$id", "-F", "#{session_created}|#{pane_id}|#{pane_pid}").second.trim().split('|')
        val pid = identity[2].toInt()
        val birth = if (System.getProperty("os.name").startsWith("Linux")) {
            val stat = File("/proc/$pid/stat").readText().substringAfterLast(')').trim().split(Regex("\\s+"))
            "linux:${File("/proc/sys/kernel/random/boot_id").readText().trim()}:${stat[19]}"
        } else {
            val p = ProcessBuilder("ps", "-o", "lstart=", "-p", "$pid").apply { environment()["LC_ALL"] = "C" }.start()
            val started = p.inputStream.bufferedReader().readText().trim().replace(Regex("\\s+"), " ")
            assertEquals(0, p.waitFor()); "darwin:$started"
        }
        val request = PreparedManagedSession(ud.path, instance, java.util.UUID.randomUUID().toString(), ad.updatedAt,
            creation, ManagedSessionChoice("managed-project", "shell"), ad.raw)
        return ManagedSessionAdoption(request, ManagedSessionReceipt(creation, id, "managed-project", instance,
            "node-terminal", "nt-$id", identity[1], pid, birth, identity[0]))
    }

    @Test fun `managed receipt adopts the actual SSH viewer with output input and reconnect without creating again`() = runBlocking {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val r = adoption.receipt
            assertEquals(0, host.tmux("new-session", "-d", "-s", r.session + "-other", *paneShell).first)
            host.connect().use { conn ->
                assertTrue(conn.listProjects().findNode(r.nodeId) != null)
                assertTrue(conn.capabilities.managedCreate); assertFalse(conn.capabilities.registerNode)
                val sink = Sink(); val stream = conn.attachManagedSession(adoption, 56, 25, sink)
                try {
                    assertFalse(stream.fresh, "host creation already delivered any agent launch")
                    stream.write("printf 'managed_%s\\n' input\r"); sink.waitFor("managed_input")
                    assertFalse(synchronized(sink.out) { sink.out.toString(Charsets.UTF_8) }.contains("NT-MANAGED-VIEW"), "private tty acknowledgement must not paint in xterm")
                    assertEquals(r.panePid.toString(), host.tmux("display-message", "-p", "-t", r.paneId, "#{pane_pid}").second.trim())
                } finally { stream.detach() }
            }
            host.connect().use { conn ->
                val sink = Sink(); val stream = conn.attachManagedSession(adoption, 52, 20, sink)
                stream.write("printf 'reopen_%s\\n' receipt\r"); sink.waitFor("reopen_receipt")
                try {
                    assertTrue(assertFailsWith<HostException> { stream.endSession() }.message.orEmpty().contains("relay"))
                    assertEquals(0, host.tmux("has-session", "-t", "=${r.session}").first, "canvas End still needs the app route; refusal does not stop the managed shell")
                    assertEquals(0, host.tmux("has-session", "-t", "=${r.session}-other").first, "refusal keeps the prefix neighbour")
                } finally { stream.detach() }
            }
        }
    }

    @Test fun `managed SSH adoption rejects stale process marker service profile and multi pane identities`() = runBlocking {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val r = adoption.receipt
            host.connect().use { conn ->
                for (changed in listOf(r.copy(panePid = r.panePid + 1), r.copy(sessionCreated = (r.sessionCreated.toLong() + 1).toString()),
                    r.copy(paneBirth = if (r.paneBirth.startsWith("linux:")) r.paneBirth.substringBeforeLast(':') + ":0" else "darwin:Mon Jan 1 00:00:00 2000"))) {
                    assertFailsWith<HostException> { conn.attachManagedSession(ManagedSessionAdoption(adoption.request, changed), 80, 24, Sink()) }
                }
                assertEquals("", host.tmux("list-clients", "-t", "=${r.session}").second.trim(), "no refused receipt acquires a viewer")
                assertEquals(0, host.tmux("set-environment", "-t", "=${r.session}", "NODETERM_MANAGED_CREATION_ID", java.util.UUID.randomUUID().toString()).first)
                assertFailsWith<HostException> { conn.attachManagedSession(adoption, 80, 24, Sink()) }
                assertEquals(0, host.tmux("set-environment", "-t", "=${r.session}", "NODETERM_MANAGED_CREATION_ID", r.creationId).first)
                val pane = host.tmux("split-window", "-d", "-t", r.paneId, "-P", "-F", "#{pane_id}", *paneShell)
                assertEquals(0, pane.first, pane.second)
                assertFailsWith<HostException> { conn.attachManagedSession(adoption, 80, 24, Sink()) }
                assertEquals(0, host.tmux("kill-pane", "-t", pane.second.trim()).first)
                host.advertisement(java.util.UUID.randomUUID().toString())
                assertFailsWith<HostException> { conn.attachManagedSession(adoption, 80, 24, Sink()) }
                host.advertisement(r.hostInstance)
                val changedProfile = adoption.copy(request = adoption.request.copy(profile = File(host.home, "other-profile").path))
                assertFailsWith<HostException> { conn.attachManagedSession(changedProfile, 80, 24, Sink()) }
                assertEquals("", host.tmux("list-clients", "-t", "=${r.session}").second.trim())
                assertEquals(0, host.tmux("has-session", "-t", "=${r.session}").first, "refusal never kills the created shell")
            }
        }
    }

    @Test fun `managed SSH final tmux queue refuses a marker replaced after shell proof`() = runBlocking {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val r = adoption.receipt
            val lookup = ProcessBuilder("/bin/sh", "-c", "command -v tmux").start()
            val tmuxPath = lookup.inputStream.bufferedReader().readText().trim(); assertEquals(0, lookup.waitFor())
            val bin = File(host.home, "race-bin").apply { mkdirs() }
            val replaced = java.util.UUID.randomUUID().toString()
            val wrapper = File(bin, "tmux").apply {
                writeText("""#!/bin/sh
                    case "${'$'}*" in *' if-shell '*)
                      ${SshScripts.q(tmuxPath)} -L node-terminal set-environment -t ${SshScripts.q("=" + r.session)} NODETERM_MANAGED_CREATION_ID ${SshScripts.q(replaced)} || exit 99
                    ;; esac
                    exec ${SshScripts.q(tmuxPath)} "${'$'}@"
                """.trimIndent()); assertTrue(setExecutable(true, true))
            }
            host.commandPath = bin.path + File.pathSeparator + System.getenv("PATH")
            val ad = assertNotNull(SshActions.parseAdvertisement("NT-ACTIONS-1\t${System.currentTimeMillis()}\n${adoption.request.advertisement}"))
            val (exit, proof) = host.execute(SshScripts.attachManaged(adoption, ad, attach = false))
            assertTrue(exit != 0, "The final false branch must return a failed command: $proof")
            assertFalse(proof.trim() == "NT-MANAGED-VERIFIED")
            assertEquals(0, host.tmux("set-environment", "-t", "=${r.session}", "NODETERM_MANAGED_CREATION_ID", r.creationId).first)
            host.connect().use { conn ->
                assertFailsWith<HostException> { conn.attachManagedSession(adoption, 56, 25, Sink()) }
                assertEquals(replaced, host.tmux("show-environment", "-t", "=${r.session}", "NODETERM_MANAGED_CREATION_ID").second.trim().substringAfter('='), "the replacement happened between the shell proof and final queue")
                assertEquals("", host.tmux("list-clients", "-t", "=${r.session}").second.trim())
                assertEquals(0, host.tmux("has-session", "-t", "=${r.session}").first)
                host.commandPath = null
                assertEquals(0, host.tmux("set-environment", "-t", "=${r.session}", "NODETERM_MANAGED_CREATION_ID", r.creationId).first)
                val sink = Sink(); val stream = conn.attachManagedSession(adoption, 56, 25, sink)
                try { stream.write("printf 'race_%s\\n' restored\r"); sink.waitFor("race_restored") } finally { stream.detach() }
            }
            assertTrue(wrapper.isFile)
        }
    }

    @Test fun `managed SSH viewer without an exit acknowledgement is not adopted or retried`() = runBlocking {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val r = adoption.receipt; var confirmations = 0
            host.onCommand = { command, channel -> if (command.contains("nt_wait=0; nt_found=0")) { confirmations++; channel.omitExitStatus = true } }
            host.connect().use { conn ->
                assertFailsWith<HostException> { conn.attachManagedSession(adoption, 56, 25, Sink()) }
                assertEquals(1, confirmations, "only one viewer confirmation is attempted")
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (host.tmux("list-clients", "-t", "=${r.session}").second.isNotBlank()) {
                    assertTrue(System.nanoTime() < deadline, "unacknowledged viewer stayed attached"); Thread.sleep(50)
                }
                assertEquals(r.panePid.toString(), host.tmux("display-message", "-p", "-t", r.paneId, "#{pane_pid}").second.trim())
                assertEquals(0, host.tmux("has-session", "-t", "=${r.session}").first)
            }
        }
    }

    @Test fun `managed SSH attach cancelled during opening detaches only that viewer and retains the shell`() = runBlocking {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val r = adoption.receipt
            host.connect().use { conn ->
                val attaching = AtomicReference<Job>(); val attachCommand = AtomicReference<ShCommand>()
                host.onCommand = { command, channel -> if (command.contains("NT-MANAGED-VIEW")) { attachCommand.set(channel); attaching.get().cancel() } }
                val job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { conn.attachManagedSession(adoption, 56, 25, Sink()) }
                attaching.set(job); job.start(); job.join(); assertTrue(job.isCancelled)
                assertTrue(assertNotNull(attachCommand.get()).exited.await(10, TimeUnit.SECONDS))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (host.tmux("list-clients", "-t", "=${r.session}").second.isNotBlank()) {
                    assertTrue(System.nanoTime() < deadline, "cancelled viewer stays attached"); Thread.sleep(50)
                }
                assertEquals(0, host.tmux("has-session", "-t", "=${r.session}").first)
            }
        }
    }

    @Test fun `actual selected-profile SSH service edits the board and delivers node actions without relay`() = runBlocking {
        SshTestHost().use { host ->
            actionsFixture(host).use { fixture ->
                host.connect().use { conn ->
                    val snapshot = conn.listProjects()
                    assertEquals(listOf("ssh-actions-project"), snapshot.projects.map { it.id })
                    assertTrue(conn.capabilities.boardWrites); assertTrue(conn.capabilities.nodeActions); assertTrue(conn.capabilities.git)
                    assertFalse(conn.capabilities.registerNode)
                    val columns = assertNotNull(conn.ensureBoard("ssh-actions-project"))
                    assertEquals(3, columns.size)
                    assertTrue(conn.setCardColumn("ssh-actions-project", "term-ssh-actions", columns[1].id))
                    val labels = assertNotNull(conn.editCardLabels("ssh-actions-project", "term-ssh-actions",
                        CardLabelEdit(create = listOf("SSH α ' quoted" to "blue"))))
                    assertTrue(labels.edited); assertEquals(listOf("SSH α ' quoted"), labels.labels.map { it.name })
                    assertEquals(labels.labels.map { it.id }, labels.cardLabelIds)
                    conn.wake("term-ssh-actions"); conn.refresh("term-ssh-actions"); conn.rename("term-ssh-actions", "Typed α ' title")
                    fixture.command("snapshot")
                    val proof = fixture.awaitEvent("snapshot")
                    val board = proof.getValue("file").jsonObject.getValue("kanban").jsonObject
                    assertEquals(columns[1].id, board.getValue("assignments").jsonArray.single().jsonObject.getValue("columnId").jsonPrimitive.content)
                    assertEquals(labels.cardLabelIds, board.getValue("meta").jsonArray.single().jsonObject.getValue("labels").jsonArray.map { it.jsonPrimitive.content })
                    assertEquals(listOf("wake", "refresh", "rename"), proof.getValue("nudges").jsonArray.map { it.jsonObject.getValue("method").jsonPrimitive.content })
                    assertEquals("Typed α ' title", proof.getValue("nudges").jsonArray.last().jsonObject.getValue("title").jsonPrimitive.content)
                    assertFailsWith<HostException> { conn.registerNode("ssh-actions-project", NewNode("new-node", null, null, null)) }
                    assertFailsWith<NeedsRelayException> { conn.setCardColumn("another-profile", "term-ssh-actions", null) }
                    assertFailsWith<NeedsRelayException> { conn.wake("term-another-profile") }
                }
            }
        }
    }

    @Test fun `stopped SSH actions producer clears cached capability before any request is published`() = runBlocking {
        SshTestHost().use { host ->
            actionsFixture(host).use { fixture ->
                host.connect().use { conn ->
                    conn.listProjects(); assertTrue(conn.capabilities.boardWrites)
                    fixture.command("stop"); fixture.awaitEvent("stopped")
                    assertFailsWith<NeedsRelayException> { conn.ensureBoard("ssh-actions-project") }
                    assertFalse(conn.capabilities.boardWrites); assertTrue(conn.capabilities.git)
                    fixture.command("snapshot")
                    val file = fixture.awaitEvent("snapshot").getValue("file").jsonObject
                    assertNull(file["kanban"])
                }
            }
        }
    }

    @Test fun `an SSH action with a lost exit acknowledgement is uncertain even when the save happened`() = runBlocking {
        SshTestHost().use { host ->
            actionsFixture(host).use { fixture ->
                host.connect().use { conn ->
                    conn.listProjects()
                    var submissions = 0
                    host.onCommand = { command, channel -> if (command.contains("NT-ACTIONS-REPLY")) { submissions++; channel.omitExitStatus = true } }
                    assertFailsWith<HostUnansweredException> { conn.ensureBoard("ssh-actions-project") }
                    assertEquals(1, submissions)
                    fixture.command("snapshot")
                    assertEquals(3, fixture.awaitEvent("snapshot").getValue("file").jsonObject.getValue("kanban").jsonObject.getValue("columns").jsonArray.size)
                    assertFalse(conn.capabilities.boardWrites)
                }
            }
        }
    }

    private fun tmuxAvailable() = runCatching { ProcessBuilder("tmux", "-V").start().waitFor() == 0 }.getOrDefault(false)

    /** A private raw-byte consumer distinguishes bracketed paste from Enter and timestamps both. */
    private fun composedRecorder(host: SshTestHost, pane: String, name: String): File {
        val bytes = File(host.home, "$name.bytes")
        val script = File(host.home, "$name.cjs").apply { writeText("""
            const fs = require('node:fs');
            const out = process.argv[2], b = Buffer.alloc(1);
            process.stdout.write('\x1b[?2004h');
            fs.writeFileSync(out + '.ready', 'ready');
            while (true) {
              const n = fs.readSync(0, b, 0, 1, null); if (!n) break;
              fs.appendFileSync(out, b.subarray(0, n));
              fs.appendFileSync(out + '.times', JSON.stringify({ byte: b[0], at: Number(process.hrtime.bigint() / 1000000n) }) + '\n');
            }
        """.trimIndent()) }
        val command = "stty raw -echo; node ${SshScripts.q(script.path)} ${SshScripts.q(bytes.path)}"
        assertEquals(0, host.tmux("send-keys", "-t", pane, "-l", "--", command).first)
        assertEquals(0, host.tmux("send-keys", "-t", pane, "Enter").first)
        val deadline = System.currentTimeMillis() + 5_000
        while (!File(bytes.path + ".ready").exists() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertTrue(File(bytes.path + ".ready").exists(), "private native raw consumer started")
        // Readiness belongs to the consumer; allow tmux's parser to process its DEC2004 output.
        // Exact observed delimiters below, rather than a nonportable format name, prove framing.
        Thread.sleep(50)
        return bytes
    }

    private fun awaitComposedBytes(file: File, expected: String) {
        val deadline = System.currentTimeMillis() + 5_000
        while ((!file.exists() || file.readText() != expected) && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(expected, if (file.exists()) file.readText() else "", "actual pane input bytes")
    }

    @Test fun `composed SSH Send exits emacs and vi history and separates real bracketed paste from Enter`() = runBlocking<Unit> {
        for (mode in listOf("emacs", "vi")) SshTestHost().use { host ->
            val adoption = managedAdoption(host)
            val pane = adoption.receipt.paneId
            val bytes = composedRecorder(host, pane, "composed-$mode")
            assertEquals(0, host.tmux("new-window", "-d", "-t", "=nt-${adoption.receipt.nodeId}", *paneShell).first)
            val sibling = host.tmux("list-panes", "-s", "-t", "=nt-${adoption.receipt.nodeId}", "-F", "#{pane_id}|#{pane_pid}").second.lines().first { !it.startsWith("$pane|") }.trim()
            val siblingPane = sibling.substringBefore('|')
            val siblingBytes = composedRecorder(host, siblingPane, "sibling-$mode")
            val siblingBefore = host.tmux("capture-pane", "-p", "-t", siblingPane, "-S", "-").second
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                try {
                    assertEquals(0, host.tmux("set-option", "-w", "-t", pane, "mode-keys", mode).first)
                    assertEquals(0, host.tmux("copy-mode", "-t", pane).first)
                    assertEquals("1", host.tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}").second.trim())
                    assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Paste("full prompt\nΩ 😀\u001b[201~", true)))
                    val expected = "\u001b[200~full prompt\rΩ 😀[201~\u001b[201~\r"
                    awaitComposedBytes(bytes, expected)
                    assertEquals("0", host.tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}").second.trim())
                    val times = File(bytes.path + ".times").readLines().map { kotlinx.serialization.json.Json.parseToJsonElement(it).jsonObject }
                    val endAt = times[times.lastIndex - 1].getValue("at").jsonPrimitive.content.toLong()
                    val enterAt = times.last().getValue("at").jsonPrimitive.content.toLong()
                    assertTrue(enterAt - endAt >= 100, "paste delimiter and Enter must be separated, actual ${enterAt - endAt}ms")
                    println("composed native $mode: bytes=${expected.toByteArray().size} paste-to-enter=${enterAt - endAt}ms once; sibling untouched")
                    assertEquals(sibling, host.tmux("display-message", "-p", "-t", siblingPane, "#{pane_id}|#{pane_pid}").second.trim())
                    assertEquals(siblingBefore, host.tmux("capture-pane", "-p", "-t", siblingPane, "-S", "-").second)
                    assertFalse(siblingBytes.exists(), "no input reached the sibling")
                } finally { stream.detach() }
            }
        }
    }

    @Test fun `composed SSH Ctrl is one raw byte with no paste or Enter`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val pane = adoption.receipt.paneId
            val bytes = composedRecorder(host, pane, "control")
            host.connect().use { conn ->
                val stream = conn.attachManagedSession(adoption, 80, 24, Sink())
                try {
                    assertEquals(0, host.tmux("copy-mode", "-t", pane).first)
                    assertEquals(ComposedInputResult.DELIVERED, stream.submitComposed(ComposedInput.Control("\u0003")))
                    awaitComposedBytes(bytes, "\u0003")
                } finally { stream.detach() }
            }
        }
    }

    @Test fun `composed SSH refuses a replaced pane or changed selection without following either`() = runBlocking<Unit> {
        for (replace in listOf(false, true)) SshTestHost().use { host ->
            val adoption = managedAdoption(host); val pane = adoption.receipt.paneId
            val bytes = composedRecorder(host, pane, "old")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                try {
                    if (replace) assertEquals(0, host.tmux("respawn-pane", "-k", "-t", pane, *paneShell).first)
                    else {
                        assertEquals(0, host.tmux("new-window", "-d", "-t", "=nt-${adoption.receipt.nodeId}", *paneShell).first)
                        assertEquals(0, host.tmux("select-window", "-t", "=nt-${adoption.receipt.nodeId}:1").first)
                    }
                    assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("must not arrive", true)).status)
                    assertFalse(bytes.exists(), "no bytes reached the old consumer")
                    assertFalse(host.tmux("capture-pane", "-p", "-t", "=nt-${adoption.receipt.nodeId}:", "-S", "-").second.contains("must not arrive"))
                } finally { stream.detach() }
            }
        }
    }

    @Test fun `composed SSH lost paste acknowledgement is uncertain once and never sends Enter or retries`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val bytes = composedRecorder(host, adoption.receipt.paneId, "uncertain")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink()); var submissions = 0
                host.onCommand = { command, channel -> if (command.contains("load-buffer") && command.contains("nt-composed-delivered")) { submissions++; channel.omitExitStatus = true } }
                try {
                    assertEquals(ComposedInputResult.Status.UNCERTAIN, stream.submitComposed(ComposedInput.Paste("exactly once", true)).status)
                    awaitComposedBytes(bytes, "\u001b[200~exactly once\u001b[201~")
                    assertEquals(1, submissions); assertFalse(conn.isConnected)
                } finally { host.onCommand = null; stream.detach() }
            }
        }
    }

    @Test fun `composed SSH lost Enter acknowledgement is uncertain after one real paste and Enter without retry`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host)
            val bytes = composedRecorder(host, adoption.receipt.paneId, "lost-enter-ack")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                val pastes = java.util.concurrent.atomic.AtomicInteger()
                val enters = java.util.concurrent.atomic.AtomicInteger()
                val enterCommand = AtomicReference<ShCommand>()
                host.onCommand = { command, channel ->
                    if (command.contains("nt-composed-delivered")) {
                        if (command.contains("load-buffer")) pastes.incrementAndGet()
                        else {
                            enters.incrementAndGet()
                            enterCommand.set(channel)
                            // ShCommand executes the real guarded Enter and drains stdout before
                            // closing this channel without its exit-status acknowledgement.
                            channel.omitExitStatus = true
                        }
                    }
                }
                try {
                    val result = stream.submitComposed(ComposedInput.Paste("one Enter Ω🧭", true))
                    awaitComposedBytes(bytes, "\u001b[200~one Enter Ω🧭\u001b[201~\r")
                    assertTrue(assertNotNull(enterCommand.get()).exited.await(2, TimeUnit.SECONDS), "the actual guarded Enter process exited")
                    assertEquals(1, pastes.get(), "one acknowledged paste; no retry")
                    assertEquals(1, enters.get(), "one executed Enter; no retry")
                    assertFalse(conn.isConnected, "the unconfirmed Enter disconnects the transport")
                    assertEquals(ComposedInputResult.Status.UNCERTAIN, result.status, "execution does not replace the missing second acknowledgement")
                } finally { host.onCommand = null; stream.detach() }
            }
        }
    }

    @Test fun `composed SSH queued behind raw IO is refused immediately on viewer retirement`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val bytes = composedRecorder(host, adoption.receipt.paneId, "retired")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                val field = stream.javaClass.getDeclaredField("io").apply { isAccessible = true }
                val io = field.get(stream) as java.util.concurrent.ExecutorService
                val started = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
                io.execute { started.countDown(); release.await(5, TimeUnit.SECONDS) }
                assertTrue(started.await(2, TimeUnit.SECONDS))
                try {
                    val result = async(start = CoroutineStart.UNDISPATCHED) { stream.submitComposed(ComposedInput.Paste("retired", true)) }
                    yield(); stream.retireComposed(); release.countDown()
                    assertEquals(ComposedInputResult.Status.REFUSED, result.await().status)
                    assertFalse(bytes.exists(), "retirement did not wait for the queued detach")
                } finally { release.countDown(); stream.detach() }
            }
        }
    }

    @Test fun `composed SSH final native queue refuses a viewer detached after shell preflight`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val bytes = composedRecorder(host, adoption.receipt.paneId, "late-detach")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                try {
                    val tty = host.tmux("list-clients", "-t", "=nt-${adoption.receipt.nodeId}", "-F", "#{client_name}").second.trim()
                    assertTrue(tty.startsWith("/dev/"))
                    val lookup = ProcessBuilder("/bin/sh", "-c", "command -v tmux").start()
                    val realTmux = lookup.inputStream.bufferedReader().readText().trim(); assertEquals(0, lookup.waitFor())
                    val bin = File(host.home, "late-bin").apply { mkdirs() }
                    File(bin, "tmux").apply {
                        writeText("""
                            #!/bin/sh
                            for nt_arg do
                              if [ "${'$'}nt_arg" = load-buffer ]; then
                                ${SshScripts.q(realTmux)} -L node-terminal detach-client -t ${SshScripts.q(tty)} || exit 3
                                break
                              fi
                            done
                            exec ${SshScripts.q(realTmux)} "${'$'}@"
                        """.trimIndent()); setExecutable(true)
                    }
                    host.commandPath = bin.path + ":" + System.getenv("PATH")
                    assertTrue(stream.submitComposed(ComposedInput.Paste("must not arrive", true)).status != ComposedInputResult.Status.DELIVERED)
                    assertFalse(bytes.exists(), "the final native queue did not write after a valid preflight lost its viewer")
                    assertTrue(host.tmux("list-buffers", "-F", "#{buffer_name}").second.lines().none { it.startsWith("nt-paste-") }, "owned temporary buffer was removed")
                } finally { host.commandPath = null; stream.detach() }
            }
        }
    }

    @Test fun `composed SSH losing the viewer after acknowledged paste retains uncertainty without Enter`() = runBlocking<Unit> {
        SshTestHost().use { host ->
            val adoption = managedAdoption(host); val bytes = composedRecorder(host, adoption.receipt.paneId, "paste-only")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                var enterAttempts = 0
                host.onCommand = { command, _ ->
                    if (command.contains("nt-composed-delivered") && !command.contains("load-buffer")) {
                        enterAttempts++
                        assertEquals(0, host.tmux("new-window", "-t", "=nt-${adoption.receipt.nodeId}", *paneShell).first)
                    }
                }
                try {
                    assertEquals(ComposedInputResult.Status.UNCERTAIN, stream.submitComposed(ComposedInput.Paste("keep draft", true)).status)
                    awaitComposedBytes(bytes, "\u001b[200~keep draft\u001b[201~")
                    assertEquals(1, enterAttempts, "one guarded Enter attempt; no retry")
                } finally { host.onCommand = null; stream.detach() }
            }
        }
    }

    @Test fun `composed SSH refuses process birth drift even when numeric client server and pane IDs still match`() = runBlocking<Unit> {
        for (which in listOf("viewer", "server", "pane")) SshTestHost().use { host ->
            val adoption = managedAdoption(host); val bytes = composedRecorder(host, adoption.receipt.paneId, "birth-$which")
            host.connect().use { conn ->
                val stream = conn.attach(adoption.receipt.nodeId, 80, 24, Sink())
                try {
                    val field = stream.javaClass.getDeclaredField("inputViewer").apply { isAccessible = true }
                    val original = field.get(stream) as SshInputViewer
                    fun drift(value: String) = if (value.startsWith("linux:")) value.substringBeforeLast(':') + ":" + (value.substringAfterLast(':').toLong() + 1)
                        else value.dropLast(1) + if (value.last() == '0') "1" else "0"
                    val changed = when (which) {
                        "viewer" -> original.copy(viewerBirth = drift(original.viewerBirth))
                        "server" -> original.copy(serverBirth = drift(original.serverBirth))
                        else -> original.copy(paneBirth = drift(original.paneBirth))
                    }
                    // A lease whose PID was reused has this shape: all numeric tmux fields match,
                    // but its captured native birth belongs to another generation.
                    field.set(stream, changed)
                    assertEquals(ComposedInputResult.Status.REFUSED, stream.submitComposed(ComposedInput.Paste("must not arrive", true)).status, which)
                    assertFalse(bytes.exists(), which)
                } finally { stream.detach() }
            }
        }
    }

    // No locale at all, like an sshd exec channel on a stock macOS host (audit A03): passing the JVM's
    // own LANG through is what hid that bug.
    // Nor any NODETERM_* of the developer's (the review of A27a): the browse reads NODETERM_DATA_DIR,
    // so an exported one pointed these tests at a real Server Edition's data dir.
    private fun childEnv(home: File = this.home, tmuxDir: File = this.tmuxDir): Map<String, String> = System.getenv().filterKeys {
        it != "TMUX" && it != "TMUX_PANE" && it != "LANG" && it != "LANGUAGE" && !it.startsWith("LC_") &&
            !it.startsWith("NODETERM_") && it !in setOf("ENV", "BASH_ENV", "INPUTRC", "SHELLOPTS", "BASHOPTS") &&
            !it.startsWith("BASH_FUNC_")
    } +
        mapOf("HOME" to home.path, "TMUX_TMPDIR" to tmuxDir.path, "XDG_CONFIG_HOME" to File(home, ".config").path, "SHELL" to "/bin/sh")

    private fun tmux(vararg args: String): Pair<Int, String> = tmuxOn("node-terminal", *args)

    /** tmux on [socket] — inside this class's private TMUX_TMPDIR, never a developer's server (#629). */
    private fun tmuxOn(socket: String, vararg args: String): Pair<Int, String> {
        val pb = ProcessBuilder(listOf("tmux", "-L", socket) + args).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(childEnv())
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        return p.waitFor() to out
    }

    /** Called with each command the server is asked to run, before it runs (and before sshj hears back). */
    @Volatile private var onCommand: ((String, ShCommand) -> Unit)? = null

    private inner class ShCommand(
        private val command: String,
        private val commandHome: File = home,
        private val environment: Map<String, String> = childEnv()
    ) : Command {
        private lateinit var input: InputStream
        private lateinit var output: OutputStream
        private lateinit var error: OutputStream
        private lateinit var exit: ExitCallback
        private var process: Process? = null
        /** Counted down once the command's process has exited (for a pty, `script` and what it ran). */
        val exited = java.util.concurrent.CountDownLatch(1)
        /** A server that closes the channel without confirming the command's exit status. */
        var omitExitStatus = false

        override fun setInputStream(`in`: InputStream) { input = `in` }
        override fun setOutputStream(out: OutputStream) { output = out }
        override fun setErrorStream(err: OutputStream) { error = err }
        override fun setExitCallback(callback: ExitCallback) { exit = callback }

        override fun start(channel: ChannelSession, env: Environment) {
            val cols = env.env["COLUMNS"] ?: "80"
            val lines = env.env["LINES"] ?: "24"
            val pty = env.env.containsKey("TERM")
            val argv = if (pty) ptyScript.argv("stty cols $cols rows $lines 2>/dev/null; $command")
            else listOf("/bin/sh", "-c", command)
            val pb = ProcessBuilder(argv).directory(commandHome)
            pb.environment().clear()
            pb.environment().putAll(environment)
            val p = pb.start()
            process = p
            fun pump(from: InputStream, to: OutputStream, closeTo: Boolean) = Thread {
                runCatching {
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = from.read(buf)
                        if (n < 0) break
                        to.write(buf, 0, n)
                        to.flush()
                    }
                }
                if (closeTo) runCatching { to.close() }
            }.apply { isDaemon = true; start() }
            val outPump = pump(p.inputStream, output, false)
            val errPump = pump(p.errorStream, error, false)
            // For a pty session, channel EOF must NOT become stdin EOF: `script` turns that into a ^D
            // typed into the pty (util-linux measured; FreeBSD's source does the same), which ends the
            // pane's shell — a harness artifact real sshd does not have (it closes the pty and the tmux
            // client just detaches).
            pump(input, p.outputStream, !pty)
            Thread {
                val code = p.waitFor()
                outPump.join(2000)
                errPump.join(2000)
                exited.countDown()
                if (omitExitStatus) channel.close(false) else exit.onExit(code)
            }.apply { isDaemon = true; start() }
        }

        override fun destroy(channel: ChannelSession) {
            process?.destroy()
        }
    }

    @BeforeAll
    fun setUp() {
        assumeTrue(tmuxAvailable(), "${PtyScript.SKIP_REASON}; no tmux on PATH")
        val script = PtyScript.detect()
        assumeTrue(script != null, "${PtyScript.SKIP_REASON}; `script` answered neither form")
        ptyScript = script!!
        // Short and resolved, so the tmux socket fits in sun_path on a Mac too (audit A62).
        root = ShortTmuxRoot.create("nt-ssh", "tmux", "node-terminal")
        home = File(root, "home").apply { mkdirs() }
        tmuxDir = File(root, "tmux").apply { mkdirs() }
        server = SshServer.setUpDefaultServer()
        server.host = "127.0.0.1"
        server.port = 0
        server.keyPairProvider = SimpleGeneratorHostKeyProvider(File(root, "hostkey.ser").toPath())
        val expected = identity.keyPair.public.encoded
        server.publickeyAuthenticator = org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator { user, key, _ ->
            authAttempts.incrementAndGet()
            user == "dev" && key.encoded.contentEquals(expected)
        }
        server.commandFactory = org.apache.sshd.server.command.CommandFactory { _, command ->
            ShCommand(command).also { onCommand?.invoke(command, it) }
        }
        server.start()
        port = server.port
        layOutDesktop()
    }

    @AfterAll
    fun tearDown() {
        if (!::server.isInitialized) return
        runCatching { tmux("kill-server") }
        runCatching { stopRmtServer() }
        runCatching { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
        server.stop(true)
        root.deleteRecursively()
    }

    @BeforeEach
    fun resetPrimaryPane() {
        // Tests deliberately send Escape, leave partial input and alter PATH. Even a failed test
        // must not leave those bytes or shell settings for the next test in this shared session.
        val (code, out) = tmux("respawn-pane", "-k", "-t", "=nt-term-a-1:", "-c", File(repo, "sub").path, *paneShell)
        assertEquals(0, code, out)
        val token = "ready_${System.nanoTime()}"
        assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "-l", "--", "printf 'fixture_%s\\n' '$token'").first)
        assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "Enter").first)
        assertTrue(waitForPane("node-terminal", "nt-term-a-1", "fixture_$token").contains("fixture_$token"), "the fresh shell must be ready")
    }

    private val repo get() = File(root, "repo")

    private fun layOutDesktop() {
        // The REAL directory name (audit A02): Electron's userData is package.json `name`.
        val ud = File(home, ".config/node-terminal").apply { mkdirs() }
        File(repo, ".nodeterm").mkdirs()
        File(repo, ".nodeterm/project.json").writeText(
            """{"version":1,"rev":3,"savedAt":"x","name":"file name ignored","color":"#000",
               "viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-a-1","kind":"terminal","title":"Claude","color":"#d97757","group":null,
                         "agentId":"claude","cwd":"./sub","position":{"x":0,"y":0},"size":{"width":1,"height":1}}],
               "kanban":{"columns":[{"id":"c1","title":"Doing","color":"#0a84ff"}],"assignments":[{"nodeId":"term-a-1","columnId":"c1"}]}}"""
        )
        File(ud, "inline-projects").mkdirs()
        File(ud, "inline-projects/p3.json").writeText(
            """{"version":1,"rev":2,"savedAt":"x","name":"n","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-c-3","kind":"terminal","title":"From file","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}"""
        )
        File(ud, "workspace.json").writeText(
            """{"version":3,"activeProjectId":"p1","entries":[
                 {"id":"p1","name":"Repo","color":"#0a84ff","cwd":"${repo.path}"},
                 {"id":"p2","name":"Server","color":"#ff9f0a","ssh":{"server":{"host":"box","user":"me"},"remoteCwd":"~"},
                  "cache":{"version":1,"rev":1,"savedAt":"x","name":"n","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
                           "nodes":[{"id":"term-b-2","kind":"terminal","title":"Remote","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}},
                 {"id":"p3","name":"Scratch","color":"#bf5af2","dataFile":true,
                  "project":{"id":"p3","name":"Scratch","color":"#bf5af2","viewport":{"x":0,"y":0,"zoom":1},
                             "nodes":[{"id":"term-c-3","kind":"terminal","title":"Stale cache","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}},
                 {"id":"p4","name":"Parked","color":"#8e8e93","closed":true,"project":{"id":"p4","name":"Parked","color":"#8e8e93","viewport":{"x":0,"y":0,"zoom":1},"nodes":[]}}
               ]}"""
        )
        File(ud, "agent-status.json").writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"working","agentId":"claude","updatedAt":5}},
               "inbox":{"events":[],"nodes":{}}}"""
        )
        File(ud, "tmux.conf").writeText("set -g status off\n")
        File(repo, "sub").mkdirs()
        val (code, out) = tmux("-f", File(ud, "tmux.conf").path, "new-session", "-d", "-s", "nt-term-a-1", "-c", File(repo, "sub").path, *paneShell)
        assertEquals(0, code, out)
    }

    private fun connect(pin: HostKeyPin = MemoryPin(), factory: javax.net.SocketFactory? = null) =
        SshHostConnection.connect("127.0.0.1", port, "dev", identity, pin, socketFactory = factory)

    private fun gitRepo(): File {
        val dir = File(repo, "git-${System.nanoTime()}").apply { mkdirs() }
        gitAt(dir, "init", "-b", "main")
        gitAt(dir, "config", "user.name", "SSH fixture")
        gitAt(dir, "config", "user.email", "fixture@example.invalid")
        gitAt(dir, "config", "commit.gpgsign", "false")
        File(dir, "base").writeText("initial\n")
        gitAt(dir, "add", "--", "base")
        gitAt(dir, "commit", "-m", "initial")
        return dir
    }

    private fun gitAt(dir: File, vararg args: String): String {
        val pb = ProcessBuilder(listOf("git") + args).directory(dir).redirectErrorStream(true)
        pb.environment().clear(); pb.environment().putAll(childEnv())
        val process = pb.start(); val out = process.inputStream.bufferedReader().readText()
        assertEquals(0, process.waitFor(), out)
        return out
    }

    @Test
    fun `typed Git over real SSH serves status diff stage unstage commit push pull and history`() = runBlocking<Unit> {
        val dir = gitRepo()
        val remote = File(root, "remote-${System.nanoTime()}.git")
        gitAt(dir, "init", "--bare", "-b", "main", remote.path)
        gitAt(dir, "remote", "add", "origin", remote.path)
        try {
            connect().use { conn ->
                assertTrue(conn.capabilities.git)
                assertEquals(LegRouting.Leg.Primary, LegRouting.route(Capability.GIT, conn.kind, conn.capabilities, LegRouting.RelayLeg.ADDED_OVER_SSH))
                // Git itself triggers the first authoritative browse before any jailed command.
                val control = SourceControl(conn, File(dir, "sub").apply { mkdirs() }.path)
                val name = "-literal ' \$(touch injected)\nß.txt"
                File(dir, name).writeText("first\nsecond\n")
                val file = control.status().untracked.single()
                assertEquals(name, file.path)
                assertTrue(control.diff(file, staged = false).lines.any { it.text == "+second" })
                assertTrue(control.stage(listOf(name)).ok)
                assertEquals(name, control.status().staged.single().path)
                assertTrue(control.unstage(listOf(name)).ok)
                assertEquals(name, control.status().untracked.single().path)
                assertTrue(control.stage(listOf(name)).ok)
                assertTrue(control.commit("from Android ' \$(touch injected)").ok)
                assertFalse(File(dir, "injected").exists())
                assertEquals(2, control.history().commits.size)
                assertTrue(control.push().ok)
                assertTrue(control.status().hasUpstream)
                assertEquals("origin/main", control.history().remoteRef)
                File(dir, "base").appendText("rejected\n")
                gitAt(dir, "commit", "-am", "rejected")
                val attempts = File(remote, "attempts")
                val hook = File(remote, "hooks/pre-receive").apply {
                    writeText("#!/bin/sh\nprintf '%s\\n' attempt >> ${SshScripts.q(attempts.path)}\nprintf '%s\\n' 'set-upstream: no upstream; rejected by fixture' >&2\nexit 1\n")
                    setExecutable(true)
                }
                assertFalse(control.push().ok)
                assertEquals(1, attempts.readText().split("attempt").size - 1, "a matching remote rejection is not a second SSH Git push")
                hook.delete(); gitAt(dir, "reset", "--hard", "HEAD~1")
                gitAt(dir, "reset", "--hard", "HEAD~1")
                assertTrue(control.history().hasIncomingChanges)
                assertTrue(control.pull().ok)
                assertTrue(File(dir, name).exists())
            }
        } finally { dir.deleteRecursively(); remote.deleteRecursively() }
    }

    @Test
    fun `Git jail never treats third-machine caches as local folders and rechecks symlinks`() = runBlocking<Unit> {
        val dir = gitRepo()
        val outside = File(root, "outside-${System.nanoTime()}").apply { mkdirs() }
        gitAt(outside, "init", "-b", "main")
        val link = File(repo, "link-${System.nanoTime()}")
        java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
        val workspace = File(home, ".config/node-terminal/workspace.json")
        val before = workspace.readText()
        try {
            val index = kotlinx.serialization.json.Json.parseToJsonElement(before) as kotlinx.serialization.json.JsonObject
            val entries = (index["entries"] as kotlinx.serialization.json.JsonArray).map { value ->
                val entry = value as kotlinx.serialization.json.JsonObject
                if ((entry["id"] as? JsonPrimitive)?.content != "p2") entry else {
                    val cache = entry["cache"] as kotlinx.serialization.json.JsonObject
                    kotlinx.serialization.json.JsonObject(entry + ("cache" to kotlinx.serialization.json.JsonObject(cache + ("cwd" to JsonPrimitive(outside.path)))))
                }
            }
            workspace.writeText(kotlinx.serialization.json.JsonObject(index + ("entries" to kotlinx.serialization.json.JsonArray(entries))).toString())
            connect().use { conn ->
                val third = conn.listProjects().projects.single { it.id == "p2" }
                assertNotNull(third.sshTarget)
                assertEquals(outside.path, third.cwd, "a real folder cached for another machine is not a local root")
                for (cwd in listOf(outside.path, link.path, "/srv/not-a-local-project", "/")) {
                    val refused = assertFailsWith<HostException> { conn.git(GitVerb.STATUS, cwd) }
                    assertTrue(refused.message!!.contains("listed project") || refused.message!!.contains("cannot be opened"), refused.message)
                }
                assertFailsWith<HostException> { conn.git(GitVerb.STAGE, dir.path, mapOf("paths" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("../../outside"))))) }
                assertTrue(GitReplies.status(conn.git(GitVerb.STATUS, dir.path))!!.hasRepo)
            }
        } finally { workspace.writeText(before); link.delete(); outside.deleteRecursively(); dir.deleteRecursively() }
    }

    @Test
    fun `SSH-only driven projects serve Git on this machine without changing shared canvas files`() = runBlocking<Unit> {
        try {
            layOutDrivenHost(System.currentTimeMillis())
            gitAt(remoteRepo, "init", "-b", "main")
            gitAt(remoteRepo, "config", "user.name", "SSH fixture")
            gitAt(remoteRepo, "config", "user.email", "fixture@example.invalid")
            gitAt(remoteRepo, "config", "commit.gpgsign", "false")
            val canvas = File(remoteRepo, ".nodeterm/project.json").readBytes()
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val project = conn.listProjects().projects.single { it.id == "project-drv" }
                        assertTrue(project.drivenRemotely); assertNull(project.sshTarget)
                        val leg = LegRouting.forProject(Capability.GIT, project,
                            LegRouting.route(Capability.GIT, conn.kind, conn.capabilities, LegRouting.RelayLeg.ADDED_OVER_SSH))
                        assertEquals(LegRouting.Leg.Primary, leg)
                        assertIs<dev.nodeterm.protocol.git.SourceControlGate.Availability.Available>(dev.nodeterm.protocol.git.SourceControlGate.of(project, leg))
                        File(remoteRepo, "owned.txt").writeText("local driven repository\n")
                        val control = SourceControl(conn, project.cwd!!)
                        assertTrue(control.status().untracked.any { it.path == "owned.txt" })
                        assertTrue(control.stage(listOf("owned.txt")).ok)
                        assertTrue(control.commit("direct driven Git").ok)
                        assertEquals("direct driven Git", control.history().commits.first().subject)
                        assertTrue(canvas.contentEquals(File(remoteRepo, ".nodeterm/project.json").readBytes()))
                    }
                }
            }
        } finally { clearDrivenHost() }
    }

    @Test
    fun `an SSH Git write without an exit receipt is uncertain once and never automatically repeated`() = runBlocking<Unit> {
        val dir = gitRepo()
        val writes = java.util.concurrent.atomic.AtomicInteger()
        try {
            connect().use { conn ->
                conn.listProjects()
                File(dir, "new").writeText("new\n")
                val control = SourceControl(conn, dir.path)
                assertTrue(control.stage(listOf("new")).ok)
                onCommand = { command, sh ->
                    if (command.contains("'commit'")) { writes.incrementAndGet(); sh.omitExitStatus = true }
                }
                val unknown = assertFailsWith<HostUnansweredException> { control.commit("unanswered-but-done") }
                assertTrue(unknown.message!!.contains("may still be running there, or may have finished"), unknown.message)
                assertEquals(1, writes.get())
                assertFalse(conn.isConnected, "an unconfirmed write retires this transport before another action")
                assertEquals("unanswered-but-done", gitAt(dir, "log", "-1", "--format=%s").trim())
            }
        } finally { onCommand = null; dir.deleteRecursively() }
    }

    @Test
    fun `SSH write deadline tears down transport and retains uncertain outcome`() = runBlocking<Unit> {
        val marker = File(root, "write-${System.nanoTime()}")
        try {
            connect().use { conn ->
                assertFailsWith<HostUnansweredException> {
                    conn.run("printf done > ${SshScripts.q(marker.path)}; sleep 3", timeoutSec = 1, uncertainWrite = true)
                }
                assertEquals("done", marker.readText())
                assertFalse(conn.isConnected)
            }
        } finally { marker.delete() }
    }

    @Test
    fun `SSH Git output cap retires the channel and an oversized dispatched write stays uncertain`() = runBlocking<Unit> {
        for (write in listOf(false, true)) connect().use { conn ->
            val error = assertFailsWith<HostException> {
                conn.run("printf '%s' 'a bounded fixture output bigger than eight bytes'", uncertainWrite = write, outputLimit = 8)
            }
            if (write) assertIs<HostUnansweredException>(error) else assertFalse(error is HostUnansweredException)
            assertTrue(error.message!!.contains("output exceeded"), error.message)
            assertFalse(conn.isConnected)
        }
    }

    /**
     * Android's StrictMode, reproduced on the JVM (which has no BlockGuard): a socket whose streams
     * throw a RuntimeException — like `NetworkOnMainThreadException` — when used from a thread marked
     * as "main". The JVM tests could not see audit A01/A04 without this.
     */
    private class MainThreadGuard : javax.net.SocketFactory() {
        val main = ThreadLocal.withInitial { false }
        val sockets = java.util.Collections.synchronizedList(ArrayList<java.net.Socket>())
        val violations = java.util.concurrent.atomic.AtomicInteger()
        @Volatile var poisonAll = false
        @Volatile var rejectNoDelay = false

        private fun check() {
            if (poisonAll) throw IllegalStateException("simulated failure after the cipher advanced")
            if (main.get()) {
                violations.incrementAndGet()
                throw IllegalStateException("NetworkOnMainThreadException (simulated)")
            }
        }

        private fun guarded(): java.net.Socket = object : java.net.Socket() {
            override fun setTcpNoDelay(on: Boolean) {
                if (on && rejectNoDelay) throw java.net.SocketException("TCP_NODELAY configuration refused")
                super.setTcpNoDelay(on)
            }

            override fun getOutputStream(): OutputStream {
                val real = super.getOutputStream()
                return object : OutputStream() {
                    override fun write(b: Int) { check(); real.write(b) }
                    override fun write(b: ByteArray, off: Int, len: Int) { check(); real.write(b, off, len) }
                    override fun flush() { check(); real.flush() }
                    override fun close() = real.close()
                }
            }
        }.also { sockets.add(it) }

        override fun createSocket(): java.net.Socket = guarded()
        override fun createSocket(host: String, port: Int) = guarded().apply { connect(java.net.InetSocketAddress(host, port)) }
        override fun createSocket(host: String, port: Int, l: java.net.InetAddress, lp: Int) = createSocket(host, port)
        override fun createSocket(host: java.net.InetAddress, port: Int) = guarded().apply { connect(java.net.InetSocketAddress(host, port)) }
        override fun createSocket(a: java.net.InetAddress, p: Int, l: java.net.InetAddress, lp: Int) = createSocket(a, p)

        fun <T> onMain(block: () -> T): T {
            main.set(true)
            try { return block() } finally { main.set(false) }
        }
    }

    /**
     * What a screen shows for [e] when the phone has no relay leg to open (A27): no relay offered, and
     * the reason that is actually in the way for that leg (the review of A27b).
     */
    private fun assertNoRelayPromised(e: NeedsRelayException) {
        assertTrue(e.withoutRelay.contains("Remote access isn't set up for this computer"), e.withoutRelay)
        assertNull(e.refusal(LegRouting.RelayLeg.AVAILABLE), "a usable relay leg is offered, not refused")
        for (leg in LegRouting.RelayLeg.entries - LegRouting.RelayLeg.AVAILABLE) {
            val said = assertNotNull(e.refusal(leg), "$leg")
            assertTrue(said.startsWith(e.fact), "$leg: $said")
            assertFalse(said.contains("opens through the relay"), "$leg: $said")
        }
        assertEquals(e.withoutRelay, e.refusal(LegRouting.RelayLeg.ADDED_OVER_SSH))
        // A paired computer set to "Only on my network" HAS remote access: the refusal names the route
        // setting in the way, never "isn't set up" (what InboxTab and SessionsTab used to say).
        val sshOnly = e.refusal(LegRouting.RelayLeg.ROUTE_SSH_ONLY)!!
        assertTrue(sshOnly.contains("\"Only on my network (SSH)\"") && sshOnly.contains("How to reach each computer"), sshOnly)
        assertFalse(sshOnly.contains("isn't set up"), sshOnly)
        for (leg in listOf(LegRouting.RelayLeg.NOT_PICKED_UP, LegRouting.RelayLeg.REMOTE_ACCESS_OFF)) {
            assertFalse(e.refusal(leg)!!.contains("isn't set up"), "$leg: ${e.refusal(leg)}")
        }
    }

    private class MemoryPin(var value: String? = null, private val paired: List<String> = emptyList()) : HostKeyPin {
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
        override fun anchors() = paired
    }

    private class Sink : TerminalSink {
        val out = ByteArrayOutputStream()
        override fun onPaint(text: String) {}
        override fun onOutput(bytes: ByteArray) {
            synchronized(out) { out.write(bytes) }
        }
        override fun onExit(code: Int?) {}
        fun waitFor(needle: String, ms: Long = 8_000) {
            val end = System.currentTimeMillis() + ms
            while (!synchronized(out) { out.toString(Charsets.UTF_8) }.contains(needle)) {
                if (System.currentTimeMillis() > end) throw AssertionError("'$needle' never appeared: ${synchronized(out) { out.toString(Charsets.UTF_8) }.takeLast(400)}")
                Thread.sleep(50)
            }
        }
    }

    @Test
    fun `a fresh test pane drops pending input and shell startup settings`() {
        val init = File(home, "unexpected-shell-init.sh").apply { writeText("echo startup_leaked\n") }
        try {
            assertEquals(0, tmux("set-environment", "-g", "ENV", init.path).first)
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "-l", "--", "PATH=/no-test-commands; export PATH").first)
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "Enter").first)
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "-l", "--", "echo leftover_").first)
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "Escape").first)
            resetPrimaryPane()
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "-l", "--", "[ -x /bin/sh ] && command -v sh >/dev/null && printf 'isolated_%s\\n' yes").first)
            assertEquals(0, tmux("send-keys", "-t", "=nt-term-a-1:", "Enter").first)
            val pane = waitForPane("node-terminal", "nt-term-a-1", "isolated_yes")
            assertTrue(pane.contains("isolated_yes"), pane)
            assertFalse(pane.contains("leftover_"), pane)
            assertFalse(pane.contains("startup_leaked"), pane)
        } finally {
            tmux("set-environment", "-gu", "ENV")
            init.delete()
        }
    }

    @Test
    fun `browse resolves the v3 index the way the desktop assembles it`() = runBlocking<Unit> {
        connect().use { conn ->
            val snap = conn.listProjects()
            assertEquals(listOf("Repo", "Server", "Scratch", "Parked"), snap.projects.map { it.name }, "names come from the ENTRY")
            val repoProject = snap.projects[0]
            val node = repoProject.nodes.single()
            assertEquals("term-a-1", node.id)
            assertEquals(repo.path + "/sub", node.cwd, "portable ./ cwds resolve against the folder")
            assertEquals("c1", repoProject.board!!.columnOf("term-a-1"))
            assertEquals("me@box", snap.projects[1].sshTarget)
            assertEquals(listOf("term-b-2"), snap.projects[1].nodes.map { it.id }, "an ssh ref reads its offline cache")
            assertEquals(listOf("From file"), snap.projects[2].nodes.map { it.title }, "the data file wins over the cache")
            assertTrue(snap.projects[3].closed)
            assertTrue(snap.isLive("term-a-1"))
            assertFalse(snap.isLive("term-b-2"))
            assertEquals(AgentState.WORKING, snap.statusOf("term-a-1")!!.state)
        }
    }

    @Test
    fun `attach joins the live tmux session and carries keystrokes both ways`() = runBlocking<Unit> {
        connect().use { conn ->
            conn.listProjects()
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            assertFalse(stream.fresh)
            Thread.sleep(400)
            stream.write("echo nt_\$((6*7))\r")
            sink.waitFor("nt_42")
            stream.detach()
            Thread.sleep(300)
            val (code, out) = tmux("has-session", "-t", "=nt-term-a-1")
            assertEquals(0, code, "detaching never ends the session: $out / ${tmux("ls").second}")
        }
    }

    @Test
    fun `SSH scrolling reveals history produced before the phone attached`() = runBlocking<Unit> {
        val pane = "=nt-term-a-1:"
        val marker = "history_before_attach_${System.nanoTime()}"
        // The desktop owns scrolling through tmux's mouse mode. The general SSH fixture only
        // disables the status bar, so enable that production setting for this session explicitly.
        val mouse = tmux("set-option", "-t", pane, "mouse", "on")
        assertEquals(0, mouse.first, mouse.second)
        try {
            assertEquals(0, tmux("clear-history", "-t", pane).first)
            val command = "printf '$marker\\n'; i=1; while [ \"${'$'}i\" -le 60 ]; do " +
                "printf 'history_tail_%03d\\n' \"${'$'}i\"; i=${'$'}((i+1)); done"
            assertEquals(0, tmux("send-keys", "-t", pane, "-l", "--", command).first)
            assertEquals(0, tmux("send-keys", "-t", pane, "Enter").first)
            waitForPane("node-terminal", "nt-term-a-1", "history_tail_060")

            connect().use { conn ->
                val sink = Sink()
                val stream = conn.attach("term-a-1", 100, 30, sink)
                try {
                    sink.waitFor("history_tail_060")
                    assertFalse(synchronized(sink.out) { sink.out.toString(Charsets.UTF_8) }.contains(marker),
                        "the old marker must be above the initial screen, not replayed on attach")
                    val history = tmux("display-message", "-p", "-t", pane, "#{history_size}").second.trim().toInt()
                    assertTrue(history > 0, "the host retained the output produced before attach")

                    stream.scroll(up = true, lines = 20)
                    sink.waitFor(marker)
                    assertEquals("1", tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}").second.trim(),
                        "the phone's wheel-up must enter tmux copy mode")
                    val position = tmux("display-message", "-p", "-t", pane, "#{scroll_position}").second.trim().toInt()
                    assertTrue(position > 0, "the phone is viewing older output")

                    stream.scroll(up = false, lines = 20)
                    val deadline = System.currentTimeMillis() + 8_000
                    var after = position
                    while (after >= position && System.currentTimeMillis() < deadline) {
                        Thread.sleep(50)
                        after = tmux("display-message", "-p", "-t", pane, "#{scroll_position}")
                            .second.trim().toIntOrNull() ?: 0 // copy mode may close at the live bottom
                    }
                    assertTrue(after < position, "wheel-down must return toward live output: $position -> $after")
                } finally {
                    stream.detach()
                }
            }
        } finally {
            tmux("send-keys", "-X", "-t", pane, "cancel")
            val resetMouse = tmux("set-option", "-u", "-t", pane, "mouse")
            assertEquals(0, resetMouse.first, resetMouse.second)
        }
    }

    @Test
    fun `SSH scrolling honors custom wheel bindings in both copy key tables`() = runBlocking<Unit> {
        val pane = "=nt-term-a-1:"
        fun checkedTmux(vararg args: String): String {
            val (code, out) = tmux(*args)
            assertEquals(0, code, "tmux ${args.joinToString(" ")}: $out")
            return out.trimEnd()
        }
        fun cancelCopyMode() {
            val active = checkedTmux("display-message", "-p", "-t", pane, "#{pane_in_mode}")
            assertTrue(active == "0" || active == "1", "missing native pane_in_mode: $active")
            if (active == "1") checkedTmux("send-keys", "-X", "-t", pane, "cancel")
        }
        fun localOption(window: Boolean, name: String): String? =
            checkedTmux(*(if (window) arrayOf("show-options", "-w", "-t", pane)
            else arrayOf("show-options", "-t", pane))).lineSequence()
                .singleOrNull { it.startsWith("$name ") }?.substringAfter(' ')
        fun wheelBindings(table: String): List<String> = checkedTmux("list-keys", "-T", table)
            .lineSequence().filter {
                Regex("^bind-key(?:\\s+-r)?\\s+-T\\s+${Regex.escape(table)}\\s+Wheel(?:Up|Down)Pane(?:\\s|$)")
                    .containsMatchIn(it)
            }.toList()

        data class Mode(val keys: String, val table: String, val upGain: Int, val downGain: Int)
        val modes = listOf(Mode("emacs", "copy-mode", 3, 2), Mode("vi", "copy-mode-vi", 7, 4))
        val originalMouse = localOption(window = false, "mouse")
        val originalModeKeys = localOption(window = true, "mode-keys")
        val originalBindings = modes.associate { it.table to wheelBindings(it.table) }
        // list-keys emits tmux source syntax. Save only the affected private-server bindings and
        // local overrides, including absence, so a failed assertion cannot change another test.
        val restore = File.createTempFile("custom-wheel-restore-", ".conf", home)
        restore.writeText(buildString {
            appendLine(if (originalMouse == null) "set-option -u -t $pane mouse"
                else "set-option -t $pane mouse $originalMouse")
            appendLine(if (originalModeKeys == null) "set-option -u -w -t $pane mode-keys"
                else "set-option -w -t $pane mode-keys $originalModeKeys")
            for (mode in modes) {
                appendLine("unbind-key -T ${mode.table} WheelUpPane")
                appendLine("unbind-key -T ${mode.table} WheelDownPane")
                originalBindings.getValue(mode.table).forEach { appendLine(it) }
            }
        })
        try {
            checkedTmux("set-option", "-t", pane, "mouse", "on")
            checkedTmux("clear-history", "-t", pane)
            val marker = "custom_wheel_done_${System.nanoTime()}"
            val command = "i=1; while [ \"${'$'}i\" -le 750 ]; do " +
                "printf 'custom_wheel_%04d\\n' \"${'$'}i\"; i=${'$'}((i+1)); done; printf '$marker\\n'"
            checkedTmux("send-keys", "-t", pane, "-l", "--", command)
            checkedTmux("send-keys", "-t", pane, "Enter")
            waitForPane("node-terminal", "nt-term-a-1", marker)

            connect().use { conn ->
                val sink = Sink()
                val stream = conn.attach("term-a-1", 100, 30, sink)
                val actions = TerminalActions(this, stream) { true }
                try {
                    sink.waitFor(marker)
                    val history = checkedTmux("display-message", "-p", "-t", pane, "#{history_size}").toInt()
                    assertTrue(history > 400, "all exact positions must stay below the retained-history boundary")
                    fun position(): Int {
                        val state = checkedTmux("display-message", "-p", "-t", pane, "#{pane_in_mode}|#{scroll_position}").split('|')
                        assertEquals("1", state.first(), "custom wheel scrolling must remain in copy mode")
                        return assertNotNull(state.getOrNull(1)?.toIntOrNull(), "missing native scroll_position: $state")
                    }
                    suspend fun awaitPosition(mode: Mode, stage: String, expected: Int) {
                        yield() // Dispatch the actor's queued calls before measuring the native pane.
                        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
                        var actual = position()
                        var stableSince: Long? = null
                        while (System.nanoTime() < deadline) {
                            val now = System.nanoTime()
                            if (actual == expected) {
                                if (stableSince == null) stableSince = now
                                if (now - stableSince >= TimeUnit.MILLISECONDS.toNanos(300)) break
                            } else stableSince = null
                            delay(25) // Let TerminalActions drain; SSH writes also finish asynchronously.
                            actual = position()
                        }
                        assertEquals(expected, actual, "${mode.keys} $stage (up=${mode.upGain}, down=${mode.downGain})")
                        assertTrue(stableSince != null && System.nanoTime() - stableSince >= TimeUnit.MILLISECONDS.toNanos(300),
                            "${mode.keys} $stage must settle, not briefly cross the expected position")
                        println("custom-wheel native ${mode.keys} $stage: upGain=${mode.upGain} downGain=${mode.downGain} scroll_position=$actual expected=$expected stableMs=300")
                    }
                    for (mode in modes) {
                        cancelCopyMode()
                        checkedTmux("set-option", "-w", "-t", pane, "mode-keys", mode.keys)
                        checkedTmux("bind-key", "-T", mode.table, "WheelUpPane", "send-keys", "-X", "-N", mode.upGain.toString(), "scroll-up")
                        checkedTmux("bind-key", "-T", mode.table, "WheelDownPane", "send-keys", "-X", "-N", mode.downGain.toString(), "scroll-down")
                        checkedTmux("copy-mode", "-t", pane)
                        assertEquals(0, position())

                        // Each call exceeds SSH's 20-wheel limit: TerminalActions must deliver
                        // every notch, while the host's own asymmetric bindings define row gain.
                        assertTrue(actions.scroll(up = true, notches = 37))
                        awaitPosition(mode, "up37", 37 * mode.upGain)
                        assertTrue(actions.scroll(up = false, notches = 23))
                        awaitPosition(mode, "down23", 37 * mode.upGain - 23 * mode.downGain)
                        assertTrue(actions.scroll(up = true, notches = 29))
                        awaitPosition(mode, "up29", 66 * mode.upGain - 23 * mode.downGain)

                        cancelCopyMode()
                        checkedTmux("copy-mode", "-t", pane)
                        assertEquals(0, position())
                        // Queue both reversals before yielding. Down73 reaches the live bottom;
                        // its clamp makes the final position sensitive to FIFO direction order.
                        assertTrue(actions.scroll(up = true, notches = 37))
                        assertTrue(actions.scroll(up = false, notches = 73))
                        assertTrue(actions.scroll(up = true, notches = 29))
                        awaitPosition(mode, "queued up37 down73 up29", 29 * mode.upGain)
                    }
                } finally {
                    actions.close()
                    stream.detach()
                }
            }
        } finally {
            try {
                cancelCopyMode()
            } finally {
                try {
                    checkedTmux("source-file", restore.path)
                    assertEquals(originalMouse, localOption(window = false, "mouse"))
                    assertEquals(originalModeKeys, localOption(window = true, "mode-keys"))
                    modes.forEach { assertEquals(originalBindings.getValue(it.table), wheelBindings(it.table)) }
                } finally {
                    restore.delete()
                }
            }
        }
    }

    @Test
    fun `an attach cancelled while it opens leaves no tmux client behind`() = runBlocking<Unit> {
        // A40 review: the blocking open finishes even when its caller is cancelled meanwhile, and
        // withContext then drops the stream. Nothing held it, so its tmux client stayed attached for
        // the life of the connection. The cancel lands exactly while the server starts the attach.
        connect().use { conn ->
            conn.listProjects()
            val attaching = AtomicReference<Job>()
            val attachCommand = AtomicReference<ShCommand>()
            onCommand = { command, cmd ->
                if (command.contains("attach-session")) {
                    attachCommand.set(cmd)
                    attaching.get().cancel()
                }
            }
            try {
                val job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { conn.attach("term-a-1", 100, 30, Sink()) }
                attaching.set(job)
                job.start()
                job.join()
                assertTrue(job.isCancelled)
                val cmd = assertNotNull(attachCommand.get(), "the attach reached the server")
                assertTrue(cmd.exited.await(10, TimeUnit.SECONDS), "the stream nobody holds was closed")
                val deadline = System.currentTimeMillis() + 5_000
                while (tmux("list-clients", "-t", "=nt-term-a-1").second.isNotBlank()) {
                    if (System.currentTimeMillis() > deadline) throw AssertionError("a tmux client is still attached: ${tmux("list-clients").second}")
                    Thread.sleep(100)
                }
            } finally {
                onCommand = null
            }
            assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first, "letting go never ends the session")
        }
    }

    @Test
    fun `the connected SSH socket disables packet coalescing for low latency input`() {
        connect().use { conn ->
            // Observe the actual default-factory native socket after a real SSH handshake/auth.
            val field = SshHostConnection::class.java.getDeclaredField("client").apply { isAccessible = true }
            val client = field.get(conn) as net.schmizz.sshj.SSHClient
            assertTrue(client.socket.isConnected)
            assertTrue(client.socket.tcpNoDelay, "small input packets must not wait for an earlier packet's ACK")
        }
    }

    @Test
    fun `low latency input also uses the socket supplied by a custom factory`() = runBlocking<Unit> {
        val factory = MainThreadGuard()
        connect(factory = factory).use { conn ->
            val socket = factory.sockets.single()
            assertTrue(socket.isConnected)
            assertTrue(socket.tcpNoDelay, "the custom factory's real connected socket must also disable Nagle")
            assertTrue(conn.listProjects().projects.isNotEmpty(), "the configured socket still serves SSH commands")
        }
    }

    @Test
    fun `a refused low latency socket option closes the socket before authentication or pinning`() {
        val factory = MainThreadGuard().apply { rejectNoDelay = true }
        val pin = MemoryPin()
        val before = authAttempts.get()
        try {
            val failure = assertFailsWith<HostException> { connect(pin, factory) }
            assertTrue(failure.message.orEmpty().contains("TCP_NODELAY configuration refused"))
            assertTrue(factory.sockets.single().isClosed, "socket option failure must not leak the connected socket")
            assertEquals(before, authAttempts.get(), "a socket configuration failure must precede authentication")
            assertNull(pin.value, "a failed connection must not pin the host key")
        } finally {
            factory.sockets.forEach { runCatching { it.close() } }
        }
    }

    @Test
    fun `resizes and key chips from the main thread never touch the socket there, and keep order`() = runBlocking<Unit> {
        // A01/A04: before the fix the resize threw on the "main" thread after sshj had advanced its
        // cipher state, and the next packet dropped the connection.
        val guard = MainThreadGuard()
        val conn = connect(factory = guard)
        var closedReason: String? = null
        conn.setOnClosed { closedReason = it ?: "closed" }
        try {
            conn.listProjects()
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            Thread.sleep(400)
            guard.onMain {
                stream.resize(90, 28)
                stream.write("echo ma")
                stream.write("in_\$((5*5))\r")
                stream.resize(100, 30)
            }
            sink.waitFor("main_25")
            // The connection is still usable for other work (listing, the Inbox) afterwards.
            conn.listProjects()
            assertEquals(0, guard.violations.get(), "no socket I/O ran on the main thread")
            assertEquals(null, closedReason)
            stream.detach()
        } finally {
            guard.onMain { conn.close() }
        }
        // close() from the main thread still really closes the socket (it used to leak).
        val end = System.currentTimeMillis() + 5_000
        while (guard.sockets.any { !it.isClosed } && System.currentTimeMillis() < end) Thread.sleep(50)
        assertTrue(guard.sockets.all { it.isClosed }, "close() from the main thread leaked the socket")
        assertEquals(0, guard.violations.get())
    }

    @Test
    fun `a write failure that corrupts the transport closes the connection instead of hiding it`() = runBlocking<Unit> {
        val guard = MainThreadGuard()
        val conn = connect(factory = guard)
        val closed = java.util.concurrent.CountDownLatch(1)
        conn.setOnClosed { closed.countDown() }
        try {
            conn.listProjects()
            val stream = conn.attach("term-a-1", 100, 30, Sink())
            Thread.sleep(300)
            // Every socket write now fails with a RuntimeException, on whatever thread it runs —
            // including the stream's own writer: the transport must be torn down, not ignored.
            guard.poisonAll = true
            stream.write("x")
            assertTrue(closed.await(10, TimeUnit.SECONDS), "the broken transport was reported through onClosed")
            // sshj's own disconnect listener may report first; the socket close lands right after.
            val end = System.currentTimeMillis() + 5_000
            while (conn.isConnected && System.currentTimeMillis() < end) Thread.sleep(20)
            assertFalse(conn.isConnected)
        } finally {
            guard.poisonAll = false
            conn.close()
        }
    }

    @Test
    fun `non-ASCII survives the attach even when the host sets no locale`() = runBlocking<Unit> {
        connect().use { conn ->
            val sink = Sink()
            val stream = conn.attach("term-a-1", 100, 30, sink)
            Thread.sleep(400)
            // ╭ (no ACS mapping) and é, built from octal escapes so the INPUT is pure ASCII.
            stream.write("printf 'u8:\\342\\225\\255\\303\\251:end\\n'\r")
            sink.waitFor("u8:╭é:end")
            stream.detach()
        }
    }

    @Test
    fun `a command that never answers drops the connection instead of hanging`() = runBlocking<Unit> {
        // A31: the read had no deadline, so a peer that vanished mid-command blocked it for as long
        // as TCP took to give up. A hung command stands in for the vanished peer here.
        val conn = connect()
        val closed = java.util.concurrent.CountDownLatch(1)
        conn.setOnClosed { closed.countDown() }
        val t0 = System.currentTimeMillis()
        assertFailsWith<HostException> { conn.run("sleep 30", timeoutSec = 1) }
        assertTrue(System.currentTimeMillis() - t0 < 10_000, "the deadline bounded the call")
        assertTrue(closed.await(5, TimeUnit.SECONDS), "the drop was reported, so the owner can fall back")
        conn.close()
    }

    @Test
    fun `phone terminal creates at home with no desktop data, browses, reattaches and ends independently`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        try {
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        assertFailsWith<NothingFoundException> { conn.listProjects() }
                        conn.createTerminal(id)
                        val snap = conn.listProjects()
                        val p = snap.projects.single { it.id == PhoneTerminals.PROJECT_ID }
                        assertEquals(home.path, p.nodes.single().cwd)
                        assertEquals(TmuxNames.PHONE_SOCKET, snap.socketOf(id))
                        assertTrue(snap.isLive(id))
                        val sink = Sink()
                        val stream = conn.attach(id, 52, 12, sink)
                        assertFalse(stream.fresh, "explicit creation does not invoke cold-agent launch")
                        stream.write("printf 'phone_%s\\n' home\r")
                        sink.waitFor("phone_home")
                        stream.detach()
                        assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
                    }
                    connect().use { conn ->
                        val snap = conn.listProjects()
                        assertEquals(home.path, snap.findNode(id)!!.second.cwd)
                        val stream = conn.attach(id, 56, 25, Sink())
                        stream.endSession()
                        assertFailsWith<NothingFoundException> { conn.listProjects() }
                        val ended = assertFailsWith<HostException> { conn.attach(id, 80, 24, Sink()) }
                        assertFalse(ended is NeedsRelayException)
                        assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first, "other sockets are untouched")
                    }
                }
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `phone terminal quotes hostile folder names and retries the same creation without respawning`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        val folder = File(root, "it's a \$(touch phone-injected) folder").apply { mkdirs() }
        try {
            connect().use { conn ->
                conn.createTerminal(id, folder.path)
                val target = "=nt-$id:"
                val pid = tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_pid}").second.trim()
                conn.createTerminal(id, folder.path)
                assertEquals(pid, tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_pid}").second.trim())
                assertEquals(folder.path, conn.listProjects().findNode(id)!!.second.cwd)
                assertFalse(File(root, "phone-injected").exists())
                assertFailsWith<SshTerminalCreationRefusedException> { conn.createTerminal(id, home.path) }
                assertEquals(folder.path, conn.listProjects().findNode(id)!!.second.cwd)
                assertFailsWith<SshTerminalCreationRefusedException> { conn.createTerminal("phone-" + java.util.UUID.randomUUID(), File(root, "gone").path) }
                val renamed = File(root, "renamed-phone-folder")
                assertTrue(folder.renameTo(renamed))
                try {
                    conn.createTerminal(id, folder.path)
                    assertEquals(pid, tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_pid}").second.trim())
                    assertEquals(folder.path, conn.listProjects().findNode(id)!!.second.cwd, "retry retains original metadata after directory rename")
                } finally { assertTrue(renamed.renameTo(folder)) }
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server"); folder.deleteRecursively() }
    }

    @Test
    fun `phone terminal uses driven project folder without changing its canvas or cold-agent refusal`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        try {
            layOutDrivenHost(System.currentTimeMillis())
            val file = File(remoteRepo, ".nodeterm/project.json")
            val before = file.readBytes()
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val driven = conn.listProjects().projects.first { it.id == "project-drv" }
                        assertTrue(driven.drivenRemotely)
                        conn.createTerminal(id, driven.cwd)
                        val snap = conn.listProjects()
                        assertEquals(remoteRepo.path, snap.findNode(id)!!.second.cwd)
                        assertEquals(TmuxNames.PHONE_SOCKET, snap.socketOf(id))
                        assertTrue(before.contentEquals(file.readBytes()), "the driving desktop owns this canvas")
                        val cold = assertFailsWith<HostException> { conn.attach("term-r-3", 80, 24, Sink()) }
                        assertFalse(cold is NeedsRelayException)
                        assertEquals(1, tmuxOn(TmuxNames.REMOTE_SOCKET, "has-session", "-t", "=nt-term-r-3").first)
                        val sink = Sink()
                        val stream = conn.attach(id, 52, 20, sink)
                        stream.write("printf 'driven_%s\\n' folder\r")
                        sink.waitFor("driven_folder")
                        stream.detach()
                    }
                }
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server"); clearDrivenHost() }
    }

    @Test
    fun `phone terminal foreign collisions and stale ownership never attach type or kill`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        val target = "=nt-$id:"
        try {
            assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", "nt-$id", *paneShell).first)
            connect().use { conn ->
                assertFailsWith<SshTerminalCreationRefusedException> { conn.createTerminal(id, home.path) }
                val refused = assertFailsWith<HostException> { conn.attach(id, 80, 24, Sink()) }
                assertFalse(refused is NeedsRelayException)
                assertFailsWith<HostException> { conn.sendKeys(id, "must_not_arrive\r") }
                assertFailsWith<HostException> { conn.killSession(id) }
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
                assertFalse(tmuxOn(TmuxNames.PHONE_SOCKET, "capture-pane", "-p", "-t", target).second.contains("must_not_arrive"))
            }
            tmuxOn(TmuxNames.PHONE_SOCKET, "kill-session", "-t", "=nt-$id")
            // A completed listing must not authorize a target whose ownership changed afterwards.
            Thread.sleep(150)
            connect().use { conn ->
                conn.createTerminal(id, home.path)
                assertTrue(conn.listProjects().isLive(id))
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "set-option", "-t", target, PhoneTerminals.CREATION_OPTION, "wrong").first)
                assertFailsWith<HostException> { conn.sendKeys(id, "stale_write\r") }
                assertFailsWith<HostException> { conn.killSession(id) }
                assertFailsWith<SshTerminalCreationRefusedException> { conn.createTerminal(id, home.path) }
                assertFalse(conn.listProjects().isLive(id))
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `phone terminal malformed atomic tuples and fully replaced stale markers cannot authorize actions`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        val target = "=nt-$id:"
        val wrong = "a".repeat(64)
        try {
            assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", "nt-$id",
                "-e", "${PhoneTerminals.ID_ENV}=$id", "-e", "${PhoneTerminals.CWD_ENV}=${home.path}",
                "-e", "${PhoneTerminals.REQUEST_ENV}=${home.path}", "-e", "${PhoneTerminals.CREATION_ENV}=$wrong", *paneShell).first)
            connect().use { conn ->
                assertFalse(conn.listProjects().isLive(id))
                assertFailsWith<HostException> { conn.attach(id, 80, 24, Sink()) }
                assertFailsWith<HostException> { conn.sendKeys(id, "forged_write\r") }
                assertFailsWith<HostException> { conn.killSession(id) }
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
            }
            tmuxOn(TmuxNames.PHONE_SOCKET, "kill-session", "-t", "=nt-$id")
            Thread.sleep(150)
            connect().use { conn ->
                conn.createTerminal(id, home.path)
                assertTrue(conn.listProjects().isLive(id))
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "set-environment", "-t", "=nt-$id", PhoneTerminals.CREATION_ENV, wrong).first)
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "set-option", "-t", target, PhoneTerminals.CREATION_OPTION, wrong).first)
                // Options still agree with the environment; this connection pins the valid tuple
                // from its last listing, so replacing both cannot authorize writes or deletion.
                assertFailsWith<HostException> { conn.attach(id, 80, 24, Sink()) }
                assertFailsWith<HostException> { conn.sendKeys(id, "replaced_write\r") }
                assertNull(conn.paneCommand(id))
                assertFailsWith<HostException> { conn.killSession(id) }
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
                assertFalse(tmuxOn(TmuxNames.PHONE_SOCKET, "capture-pane", "-p", "-t", target).second.contains("replaced_write"))
                assertFalse(conn.listProjects().isLive(id))
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `phone terminal reserved id cannot create or reopen on either desktop socket`() = runBlocking<Unit> {
        for (socket in listOf(TmuxNames.SOCKET, TmuxNames.REMOTE_SOCKET)) {
            val id = "phone-" + java.util.UUID.randomUUID()
            try {
                assertEquals(0, tmuxOn(socket, "-f", "/dev/null", "new-session", "-d", "-s", "nt-$id", *paneShell).first)
                connect().use { conn ->
                    assertFailsWith<SshTerminalCreationRefusedException> { conn.createTerminal(id, home.path) }
                    assertFailsWith<HostException> { conn.attach(id, 80, 24, Sink()) }
                    assertEquals(1, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
                    assertEquals(0, tmuxOn(socket, "has-session", "-t", "=nt-$id").first)
                }
            } finally { tmuxOn(socket, "kill-session", "-t", "=nt-$id") }
        }
    }

    @Test
    fun `phone terminal warm server clears all stale managed hook identities and has configured history`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        try {
            assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", "warm", *paneShell).first)
            for (name in listOf("NODETERM_NODE_ID", "NODETERM_HOOK_TOKEN", "NODETERM_FUTURE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME")) {
                assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "set-environment", "-g", name, "fixture-stale-value").first)
            }
            for (name in listOf("LANG", "LC_ALL")) assertEquals(0, tmuxOn(TmuxNames.PHONE_SOCKET, "set-environment", "-g", name, "C").first)
            connect().use { conn ->
                conn.createTerminal(id, home.path)
                val target = "=nt-$id:"
                assertEquals("50000", tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{history_limit}").second.trim())
                val sink = Sink()
                val stream = conn.attach(id, 52, 10, sink)
                stream.write("n=\$(env | grep '^NODETERM_' | wc -l | tr -d ' '); printf 'cleared_%s\\n' \"\$n\"\r")
                sink.waitFor("cleared_0")
                stream.write("printf 'accounts_%s_%s\\n' \"\${CLAUDE_CONFIG_DIR:-none}\" \"\${CODEX_HOME:-none}\"\r")
                sink.waitFor("accounts_none_none")
                stream.write("printf 'phone_locale_%s\\n' \"\$(locale charmap)\"\r")
                sink.waitFor("phone_locale_UTF-8")
                stream.write("i=1; while [ \$i -le 80 ]; do printf 'phone_history_%s\\n' \"\$i\"; i=\$((i+1)); done\r")
                sink.waitFor("phone_history_80")
                stream.scroll(true, 20)
                val modeDeadline = System.currentTimeMillis() + 5000
                while (System.currentTimeMillis() < modeDeadline && tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_in_mode}").second.trim() != "1") Thread.sleep(20)
                assertEquals("1", tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_in_mode}").second.trim())
                conn.sendKeys(id, "\u001b")
                assertEquals("0", tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_in_mode}").second.trim())
                stream.detach()
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `phone terminal interrupted option finalization is discoverable after a process restart`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        val target = "=nt-$id:"
        try {
            // Stop the actual generated shell immediately after its new-session command returns.
            // No metadata options or viewer attach have run; only the atomic creation tuple exists.
            val script = SshScripts.createTerminal(id, home.path)
            val partial = script.substringBefore("nt_marker=") + "exit 99\n"
            assertTrue(partial.contains("new-session"))
            connect().use { conn -> assertEquals(99, conn.run(partial).first) }
            assertEquals("", tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{${PhoneTerminals.CREATION_OPTION}}").second.trim())
            assertEquals("50000", tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{history_limit}").second.trim(),
                "startup output already gets the configured history before option finalization or attach")
            connect().use { conn ->
                val snap = conn.listProjects()
                assertTrue(snap.isLive(id), "restart must rediscover an owned creation, not orphan it")
                assertEquals(home.path, snap.findNode(id)!!.second.cwd)
                val sink = Sink()
                val stream = conn.attach(id, 52, 20, sink)
                stream.write("printf 'recovered_%s\\n' partial\r")
                sink.waitFor("recovered_partial")
                assertEquals("on", tmuxOn(TmuxNames.PHONE_SOCKET, "show-options", "-v", "-t", target, "mouse").second.trim())
                stream.endSession()
                assertEquals(1, tmuxOn(TmuxNames.PHONE_SOCKET, "has-session", "-t", "=nt-$id").first)
            }
        } finally { tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `phone terminal a lost exit status preserves ownership for an idempotent retry`() = runBlocking<Unit> {
        val id = "phone-" + java.util.UUID.randomUUID()
        try {
            connect().use { conn ->
                onCommand = { command, cmd -> if (command.contains("new-session") && command.contains(id)) cmd.omitExitStatus = true }
                val failed = assertFailsWith<HostException> { conn.createTerminal(id, home.path) }
                assertFalse(failed is SshTerminalCreationRefusedException, "unknown outcome must preserve the request")
                onCommand = null
                val target = "=nt-$id:"
                val pid = tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_pid}").second.trim()
                assertTrue(pid.toLongOrNull() != null)
                conn.createTerminal(id, home.path)
                assertEquals(pid, tmuxOn(TmuxNames.PHONE_SOCKET, "display-message", "-p", "-t", target, "#{pane_pid}").second.trim())
                assertTrue(conn.listProjects().isLive(id))
                assertEquals("", tmuxOn(TmuxNames.PHONE_SOCKET, "list-clients", "-t", "=nt-$id").second.trim(), "creation itself reserves no viewer")
            }
        } finally { onCommand = null; tmuxOn(TmuxNames.PHONE_SOCKET, "kill-server") }
    }

    @Test
    fun `a session that is not running is never created over SSH`() = runBlocking<Unit> {
        // A08: `new-session -A` over SSH created the desktop's session with no hook env. Now the
        // phone is told to use the relay, and nothing appears on the computer's tmux. term-c-3 is a
        // node of the computer's own index (the Scratch project) whose session is not running.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-c-3", 80, 24, Sink()) }
            assertEquals("term-c-3", e.nodeId)
            // With no relay leg to offer (remote access off, or a computer added by its SSH address,
            // A27), the refusal promises no relay and says remote access isn't set up.
            assertNoRelayPromised(e)
            Thread.sleep(300)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-c-3").first, "no session was created")
        }
    }

    @Test
    fun `a node no listing names is not offered this computer's relay when its session is not running`() = runBlocking<Unit> {
        // The review of A27a: the relay's pty.attach creates what it does not find, so for a node the
        // computer's own index does not have (a deleted node, a driven project no longer listed) it
        // would make a bare nt-<id> of no project on node-terminal. Only the computer's own nodes get
        // the relay; this one is told why it cannot be started from here.
        connect().use { conn ->
            val e = assertFailsWith<HostException> { conn.attach("term-z-9", 80, 24, Sink()) }
            assertFalse(e is NeedsRelayException, "no relay offered for a node nobody lists")
            assertEquals(SshHostConnection.NOT_RUNNING_UNLISTED, e.message)
            Thread.sleep(300)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-z-9").first, "no session was created")
        }
    }

    @Test
    fun `a fresh connection settles which nodes are whose before it refuses, with no listing first`() = runBlocking<Unit> {
        // The review of A27a: what a node is (the desktop's SSH project's, a driven one, the computer's
        // own) came only from a listing on the SAME connection, and a redial or a terminal restored
        // after the process died attaches at once. Each call below is the first on its connection.
        connect().use { conn ->
            // A09 with no listing: still the desktop's SSH project's node, not this computer's tmux.
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
            assertTrue(e.message!!.contains("me@box"), e.message)
            assertEquals(1, tmux("has-session", "-t", "=nt-term-b-2").first, "no phantom session")
        }
        connect().use { conn ->
            val ev = InboxEvent("e2", 1, "term-b-2", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, "term-b-2-1-1")
            assertFailsWith<NeedsRelayException> { conn.answerApproval(ev, allow = true) }
        }
        connect().use { conn ->
            conn.ackRead("term-b-2", "e2")
            assertFalse(File(home, ".nodeterm/acks/term-b-2.seen").exists(), "no ack written on the wrong machine")
        }
        connect().use { conn ->
            // The computer's own node that is not running: the relay, as with a listing.
            assertFailsWith<NeedsRelayException> { conn.attach("term-c-3", 80, 24, Sink()) }
        }
    }

    @Test
    fun `a Sleeping session opened over SSH offers its wake line, which a tap types at the pane's own prompt (A76)`() = runBlocking<Unit> {
        // Eco exited the CLI: term-a-1's pane is a shell again, still in the node's folder, and the
        // mirror says Sleeping. Nothing tells the desktop about an SSH attach, so the phone offers it.
        val status = File(home, ".config/node-terminal/agent-status.json")
        val before = status.readText()
        // A stand-in CLI that reports where it ran and with what.
        val bin = File(root, "fake-bin").apply { mkdirs() }
        File(bin, "claude").apply {
            writeText("#!/bin/sh\necho \"woke:\$(pwd -P):\$*\"\n")
            setExecutable(true)
        }
        status.writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"agentId":"claude","sessionId":"sid-7","hibernated":true,"updatedAt":5}},
               "settings":{"claudePermissionMode":"plan","claudeAccounts":[]},"inbox":{"events":[],"nodes":{}}}"""
        )
        try {
            connect().use { conn ->
                val snap = conn.listProjects()
                val stream = conn.attach("term-a-1", 100, 30, Sink())
                assertTrue(ResumeOffer.wantsPane(stream.fresh, conn.kind, snap, "term-a-1"))
                val owner = conn.paneCommand("term-a-1")
                assertTrue(Pane.isShell(owner), "Eco's shell owns the pane: $owner")
                val offer = assertNotNull(ResumeOffer.afterAttach(stream.fresh, conn.kind, snap, "term-a-1", paneCommand = owner))
                assertEquals(ResumeOffer.Kind.WAKE, offer.kind)
                assertEquals("claude --resume sid-7 --permission-mode plan", offer.command, "no cd: the pane is already there")
                Thread.sleep(400)
                stream.write("PATH='${bin.path}':\$PATH; export PATH\r")
                // A line someone left half-typed at the Sleeping prompt: the wake clears it first,
                // or the shell would run `echo half_typedclaude …` and the CLI would never start.
                stream.write("echo half_typed")
                stream.write(offer.keys)
                val want = "woke:${File(repo, "sub").canonicalPath}:--resume sid-7 --permission-mode plan"
                val end = System.currentTimeMillis() + 8_000
                var pane = ""
                while (System.currentTimeMillis() < end) {
                    pane = tmux("capture-pane", "-p", "-J", "-t", "=nt-term-a-1:").second
                    if (pane.contains(want)) break
                    Thread.sleep(100)
                }
                assertTrue(pane.contains(want), pane)
                stream.detach()
            }
        } finally {
            status.writeText(before)
        }
    }

    /**
     * The A76 review: the mirror's `hibernated` flag outlives a CLI resumed outside the desktop's own
     * wake (here the desktop app is not running at all, so nothing hears the resumed CLI). The phone
     * wakes a Sleeping codex session, codex keeps running, and the node still reads Sleeping; the next
     * open must not offer `codex resume` into it, where it would be sent as a prompt.
     */
    @Test
    fun `a codex session the phone woke is not offered the wake again while it runs, though the flag stays`() = runBlocking<Unit> {
        val status = File(home, ".config/node-terminal/agent-status.json")
        val before = status.readText()
        // term-a-1 runs codex for this test.
        val project = File(repo, ".nodeterm/project.json")
        val projectBefore = project.readText()
        project.writeText(projectBefore.replace("\"agentId\":\"claude\"", "\"agentId\":\"codex\""))
        // A stand-in codex that stays in the foreground, like the real TUI (its argv[0] is not a shell).
        val bin = File(root, "fake-codex").apply { mkdirs() }
        File(bin, "codex").apply {
            writeText("#!/bin/sh\necho \"codex-up:\$*\"\nexec sleep 60\n")
            setExecutable(true)
        }
        status.writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"done","agentId":"codex","sessionId":"t-9","hibernated":true,"updatedAt":5}},
               "inbox":{"events":[],"nodes":{}}}"""
        )
        fun paneOwner(): String = tmux("display-message", "-p", "-t", "=nt-term-a-1:", "#{pane_current_command}").second.trim()
        try {
            connect().use { conn ->
                val snap = conn.listProjects()
                assertEquals(true, snap.statusOf("term-a-1")?.hibernated)
                val first = conn.attach("term-a-1", 100, 30, Sink())
                val wake = assertNotNull(
                    ResumeOffer.afterAttach(first.fresh, conn.kind, snap, "term-a-1", paneCommand = conn.paneCommand("term-a-1"))
                )
                assertEquals("codex resume t-9", wake.command)
                Thread.sleep(400)
                first.write("PATH='${bin.path}':\$PATH; export PATH\r")
                first.write(wake.keys)
                val end = System.currentTimeMillis() + 8_000
                while (paneOwner() != "sleep" && System.currentTimeMillis() < end) Thread.sleep(100)
                assertEquals("sleep", paneOwner(), "the stand-in codex holds the pane")
                first.detach()

                // Nothing cleared the flag: the listing still says Sleeping. The next open reads the pane.
                val again = conn.listProjects()
                assertEquals(true, again.statusOf("term-a-1")?.hibernated, "the flag outlived the sleep")
                val second = conn.attach("term-a-1", 100, 30, Sink())
                assertTrue(ResumeOffer.wantsPane(second.fresh, conn.kind, again, "term-a-1"))
                val pane = conn.paneCommand("term-a-1")
                assertEquals("sleep", pane)
                assertNull(ResumeOffer.afterAttach(second.fresh, conn.kind, again, "term-a-1", paneCommand = pane), "no wake over a running CLI")
                // An offer still on screen from before is withdrawn at the tap by the same read.
                assertFalse(wake.stillOffered(again, "term-a-1", pane))
                second.detach()
            }
        } finally {
            status.writeText(before)
            project.writeText(projectBefore)
            // Hand the shared session back to its shell for the other tests.
            tmux("send-keys", "-t", "=nt-term-a-1:", "C-c")
            val end = System.currentTimeMillis() + 5_000
            while (!Pane.isShell(paneOwner()) && System.currentTimeMillis() < end) Thread.sleep(100)
        }
    }

    @Test
    fun `a pane that cannot be read is unknown, never a shell`() = runBlocking<Unit> {
        connect().use { conn ->
            // No such session, a node of the desktop's SSH projects (its pane is on another host), an id
            // no tmux target can be built from, and shell text (it becomes a session name that does not
            // exist): all null, none of them a shell.
            assertNull(conn.paneCommand("term-z-9"))
            conn.rememberRemoteNodes(conn.listProjects())
            assertNull(conn.paneCommand("term-b-2"))
            assertNull(conn.paneCommand(""))
            assertNull(conn.paneCommand("x; rm -rf ~"))
        }
    }

    @Test
    fun `the attach script itself refuses to create a missing session, on either socket`() {
        // Belt and braces for the race where the session ends between the check and the attach. On
        // nodeterm-rmt too (A27): a session a driving desktop makes there gets its remote tmux.conf
        // and hook env, which an attach from the phone would not. A live server on each socket, so
        // "missing" is a missing SESSION, not a socket nobody listens on.
        try {
            assertEquals(0, tmuxOn("nodeterm-rmt", "-f", "/dev/null", "new-session", "-d", "-s", "nt-keep-rmt", *paneShell).first)
            for (socket in listOf("node-terminal", "nodeterm-rmt")) {
                val (code, _) = run {
                    val pb = ProcessBuilder(ptyScript.argv(SshScripts.attach("term-y-8", socket))).directory(home)
                    pb.environment().clear()
                    pb.environment().putAll(childEnv())
                    val p = pb.start()
                    p.outputStream.close()
                    p.waitFor(10, TimeUnit.SECONDS)
                    p.exitValue() to p.inputStream.bufferedReader().readText()
                }
                assertEquals(SshScripts.NO_SESSION_EXIT, code, socket)
                assertEquals(1, tmuxOn(socket, "has-session", "-t", "=nt-term-y-8").first, socket)
            }
        } finally {
            stopRmtServer()
        }
    }

    @Test
    fun `nodes of the desktop's SSH projects are never reached on the desktop's own tmux`() = runBlocking<Unit> {
        // A09: term-b-2 belongs to the ssh project "Server" (me@box). Its session, approvals and acks
        // live on that host; over direct SSH the phone refuses instead of acting on the wrong machine.
        connect().use { conn ->
            conn.listProjects()
            val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
            assertTrue(e.message!!.contains("me@box"), e.message)
            assertTrue(e.withoutRelay.contains("me@box"), e.withoutRelay)
            assertNoRelayPromised(e)
            assertFailsWith<NeedsRelayException> { conn.sendKeys("term-b-2", "1") }
            val ev = InboxEvent("e2", 1, "term-b-2", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, "term-b-2-1-1")
            assertFailsWith<NeedsRelayException> { conn.answerApproval(ev, allow = true) }
            conn.ackRead("term-b-2", "e2")
            assertFalse(File(home, ".nodeterm/acks/term-b-2.seen").exists(), "no ack written on the wrong machine")
            assertEquals(1, tmux("has-session", "-t", "=nt-term-b-2").first, "no phantom session")
        }
    }

    @Test
    fun `without a live SSH actions advertisement app verbs route to relay with an honest refusal`() = runBlocking<Unit> {
        // A26: An older host with no file service routes Board, new session and node actions to relay.
        // Auto keeps its working SSH terminal leg; a caller
        // that reaches the SSH transport anyway is not told to turn on remote access (it may be on).
        connect().use { conn ->
            for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS)) {
                assertEquals(LegRouting.Leg.Relay, LegRouting.route(cap, conn.kind, conn.capabilities, LegRouting.RelayLeg.AVAILABLE), "$cap")
            }
            // What SSH does itself stays on SSH.
            assertEquals(
                LegRouting.Leg.Primary,
                LegRouting.route(Capability.ANSWER_APPROVALS, conn.kind, conn.capabilities, LegRouting.RelayLeg.AVAILABLE)
            )
            val refusals = listOf<suspend () -> Unit>(
                { conn.registerNode("p1", NewNode("term-n-1", "x", null, null)) },
                { conn.ensureBoard("p1") },
                { conn.setCardColumn("p1", "term-a-1", null) },
                { conn.editCardLabels("p1", "term-a-1", CardLabelEdit()) },
                { conn.wake("term-a-1") },
                { conn.rename("term-a-1", "x") }
            )
            for (call in refusals) {
                val e = assertFailsWith<HostException> { call() }
                assertFalse(e.message!!.contains("turn on remote access"), e.message)
                assertTrue(e.message!!.contains("through the relay"), e.message)
            }
        }
    }

    /**
     * The review of A26: a relay token the phone holds outlives the computer's remote-access toggle.
     * Each listing says whether the computer advertises its relay right now (`~/.nodeterm/relay.json`,
     * written while the desktop's phone host is registered and removed when it stops), and with it
     * off the app's verbs are unavailable with that reason instead of a tap that waits out the relay.
     */
    @Test
    fun `each listing says whether the computer advertises its relay, and off takes the stored leg away`() = runBlocking<Unit> {
        val ad = File(dotNodeterm, "relay.json")
        try {
            relayAdvertisementRoundTrip(ad)
        } finally {
            ad.delete()
        }
    }

    private suspend fun relayAdvertisementRoundTrip(ad: File) {
        connect().use { conn ->
            assertNull(conn.relayAdvertised, "unknown before the first listing")
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised, "no relay.json: remote access is off")
            val off = LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, relayAdvertised = conn.relayAdvertised)
            assertEquals(LegRouting.RelayLeg.REMOTE_ACCESS_OFF, off)
            for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS)) {
                val leg = assertIs<LegRouting.Leg.Unavailable>(LegRouting.route(cap, conn.kind, conn.capabilities, off), "$cap")
                assertTrue(leg.reason.contains("remote access is off on the computer"), leg.reason)
            }

            // Remote access turned on while the phone watches: the same connection's next listing sees it.
            dotNodeterm.mkdirs()
            ad.writeText("""{"v":1,"hostId":"h","hostPublicKeyB64":"k","relayEndpoint":"wss://relay.nodeterm.dev","hostDeviceId":"d"}""" + "\n")
            conn.listProjects()
            assertEquals(true, conn.relayAdvertised)
            assertEquals(LegRouting.RelayLeg.AVAILABLE, LegRouting.relayLeg(true, false, relayAdvertised = conn.relayAdvertised))
            // A phone without a token adopts it now, on the poll, without a new connection.
            assertTrue(LegRouting.adoptAfterListing(LegRouting.RelayLeg.NOT_PICKED_UP, false, conn.relayAdvertised, userAsked = false))

            // An empty file is no advertisement; a removed one is off again.
            ad.writeText("")
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised)
            ad.delete()
            conn.listProjects()
            assertEquals(false, conn.relayAdvertised)
        }
    }

    @Test
    fun `send keys types literally, even text that starts with a dash`() = runBlocking<Unit> {
        connect().use { conn ->
            conn.sendKeys("term-a-1", "-R; echo sk_\$((2+3))")
            conn.sendKeys("term-a-1", "\r")
            val end = System.currentTimeMillis() + 5_000
            var pane = ""
            while (System.currentTimeMillis() < end) {
                pane = tmux("capture-pane", "-p", "-t", "=nt-term-a-1:").second
                if (pane.contains("sk_5")) break
                Thread.sleep(100)
            }
            assertTrue(pane.contains("sk_5"), pane)
        }
    }

    @Test
    fun `send keys refuses to confirm success when the server gives no exit status`() = runBlocking<Unit> {
        connect().use { conn ->
            conn.listProjects()
            try {
                onCommand = { command, cmd ->
                    if (command.contains("send-keys")) cmd.omitExitStatus = true
                }
                val e = assertFailsWith<HostException> { conn.sendKeys("term-a-1", "\u001b") }
                assertTrue(e.message!!.contains("without a status"), e.message)
            } finally {
                onCommand = null
            }
        }
    }

    @Test
    fun `a held approval is answered through its answer file, exactly once`() = runBlocking<Unit> {
        val pending = File(home, ".nodeterm/pending").apply { mkdirs() }
        val id = "term-a-1-1700000000000-99"
        File(pending, "$id.json").writeText("{}")
        val event = InboxEvent("e1", 1, "term-a-1", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, id)
        connect().use { conn ->
            assertEquals(ApprovalOutcome.SENT, conn.answerApproval(event, allow = false))
            assertEquals("deny", File(pending, "$id.answer").readText())
            File(pending, "$id.json").delete()
            assertEquals(ApprovalOutcome.GONE, conn.answerApproval(event, allow = true))
            conn.ackRead("term-a-1", "e1")
            assertEquals("e1", File(home, ".nodeterm/acks/term-a-1.seen").readText())
        }
    }

    @Test
    fun `structured hook replies use exact original rules and complete multi select input over real SSH stdin`() = runBlocking<Unit> {
        val pending = File(home, ".nodeterm/pending").apply { mkdirs() }
        val id = "term-a-1-1700000000000-100"
        val held = File(pending, "$id.json")
        val event = InboxEvent("e2", 1, "term-a-1", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, id)
        val json = kotlinx.serialization.json.Json
        val permission = """{"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_suggestions":[{"type":"addRules","behavior":"allow","destination":"session","rules":[{"toolName":"Bash","ruleContent":"npm test"}]}]}"""
        held.writeText(permission)
        connect().use { conn ->
            assertEquals(ApprovalOutcome.SENT, conn.rememberApproval(event, 0))
            val remembered = File(pending, "$id.answer").readText()
            assertTrue(remembered.startsWith(dev.nodeterm.protocol.model.HookReplies.MARKER + "\n"))
            assertEquals(json.parseToJsonElement(permission).jsonObject["permission_suggestions"],
                json.parseToJsonElement(remembered.substringAfter('\n')).jsonObject["hookSpecificOutput"]!!.jsonObject["decision"]!!.jsonObject["updatedPermissions"])
            File(pending, "$id.answer").delete()
            val large = "x".repeat(70_000)
            val request = """{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"extra":"$large","questions":[{"question":"Which?","header":"Pick","multiSelect":true,"options":[{"label":"α","description":""},{"label":"β","description":""}]}]}}"""
            held.writeText(request)
            val question = event.copy(kind = InboxKind.QUESTION, pendingId = null, questionPendingId = id)
            assertEquals(ApprovalOutcome.SENT, conn.answerQuestions(question, listOf(listOf(0, 1))))
            val input = json.parseToJsonElement(File(pending, "$id.answer").readText().substringAfter('\n')).jsonObject["hookSpecificOutput"]!!.jsonObject["updatedInput"]!!.jsonObject
            assertEquals(large, input["extra"]!!.jsonPrimitive.content)
            assertEquals("α, β", input["answers"]!!.jsonObject["Which?"]!!.jsonPrimitive.content)
            held.delete()
            assertEquals(ApprovalOutcome.GONE, conn.answerQuestions(question, listOf(listOf(0))))
        }
        pending.deleteRecursively()
    }

    @Test fun `a structured hook write with lost exit acknowledgement stays uncertain without replay`() = runBlocking<Unit> {
        val pending = File(home, ".nodeterm/pending").apply { mkdirs() }
        val id = "term-a-1-1700000000000-102"
        val permission = """{"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_suggestions":[{"type":"addRules","behavior":"allow","destination":"session","rules":[{"toolName":"Bash","ruleContent":"npm test"}]}]}"""
        val question = """{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which?","header":"Pick","multiSelect":true,"options":[{"label":"α","description":""},{"label":"β","description":""}]}]}}"""
        val event = InboxEvent("lost-structured", 1, "term-a-1", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, id)
        try {
            for (approval in listOf(true, false)) {
                File(pending, "$id.answer").delete()
                File(pending, "$id.json").writeText(if (approval) permission else question)
                connect().use { conn ->
                    conn.listProjects()
                    var writes = 0
                    onCommand = { command, channel -> if (command.contains("cat >")) { writes++; channel.omitExitStatus = true } }
                    assertFailsWith<HostUnansweredException> {
                        if (approval) conn.rememberApproval(event, 0)
                        else conn.answerQuestions(event.copy(kind = InboxKind.QUESTION, pendingId = null, questionPendingId = id), listOf(listOf(0, 1)))
                    }
                    assertEquals(1, writes, "no automatic replay of an unanswered answer")
                    val answer = File(pending, "$id.answer").readText()
                    assertTrue(answer.startsWith(dev.nodeterm.protocol.model.HookReplies.MARKER + "\n"))
                    val output = kotlinx.serialization.json.Json.parseToJsonElement(answer.substringAfter('\n')).jsonObject.getValue("hookSpecificOutput").jsonObject
                    if (approval) assertNotNull(output["decision"])
                    else assertEquals("α, β", output.getValue("updatedInput").jsonObject.getValue("answers").jsonObject.getValue("Which?").jsonPrimitive.content)
                    onCommand = null
                }
            }
        } finally { onCommand = null; pending.deleteRecursively() }
    }

    @Test
    fun `structured reply refuses a changed held request and an unconfirmed command status`() = runBlocking<Unit> {
        val pending = File(home, ".nodeterm/pending").apply { mkdirs() }
        val id = "term-a-1-1700000000000-101"
        val held = File(pending, "$id.json")
        val request = """{"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_suggestions":[{"type":"addRules","behavior":"allow","destination":"session","rules":[{"toolName":"Bash","ruleContent":"npm test"}]}]}"""
        val event = InboxEvent("e3", 1, "term-a-1", "claude", null, InboxKind.APPROVAL, "Approve", null, false, false, emptyList(), false, id)
        connect().use { conn ->
            conn.listProjects()
            try {
                held.writeText(request)
                onCommand = { command, _ -> if (command.contains("cat >")) held.writeText(request.replace("npm test", "npm changed")) }
                assertFailsWith<HostException> { conn.rememberApproval(event, 0) }
                assertFalse(File(pending, "$id.answer").exists())
                held.writeText(request)
                onCommand = { command, cmd -> if (command.contains("cat >")) cmd.omitExitStatus = true }
                assertFailsWith<HostException> { conn.rememberApproval(event, 0) }
            } finally { onCommand = null; pending.deleteRecursively() }
        }
    }

    // ---- Audit A27: a computer a desktop drives over SSH, and the Server Edition ----------------------

    private val remoteRepo get() = File(root, "remote-repo")
    private val dotNodeterm get() = File(home, ".nodeterm")

    /**
     * What a desktop that drives this computer over SSH leaves here, written in the shapes its own
     * code writes them (hand-copied, like the rest of this class's layout — docs/android.md "Interop
     * tests"): an SSH project's canvas in `<remoteCwd>/.nodeterm/project.json` with the desktop's
     * project id as `id` (`projectToFile(p, …, p.id)`), the per-project status slices
     * `~/.nodeterm/agent-status-<projectId>.json` (`filterMirrorForNodes` + the host's settings block,
     * remote-status-push.ts) — one fresh, one a connected desktop's with no project file, one stale —
     * and sessions on the `nodeterm-rmt` socket started in the node's folder (`new-session -c`).
     */
    private fun layOutDrivenHost(now: Long) {
        File(remoteRepo, ".nodeterm").mkdirs()
        File(remoteRepo, "sub").mkdirs()
        File(remoteRepo, ".nodeterm/project.json").writeText(
            """{"version":1,"rev":4,"savedAt":"x","id":"project-drv","name":"Remote repo","color":"#30d158",
               "viewport":{"x":0,"y":0,"zoom":1},
               "nodes":[{"id":"term-r-1","kind":"terminal","title":"Claude here","color":"#d97757","group":null,
                         "agentId":"claude","cwd":"${File(remoteRepo, "sub").path}","position":{"x":0,"y":0},"size":{"width":1,"height":1}},
                        {"id":"term-r-2","kind":"terminal","title":"Shell here","color":"#000","group":null,
                         "position":{"x":0,"y":0},"size":{"width":1,"height":1}},
                        {"id":"term-r-3","kind":"terminal","title":"Not running","color":"#000","group":null,"agentId":"claude",
                         "position":{"x":0,"y":0},"size":{"width":1,"height":1}}],
               "kanban":{"columns":[{"id":"c9","title":"Doing","color":"#0a84ff"}],"assignments":[{"nodeId":"term-r-1","columnId":"c9"}]}}"""
        )
        dotNodeterm.mkdirs()
        File(dotNodeterm, "agent-status-project-drv.json").writeText(
            """{"v":1,"updatedAt":$now,"nodes":{"term-r-1":{"state":"working","agentId":"claude","sessionId":"sid-r1","updatedAt":$now}},
               "inbox":{"events":[{"id":"ev-r1","ts":$now,"nodeId":"term-r-1","agentId":"claude","kind":"approval",
                                   "title":"Run the tests?","pendingId":"term-r-1-1700000000000-7"}],"nodes":{}},
               "settings":{"claudePermissionMode":"plan","autoSupported":true,"claudeAccounts":[]}}"""
        )
        File(dotNodeterm, "agent-status-project-live2.json").writeText(
            """{"v":1,"updatedAt":$now,"nodes":{"term-s-7":{"state":"done","agentId":"codex","updatedAt":$now}}}"""
        )
        val old = now - 5 * 60_000
        File(dotNodeterm, "agent-status-project-gone.json").writeText(
            """{"v":1,"updatedAt":$old,"nodes":{"term-g-1":{"state":"blocked","agentId":"claude","updatedAt":$old}},
               "inbox":{"events":[{"id":"ev-g1","ts":$old,"nodeId":"term-g-1","kind":"approval","title":"Stale"}],"nodes":{}}}"""
        )
        val elsewhere = File(root, "elsewhere").apply { mkdirs() }
        for ((name, dir) in listOf("nt-term-r-1" to File(remoteRepo, "sub"), "nt-term-r-2" to remoteRepo, "nt-term-g-1" to elsewhere)) {
            val (code, out) = tmuxOn("nodeterm-rmt", "-f", "/dev/null", "new-session", "-d", "-s", name, "-c", dir.path, *paneShell)
            assertEquals(0, code, out)
        }
    }

    private fun clearDrivenHost() {
        stopRmtServer()
        dotNodeterm.listFiles()?.filter { it.name.startsWith("agent-status-") }?.forEach { it.delete() }
        remoteRepo.deleteRecursively()
    }

    /**
     * Stop this class's `nodeterm-rmt` server and wait until it is gone: a server exits AFTER
     * `kill-server` (or the end of its last session) returns, and a client that connects meanwhile
     * gets "server exited unexpectedly" instead of starting a new one.
     */
    private fun stopRmtServer() {
        tmuxOn("nodeterm-rmt", "kill-server")
        val end = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < end) {
            val (code, out) = tmuxOn("nodeterm-rmt", "list-sessions")
            if (code != 0 && !out.contains("server exited unexpectedly")) return
            Thread.sleep(50)
        }
    }

    /** Run [block] with the desktop app's userData moved away: a computer no nodeterm runs on. */
    private fun <T> withoutOwnData(block: () -> T): T {
        val ud = File(home, ".config/node-terminal")
        val aside = File(root, "ud-aside")
        check(ud.renameTo(aside))
        try {
            return block()
        } finally {
            check(aside.renameTo(ud))
        }
    }

    private fun waitForPane(socket: String, session: String, needle: String): String {
        val end = System.currentTimeMillis() + 8_000
        var pane = ""
        while (System.currentTimeMillis() < end) {
            pane = tmuxOn(socket, "capture-pane", "-p", "-J", "-t", "=$session:").second
            if (pane.contains(needle)) break
            Thread.sleep(100)
        }
        return pane
    }

    @Test
    fun `a computer another desktop drives over SSH lists its projects, sessions and status from what that desktop left there`() = runBlocking<Unit> {
        val now = System.currentTimeMillis()
        try {
            layOutDrivenHost(now)
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val snap = conn.listProjects()
                        assertEquals(
                            listOf("Remote repo", "project-live2", HostBrowse.OTHER_SESSIONS_NAME),
                            snap.projects.map { it.name },
                            "the project file, a connected desktop's slice with no file, and the sessions nobody names"
                        )
                        assertTrue(snap.projects.all { it.drivenRemotely && it.sshTarget == null })
                        val drv = snap.projects[0]
                        assertEquals("project-drv", drv.id, "the desktop's project id, which its slice is named by")
                        assertEquals(remoteRepo.path, drv.cwd)
                        assertEquals(listOf("term-r-1", "term-r-2", "term-r-3"), drv.nodes.map { it.id })
                        assertEquals("c9", drv.board!!.columnOf("term-r-1"))
                        assertEquals(listOf("term-s-7"), snap.projects[1].nodes.map { it.id })
                        assertEquals(listOf("term-g-1"), snap.projects[2].nodes.map { it.id }, "a stale slice names no project")

                        assertTrue(snap.isLive("term-r-1") && snap.isLive("term-r-2") && snap.isLive("term-g-1"))
                        assertFalse(snap.isLive("term-r-3"))
                        assertEquals("nodeterm-rmt", snap.socketOf("term-r-1"))
                        assertEquals(AgentState.WORKING, snap.statusOf("term-r-1")!!.state)
                        assertEquals(AgentState.DONE, snap.statusOf("term-s-7")!!.state)
                        assertNull(snap.statusOf("term-g-1"), "a slice older than twice the heartbeat is no data")
                        assertEquals(listOf("ev-r1"), snap.status!!.inbox!!.events.map { it.id })
                        assertEquals("plan", snap.status!!.settings!!.claudePermissionMode, "the slice carries the host's settings")

                        // What needs nodeterm the app is that OTHER desktop's.
                        assertTrue(NewSessionChoice.offeredProjects(snap).isEmpty())
                        assertIs<LegRouting.Leg.Unavailable>(
                            LegRouting.forProject(Capability.BOARD_WRITES, drv, LegRouting.Leg.Relay)
                        )

                        // The session runs HERE, on nodeterm-rmt: attach, type, read its pane.
                        val sink = Sink()
                        val stream = conn.attach("term-r-1", 100, 30, sink)
                        assertFalse(stream.fresh)
                        Thread.sleep(400)
                        stream.write("echo rmt_\$((6*7))\r")
                        sink.waitFor("rmt_42")
                        assertTrue(waitForPane("nodeterm-rmt", "nt-term-r-1", "rmt_42").contains("rmt_42"), "typed into the rmt session")
                        stream.detach()
                        Thread.sleep(300)
                        assertEquals(0, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-1").first, "detaching never ends it")

                        conn.sendKeys("term-r-2", "echo sk_rmt_\$((3*3))")
                        conn.sendKeys("term-r-2", "\r")
                        assertTrue(waitForPane("nodeterm-rmt", "nt-term-r-2", "sk_rmt_9").contains("sk_rmt_9"))
                        assertTrue(Pane.isShell(conn.paneCommand("term-r-2")), "the pane read reaches the rmt socket")

                        // Not running: only its own desktop starts it, and the phone's relay is not that
                        // desktop's, so there is nothing to offer — and nothing is created on either socket.
                        val e = assertFailsWith<HostException> { conn.attach("term-r-3", 80, 24, Sink()) }
                        assertFalse(e is NeedsRelayException)
                        assertEquals(SshHostConnection.DRIVEN_NOT_RUNNING, e.message)
                        // The same on a connection that has not listed yet (a redial, a terminal restored
                        // after the process died): the review of A27a.
                        connect().use { fresh ->
                            val e2 = assertFailsWith<HostException> { fresh.attach("term-r-3", 80, 24, Sink()) }
                            assertFalse(e2 is NeedsRelayException, "no relay offered on a connection that never listed")
                            assertEquals(SshHostConnection.DRIVEN_NOT_RUNNING, e2.message)
                        }
                        Thread.sleep(300)
                        assertEquals(1, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-3").first)
                        assertEquals(1, tmux("has-session", "-t", "=nt-term-r-3").first)

                        // The held approval and the read-ack are files on THIS computer, where the driving
                        // desktop's SSH answer path and ack sweep look for them.
                        val pending = File(dotNodeterm, "pending").apply { mkdirs() }
                        val ev = snap.status!!.inbox!!.events.single()
                        File(pending, "${ev.pendingId}.json").writeText("{}")
                        assertEquals(ApprovalOutcome.SENT, conn.answerApproval(ev, allow = true))
                        assertEquals("allow", File(pending, "${ev.pendingId}.answer").readText())
                        conn.ackRead("term-r-1", "ev-r1")
                        assertEquals("ev-r1", File(dotNodeterm, "acks/term-r-1.seen").readText())

                        // Ending it stops the rmt session and nothing on the host's own socket.
                        conn.killSession("term-r-2")
                        assertEquals(1, tmuxOn("nodeterm-rmt", "has-session", "-t", "=nt-term-r-2").first)
                        assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first)
                    }
                }
            }
        } finally {
            clearDrivenHost()
        }
    }

    @Test
    fun `with both sockets in use the host's own projects come first, and the paired desktop's SSH project stays its own (A09)`() = runBlocking<Unit> {
        val now = System.currentTimeMillis()
        // The paired desktop drives THIS computer as its SSH project "Server" (p2): that project's
        // file and session are here too, and must not turn into a second, directly reachable project.
        val selfSsh = File(root, "self-ssh/.nodeterm")
        try {
            layOutDrivenHost(now)
            selfSsh.mkdirs()
            File(selfSsh, "project.json").writeText(
                """{"version":1,"rev":1,"savedAt":"x","id":"p2","name":"Server again","color":"#000","viewport":{"x":0,"y":0,"zoom":1},
                   "nodes":[{"id":"term-b-2","kind":"terminal","title":"Remote","color":"#000","group":null,"position":{"x":0,"y":0},"size":{"width":1,"height":1}}]}"""
            )
            assertEquals(0, tmuxOn("nodeterm-rmt", "new-session", "-d", "-s", "nt-term-b-2", "-c", selfSsh.parentFile.path, *paneShell).first)
            // A name on BOTH sockets is the host's own session (first wins, as the desktop's sweep does).
            assertEquals(0, tmuxOn("nodeterm-rmt", "new-session", "-d", "-s", "nt-term-a-1", "-c", root.path, *paneShell).first)
            connect().use { conn ->
                val snap = conn.listProjects()
                assertEquals(
                    listOf("Repo", "Server", "Scratch", "Parked", "Remote repo", "project-live2", HostBrowse.OTHER_SESSIONS_NAME),
                    snap.projects.map { it.name }
                )
                assertEquals(listOf("term-g-1"), snap.projects.last().nodes.map { it.id }, "neither term-a-1 nor term-b-2 is an orphan")
                assertEquals("node-terminal", snap.socketOf("term-a-1"))
                assertEquals("nodeterm-rmt", snap.socketOf("term-r-1"))
                assertEquals(AgentState.WORKING, snap.statusOf("term-a-1")!!.state, "the host's own mirror")
                assertEquals(AgentState.WORKING, snap.statusOf("term-r-1")!!.state, "the slice")

                // The desktop's own SSH project: still reached through the desktop.
                val e = assertFailsWith<NeedsRelayException> { conn.attach("term-b-2", 80, 24, Sink()) }
                assertTrue(e.message!!.contains("me@box"), e.message)

                // term-a-1 is attached on node-terminal, never on the rmt session of the same name.
                val sink = Sink()
                val stream = conn.attach("term-a-1", 100, 30, sink)
                Thread.sleep(400)
                stream.write("echo own_\$((4*4))\r")
                sink.waitFor("own_16")
                assertTrue(waitForPane("node-terminal", "nt-term-a-1", "own_16").contains("own_16"))
                assertFalse(tmuxOn("nodeterm-rmt", "capture-pane", "-p", "-t", "=nt-term-a-1:").second.contains("own_16"))
                stream.detach()
            }
        } finally {
            clearDrivenHost()
            selfSsh.parentFile.deleteRecursively()
        }
    }

    @Test
    fun `a Server Edition's data dir is found, and its install metadata read`() = runBlocking<Unit> {
        val data = File(home, ".nodeterm-server").apply { mkdirs() }
        File(data, "workspace.json").writeText(
            """{"version":3,"activeProjectId":"p1","entries":[{"id":"p1","name":"Served repo","color":"#0a84ff","cwd":"${repo.path}"}]}"""
        )
        File(data, "agent-status.json").writeText(
            """{"v":1,"updatedAt":1,"nodes":{"term-a-1":{"state":"done","agentId":"claude","updatedAt":5}},
               "server":{"version":"0.2.17","commit":"1e56f83","installedAt":"2026-09-01T10:00:00.000Z"}}"""
        )
        try {
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val snap = conn.listProjects()
                        assertEquals(listOf("Served repo"), snap.projects.map { it.name })
                        assertEquals(listOf("term-a-1"), snap.projects.single().nodes.map { it.id })
                        assertFalse(snap.projects.single().drivenRemotely)
                        assertEquals(AgentState.DONE, snap.statusOf("term-a-1")!!.state)
                        assertEquals("nodeterm server 0.2.17 · 1e56f83 · installed 2026-09-01", snap.status!!.server!!.describe())
                    }
                }
            }
        } finally {
            data.deleteRecursively()
        }
    }

    @Test
    fun `nothing of nodeterm's found is an error that says where it looked, not an empty computer`() = runBlocking<Unit> {
        withoutOwnData {
            runBlocking {
                connect().use { conn ->
                    val e = assertFailsWith<NothingFoundException> { conn.listProjects() }
                    assertEquals(SshHostConnection.NO_USER_DATA, e.message)
                    assertTrue(e.message!!.contains("~/.nodeterm-server") && e.message!!.contains("--data-dir"), e.message)
                    // The relay is offered only to a phone that holds a relay leg (the review of A27b):
                    // a computer added by its SSH address never has one.
                    for (leg in LegRouting.RelayLeg.entries) {
                        val said = e.said(leg)
                        assertTrue(said.startsWith(SshHostConnection.NOT_FOUND), "$leg: $said")
                        val offered = leg == LegRouting.RelayLeg.AVAILABLE || leg == LegRouting.RelayLeg.ROUTE_SSH_ONLY
                        assertEquals(offered, said.contains("relay"), "$leg: $said")
                    }
                    assertTrue(e.said(LegRouting.RelayLeg.ADDED_OVER_SSH).contains("added as the user"))
                }
            }
        }
    }

    @Test
    fun `a computer a desktop drove once, where only its stale slices remain, is still nothing found`() = runBlocking<Unit> {
        // The review of A27a: the desktop never deletes ~/.nodeterm/agent-status-<projectId>.json, so
        // once a desktop has driven a computer its slices stay. Old ones are no data, and must not
        // turn "not found, here is where the phone looked" into an empty computer.
        val old = System.currentTimeMillis() - 10 * 60_000
        dotNodeterm.mkdirs()
        File(dotNodeterm, "agent-status-project-gone.json").writeText(
            """{"v":1,"updatedAt":$old,"nodes":{"term-g-1":{"state":"blocked","agentId":"claude","updatedAt":$old}}}"""
        )
        try {
            withoutOwnData {
                runBlocking {
                    connect().use { conn ->
                        val e = assertFailsWith<HostException> { conn.listProjects() }
                        assertEquals(SshHostConnection.NO_USER_DATA, e.message)
                    }
                }
            }
        } finally {
            clearDrivenHost()
        }
    }

    @Test
    fun `the host key is pinned on first use and a changed key is refused`() {
        val pin = MemoryPin()
        connect(pin).close()
        assertTrue(pin.value!!.startsWith("SHA256:"))
        connect(pin).close()
        assertFailsWith<HostKeyChangedException> { connect(MemoryPin("SHA256:not-this-host")) }
    }

    @Test
    fun `a server that refuses our key never becomes the pin (A49)`() {
        // What answers at the paired address after the DHCP lease moved, or on another network that
        // uses the same private range: an sshd that completes the key exchange and then refuses the
        // phone's key. Pinning its host key during the exchange made the real computer "changed" on
        // the next connect.
        val pin = MemoryPin()
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "dev", SshIdentity.generate(), pin).close()
        }
        assertNull(pin.value, "a key exchange whose authentication failed must not pin")
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "someone-else", identity, pin).close()
        }
        assertNull(pin.value, "a refused user must not pin either")
        // The first connect that AUTHENTICATES pins exactly the server's host key.
        connect(pin).close()
        val serverKey = server.keyPairProvider.loadKeys(null).first().public
        assertEquals(SshHostConnection.fingerprint(serverKey), pin.value)
    }

    @Test
    fun `a first connect must present a key the pairing named, refused before our key is offered (A49-anchor)`() {
        val serverFp = SshHostConnection.fingerprint(server.keyPairProvider.loadKeys(null).first().public)
        val stranger = "SHA256:" + "A".repeat(43)
        // The computer named other keys at pairing: whatever answers here is not one of them.
        val pin = MemoryPin(paired = listOf(stranger))
        val before = authAttempts.get()
        val refused = assertFailsWith<HostKeyNotPairedException> { connect(pin).close() }
        assertNull(pin.value, "a key the pairing did not name must never become the pin")
        assertEquals(before, authAttempts.get(), "the phone's key must not be offered to a server the pairing did not name")
        assertEquals(serverFp, refused.actual)
        assertEquals(listOf(stranger), refused.paired)
        assertTrue(refused.message!!.contains("the computer reported to this phone (when it was paired, or since through the relay)"), refused.message)
        // A HostKeyChangedException, so SshFallback refuses SSH and in Auto still tries the relay.
        assertIs<HostKeyChangedException>(refused)

        // The computer named this server's key among others: it connects and pins exactly that key.
        val anchored = MemoryPin(paired = listOf(stranger, serverFp))
        connect(anchored).close()
        assertEquals(serverFp, anchored.value)
        // Later connects verify the pin, as they always did.
        connect(anchored).close()
    }

    @Test
    fun `a key the computer does not know is refused`() {
        assertFailsWith<HostException> {
            SshHostConnection.connect("127.0.0.1", port, "dev", SshIdentity.generate(), MemoryPin()).close()
        }
        // …and the same session was never at risk.
        assertEquals(0, tmux("has-session", "-t", "=nt-term-a-1").first)
        TimeUnit.MILLISECONDS.sleep(1)
    }
}
