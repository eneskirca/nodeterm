package dev.nodeterm.protocol.host

import kotlinx.serialization.json.*

/** Inert physical rows from one immutable, viewer-owned host capture, never terminal bytes. */
object TerminalScrollView {
    const val MAX_ROWS = 200
    const val MAX_BYTES = 256 * 1024
    const val MAX_TOTAL_ROWS = 8192
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    data class Row(val text: String, val isWrapped: Boolean, val section: String)
    sealed interface Result {
        data class History(val viewId: String, val offset: Int, val totalRows: Int, val cols: Int,
            val rows: List<Row>, val olderTruncated: Boolean, val hasOlder: Boolean, val hasNewer: Boolean) : Result {
            fun json(): String = buildJsonObject {
                put("status", "history"); put("viewId", viewId); put("offset", offset)
                put("totalRows", totalRows); put("cols", cols); put("olderTruncated", olderTruncated)
                put("hasOlder", hasOlder); put("hasNewer", hasNewer)
                put("rows", buildJsonArray { rows.forEach { row -> add(buildJsonObject {
                    put("text", row.text); put("isWrapped", row.isWrapped); put("section", row.section)
                }) } })
            }.toString()
        }
        data object Input : Result
        data class Refused(val message: String) : Result
        data class Uncertain(val message: String) : Result
    }
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.number(key: String): Int? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
    private fun JsonObject.bool(key: String): Boolean? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    fun parse(value: JsonElement?): Result? {
        val o = value as? JsonObject ?: return null
        if (o.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) return null
        return when (o.string("status")) {
            "input" -> Result.Input
            "refused", "uncertain" -> {
                val message = o.string("message")?.takeIf { it.isNotBlank() && it.length <= 1024 } ?: return null
                if (o.string("status") == "refused") Result.Refused(message) else Result.Uncertain(message)
            }
            "history" -> {
                val id = o.string("viewId")?.takeIf { uuid.matches(it) } ?: return null
                val offset = o.number("offset") ?: return null
                val total = o.number("totalRows") ?: return null
                val cols = o.number("cols") ?: return null
                val older = o.bool("hasOlder") ?: return null
                val newer = o.bool("hasNewer") ?: return null
                val truncated = o.bool("olderTruncated") ?: return null
                val raw = o["rows"] as? JsonArray ?: return null
                if (total !in 1..MAX_TOTAL_ROWS || cols !in 1..65535 || raw.isEmpty() || raw.size > MAX_ROWS ||
                    offset < 0 || offset > total - raw.size || older != (offset < total - raw.size) || newer != (offset > 0)) return null
                val rows = raw.map { element ->
                    val row = element as? JsonObject ?: return null
                    val text = row.string("text") ?: return null
                    // Host emulator rows are printable text. Refuse escape/control bytes even
                    // though the WebView's separate layer would render them through textContent.
                    if (text.any { it.code < 32 || it.code in 127..159 }) return null
                    val wrapped = row.bool("isWrapped") ?: return null
                    val section = row.string("section")?.takeIf { it == "normal" || it == "alternate" } ?: return null
                    Row(text, wrapped, section)
                }
                Result.History(id, offset, total, cols, rows, truncated, older, newer)
            }
            else -> null
        }
    }
}
