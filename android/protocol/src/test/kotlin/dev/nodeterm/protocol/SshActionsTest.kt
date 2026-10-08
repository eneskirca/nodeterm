package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.*
import dev.nodeterm.protocol.model.*
import dev.nodeterm.protocol.ssh.SshActions
import dev.nodeterm.protocol.ssh.SshActionsScripts
import kotlinx.serialization.json.*
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.*

class SshActionsTest {
    private val instance = "10000000-0000-4000-8000-000000000001"
    private val nonce = "20000000-0000-4000-8000-000000000002"
    private val now = 1_700_000_000_000L
    private fun raw(at: Long = now, remote: Boolean = true, methods: Set<String> = SshActions.ALL) = buildJsonObject {
        put("version", 1); put("instance", instance); put("pid", 10); put("updatedAt", at)
        put("methods", JsonArray(methods.map(::JsonPrimitive))); put("remoteProjects", remote)
    }.toString()
    private fun advert(at: Long = now, remote: Boolean = true, methods: Set<String> = SshActions.ALL) =
        SshActions.parseAdvertisement("NT-ACTIONS-1\t$now\n${raw(at, remote, methods)}\n")!!
    private fun response(n: String = nonce, i: String = instance, extra: String = "\"ok\":true,\"result\":{\"delivered\":true}") =
        "{\"version\":1,\"instance\":\"$i\",\"nonce\":\"$n\",$extra}"
    private fun node(id: String = "term-1") = NodeInfo(id, NodeKind.TERMINAL, "T", null, null, null, null, null, null, null, null)
    private fun project(remote: String? = null, driven: Boolean = false, nodes: List<NodeInfo> = listOf(node())) =
        ProjectInfo("project-1", "P", null, "/project", remote, false, nodes, null, drivenRemotely = driven)

