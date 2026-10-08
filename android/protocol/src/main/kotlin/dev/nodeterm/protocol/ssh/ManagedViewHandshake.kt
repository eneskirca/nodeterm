package dev.nodeterm.protocol.ssh

import java.io.InputStream
import java.io.IOException

/** Consume exactly the private first line, leaving every terminal byte for SshStream. */
internal object ManagedViewHandshake {
    fun read(input: InputStream, prefix: String = "NT-MANAGED-VIEW "): String {
        val line = java.io.ByteArrayOutputStream()
        while (line.size() <= 256) {
            val next = input.read()
            if (next < 0) throw IOException("The host-created terminal refused attachment.")
            if (next == 10) {
                val text = String(line.toByteArray(), Charsets.UTF_8)
                val value = text.removeSuffix("\r").removePrefix(prefix)
                if (!text.startsWith(prefix) || !validTty(value)) throw IOException("The terminal returned an invalid attachment receipt.")
                return value
            }
            line.write(next)
        }
        throw IOException("The host-created terminal returned an oversized attachment receipt.")
    }
    fun validTty(value: String): Boolean = Regex("^/dev/(?:pts/[0-9]{1,12}|tty[A-Za-z0-9]{1,32})$").matches(value)
}
