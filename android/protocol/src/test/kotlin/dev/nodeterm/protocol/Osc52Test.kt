package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Osc52
import dev.nodeterm.protocol.model.Osc52.Result
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A53: OSC 52 copy, parsed like the desktop's parseOsc52 but capped for the Android clipboard. */
class Osc52Test {
    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun b64(text: String): String = b64(text.toByteArray(Charsets.UTF_8))
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test
    fun `a normal payload decodes to its text`() {
        assertEquals(Result.Copy("Hello, world"), Osc52.parse("c;" + b64("Hello, world")))
        val multi = "héllo ✓ 你好 😀\nsecond line"
        assertEquals(Result.Copy(multi), Osc52.parse("c;" + b64(multi)))
        // Any selection name, including none at all, as tmux and vim both send.
        assertEquals(Result.Copy("x"), Osc52.parse(";" + b64("x")))
        assertEquals(Result.Copy("x"), Osc52.parse("pc;" + b64("x")))
    }

    @Test
    fun `the selection separator is required`() {
        // A bare base64 string used to be copied as if it were the payload.
        assertEquals(Result.Ignored, Osc52.parse(b64("Hello")))
        assertEquals(Result.Ignored, Osc52.parse(""))
    }

    @Test
    fun `a selection field longer than any xterm uses is not a clipboard write`() {
        val sel = "c".repeat(Osc52.MAX_SELECTION)
        assertEquals(Result.Copy("x"), Osc52.parse(sel + ";" + b64("x")))
        assertEquals(Result.Ignored, Osc52.parse(sel + "c;" + b64("x")))
    }

    @Test
    fun `a read query and an empty payload copy nothing`() {
        assertEquals(Result.Ignored, Osc52.parse("c;?"))
        assertEquals(Result.Ignored, Osc52.parse(";?"))
        assertEquals(Result.Ignored, Osc52.parse("c;"))
        // Whitespace is valid base64 for nothing: no "Copied" over an emptied clipboard.
        assertEquals(Result.Ignored, Osc52.parse("c;  \n"))
    }

    @Test
    fun `invalid base64 is refused, not skipped over`() {
        // android.util.Base64 skipped the characters it did not know and decoded the rest.
        assertEquals(Result.Invalid, Osc52.parse("c;not_base64!!"))
        assertEquals(Result.Invalid, Osc52.parse("c;SGVs-bG8="))
        assertEquals(Result.Invalid, Osc52.parse("c;SG=VsbG8=")) // padding in the middle
        assertEquals(Result.Invalid, Osc52.parse("c;SGVsbG8===")) // three '='
        assertEquals(Result.Invalid, Osc52.parse("c;A")) // 1 mod 4
        assertEquals(Result.Invalid, Osc52.parse("c;SGVsbG8=A"))
    }

    @Test
    fun `base64 is as forgiving as atob and no more`() {
        assertEquals(Result.Copy("Hello"), Osc52.parse("c;SGVsbG8=")) // padded
        assertEquals(Result.Copy("Hello"), Osc52.parse("c;SGVsbG8")) // unpadded
        assertEquals(Result.Copy("Hello"), Osc52.parse("c;SGVs\r\n bG8\t=")) // ASCII whitespace
        assertEquals(Result.Copy("Hi"), Osc52.parse("c;SGk=")) // one '='
        assertEquals(Result.Copy("H"), Osc52.parse("c;SA==")) // two '='
        // Leftover bits of a short last group are discarded, not checked ("SB" and "SA" both = "H").
        assertEquals(Result.Copy("H"), Osc52.parse("c;SB"))
        // Non-ASCII whitespace is not whitespace to atob.
        assertEquals(Result.Invalid, Osc52.parse("c;SGVs bG8="))
    }

