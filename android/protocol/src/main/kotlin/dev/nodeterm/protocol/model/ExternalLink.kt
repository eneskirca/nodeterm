package dev.nodeterm.protocol.model

/**
 * A link from the terminal page that the phone may open in a browser (audit A32): an `http` or
 * `https` URL, and nothing else. The page (terminal.js) only hands over a URL its URL parser wrote out
 * (`new URL(text).href`): printable ASCII, the host lower-cased and punycoded, the rest
 * percent-encoded, a backslash in the authority turned into a slash. This check is the app's own, so
 * a page that did not do that (a bug, or the bridge called with something else) still cannot hand
 * Android an `intent:`, `file:`, `content:` or `javascript:` URI to open.
 *
 * [host] is what the screen names before it opens the link ("Open <host>?"). An OSC 8 link shows a
 * label and hides its URL, so the user is shown where it really goes, user info stripped: in
 * `https://github.com@evil.example/`, the host is `evil.example`.
 */
data class ExternalLink(val url: String, val host: String) {
    companion object {
        /** Longer than any URL a page is expected to show; an OAuth URL is under 2,000 characters. */
        const val MAX_LENGTH = 8_192

        private val SCHEME = Regex("^https?://", RegexOption.IGNORE_CASE)
        private val PORT = Regex("^[0-9]*$")

        fun parse(url: String): ExternalLink? {
            if (url.isEmpty() || url.length > MAX_LENGTH) return null
            // Printable ASCII only: no space, no control character, nothing the URL parser would
            // have encoded.
            if (url.any { it.code !in 0x21..0x7e }) return null
            val scheme = SCHEME.find(url) ?: return null
            val rest = url.substring(scheme.range.last + 1)
            val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
            val authority = if (end < 0) rest else rest.substring(0, end)
            // The URL parser never leaves one here; a browser reads it as a slash, so the host
            // named below would not be the one it opens.
            if ('\\' in authority) return null
            val hostPort = authority.substringAfterLast('@')
            val host: String
            val port: String
            if (hostPort.startsWith('[')) {
                val close = hostPort.indexOf(']')
                if (close < 0) return null
                host = hostPort.substring(0, close + 1)
                val after = hostPort.substring(close + 1)
                if (after.isNotEmpty() && !after.startsWith(':')) return null
                port = after.removePrefix(":")
            } else {
                host = hostPort.substringBefore(':')
                port = hostPort.substringAfter(':', "")
            }
            if (host.isEmpty() || host == "[]" || !PORT.matches(port)) return null
            return ExternalLink(url, host.lowercase())
        }
    }
}
