package dev.nodeterm.protocol

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.TimeUnit

// What the machine running SshTransportTest has to provide, and the two places where the platforms
// contributors use differ (audit A62): where a tmux socket can be bound, and which `script(1)` stands
// in for sshd's pty. Both were Linux-only, so on a Mac with Homebrew tmux the audit found every test
// of that class failing instead of running or skipping. Only the Linux leg has run here.

/**
 * The longest unix socket path that can be bound. macOS `sys/un.h` declares `sun_path[104]`, which is
 * 103 characters plus the NUL; Linux allows 107. The smaller number holds everywhere, as in
 * `src/core/tmux-test-socket.ts`: a limit that only bites on a Mac looks like a broken test.
 */
internal const val SUN_PATH_MAX = 103

/**
 * A private temp root for the SSH transport tests, short enough that `<root>/<tmuxSubdir>` works as
 * `TMUX_TMPDIR` for `-L <socket>`.
 *
 * The JVM's temp dir on a Mac is `/var/folders/…/T/`, which tmux resolves to `/private/var/folders/…`
 * before it binds. Under it the socket path was about 110 characters, and `tmux new-session` failed
 * with "File name too long" in `@BeforeAll`. So `/tmp` is tried first (`/private/tmp` on a Mac,
 * `/tmp` itself on Linux, where the JVM's temp dir usually already is `/tmp`), and every base is
 * resolved before anything is measured.
 */
internal object ShortTmuxRoot {
    /** Where tmux binds `-L <socket>` under `TMUX_TMPDIR=<tmuxDir>` for [uid]. */
    fun socketPath(tmuxDir: File, uid: Int, socket: String): String = "${tmuxDir.path}/tmux-$uid/$socket"

    fun defaultBases(): List<File> = listOf(File("/tmp"), File(System.getProperty("java.io.tmpdir")))

    /**
     * Create the root under the first of [bases] that leaves room for the socket, and return it
     * resolved. Each base is resolved first, because tmux resolves its directory before binding and
     * measuring the unresolved spelling under-counts. The length is then measured on the directory
     * actually created, with the uid that owns it (the uid tmux names its `tmux-<uid>` directory
     * after). The directory made under a base without room is removed and the next base tried; when
     * none has room this throws, naming the lengths, instead of handing back a path that fails at bind
     * time.
     */
    fun create(prefix: String, tmuxSubdir: String, socket: String, bases: List<File> = defaultBases()): File {
        val tried = ArrayList<String>()
        for (base in bases.mapNotNull { resolved(it) }.distinct()) {
            val root = try {
                Files.createTempDirectory(base.toPath(), prefix).toRealPath().toFile()
            } catch (e: IOException) {
                tried += "$base (${e.message})"
                continue
            }
            val uid = Files.getAttribute(root.toPath(), "unix:uid") as Int
            val bound = socketPath(File(root, tmuxSubdir), uid, socket)
            if (bound.length <= SUN_PATH_MAX) return root
            tried += "$bound (${bound.length} chars)"
            root.deleteRecursively()
        }
        throw IllegalStateException(
            "no temp dir leaves room for a tmux socket within $SUN_PATH_MAX chars; tried: ${tried.joinToString("; ")}"
        )
    }

    private fun resolved(dir: File): File? =
        runCatching { dir.toPath().toRealPath().toFile() }.getOrNull()?.takeIf { it.isDirectory }
}

/**
 * The `script(1)` that gives a pty-requesting exec its pty, standing in for sshd (MINA's process
 * bridge has none). The two in the field take different arguments:
 *
 * - **util-linux** (Linux): `script -qfec <command> /dev/null`. `-c` runs the command through
 *   `$SHELL -c`, `-e` returns its exit status, `-q` drops the start/done banners.
 * - **BSD** (macOS, FreeBSD): `script [-aeFkqr] [-t time] [file [command ...]]`. There is no `-c`:
 *   the command is the argv after the typescript file, exec'd as is. Its exit status should be the
 *   command's; [detect] checks that rather than trusting it. The command runs as
 *   `/bin/sh -c <command>`, the shell the harness uses for commands without a pty.
 *
 * util-linux writes the terminal's EOF character into the pty when its stdin ends (measured), and
 * FreeBSD's `script.c` does the same in canonical mode (macOS unmeasured), which is why the harness
 * never closes a pty command's stdin.
 */
internal class PtyScript private constructor(val flavor: Flavor, private val executable: String) {
    enum class Flavor { UTIL_LINUX, BSD }

    /** The argv that runs [command] (one shell line) under a fresh pty, with `/dev/null` as the typescript. */
    fun argv(command: String): List<String> = when (flavor) {
        Flavor.UTIL_LINUX -> listOf(executable, "-qfec", command, "/dev/null")
        Flavor.BSD -> listOf(executable, "-q", "/dev/null", "/bin/sh", "-c", command)
    }

    companion object {
        const val SKIP_REASON = "the SSH transport tests need tmux and a script(1) that gives a command a pty: " +
            "util-linux (Linux) or BSD (macOS)"

        private const val PROBE_SECONDS = 10L

        /** A command whose exit status 7 proves both that it had a tty and that the status came back. */
        internal const val PROBE_COMMAND = "[ -t 0 ] && [ -t 1 ] || exit 3; exit 7"

        fun of(flavor: Flavor, executable: String = "script") = PtyScript(flavor, executable)

        /**
         * Which `script` [executable] is, or null for neither (the tests then skip with [SKIP_REASON]).
         * util-linux names itself in `--version`, so Linux is recognised without running anything under
         * a pty, exactly as before. BSD `script` has no `--version` (an unknown option prints the usage
         * and exits 1), so it is recognised by running [PROBE_COMMAND] in its own argument form.
         */
        fun detect(executable: String = "script"): PtyScript? {
            val version = run(listOf(executable, "--version"))
            if (version != null && version.first == 0 && "util-linux" in version.second) return of(Flavor.UTIL_LINUX, executable)
            val bsd = of(Flavor.BSD, executable)
            return bsd.takeIf { run(it.argv(PROBE_COMMAND))?.first == 7 }
        }

        private fun run(argv: List<String>): Pair<Int, String>? = runCatching {
            // Run where a typescript some other script(1) might write cannot land in the source tree.
            val p = ProcessBuilder(argv).directory(File(System.getProperty("java.io.tmpdir")))
                .redirectErrorStream(true).start()
            p.outputStream.close()
            val out = StringBuffer()
            val reader = Thread { runCatching { out.append(p.inputStream.bufferedReader().readText()) } }
                .apply { isDaemon = true; start() }
            if (!p.waitFor(PROBE_SECONDS, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                return@runCatching null
            }
            reader.join(2_000)
            p.exitValue() to out.toString()
        }.getOrNull()
    }
}
