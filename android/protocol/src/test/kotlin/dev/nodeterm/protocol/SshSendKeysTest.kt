package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.ssh.SshScripts
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The generated quick-answer shell, including errors tmux can report before accepting input. */
class SshSendKeysTest {
    private fun run(argv: List<String>, home: File, env: Map<String, String>): Pair<Int, String> {
        val pb = ProcessBuilder(argv).directory(home).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin") + env)
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        return p.waitFor() to out
    }

    private fun shell(script: String, home: File, env: Map<String, String>): Pair<Int, String> =
        run(listOf("/bin/sh", "-c", script), home, env)

    /**
     * A tmux edge double that keeps copy mode until cancelled. Ordinary send-keys in copy mode still
     * succeeds, as real tmux does, but records delivery to the mode instead of the application.
     */
    private fun fakeTmux(home: File, socket: String, mode: Int): Map<String, String> {
        val bin = File(home, "bin").apply { mkdirs() }
        File(home, "mode").writeText(mode.toString())
        File(bin, "tmux").apply {
            writeText("""
                #!/bin/sh
                [ "${'$'}1" = -L ] && [ "${'$'}2" = "${'$'}FAKE_SOCKET" ] || exit 2
                case "${'$'}3" in
                  display-message)
                    printf 'resolve:%s\n' "${'$'}6" >> "${'$'}HOME/log"
                    [ "${'$'}4" = -p ] && [ "${'$'}5" = -t ] && [ "${'$'}6" = '=nt-answer:' ] || exit 3
                    [ "${'$'}{FAKE_RESOLVE_EXIT:-0}" = 0 ] || exit "${'$'}FAKE_RESOLVE_EXIT"
                    printf '%s\n' "${'$'}{FAKE_STATE:-%42 ${'$'}(cat "${'$'}HOME/mode")}" ;;
                  send-keys)
                    [ "${'$'}4" = -t ] && [ "${'$'}5" = %42 ] || exit 4
                    if [ "${'$'}6" = -X ]; then
                      [ "${'$'}7" = cancel ] || exit 5
                      printf 'cancel:%s\n' "${'$'}5" >> "${'$'}HOME/log"
                      [ "${'$'}{FAKE_CANCEL_EXIT:-0}" = 0 ] || exit "${'$'}FAKE_CANCEL_EXIT"
                      printf 0 > "${'$'}HOME/mode"
                    else
                      printf 'send:%s\n' "${'$'}5" >> "${'$'}HOME/log"
                      if [ "${'$'}(cat "${'$'}HOME/mode")" = 0 ]; then printf pane; else printf copy; fi > "${'$'}HOME/delivery"
                      if [ "${'$'}6" = -l ]; then
                        [ "${'$'}7" = -- ] || exit 6
                        printf '%s' "${'$'}8" > "${'$'}HOME/keys"
                      else
                        printf '%s' "${'$'}6" > "${'$'}HOME/keys"
                      fi
                      exit "${'$'}{FAKE_SEND_EXIT:-0}"
                    fi ;;
                  *) exit 1 ;;
                esac
            """.trimIndent() + "\n")
            setExecutable(true)
        }
        return mapOf("PATH" to "${bin.path}:/usr/bin:/bin", "FAKE_SOCKET" to socket,
            "TMUX_TMPDIR" to File(home, "tmux").apply { mkdirs() }.path)
    }

    @Test
    fun `literal answers Enter and Escape leave copy mode and use the resolved pane on either socket`() {
        assumeTrue(File("/bin/sh").canExecute())
        val keys = listOf("-R; quote's ${'$'}literal\nnext" to "-R; quote's ${'$'}literal\nnext", "\r" to "Enter", "\u001b" to "Escape")
        for (socket in listOf(TmuxNames.SOCKET, TmuxNames.REMOTE_SOCKET)) for (mode in listOf(0, 1)) for ((input, expected) in keys) {
            val home = Files.createTempDirectory("nt-send-").toFile()
            try {
                val env = fakeTmux(home, socket, mode)
                val (code, out) = shell(SshScripts.sendKeys("answer", input, socket), home, env)
                assertEquals(0, code, out)
                assertEquals("pane", File(home, "delivery").readText(), "copy mode must not swallow a successful answer")
                assertEquals(expected, File(home, "keys").readText())
                assertEquals("resolve:=nt-answer:\n" + (if (mode == 1) "cancel:%42\n" else "") + "send:%42\n", File(home, "log").readText())
            } finally {
                home.deleteRecursively()
            }
        }
    }

