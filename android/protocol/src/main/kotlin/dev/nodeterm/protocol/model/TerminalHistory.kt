package dev.nodeterm.protocol.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** A host-side literal, case-sensitive search of all retained terminal output. */
object TerminalHistory {
    const val MAX_QUERY = 256
    const val MAX_ROWS = 200
    const val MAX_BYTES = 256 * 1024
    const val CAPTURE_BYTES = 50 * 1024 * 1024
    data class Row(val line: Int, val text: String)
    data class Result(val searchedLines: Int, val truncated: Boolean, val rows: List<Row>)

    fun validQuery(query: String): Boolean = query.isNotEmpty() && query.length <= MAX_QUERY &&
        query.none { it.code < 32 || it.code == 127 }

    private fun checked(lines: Long?, truncated: Boolean?, rows: List<Row>, query: String): Result? {
        if (!validQuery(query) || lines == null || lines !in 0..Int.MAX_VALUE.toLong() || truncated == null || rows.size > MAX_ROWS) return null
        var previous = -1
        var bytes = 0L
        for (row in rows) {
            if (row.line <= previous || row.line >= lines || !row.text.contains(query) || '\n' in row.text || '\r' in row.text) return null
            previous = row.line
            bytes += row.text.toByteArray(Charsets.UTF_8).size + row.line.toString().length + 2
            if (bytes > MAX_BYTES) return null
        }
        return Result(lines.toInt(), truncated, rows)
    }

    fun parseRelay(body: JsonElement?, query: String): Result? {
        val o = J.obj(body) ?: return null
        val raw = J.arr(o["rows"]) ?: return null
        if (raw.size > MAX_ROWS) return null
        val rows = raw.map { value ->
            val row = J.obj(value) ?: return null
            val line = number(row["line"]) ?: return null
            if (line !in 0..Int.MAX_VALUE.toLong()) return null
            Row(line.toInt(), J.str(row["text"]) ?: return null)
        }
        return checked(number(o["searchedLines"]), J.bool(o["truncated"]), rows, query)
    }
    private fun number(value: JsonElement?): Long? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

    /** SSH emits a bounded, framed line protocol; text is never interpreted as a command. */
    fun parseSsh(text: String, query: String): Result? {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES + 128) return null
        val lines = text.split('\n').toMutableList()
        if (lines.lastOrNull() == "") lines.removeAt(lines.lastIndex)
        val header = lines.firstOrNull()?.split('\t') ?: return null
        if (header.size != 3 || header[0] != "NT-HISTORY-1" || header[2] !in listOf("0", "1")) return null
        if (lines.size - 1 > MAX_ROWS) return null
        val rows = lines.drop(1).map { value ->
            val split = value.indexOf('\t')
            if (split < 0) return null
            Row(value.substring(0, split).toIntOrNull() ?: return null, value.substring(split + 1))
        }
        return checked(header[1].toLongOrNull(), header[2] == "1", rows, query)
    }
}
