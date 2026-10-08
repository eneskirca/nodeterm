package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.ssh.SshHostConnection
import dev.nodeterm.protocol.ssh.SshPasswordBootstrap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.apache.sshd.common.keyprovider.KeyPairProvider
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.auth.keyboard.InteractiveChallenge
import org.apache.sshd.server.auth.keyboard.KeyboardInteractiveAuthenticator
import org.apache.sshd.server.auth.password.PasswordAuthenticator
import org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.command.CommandFactory
import org.apache.sshd.server.config.keys.AuthorizedKeysAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.apache.sshd.server.session.ServerSession
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.PublicKey
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** Real MINA authentication and real /bin/sh installation in a fresh private HOME, never user files. */
class SshPasswordBootstrapTest {
    private val identity = SshIdentity.fromSeed(ByteArray(32) { (it + 9).toByte() })

    private class Fixture : Closeable {
        val root = Files.createTempDirectory("nt-ssh-enroll-").toFile()
        val home = File(root, "home").apply { mkdir() }
        val keys get() = File(home, ".ssh/authorized_keys")
        val passwordCalls = AtomicInteger()
        val keyCalls = AtomicInteger()
        val interactiveCalls = AtomicInteger()
        val commandCalls = AtomicInteger()
        val commandStarted = CompletableDeferred<Unit>()
        val keyStarted = CompletableDeferred<Unit>()
        val authStarted = CompletableDeferred<Unit>()
        var omitExit = false
        var rejectKey = false
        var replaceHostKey = false
        var authDelayMs = 0L
        var commandDelayMs = 0L
        var keyDelayMs = 0L
        var stderrBytes = 0
        val sessions = CopyOnWriteArrayList<ServerSession>()
        private val first = SimpleGeneratorHostKeyProvider(File(root, "host.ser").toPath())
        private val other = SimpleGeneratorHostKeyProvider(File(root, "other-host.ser").toPath())
        private var provider: KeyPairProvider = first
        val sshd = SshServer.setUpDefaultServer().apply {
            host = "127.0.0.1"
            port = 0
            keyPairProvider = KeyPairProvider { session -> provider.loadKeys(session) }
            passwordAuthenticator = PasswordAuthenticator { user, password, session ->
                sessions += session
                passwordCalls.incrementAndGet()
                authStarted.complete(Unit)
                if (authDelayMs > 0) Thread.sleep(authDelayMs)
                user == "dev" && password == "fixture-password"
            }
            val actual = object : AuthorizedKeysAuthenticator(File(home, ".ssh/authorized_keys").toPath()) {
                override fun isValidUsername(username: String?, session: ServerSession?) = username == "dev"
            }
            publickeyAuthenticator = PublickeyAuthenticator { user, key, session ->
                keyCalls.incrementAndGet()
                keyStarted.complete(Unit)
                if (keyDelayMs > 0) Thread.sleep(keyDelayMs)
                !rejectKey && actual.authenticate(user, key, session)
            }
            keyboardInteractiveAuthenticator = object : KeyboardInteractiveAuthenticator {
                override fun generateChallenge(session: ServerSession, username: String, lang: String, subMethods: String): InteractiveChallenge {
                    interactiveCalls.incrementAndGet()
                    return InteractiveChallenge().apply { addPrompt("Fixture MFA", false) }
                }
                override fun authenticate(session: ServerSession, username: String, responses: MutableList<String>): Boolean = true
            }
            commandFactory = CommandFactory { _, command -> Shell(command) }
            try { start() } catch (e: Exception) { root.deleteRecursively(); throw e }
        }
        val address get() = ManualHost.Address("127.0.0.1", sshd.port, "dev", "Enrollment fixture")
        fun fingerprint(): String = SshHostConnection.hostKeyFingerprint(provider.loadKeys(null).first().public)

        private inner class Shell(private val command: String) : Command {
            private lateinit var output: OutputStream
            private lateinit var error: OutputStream
            private lateinit var exit: ExitCallback
            private var process: Process? = null
            private var worker: Thread? = null
            override fun setInputStream(input: InputStream) = Unit
            override fun setOutputStream(out: OutputStream) { output = out }
            override fun setErrorStream(err: OutputStream) { error = err }
            override fun setExitCallback(callback: ExitCallback) { exit = callback }
            override fun start(channel: ChannelSession, env: Environment) {
                commandCalls.incrementAndGet()
                commandStarted.complete(Unit)
                worker = Thread {
                    try {
                        if (commandDelayMs > 0) Thread.sleep(commandDelayMs)
                        if (stderrBytes > 0) { error.write(ByteArray(stderrBytes) { 120 }); error.flush() }
                        val pb = ProcessBuilder("/bin/sh", "-c", command).directory(home)
                        pb.environment().clear()
                        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin"))
                        val p = pb.start()
                        process = p
                        p.outputStream.close()
                        val errReader = Thread { runCatching { p.errorStream.copyTo(error) } }.apply { isDaemon = true; start() }
                        p.inputStream.copyTo(output)
                        val code = p.waitFor()
                        errReader.join(2000)
                        if (replaceHostKey) provider = other
                        if (omitExit) channel.close(false) else exit.onExit(code)
                    } catch (_: InterruptedException) {
                        channel.close(true)
                    } finally {
                        process?.destroyForcibly()
                    }
                }.apply { isDaemon = true; start() }
            }
            override fun destroy(channel: ChannelSession) { worker?.interrupt(); process?.destroyForcibly() }
        }
        override fun close() {
            sshd.stop(true)
            root.deleteRecursively()
        }
    }

