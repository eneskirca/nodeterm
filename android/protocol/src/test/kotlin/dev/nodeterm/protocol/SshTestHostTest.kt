package dev.nodeterm.protocol

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The machine-facing half of [SshTransportTest] (audit A62): the temp root its tmux socket lives in,
 * and the `script(1)` that gives its pty commands a pty. Both were Linux-only, so on a Mac the audit
 * found every test of that class failing instead of running. Nothing here has run on a Mac: the macOS
 * temp dir is stood in for by a symlink to a long directory, and BSD `script` by
 * `bsd-script-standin.sh`, which follows BSD's documented argument grammar.
 */
class SshTestHostTest {
    private val socket = "node-terminal"

    /**
     * [ShortTmuxRoot] is POSIX-only by construction: it reads the owning uid through the `unix`
     * attribute view (absent on Windows, where the read throws UnsupportedOperationException) and its
     * first base is `/tmp`. So its tests skip where that is missing, the way [SshScriptsTest] gates on
     * `/bin/sh`, instead of failing, which is the shape A62 was about. [SshTransportTest] never gets
     * that far there: its tmux and `script(1)` gates skip it first.
     */
    private fun assumePosixTemp() = assumeTrue(
        "unix" in FileSystems.getDefault().supportedFileAttributeViews() && File("/tmp").isDirectory,
        "ShortTmuxRoot needs a POSIX filesystem (the unix attribute view) and /tmp"
    )

    /** A real directory whose socket path cannot fit, whatever temp root it sits under. */
    private fun longDir(parent: File): File =
        File(parent, "x".repeat(maxOf(1, 100 - parent.path.length))).apply { mkdirs() }.toPath().toRealPath().toFile()

    @Test
    fun `a base that resolves to a long path is passed over, however short its own spelling`() {
        assumePosixTemp()
        // macOS's shape: the JVM's temp dir is spelled /var/folders/…, but tmux binds under
        // /private/var/folders/…, 8 characters longer. Measuring the spelling said it fit when it did not.
        val scratch = Files.createTempDirectory("nt-a62").toFile()
        val links = Files.createTempDirectory(File("/tmp").toPath(), "nt-l").toFile()
        try {
            val long = longDir(scratch)
            val link = File(links, "t")
            Files.createSymbolicLink(link.toPath(), long.toPath())
            assertTrue(
                ShortTmuxRoot.socketPath(File(link, "nt-t12345678901234567890/tmux"), 501, socket).length <= SUN_PATH_MAX,
                "the stand-in must look short when measured unresolved"
            )
            val root = ShortTmuxRoot.create("nt-t", "tmux", socket, bases = listOf(link, File("/tmp")))
            try {
                assertEquals(File("/tmp").toPath().toRealPath(), root.toPath().parent, "picked $root")
                assertEquals(root.toPath().toRealPath().toFile(), root, "TMUX_TMPDIR is handed over resolved")
                val uid = Files.getAttribute(root.toPath(), "unix:uid") as Int
                assertTrue(ShortTmuxRoot.socketPath(File(root, "tmux"), uid, socket).length <= SUN_PATH_MAX)
                assertEquals(emptyList(), long.list()!!.toList(), "the directory made under the long base was removed")
            } finally {
                root.deleteRecursively()
            }
        } finally {
            links.deleteRecursively()
            scratch.deleteRecursively()
        }
    }

    @Test
    fun `no base with room is a failure naming the lengths, never a path that fails at bind time`() {
        assumePosixTemp()
        val scratch = Files.createTempDirectory("nt-a62").toFile()
        try {
            val long = longDir(scratch)
            val e = assertFailsWith<IllegalStateException> { ShortTmuxRoot.create("nt-t", "tmux", socket, bases = listOf(long)) }
            assertTrue(e.message!!.contains("$SUN_PATH_MAX chars") && e.message!!.contains(long.path), e.message)
            assertEquals(emptyList(), long.list()!!.toList())
        } finally {
            scratch.deleteRecursively()
        }
    }

    @Test
    fun `util-linux keeps the arguments the harness always used`() {
        assertEquals(
            listOf("script", "-qfec", "stty size", "/dev/null"),
            PtyScript.of(PtyScript.Flavor.UTIL_LINUX).argv("stty size")
        )
    }

    @Test
    fun `BSD gets the command as argv after the typescript file`() {
        assertEquals(
            listOf("script", "-q", "/dev/null", "/bin/sh", "-c", "stty size"),
            PtyScript.of(PtyScript.Flavor.BSD).argv("stty size")
        )
    }

    private fun runScript(argv: List<String>): Pair<Int, String> {
        val p = ProcessBuilder(argv).redirectErrorStream(true).start()
        val out = StringBuffer()
        val reader = Thread { runCatching { out.append(p.inputStream.bufferedReader().readText()) } }
            .apply { isDaemon = true; start() }
        // Like the harness's pty commands, stdin stays open while it runs (its EOF types a ^D).
        try {
            if (!p.waitFor(10, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                throw AssertionError("$argv did not exit: $out")
            }
        } finally {
            p.outputStream.close()
        }
        reader.join(2_000)
        return p.exitValue() to out.toString()
    }

    /** The command shape [SshTransportTest] runs under a pty: size the pty, then the product's line. */
    private val sizedCommand = "stty cols 100 rows 30 2>/dev/null; stty size; exit 5"

    @Test
    fun `this machine's script gives the harness's command a pty and returns its status`() {
        val script = PtyScript.detect()
        assumeTrue(script != null, PtyScript.SKIP_REASON)
        val (code, out) = runScript(script!!.argv(sizedCommand))
        assertEquals(5, code, out)
        assertTrue(out.contains("30 100"), out)
    }

    private fun executable(dir: File, name: String, text: String) =
        File(dir, name).apply { writeText(text); setExecutable(true) }

    @Test
    fun `a BSD-shaped script is recognised by its argument form, and runs the harness's command`() {
        // The stand-in borrows its pty from util-linux.
        assumeTrue(PtyScript.detect()?.flavor == PtyScript.Flavor.UTIL_LINUX, "the BSD stand-in needs util-linux script")
        val dir = Files.createTempDirectory("nt-a62").toFile()
        try {
            val text = assertNotNull(javaClass.getResource("/bsd-script-standin.sh")).readText()
            val bsd = executable(dir, "bsd-script", text)
            val script = assertNotNull(PtyScript.detect(bsd.path))
            assertEquals(PtyScript.Flavor.BSD, script.flavor)
            val (code, out) = runScript(script.argv(sizedCommand))
            assertEquals(5, code, out)
            assertTrue(out.contains("30 100"), out)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a script that answers neither form, or gives no pty, is not used`() {
        val dir = Files.createTempDirectory("nt-a62").toFile()
        try {
            assertNull(PtyScript.detect(executable(dir, "refuses", "#!/bin/sh\nexit 1\n").path))
            // BSD's argument grammar without a pty: the probe asks for a tty, not just an exit status.
            val noPty = executable(dir, "no-pty", "#!/bin/sh\nshift 2\nexec \"\$@\"\n")
            assertNull(PtyScript.detect(noPty.path))
            assertNull(PtyScript.detect(File(dir, "missing").path))
        } finally {
            dir.deleteRecursively()
        }
    }
}
