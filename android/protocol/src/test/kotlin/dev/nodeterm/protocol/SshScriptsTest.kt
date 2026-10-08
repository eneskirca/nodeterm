package dev.nodeterm.protocol

import dev.nodeterm.protocol.ssh.HostBrowse
import dev.nodeterm.protocol.ssh.SshScripts
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The generated shell run for real under `/bin/sh` against fake HOMEs laid out the way a desktop
 * lays them out — no SSH involved, so each case can have its own HOME.
 *
 * The browse runs whatever tmux it finds, read-only (`list-sessions`). Each run gets its own
 * `TMUX_TMPDIR` inside its HOME, so even that never reaches a tmux server a developer is using
 * (CLAUDE.md, "The test suite never touches a live tmux server").
 */
class SshScriptsTest {
    private fun sh(script: String, home: File, extraEnv: Map<String, String> = emptyMap()): String {
        val pb = ProcessBuilder("/bin/sh", "-c", script).redirectErrorStream(true)
        pb.environment().clear()
        val tmuxDir = File(home, ".tmux-sandbox").apply { mkdirs() }
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin", "TMUX_TMPDIR" to tmuxDir.path) + extraEnv)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        p.waitFor()
        return out
    }

    private fun udOf(home: File, env: Map<String, String> = emptyMap()): String =
        sh(SshScripts.browse(), home, env).lineSequence().first { it.startsWith("ud=") }.removePrefix("ud=")

    private fun freshHome(): File = Files.createTempDirectory("nt-home").toFile()