    private suspend fun Fixture.confirm() = SshPasswordBootstrap.inspect(address).let { it.confirm(it.fingerprint) }
    private fun password() = "fixture-password".toCharArray()

    @Test fun `inspection sends no authentication and confirmation must match its exact fingerprint`() = runBlocking<Unit> {
        Fixture().use { host ->
            val inspection = SshPasswordBootstrap.inspect(host.address)
            assertEquals(host.fingerprint(), inspection.fingerprint)
            assertEquals(host.address, inspection.address)
            assertEquals(0, host.passwordCalls.get())
            assertEquals(0, host.keyCalls.get())
            assertEquals(0, host.interactiveCalls.get())
            assertEquals(0, host.commandCalls.get())
            assertFalse(host.keys.exists())
            assertFailsWith<IllegalArgumentException> { inspection.confirm("SHA256:" + "A".repeat(43)) }
        }
    }

    @Test fun `enrollment preserves other keys, installs only retained public identity and proves a fresh pinned key login`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.keys.parentFile.mkdir()
            val otherKey = SshIdentity.generate().authorizedKeysLine("fixture-other")
            host.keys.writeText(otherKey) // No final LF: it must not concatenate keys.
            val secret = password()
            val record = SshPasswordBootstrap.install(host.confirm(), identity, secret, id = "ssh-fixture", now = 77)
            assertTrue(secret.all { it == '\u0000' })
            assertEquals("$otherKey\n${ManualHost.authorizedKeysLine(identity)}\n", host.keys.readText())
            assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(host.keys.parentFile.toPath())))
            assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(host.keys.toPath())))
            assertEquals(ManualHost.record(host.address, host.fingerprint(), "ssh-fixture", 77), record)
            assertEquals(1, host.passwordCalls.get())
            assertTrue(host.keyCalls.get() > 0, "Success requires an independent retained-key login")
            assertEquals(1, host.commandCalls.get())
            assertEquals(0, host.interactiveCalls.get())
            assertTrue(record.manual && record.relay == null)
            // A deliberately fresh user-confirmed attempt is safe and does not duplicate a key.
            SshPasswordBootstrap.install(host.confirm(), identity, password())
            assertEquals("$otherKey\n${ManualHost.authorizedKeysLine(identity)}\n", host.keys.readText())
        }
    }

    @Test fun `the same retained public key with another comment is not appended again`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.keys.parentFile.mkdir()
            val retained = identity.authorizedKeysLine("existing-device-comment") + "\n"
            host.keys.writeText(retained)
            SshPasswordBootstrap.install(host.confirm(), identity, password())
            assertEquals(retained, host.keys.readText())
        }
    }

    @Test fun `a changed host is refused before the password is offered`() = runBlocking<Unit> {
        Fixture().use { host ->
            val wrong = SshPasswordBootstrap.Inspection(host.address, "SHA256:" + "A".repeat(43)).confirm("SHA256:" + "A".repeat(43))
            val secret = password()
            assertFailsWith<HostKeyChangedException> { SshPasswordBootstrap.install(wrong, identity, secret) }
            assertTrue(secret.all { it == '\u0000' })
            assertEquals(0, host.passwordCalls.get())
            assertEquals(0, host.keyCalls.get())
            assertEquals(0, host.interactiveCalls.get())
            assertFalse(host.keys.exists())
        }
    }

    @Test fun `refused password does not fall back to keyboard interactive or install a key`() = runBlocking<Unit> {
        Fixture().use { host ->
            val secret = "wrong-private-password".toCharArray()
            val e = assertFailsWith<HostException> { SshPasswordBootstrap.install(host.confirm(), identity, secret) }
            assertFalse(e.message!!.contains("wrong-private-password"))
            assertTrue(e.message!!.contains("keyboard-interactive"))
            assertEquals(1, host.passwordCalls.get())
            assertEquals(0, host.interactiveCalls.get(), "This accepting MFA boundary must never be attempted")
            assertEquals(0, host.commandCalls.get())
            assertFalse(host.keys.exists())
            assertTrue(secret.all { it == '\u0000' })
        }
    }

    @Test fun `a confirmed write without exit acknowledgement is uncertain and cannot be replayed`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.omitExit = true
            val confirmed = host.confirm()
            val e = assertFailsWith<HostUnansweredException> { SshPasswordBootstrap.install(confirmed, identity, password()) }
            assertTrue(e.message!!.contains("may already be installed"))
            assertEquals(ManualHost.authorizedKeysLine(identity) + "\n", host.keys.readText())
            assertEquals(0, host.keyCalls.get())
            val secret = password()
            assertFailsWith<IllegalStateException> { SshPasswordBootstrap.install(confirmed, identity, secret) }
            assertTrue(secret.all { it == '\u0000' })
            assertEquals(1, host.commandCalls.get())
            assertEquals(1, host.passwordCalls.get())
        }
    }

    @Test fun `successful installation alone cannot return a record when retained-key login is refused`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.rejectKey = true
            val e = assertFailsWith<HostException> { SshPasswordBootstrap.install(host.confirm(), identity, password()) }
            assertTrue(e.message!!.contains("no computer was saved"))
            assertTrue(host.keyCalls.get() > 0)
            assertEquals(1, host.commandCalls.get())
            assertEquals(ManualHost.authorizedKeysLine(identity) + "\n", host.keys.readText())
        }
    }

    @Test fun `retained-key verification must present the original confirmed host fingerprint`() = runBlocking<Unit> {
        Fixture().use { host ->
            val original = host.fingerprint()
            host.replaceHostKey = true
            assertFailsWith<HostKeyChangedException> { SshPasswordBootstrap.install(host.confirm(), identity, password()) }
            assertNotEquals(original, host.fingerprint())
            assertEquals(1, host.passwordCalls.get())
            assertEquals(0, host.keyCalls.get(), "No retained key is offered to the changed host")
        }
    }

    @Test fun `own command timeout is uncertain, external cancellation propagates, both close owned sockets`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.commandDelayMs = 15_000
            val confirmed = host.confirm()
            val sockets = RecordingSockets()
            val attempt = async { runCatching { SshPasswordBootstrap.install(confirmed, identity, password(), timeoutMs = 3000, socketFactory = sockets) } }
            withTimeout(5000) { host.commandStarted.await() }
            val e = assertFailsWith<HostUnansweredException> { attempt.await().getOrThrow() }
            assertTrue(e.message!!.contains("will not be repeated"))
            assertTrue(sockets.opened.isNotEmpty() && sockets.opened.all { it.isClosed })
            assertFalse(host.keys.exists())
            assertEquals(1, host.commandCalls.get())
            assertFailsWith<IllegalStateException> { SshPasswordBootstrap.install(confirmed, identity, password()) }
        }
        Fixture().use { host ->
            host.commandDelayMs = 15_000
            val confirmed = host.confirm()
            val sockets = RecordingSockets()
            val attempt = async { runCatching {
                coroutineScope {
                    val enrollment = async { SshPasswordBootstrap.install(confirmed, identity, password(), socketFactory = sockets) }
                    withTimeout(5000) { host.commandStarted.await() }
                    withTimeout(100) { enrollment.await() }
                }
            } }
            assertFailsWith<TimeoutCancellationException> { attempt.await().getOrThrow() }
            assertTrue(sockets.opened.isNotEmpty() && sockets.opened.all { it.isClosed })
            assertFalse(host.keys.exists())
        }
    }

    @Test fun `cancellation during password or key verification closes resources and returns no record`() = runBlocking<Unit> {
        for (duringKey in listOf(false, true)) Fixture().use { host ->
            if (duringKey) host.keyDelayMs = 15_000 else host.authDelayMs = 15_000
            val confirmed = host.confirm()
            val sockets = RecordingSockets()
            val secret = password()
            val job = async { SshPasswordBootstrap.install(confirmed, identity, secret, socketFactory = sockets) }
            withTimeout(5000) { if (duringKey) host.keyStarted.await() else host.authStarted.await() }
            job.cancelAndJoin()
            assertTrue(secret.all { it == '\u0000' })
            assertTrue(sockets.opened.isNotEmpty() && sockets.opened.all { it.isClosed })
            assertEquals(if (duringKey) 1 else 0, host.commandCalls.get())
            assertEquals(duringKey, host.keys.exists())
        }
    }

    @Test fun `both command streams are bounded and server stderr never becomes a surfaced error`() = runBlocking<Unit> {
        Fixture().use { host ->
            host.stderrBytes = 16_384
            val e = assertFailsWith<HostUnansweredException> { SshPasswordBootstrap.install(host.confirm(), identity, password(), timeoutMs = 5000) }
            assertFalse(e.message!!.contains("x".repeat(32)))
            assertEquals(1, host.commandCalls.get())
            assertEquals(0, host.keyCalls.get())
        }
    }

    private class RecordingSockets : SocketFactory() {
        val opened = CopyOnWriteArrayList<Socket>()
        private fun record(socket: Socket): Socket = socket.also { opened += it }
        override fun createSocket() = record(Socket())
        override fun createSocket(host: String, port: Int) = record(Socket(host, port))
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) = record(Socket(host, port, local, localPort))
        override fun createSocket(host: InetAddress, port: Int) = record(Socket(host, port))
        override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) = record(Socket(host, port, local, localPort))
    }
}