    @Test
    fun `a failed exact pane lookup or copy mode cancellation never sends the answer`() {
        assumeTrue(File("/bin/sh").canExecute())
        for ((extra, expectedExit, expectedLog) in listOf(
            Triple(mapOf("FAKE_RESOLVE_EXIT" to "3"), 3, "resolve:=nt-answer:\n"),
            Triple(mapOf("FAKE_CANCEL_EXIT" to "7"), 7, "resolve:=nt-answer:\ncancel:%42\n"),
            Triple(mapOf("FAKE_STATE" to "%oops 1"), 1, "resolve:=nt-answer:\n"),
            Triple(mapOf("FAKE_STATE" to "42 0"), 1, "resolve:=nt-answer:\n"),
            Triple(mapOf("FAKE_STATE" to "%42 unknown"), 1, "resolve:=nt-answer:\n")
        )) {
            val home = Files.createTempDirectory("nt-send-fail-").toFile()
            try {
                val env = fakeTmux(home, "node-terminal", 1) + extra
                assertEquals(expectedExit, shell(SshScripts.sendKeys("answer", "1", "node-terminal"), home, env).first)
                assertEquals(expectedLog, File(home, "log").readText())
                assertFalse(File(home, "delivery").exists(), "an unconfirmed cancellation must not type")
            } finally {
                home.deleteRecursively()
            }
        }
    }

    @Test
    fun `a send keys failure remains a failure after leaving copy mode`() {
        assumeTrue(File("/bin/sh").canExecute())
        val home = Files.createTempDirectory("nt-send-exit-").toFile()
        try {
            val env = fakeTmux(home, "node-terminal", 1) + mapOf("FAKE_SEND_EXIT" to "9")
            assertEquals(9, shell(SshScripts.sendKeys("answer", "1", "node-terminal"), home, env).first)
            assertEquals("pane", File(home, "delivery").readText())
        } finally {
            home.deleteRecursively()
        }
    }

    @Test
    fun `real tmux delivers a quick answer out of copy mode and never matches a longer session name`() {
        assumeTrue(File("/bin/sh").canExecute())
        assumeTrue(runCatching { ProcessBuilder("tmux", "-V").start().waitFor() == 0 }.getOrDefault(false), "tmux required")
        // A short private socket directory, never the developer's live server (CLAUDE.md, #629).
        val root = ShortTmuxRoot.create("nt-send", "tmux", "node-terminal")
        val home = File(root, "home").apply { mkdirs() }
        val env = mapOf("TMUX_TMPDIR" to File(root, "tmux").apply { mkdirs() }.path)
        fun tmux(socket: String, vararg args: String) = run(listOf("tmux", "-L", socket) + args, home, env)
        val reader = "while IFS= read -r line; do printf '%s\\n' \"${'$'}line\" >> \"${'$'}HOME/received\"; done"
        try {
            for (socket in listOf(TmuxNames.SOCKET, TmuxNames.REMOTE_SOCKET)) {
                for (name in listOf("nt-answer", "nt-answer-longer")) {
                    val (code, out) = tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", name, "/bin/sh -c " + SshScripts.q(reader))
                    assertEquals(0, code, out)
                    assertEquals(0, tmux(socket, "copy-mode", "-t", "=$name:").first)
                }
                assertEquals("1", tmux(socket, "display-message", "-p", "-t", "=nt-answer:", "#{pane_in_mode}").second.trim())
                assertEquals(0, shell(SshScripts.sendKeys("answer", "answer-$socket", socket), home, env).first)
                assertEquals(0, shell(SshScripts.sendKeys("answer", "\r", socket), home, env).first)
                val end = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
                while (runCatching { File(home, "received").readText() }.getOrNull() != "answer-$socket\n" && System.nanoTime() < end) Thread.sleep(20)
                assertEquals("answer-$socket\n", File(home, "received").readText())
                assertEquals("0", tmux(socket, "display-message", "-p", "-t", "=nt-answer:", "#{pane_in_mode}").second.trim())
                assertEquals("1", tmux(socket, "display-message", "-p", "-t", "=nt-answer-longer:", "#{pane_in_mode}").second.trim())

                assertEquals(0, tmux(socket, "kill-session", "-t", "=nt-answer").first)
                assertTrue(shell(SshScripts.sendKeys("answer", "wrong session", socket), home, env).first != 0)
                assertEquals("1", tmux(socket, "display-message", "-p", "-t", "=nt-answer-longer:", "#{pane_in_mode}").second.trim())
                assertEquals("answer-$socket\n", File(home, "received").readText(), "a prefix match must never receive input")
                assertEquals(0, tmux(socket, "kill-server").first)
                File(home, "received").delete()
            }
        } finally {
            for (socket in TmuxNames.SOCKETS) tmux(socket, "kill-server")
            root.deleteRecursively()
        }
    }
}
