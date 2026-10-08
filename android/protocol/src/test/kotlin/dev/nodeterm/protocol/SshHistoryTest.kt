package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.TerminalHistory as H
import dev.nodeterm.protocol.ssh.SshScripts
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import kotlin.test.*

class SshHistoryTest {
    private fun check(history: String, query: String, failure: Boolean = false): Pair<Int, String> {
        assumeTrue(File("/bin/sh").canExecute())
        val home = Files.createTempDirectory("nt-history-").toFile()
        try {
            val bin = File(home, "bin").apply { mkdirs() }
            File(home, "history").writeText(history)
            File(bin, "tmux").apply {
                writeText("""
                    #!/bin/sh
                    [ "${'$'}1" = -L ] && [ "${'$'}2" = nodeterm-rmt ] || exit 9
                    case "${'$'}3" in
                      display-message)
                        [ "${'$'}6" = '=nt-search:' ] && [ "${'$'}7" = '#{pane_id}' ] || exit 8
                        printf '%%42\n';;
                      capture-pane)
                        [ "${'$'}4" = -p ] && [ "${'$'}5" = -J ] && [ "${'$'}6" = -t ] && [ "${'$'}7" = %42 ] && [ "${'$'}8" = -S ] && [ "${'$'}9" = - ] || exit 7
                        ${if (failure) "exit 6" else "cat \"${'$'}HOME/history\""};;
                      *) exit 5;;
                    esac
                """.trimIndent())
                setExecutable(true)
            }
            val pb = ProcessBuilder("/bin/sh", "-c", SshScripts.searchHistory("search", query, "nodeterm-rmt"))
            pb.environment().clear()
            pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "${bin.path}:/usr/bin:/bin", "TMPDIR" to home.path))
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            val code = p.waitFor()
            assertFalse(File(home, "injected").exists())
            assertTrue(home.listFiles()!!.none { it.name.startsWith("nodeterm-history.") }, "private spool removed")
            return code to out
        } finally { home.deleteRecursively() }
    }
    @Test fun `real shell awk scans old output and treats query as literal bytes`() {
        val query = "'\"`$(touch injected).* Ω 😀\\x"
        val (code, out) = check("old$query\n" + "recent\n".repeat(500), query)
        assertEquals(0, code)
        assertEquals(H.Result(501, false, listOf(H.Row(0, "old$query"))), H.parseSsh(out, query))
    }
    @Test fun `bounded results still count the complete history`() {
        val (code, out) = check("match\n".repeat(300) + "tail\n", "match")
        assertEquals(0, code)
        val result = H.parseSsh(out, "match")!!
        assertTrue(result.truncated)
        assertEquals(301, result.searchedLines)
        assertEquals(200, result.rows.size)
    }
    @Test fun `regular expression syntax cannot match unrelated output`() {
        val (code, out) = check("unrelated Ω 😀\n", ".* Ω 😀")
        assertEquals(0, code)
        assertEquals(H.Result(1, false, emptyList()), H.parseSsh(out, ".* Ω 😀"))
    }
    @Test fun `capture failure produces an error instead of successful empty results`() {
        val (code, out) = check("match\n", "match", failure = true)
        assertNotEquals(0, code)
        assertNull(H.parseSsh(out, "match"))
    }
    @Test fun `unlisted sockets and invalid queries refuse and node names are normalized`() {
        assertFailsWith<IllegalArgumentException> { SshScripts.searchHistory("search", "x", "foreign") }
        assertTrue(SshScripts.searchHistory("search;evil", "x", "node-terminal").contains("'=nt-search_evil:'"))
        assertFailsWith<IllegalArgumentException> { SshScripts.searchHistory("search", "x\ny", "node-terminal") }
    }
}