    @Test fun `advertisements need exact version instance owner and a current host-clock heartbeat`() {
        assertNotNull(SshActions.parseAdvertisement("NT-ACTIONS-1\t$now\n${raw()}"))
        for (bad in listOf(raw(now - 15001), raw(now + 30001), raw().replace(instance, "not-uuid"),
            raw().replace("\"pid\":10", "\"pid\":0"), raw().replace("\"version\":1", "\"version\":\"1\""),
            raw().replace("\"updatedAt\":$now", "\"updatedAt\":\"$now\""))) {
            assertNull(SshActions.parseAdvertisement("NT-ACTIONS-1\t$now\n$bad"), bad)
        }
        assertNull(SshActions.parseAdvertisement("wrong\t$now\n${raw()}"))
    }
    @Test fun `capabilities are advertised as complete groups and registration stays unavailable`() {
        var value = raw(methods = setOf("node.wake"))
        val a = SshActions { _, _, _, _, _ -> 0 to "NT-ACTIONS-1\t$now\n$value" }
        a.probe("/profile")
        assertFalse(a.capabilities.nodeActions); assertFalse(a.capabilities.boardWrites); assertFalse(a.capabilities.registerNode)
        value = raw(); a.probe("/profile")
        assertTrue(a.capabilities.nodeActions); assertTrue(a.capabilities.boardWrites)
        a.clear(); assertFalse(a.capabilities.boardWrites)
        value = raw(now - 15000); a.probe("/profile"); assertFalse(a.capabilities.nodeActions)
    }
    @Test fun `a request keeps one nonce and the advertisement timestamp across upload`() {
        var writes = 0
        val a = SshActions { _, timeout, input, write, limit ->
            if (input == null) 0 to "NT-ACTIONS-1\t$now\n${raw()}" else {
                writes++; assertTrue(write); assertEquals(20L, timeout); assertEquals(131200, limit)
                val request = Json.parseToJsonElement(input).jsonObject
                assertEquals(now, request.getValue("issuedAt").jsonPrimitive.long)
                assertEquals(instance, request.getValue("instance").jsonPrimitive.content)
                val n = request.getValue("nonce").jsonPrimitive.content; assertTrue(SshActions.UUID.matches(n))
                0 to "NT-ACTIONS-REPLY\n${response(n)}\n"
            }
        }
        assertEquals(true, a.call("/profile", "node.wake", buildJsonObject { put("nodeId", "term-1") }, "term-1") { true }.jsonObject["delivered"]?.jsonPrimitive?.boolean)
        assertEquals(1, writes)
    }
    @Test fun `unavailable capability or ownership is refused before a write`() {
        for ((methods, owns) in listOf(emptySet<String>() to true, SshActions.ALL to false)) {
            var writes = 0
            val a = SshActions { _, _, input, _, _ -> if (input != null) { writes++; 0 to "" } else 0 to "NT-ACTIONS-1\t$now\n${raw(methods = methods)}" }
            assertFailsWith<NeedsRelayException> { a.call("/profile", "node.wake", JsonObject(emptyMap()), "term-1") { owns } }
            assertEquals(0, writes)
        }
    }
    @Test fun `after submission unanswered outcomes never become relay fallback or an automatic retry`() {
        for (out in listOf(null to "", 4 to "NT-ACTIONS-UNCERTAIN", 0 to "bad", 3 to "other refusal")) {
            var writes = 0
            val a = SshActions { _, _, input, _, _ -> if (input == null) 0 to "NT-ACTIONS-1\t$now\n${raw()}" else { writes++; out } }
            assertFailsWith<HostUnansweredException> { a.call("/profile", "node.wake", JsonObject(emptyMap()), "term-1") { true } }
            assertEquals(1, writes)
        }
    }
    @Test fun `a confirmed prepublication descriptor refusal remains safe for relay`() {
        val a = SshActions { _, _, input, _, _ -> if (input == null) 0 to "NT-ACTIONS-1\t$now\n${raw()}" else 3 to SshActionsScripts.UNAVAILABLE }
        assertFailsWith<NeedsRelayException> { a.call("/profile", "node.wake", JsonObject(emptyMap()), "term-1") { true } }
        assertFalse(a.capabilities.nodeActions)
    }
    @Test fun `reply identity shape and uncertainty must be confirmed while a real refusal is an answer`() {
        for (bad in listOf(response(i = nonce), response(n = instance), response().replace("\"version\":1", "\"version\":2"),
            response(extra = "\"ok\":true"), response(extra = "\"ok\":true,\"result\":{},\"uncertain\":true"),
            response(extra = "\"ok\":\"true\",\"result\":{}"), "x".repeat(131073))) {
            assertFailsWith<HostUnansweredException> { SshActions.parseResponse(bad, instance, nonce) }
        }
        val e = assertFailsWith<HostException> { SshActions.parseResponse(response(extra = "\"ok\":false,\"error\":\"Owned node not found\""), instance, nonce) }
        assertFalse(e is HostUnansweredException); assertEquals("Owned node not found", e.message)
    }
    @Test fun `profile ownership excludes driven synthetic duplicate and foreign nodes but permits desktop SSH refs`() {
        assertTrue(SshActions.owns(listOf(project()), "project-1", "term-1", advert()))
        assertTrue(SshActions.owns(listOf(project("user@other")), "project-1", "term-1", advert()))
        assertFalse(SshActions.owns(listOf(project("user@other")), "project-1", "term-1", advert(remote = false)))
        assertFalse(SshActions.owns(listOf(project(driven = true)), "project-1", "term-1", advert()))
        assertFalse(SshActions.owns(listOf(project()), "foreign", "term-1", advert()))
        assertFalse(SshActions.owns(listOf(project()), "project-1", "missing", advert()))
        assertFalse(SshActions.owns(listOf(project(), project()), "project-1", "term-1", advert()))
        assertFalse(SshActions.owns(listOf(project(nodes = listOf(node(), node()))), "project-1", "term-1", advert()))
    }
    @Test fun `request size is limited before dispatch`() {
        var writes = 0
        val a = SshActions { _, _, input, _, _ -> if (input != null) { writes++; 0 to "" } else 0 to "NT-ACTIONS-1\t$now\n${raw()}" }
        assertFailsWith<IllegalArgumentException> { a.call("/profile", "node.rename", buildJsonObject { put("title", "é".repeat(70000)) }, "term-1") { true } }
        assertEquals(0, writes)
    }

