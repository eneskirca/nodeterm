package dev.nodeterm.protocol

import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.ssh.SshPasswordBootstrap
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Actual POSIX command, private synthetic HOME only; never a live login or key store. */
class SshPasswordInstallTest {
    private val identity = SshIdentity.fromSeed(ByteArray(32) { (it + 6).toByte() })

    private fun run(home: File, path: String = "/usr/bin:/bin"): Int {
        val pb = ProcessBuilder("/bin/sh", "-c", SshPasswordBootstrap.installCommand(identity)).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to path))
        val p = pb.start()
        assertEquals(true, p.waitFor(5, TimeUnit.SECONDS), "Command must refuse unsafe nonregular files without waiting on them")
        p.inputStream.readBytes()
        return p.exitValue()
    }

    @Test fun `automatic install refuses linked directory and key file without changing their targets`() {
        val root = Files.createTempDirectory("nt-enroll-unsafe-").toFile()
        try {
            val home = File(root, "home").apply { mkdir() }
            val outside = File(root, "outside").apply { mkdir() }
            val keys = File(outside, "authorized_keys").apply { writeText("sentinel-key\n") }
            Files.createSymbolicLink(File(home, ".ssh").toPath(), outside.toPath())
            assertEquals(2, run(home))
            assertEquals("sentinel-key\n", keys.readText())
            File(home, ".ssh").delete()
            File(home, ".ssh").mkdir()
            Files.createSymbolicLink(File(home, ".ssh/authorized_keys").toPath(), keys.toPath())
            assertEquals(2, run(home))
            assertEquals("sentinel-key\n", keys.readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun `automatic install refuses nonregular and multiply-linked key files`() {
        val root = Files.createTempDirectory("nt-enroll-type-").toFile()
        try {
            val ssh = File(root, ".ssh").apply { mkdir() }
            val keys = File(ssh, "authorized_keys").apply { mkdir() }
            assertEquals(2, run(root))
            keys.delete()
            val other = File(root, "other").apply { writeText("hardlink-sentinel\n") }
            Files.createLink(keys.toPath(), other.toPath())
            assertEquals(2, run(root))
            assertEquals("hardlink-sentinel\n", other.readText())
            keys.delete()
            val mkfifo = ProcessBuilder("mkfifo", keys.path).start()
            assertEquals(0, mkfifo.waitFor())
            assertEquals(2, run(root))
        } finally { root.deleteRecursively() }
    }

    @Test fun `automatic install refuses foreign owner metadata before altering permissions or key contents`() {
        val root = Files.createTempDirectory("nt-enroll-owner-").toFile()
        try {
            val ssh = File(root, ".ssh").apply { mkdir() }
            val keys = File(ssh, "authorized_keys").apply { writeText("owner-sentinel\n") }
            val bin = File(root, "bin").apply { mkdir() }
            // Inert stat OS boundary: actual files stay owned by the test account. No chown privilege
            // or another user's files are needed to exercise foreign-owner refusal.
            File(bin, "stat").apply { writeText("#!/bin/sh\nprintf '999999\\n'\n"); setExecutable(true) }
            assertEquals(2, run(root, bin.path + ":/usr/bin:/bin"))
            assertEquals("owner-sentinel\n", keys.readText())
            assertFalse(keys.readText().contains("nodeterm-android"))
        } finally { root.deleteRecursively() }
    }

    @Test fun `comments and another keys trailing comment do not suppress retained-key installation`() {
        for (prefix in listOf("# " + identity.authorizedKeysLine("comment-only"),
            SshIdentity.generate().authorizedKeysLine("other-key") + " " + identity.authorizedKeysLine("trailing-note"))) {
            val root = Files.createTempDirectory("nt-enroll-comment-").toFile()
            try {
                val keys = File(root, ".ssh").apply { mkdir() }.resolve("authorized_keys")
                keys.writeText(prefix + "\n")
                assertEquals(0, run(root))
                assertEquals(prefix + "\n" + identity.authorizedKeysLine() + "\n", keys.readText())
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun `an existing restricted key with quoted and escaped options stays restricted without a duplicate`() {
        val root = Files.createTempDirectory("nt-enroll-options-").toFile()
        try {
            val keys = File(root, ".ssh").apply { mkdir() }.resolve("authorized_keys")
            val existing = "command=\"printf \\\"fixture only\\\"\",restrict " + identity.authorizedKeysLine("restricted") + "\n"
            keys.writeText(existing)
            assertEquals(0, run(root))
            assertEquals(existing, keys.readText(), "Never append unrestricted authorization around a retained key's restrictions")
            keys.writeText("command=\"unterminated " + identity.authorizedKeysLine() + "\n")
            assertEquals(2, run(root), "Ambiguous options must refuse without modifying authorization")
            assertEquals("command=\"unterminated " + identity.authorizedKeysLine() + "\n", keys.readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun `own inspection deadline is a visible error but outer cancellation propagates and both close the dial socket`() = runBlocking<Unit> {
        val address = ManualHost.Address("127.0.0.1", 1, "fixture", "Fixture")
        val own = BlockingSockets()
        // Cold SSHJ/provider initialization is not socket admission. Give it a realistic budget,
        // and prove this attempt actually entered the blocking dial before checking cleanup.
        val ownAttempt = async { runCatching { SshPasswordBootstrap.inspect(address, 3000, own) } }
        withTimeout(5000) { own.admitted.await() }
        val e = assertFailsWith<HostException> { ownAttempt.await().getOrThrow() }
        assertTrue(e.message!!.contains("timed out"))
        assertTrue(own.opened.isNotEmpty() && own.opened.all { it.isClosed })
        val outer = BlockingSockets()
        val outerAttempt = async { runCatching {
            coroutineScope {
                val inspection = async { SshPasswordBootstrap.inspect(address, 10_000, outer) }
                withTimeout(5000) { outer.admitted.await() }
                // Start the external wait's deadline after admission. Its failure cancels the
                // enclosing scope and therefore the actual in-flight inspection child.
                withTimeout(100) { inspection.await() }
            }
        } }
        assertFailsWith<TimeoutCancellationException> { outerAttempt.await().getOrThrow() }
        assertTrue(outer.opened.isNotEmpty() && outer.opened.all { it.isClosed })
    }

    /** Inert socket boundary, modeling a blocking dial that ignores thread interruption. */
    private class BlockingSockets : SocketFactory() {
        val opened = CopyOnWriteArrayList<Socket>()
        val admitted = CompletableDeferred<Unit>()
        override fun createSocket(): Socket = object : Socket() {
            private val closed = CountDownLatch(1)
            override fun connect(endpoint: SocketAddress, timeout: Int) {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (closed.count != 0L && System.nanoTime() < deadline) {
                    try { closed.await(10, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { /* close owns cancellation */ }
                }
                throw SocketException("fixture closed dial")
            }
            override fun close() { super.close(); closed.countDown() }
        }.also { opened += it; admitted.complete(Unit) }
        override fun createSocket(host: String, port: Int): Socket = error("unused socket overload")
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = error("unused socket overload")
        override fun createSocket(host: InetAddress, port: Int): Socket = error("unused socket overload")
        override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket = error("unused socket overload")
    }
}