    @Test
    fun `the desktop's real userData dir (node-terminal) is found on Linux and macOS layouts`() {
        assumeTrue(File("/bin/sh").canExecute())
        // A02: the desktop's userData is named after package.json `name` = node-terminal.
        val linux = freshHome()
        File(linux, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(linux, ".config/node-terminal").path, udOf(linux))

        val mac = freshHome()
        File(mac, "Library/Application Support/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(mac, "Library/Application Support/node-terminal").path, udOf(mac))

        val xdg = freshHome()
        val cfg = File(xdg, "cfg")
        File(cfg, "node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(cfg, "node-terminal").path, udOf(xdg, mapOf("XDG_CONFIG_HOME" to cfg.path)))
        listOf(linux, mac, xdg).forEach { it.deleteRecursively() }
    }

    @Test
    fun `the legacy nodeterm spelling is a fallback, never preferred`() {
        assumeTrue(File("/bin/sh").canExecute())
        val legacy = freshHome()
        File(legacy, ".config/nodeterm").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(legacy, ".config/nodeterm").path, udOf(legacy))

        val both = freshHome()
        File(both, ".config/nodeterm").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        File(both, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(both, ".config/node-terminal").path, udOf(both))

        val none = freshHome()
        assertEquals("", udOf(none))
        listOf(legacy, both, none).forEach { it.deleteRecursively() }
    }

    // ---- Audit A27: the Server Edition's data dir, and what a driving desktop leaves here ----------

    @Test
    fun `the Server Edition's data dir is found after the desktop's, by any file it writes, and NODETERM_DATA_DIR first`() {
        assumeTrue(File("/bin/sh").canExecute())
        // Default dir, with a workspace; and a fresh install that has written only its install metadata.
        val server = freshHome()
        File(server, ".nodeterm-server").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(server, ".nodeterm-server").path, udOf(server))
        val fresh = freshHome()
        File(fresh, ".nodeterm-server").apply { mkdirs() }.resolve("install-meta.json").writeText("{}")
        assertEquals(File(fresh, ".nodeterm-server").path, udOf(fresh))

        // --data-dir / NODETERM_DATA_DIR: found when the SSH session carries it, before the default.
        val custom = freshHome()
        val elsewhere = File(custom, "srv data").apply { mkdirs() }
        elsewhere.resolve("agent-status.json").writeText("{}")
        File(custom, ".nodeterm-server").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(elsewhere.path, udOf(custom, mapOf("NODETERM_DATA_DIR" to elsewhere.path)))
        // …and without it, a server elsewhere is not found (the app says "not found", never "none").
        val hidden = freshHome()
        File(hidden, "srv").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals("", udOf(hidden))

        // A nodeterm desktop app on the same account wins, as before.
        val both = freshHome()
        File(both, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        File(both, ".nodeterm-server").apply { mkdirs() }.resolve("workspace.json").writeText("{}")
        assertEquals(File(both, ".config/node-terminal").path, udOf(both))
        listOf(server, fresh, custom, hidden, both).forEach { it.deleteRecursively() }
    }

    /**
     * A stand-in tmux: `list-sessions` prints `<dir>/<socket>.txt` as given, `has-session -t =<name>`
     * answers from the first column of the same file. Enough to run the browse and socket scripts'
     * own shell logic under /bin/sh with tricky input; the real tmux runs in SshTransportTest.
     */
    private fun fakeTmux(home: File, sockets: Map<String, String>): Map<String, String> {
        val bin = File(home, "fake-bin").apply { mkdirs() }
        val data = File(home, "fake-tmux").apply { mkdirs() }
        for ((socket, text) in sockets) File(data, "$socket.txt").writeText(text)
        File(bin, "tmux").apply {
            writeText(
                "#!/bin/sh\n" +
                    "f=\"${'$'}FAKE_TMUX/${'$'}2.txt\"\n" +
                    "case \"${'$'}3\" in\n" +
                    "  list-sessions) cat \"${'$'}f\" 2>/dev/null ;;\n" +
                    "  has-session) n=${'$'}{5#=}; [ -f \"${'$'}f\" ] && cut -d' ' -f1 \"${'$'}f\" | grep -qx -- \"${'$'}n\" ;;\n" +
                    "  *) exit 1 ;;\n" +
                    "esac\n"
            )
            setExecutable(true)
        }
        return mapOf("PATH" to "${bin.path}:/usr/bin:/bin", "FAKE_TMUX" to data.path)
    }

    @Test
    fun `browse lists the rmt sessions, walks up to each project file once, and prints the status slices`() {
        assumeTrue(File("/bin/sh").canExecute())
        val home = freshHome()
        File(home, ".config/node-terminal").apply { mkdirs() }.resolve("workspace.json").writeText("""{"version":3,"entries":[]}""")
        // Two projects, one inside the other; a folder with a space; sessions deep below them.
        val outer = File(home, "work space/outer").apply { mkdirs() }
        File(outer, ".nodeterm").mkdirs()
        File(outer, ".nodeterm/project.json").writeText("""{"id":"project-outer","name":"Outer"}""")
        val inner = File(outer, "pkg/inner").apply { mkdirs() }
        File(inner, ".nodeterm").mkdirs()
        File(inner, ".nodeterm/project.json").writeText("""{"id":"project-inner","name":"Inner"}""")
        val deep = File(inner, "a/b").apply { mkdirs() }
        val dot = File(home, ".nodeterm").apply { mkdirs() }
        File(dot, "agent-status-project-outer.json").writeText("""{"v":1,"updatedAt":1,"nodes":{}}""")
        File(dot, "agent-status-bad id.json").writeText("{}")
        File(dot, "agent-status.json").writeText("{}") // not a slice: no `-<projectId>`
        val env = fakeTmux(
            home,
            mapOf(
                "node-terminal" to "nt-own-1\n",
                "nodeterm-rmt" to listOf(
                    "nt-r-1 ${deep.path}",
                    "nt-r-2 ${outer.path}",
                    "nt-r-3 ${inner.path}",          // the inner file again: printed once
                    "nt-r-4 relative/path",           // not absolute: no walk
                    "nt-bad;rm ${outer.path}",        // not a session name this app makes: dropped
                    "other ${outer.path}",
                    "nt-r-5"                          // no path at all
                ).joinToString("\n") + "\n"
            )
        )
        val raw = sh(SshScripts.browse(), home, env)
        val out = HostBrowse.split(raw)
        assertEquals(File(home, ".config/node-terminal").path, out.userData)
        assertTrue(out.blob.contains("nt-own-1"), out.blob)
        assertEquals(listOf("nt-r-1", "nt-r-2", "nt-r-3", "nt-r-4", "nt-r-5"), out.rmtSessions)
        assertEquals(listOf(inner.path, outer.path), out.projectFiles.map { it.first }, "nearest first, each once: $raw")
        assertTrue(out.projectFiles[0].second.contains("project-inner"))
        assertEquals(listOf("project-outer"), out.slices.map { it.first }, "only well-formed slice names")
        assertTrue(out.slices.single().second.contains("\"updatedAt\":1"))
        assertTrue(raw.trimEnd().endsWith(SshScripts.END_MARK), raw)
        home.deleteRecursively()
    }

    @Test
    fun `the socket lookup finds a session on either socket, the host's own first`() {
        assumeTrue(File("/bin/sh").canExecute())
        val home = freshHome()
        val env = fakeTmux(home, mapOf("node-terminal" to "nt-both\nnt-own\n", "nodeterm-rmt" to "nt-both /x\nnt-drv /y\n"))
        fun which(node: String) = sh(SshScripts.whichSocket(node), home, env).trim()
        assertEquals("node-terminal", which("own"))
        assertEquals("nodeterm-rmt", which("drv"))
        assertEquals("node-terminal", which("both"), "a name on both is the host's own session")
        assertEquals("", which("none"))
        home.deleteRecursively()
    }
}