    @Test
    fun `invalid UTF-8 is refused, never replaced`() {
        assertEquals(Result.Invalid, Osc52.parse("c;" + b64(bytes(0xC3, 0x28)))) // bad continuation
        assertEquals(Result.Invalid, Osc52.parse("c;" + b64(bytes(0x61, 0xE2, 0x82)))) // truncated
        assertEquals(Result.Invalid, Osc52.parse("c;" + b64(bytes(0xC0, 0xAF)))) // overlong '/'
        assertEquals(Result.Invalid, Osc52.parse("c;" + b64(bytes(0xED, 0xA0, 0x80)))) // a surrogate
        assertEquals(Result.Invalid, Osc52.parse("c;" + b64(bytes(0xFF))))
    }

    @Test
    fun `one leading byte-order mark is dropped, as TextDecoder drops it`() {
        assertEquals(Result.Copy("hi"), Osc52.parse("c;" + b64("﻿hi")))
        assertEquals(Result.Copy("﻿hi"), Osc52.parse("c;" + b64("﻿﻿hi")))
        assertEquals(Result.Ignored, Osc52.parse("c;" + b64("﻿")))
    }

    @Test
    fun `the payload the desktop's cap lets through is refused before decoding`() {
        // tmux 3.4 forwards a 986,675-character OSC 52 (measured by the audit's verifier): under the
        // desktop's 1,000,000, about 1.5 MB as a UTF-16 parcel, over the binder buffer.
        assertEquals(Result.TooLarge, Osc52.parse("c;" + "A".repeat(986_675)))
        assertEquals(Result.TooLarge, Osc52.parse("c;" + "A".repeat(Osc52.MAX_BASE64 + 1)))
        // Even when it is not base64 at all: the length is checked first.
        assertEquals(Result.TooLarge, Osc52.parse("c;" + "!".repeat(Osc52.MAX_BASE64 + 1)))
        assertEquals(Result.Invalid, Osc52.parse("c;" + "!".repeat(Osc52.MAX_BASE64)))
    }

    @Test
    fun `the text cap is exact`() {
        val atCap = "a".repeat(Osc52.MAX_TEXT_CHARS)
        assertEquals(Result.Copy(atCap), Osc52.parse("c;" + b64(atCap)))
        // Well under the base64 cap, over the text cap.
        val overCap = "a".repeat(Osc52.MAX_TEXT_CHARS + 1)
        assertTrue(b64(overCap).length < Osc52.MAX_BASE64)
        assertEquals(Result.TooLarge, Osc52.parse("c;" + b64(overCap)))
    }

    @Test
    fun `the base64 cap never refuses a text the text cap takes`() {
        // Three UTF-8 bytes per UTF-16 unit is the worst case, and it lands exactly on the cap.
        val cjk = "你".repeat(Osc52.MAX_TEXT_CHARS)
        val payload = b64(cjk)
        assertEquals(Osc52.MAX_BASE64, payload.length)
        assertEquals(Result.Copy(cjk), Osc52.parse("c;$payload"))
        // Four-byte characters are two units each: denser in units, so the text cap binds first.
        val emoji = "😀".repeat(Osc52.MAX_TEXT_CHARS / 2)
        assertEquals(Result.Copy(emoji), Osc52.parse("c;" + b64(emoji)))
        assertEquals(Result.TooLarge, Osc52.parse("c;" + b64(emoji + "a")))
    }

    @Test
    fun `the clip stays far below the shared binder buffer`() {
        // ClipData parcels its text as UTF-16; the system server's buffer is about 1 MB, shared.
        assertTrue(Osc52.MAX_TEXT_CHARS * 2 <= 256 * 1024)
    }

    @Test
    fun `decodeBase64 matches the JDK on well-formed input`() {
        for (len in 0..20) {
            val data = ByteArray(len) { (it * 37 + 11).toByte() }
            val padded = b64(data)
            assertContentEquals(data, Osc52.decodeBase64(padded))
            assertContentEquals(data, Osc52.decodeBase64(padded.trimEnd('=')))
        }
        assertNull(Osc52.decodeBase64("AAAAA"))
    }
}