    private fun posix() = assumeTrue(!System.getProperty("os.name").startsWith("Windows"), "SSH companion scripts need a POSIX filesystem host")
    private fun File.privateDir(): File = apply { mkdirs(); Files.setPosixFilePermissions(toPath(), PosixFilePermissions.fromString("rwx------")) }
    private fun File.privateFile(text: String): File = apply { writeText(text); Files.setPosixFilePermissions(toPath(), PosixFilePermissions.fromString("rw-------")) }
    private fun fixture(body: (File, File, File) -> Unit) {
        posix(); val home = Files.createTempDirectory("nt-ssh-actions-").toFile()
        try {
            val ud = File(home, "profile '$ quoted").privateDir()
            val root = File(ud, "ssh-actions").privateDir(); val dir = File(root, instance).privateDir()
            File(root, "advertisement.json").privateFile(raw(System.currentTimeMillis()))
            body(ud, root, dir)
        } finally { home.deleteRecursively() }
    }
    private fun shell(script: String): Process = ProcessBuilder("/bin/sh", "-c", script).apply {
        environment().clear(); environment()["PATH"] = "/usr/bin:/bin"
    }.start()
    private fun finish(p: Process): Pair<Int, String> {
        assertTrue(p.waitFor(5, TimeUnit.SECONDS), "shell did not finish")
        val error = p.errorStream.bufferedReader().readText()
        val output = p.inputStream.bufferedReader().readText()
        assertTrue(error.isBlank(), error)
        return p.exitValue() to output
    }
    private fun liveAd(ud: File): SshActions.Advertisement {
        val p = shell(SshActionsScripts.probe(ud.path)); p.outputStream.close()
        val (exit, out) = finish(p); assertEquals(0, exit, out)
        return SshActions.parseAdvertisement(out)!!
    }
    @Test fun `real shell probes only the selected quoted private profile and refuses symlinks modes and oversized files`() = fixture { ud, root, _ ->
        val ad = File(root, "advertisement.json"); val raw = ad.readText()
        assertEquals(instance, liveAd(ud).instance)
        for (bad in listOf("symlink", "world-readable", "hardlink", "oversize", "unsafe-profile")) {
            ad.delete(); ad.privateFile(raw); Files.setPosixFilePermissions(ud.toPath(), PosixFilePermissions.fromString("rwx------"))
            val other = File(root, "other"); other.delete()
            when (bad) {
                "symlink" -> { ad.delete(); other.privateFile(raw); Files.createSymbolicLink(ad.toPath(), other.toPath()) }
                "world-readable" -> Files.setPosixFilePermissions(ad.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
                "hardlink" -> Files.createLink(other.toPath(), ad.toPath())
                "oversize" -> ad.privateFile("x".repeat(131073))
                "unsafe-profile" -> Files.setPosixFilePermissions(ud.toPath(), PosixFilePermissions.fromString("rwxrwx---"))
            }
            val p = shell(SshActionsScripts.probe(ud.path)); p.outputStream.close()
            assertEquals(3, finish(p).first, bad)
        }
    }
    @Test fun `real upload checks the descriptor again after stdin without treating heartbeats as restarts`() = fixture { ud, root, dir ->
        for (restart in listOf(false, true)) {
            dir.listFiles()!!.forEach { it.delete() }
            File(root, "advertisement.json").privateFile(raw(System.currentTimeMillis()))
            val a = liveAd(ud); val p = shell(SshActionsScripts.submit(ud.path, a, nonce))
            p.outputStream.write("{\"partial\":".toByteArray()); p.outputStream.flush()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (dir.listFiles()!!.none { it.name.endsWith(".upload") }) { assertTrue(System.nanoTime() < deadline); Thread.sleep(5) }
            File(root, "advertisement.json").privateFile(raw(System.currentTimeMillis()).let { if (restart) it.replace(instance, this.nonce) else it })
            val producer = if (!restart) thread {
                val request = File(dir, "$nonce.request")
                while (!request.exists() && System.nanoTime() < deadline) Thread.sleep(5)
                assertTrue(request.exists()); File(dir, "$nonce.response").privateFile(response())
            } else null
            p.outputStream.use { it.write("true}".toByteArray()) }
            val (code, out) = finish(p); producer?.join()
            assertEquals(if (restart) 3 else 0, code, out)
            if (restart) assertFalse(File(dir, "$nonce.request").exists()) else assertTrue(out.startsWith("NT-ACTIONS-REPLY\n"))
            assertTrue(dir.listFiles()!!.none { it.name.endsWith(".upload") })
        }
    }
    @Test fun `real publication never replaces an existing nonce and rejects unsafe responses`() = fixture { ud, _, dir ->
        val ad = liveAd(ud)
        File(dir, "$nonce.request").privateFile("original")
        val collision = shell(SshActionsScripts.submit(ud.path, ad, nonce)); collision.outputStream.use { it.write("replacement".toByteArray()) }
        assertEquals(4, finish(collision).first); assertEquals("original", File(dir, "$nonce.request").readText())
        File(dir, "$nonce.request").delete()
        val p = shell(SshActionsScripts.submit(ud.path, ad, nonce))
        val producer = thread {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
            while (!File(dir, "$nonce.request").exists() && System.nanoTime() < deadline) Thread.sleep(5)
            Files.createSymbolicLink(File(dir, "$nonce.response").toPath(), File(dir, "$nonce.request").toPath())
        }
        p.outputStream.use { it.write("{}".toByteArray()) }
        assertEquals(4, finish(p).first); producer.join()
    }
}
