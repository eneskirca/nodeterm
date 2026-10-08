package dev.nodeterm.protocol.model

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * An OSC 52 clipboard write from the pane (tmux copy-mode with `set-clipboard on`, or a program
 * such as vim `"+y`) turned into clipboard text. Mirrors the desktop's `parseOsc52`
 * (src/renderer/terminal/osc52.ts): the payload is `<selection>;<base64>` and the `;` is
 * required; it is WRITE-ONLY, so a `?` read query is refused (a remote program must never read the
 * phone's clipboard); the base64 is decoded the way the desktop's `atob` decodes it (ASCII
 * whitespace and missing padding tolerated, anything else outside the alphabet refused) and the
 * bytes as strict UTF-8 (`TextDecoder` with `fatal: true`, including its removal of one leading
 * byte-order mark).
 *
 * The size cap is the one place the phone must be STRICTER than the desktop (audit A53). The
 * clipboard write is a binder transaction into the system server, whose buffer is about 1 MB and
 * shared by every transaction in flight, and `ClipData` parcels its text as UTF-16. The desktop's
 * cap of 1,000,000 base64 characters does not keep a copy under that: tmux 3.4 forwards a
 * 986,675-character payload (measured), about 740 KB of text and about 1.5 MB as a parcel, over the
 * binder limit; a failed transaction is rethrown from `setPrimaryClip` as a RuntimeException, which
 * the app did not catch (not reproduced on a device). So there are two caps here:
 * [MAX_TEXT_CHARS] is the real one, and [MAX_BASE64] is the most base64 such a text can take,
 * checked first so an oversized payload is refused before anything is decoded. terminal.js reads
 * [MAX_BASE64] over the bridge and applies it before the sequence crosses it.
 */
object Osc52 {
    /**
     * The longest selection field (the part before the `;`) accepted: xterm's own are `c`, `p`,
     * `q`, `s` and `0`-`7`, possibly several together. A longer field is not a clipboard write we
     * understand, and terminal.js drops it before the bridge so it cannot carry megabytes across.
     */
    const val MAX_SELECTION = 16

    /**
     * The most text the phone hands the clipboard, in UTF-16 code units (a Kotlin `String`'s
     * length). At two bytes a unit the parcel stays around 200 KB: a fifth of the shared binder
     * buffer, and far more than a screen of copy-mode selection.
     */
    const val MAX_TEXT_CHARS = 100_000

    /**
     * The most base64 that can still decode to a text within [MAX_TEXT_CHARS]. A UTF-16 unit takes
     * at most three UTF-8 bytes (a surrogate pair is two units for four bytes), and base64 spends
     * four characters per three bytes, so this cap never refuses a text the text cap would take.
     * It is measured on the raw payload, before whitespace is removed, exactly as the desktop does.
     */
    const val MAX_BASE64 = MAX_TEXT_CHARS * 4

    sealed interface Result {
        /** Put [text] on the clipboard. Never empty and never longer than [MAX_TEXT_CHARS]. */
        data class Copy(val text: String) : Result

        /**
         * Nothing to copy, and nothing wrong: no `;` separator, an empty payload, a `?` read query,
         * or a payload that decodes to no text. (An empty decode writes nothing, where the desktop
         * writes an empty string: a "Copied" toast over an emptied clipboard would be a lie.)
         */
        data object Ignored : Result

        /** The payload is not base64, or its bytes are not UTF-8. The desktop ignores these too. */
        data object Invalid : Result

        /** Over [MAX_BASE64] or [MAX_TEXT_CHARS]. The user asked for a copy and should be told. */
        data object TooLarge : Result
    }

    fun parse(data: String): Result {
        val i = data.indexOf(';')
        if (i < 0 || i > MAX_SELECTION) return Result.Ignored
        // Length first: xterm.js accepts OSC payloads up to 10,000,000 characters, and there is no
        // reason to copy one out of `data` only to refuse it.
        if (data.length - i - 1 > MAX_BASE64) return Result.TooLarge
        val payload = data.substring(i + 1)
        if (payload.isEmpty() || payload == "?") return Result.Ignored
        val bytes = decodeBase64(payload) ?: return Result.Invalid
        val text = decodeUtf8(bytes) ?: return Result.Invalid
        if (text.isEmpty()) return Result.Ignored
        if (text.length > MAX_TEXT_CHARS) return Result.TooLarge
        return Result.Copy(text)
    }

    /**
     * The WHATWG forgiving-base64 decode, which is what `atob` runs: drop ASCII whitespace, drop at
     * most two trailing `=` when the length is a multiple of four, refuse a length of 1 mod 4 and
     * any character outside `A-Z a-z 0-9 + /`, and discard the leftover bits of a short last group.
     * Null = not base64. (android.util.Base64, used before, silently SKIPS characters it does not
     * know, so garbage decoded to something.)
     */
    internal fun decodeBase64(s: String): ByteArray? {
        val chars = CharArray(s.length)
        var n = 0
        for (c in s) {
            if (c == ' ' || c == '\t' || c == '\n' || c == '\u000C' || c == '\r') continue
            chars[n++] = c
        }
        if (n % 4 == 0 && n > 0 && chars[n - 1] == '=') {
            n--
            if (n > 0 && chars[n - 1] == '=') n--
        }
        if (n % 4 == 1) return null
        val out = ByteArray(n / 4 * 3 + maxOf(0, n % 4 - 1))
        var bits = 0
        var count = 0
        var o = 0
        for (k in 0 until n) {
            val v = sextet(chars[k])
            if (v < 0) return null
            bits = (bits shl 6) or v
            count += 6
            if (count >= 8) {
                count -= 8
                out[o++] = (bits shr count).toByte()
                bits = bits and ((1 shl count) - 1)
            }
        }
        return out
    }

    private fun sextet(c: Char): Int = when (c) {
        in 'A'..'Z' -> c - 'A'
        in 'a'..'z' -> c - 'a' + 26
        in '0'..'9' -> c - '0' + 52
        '+' -> 62
        '/' -> 63
        else -> -1
    }

    /**
     * Strict UTF-8: malformed input (bad or truncated sequences, overlong forms, encoded
     * surrogates) is an error, never a replacement character. One leading U+FEFF is dropped, as
     * `TextDecoder` drops it. Null = not UTF-8.
     */
    internal fun decodeUtf8(bytes: ByteArray): String? {
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: CharacterCodingException) {
            return null
        }
        return if (text.startsWith('﻿')) text.substring(1) else text
    }
}
