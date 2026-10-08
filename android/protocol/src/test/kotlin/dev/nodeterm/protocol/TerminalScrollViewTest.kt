package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.TerminalScrollView
import kotlinx.serialization.json.*
import kotlin.test.*

class TerminalScrollViewTest {
    private fun page(change: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("status", "history"); put("viewId", "b3b8e879-6449-4c8c-8529-4c02d6885878")
        put("offset", 3); put("totalRows", 10); put("cols", 80)
        put("olderTruncated", true); put("hasOlder", true); put("hasNewer", true)
        put("rows", buildJsonArray { repeat(4) { add(buildJsonObject {
            put("text", "row $it"); put("isWrapped", it == 1); put("section", if (it < 2) "normal" else "alternate")
        }) } }); change()
    }
    @Test fun `physical rows retain wraps sections truncation and exact opaque identity`() {
        val parsed = assertIs<TerminalScrollView.Result.History>(TerminalScrollView.parse(page()))
        assertEquals(3, parsed.offset); assertEquals(listOf("normal", "normal", "alternate", "alternate"), parsed.rows.map { it.section })
        assertTrue(parsed.rows[1].isWrapped); assertTrue(parsed.olderTruncated)
        assertEquals(parsed, TerminalScrollView.parse(Json.parseToJsonElement(parsed.json())))
    }
    @Test fun `offset counts back from live and both boundary flags must agree`() {
        assertNotNull(TerminalScrollView.parse(page { put("offset", 0); put("hasNewer", false) }))
        assertNotNull(TerminalScrollView.parse(page { put("offset", 6); put("hasOlder", false) }))
        assertNull(TerminalScrollView.parse(page { put("offset", 7) }))
        assertNull(TerminalScrollView.parse(page { put("hasOlder", false) }))
        assertNull(TerminalScrollView.parse(page { put("hasNewer", false) }))
        assertNotNull(TerminalScrollView.parse(page { put("totalRows", 4); put("offset", 0); put("hasOlder", false); put("hasNewer", false) }))
    }
    @Test fun `wrong primitive types malformed UUID bounds and controls never become pages`() {
        for ((key, value) in listOf("offset" to JsonPrimitive("3"), "cols" to JsonPrimitive(0),
            "cols" to JsonPrimitive(65536), "totalRows" to JsonPrimitive(8193), "viewId" to JsonPrimitive("someone-elses-view"),
            "hasOlder" to JsonPrimitive("true"))) assertNull(TerminalScrollView.parse(page { put(key, value) }), key)
        for (bad in listOf("\u001b[31m", "\n", "\u009b31m")) assertNull(TerminalScrollView.parse(page {
            put("rows", buildJsonArray { add(buildJsonObject { put("text", bad); put("isWrapped", false); put("section", "normal") }) })
        }))
    }
    @Test fun `both physical row count and UTF8 byte budget are enforced`() {
        fun many(count: Int, text: String) = page {
            put("rows", buildJsonArray { repeat(count) { add(buildJsonObject { put("text", text); put("isWrapped", false); put("section", "normal") }) } })
            put("totalRows", count); put("offset", 0); put("hasOlder", false); put("hasNewer", false)
        }
        assertNotNull(TerminalScrollView.parse(many(200, "x")))
        assertNull(TerminalScrollView.parse(many(201, "x")))
        assertNull(TerminalScrollView.parse(many(100, "界".repeat(1000))))
    }
    @Test fun `input refusal uncertainty remain distinct and unknown replies never imply input`() {
        assertEquals(TerminalScrollView.Result.Input, TerminalScrollView.parse(buildJsonObject { put("status", "input") }))
        assertIs<TerminalScrollView.Result.Refused>(TerminalScrollView.parse(buildJsonObject { put("status", "refused"); put("message", "Old host") }))
        assertIs<TerminalScrollView.Result.Uncertain>(TerminalScrollView.parse(buildJsonObject { put("status", "uncertain"); put("message", "Not confirmed") }))
        assertNull(TerminalScrollView.parse(buildJsonObject { put("status", "ok") }))
        assertNull(TerminalScrollView.parse(buildJsonObject { put("status", "refused"); put("message", 42) }))
    }
}
