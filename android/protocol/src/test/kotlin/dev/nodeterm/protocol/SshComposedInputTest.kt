package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.ComposedInput
import dev.nodeterm.protocol.ssh.ManagedViewHandshake
import dev.nodeterm.protocol.ssh.SshComposedInput
import java.io.ByteArrayInputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class SshComposedInputTest {
    private val tty = "/dev/pts/3"
    private val birth = "linux:12345678-1234-1234-1234-123456789abc:123"
    private val raw = "NT-COMPOSED-VIEW|$tty|101|123456|102|nt-term-abc-1|123456|\$0|%1|103|$birth|$birth|$birth\n"

    @Test fun `capture receipt requires exact tty session fields and bounded process births`() {
        val proof = assertNotNull(SshComposedInput.parse(raw, tty, "term-abc-1"))
        assertEquals(101, proof.viewerPid); assertEquals(103, proof.panePid)
        for (bad in listOf(raw.replace(tty, "/dev/pts/4"), raw.replace("nt-term-abc-1", "nt-term-other-1"),
            raw.replace("|%1|", "|%1;touch /tmp/wrong|"), raw.replace("|101|", "|-1|"),
            raw.replace(birth, "linux:wrong:123"), raw.trim() + "|extra", raw.replace("|123456|\$0", "|0|\$0"))) {
            assertNull(SshComposedInput.parse(bad, tty, "term-abc-1"), bad)
        }
    }

    @Test fun `private normal-view handshake consumes only its bounded tty line`() {
        val input = ByteArrayInputStream("NT-INPUT-VIEW $tty\n\u001b[2Jactual output".toByteArray())
        assertEquals(tty, ManagedViewHandshake.read(input, "NT-INPUT-VIEW "))
        assertEquals("\u001b[2Jactual output", input.readBytes().toString(Charsets.UTF_8))
    }

    @Test fun `composed SSH script carries identity and framing instructions without draft on argv`() {
        val proof = assertNotNull(SshComposedInput.parse(raw, tty, "term-abc-1"))
        val input = "private full prompt with \"quotes\", \$HOME and newlines\n"
        val script = SshComposedInput.send("term-abc-1", "node-terminal", null, proof, ComposedInput.Paste(input, false))
        assertFalse(script.contains(input), "text only goes through bounded SSH stdin")
        assertFalse(script.contains("send-keys -l"), "tmux bracketed paste remains the composed path")
    }
}
