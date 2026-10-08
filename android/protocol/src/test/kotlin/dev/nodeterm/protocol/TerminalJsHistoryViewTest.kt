package dev.nodeterm.protocol

import kotlinx.serialization.json.*
import kotlin.test.*

class TerminalJsHistoryViewTest {
    private fun row(text: String, wrapped: Boolean = false, section: String = "normal") = buildJsonObject {
        put("text", text); put("isWrapped", wrapped); put("section", section)
    }
    private fun page(vararg rows: JsonObject) = buildJsonObject {
        put("status", "history"); put("viewId", "b3b8e879-6449-4c8c-8529-4c02d6885878")
        put("offset", 4); put("totalRows", rows.size + 4); put("cols", 20)
        put("olderTruncated", true); put("hasOlder", false); put("hasNewer", true)
        put("rows", JsonArray(rows.toList()))
    }
    private fun run(build: JsonObjectBuilder.() -> Unit) = TerminalJsDriver.run(buildJsonObject {
        put("copyLimit", 8)
        put("screen", buildJsonObject { put("cols", 20); put("rows", 10)
            put("lines", buildJsonArray { add(buildJsonObject { put("text", "LIVE https://live.x/") }) }) })
        build()
    })
    private fun history(result: JsonObject) = result["history"]!!.jsonObject
    private fun actionPage(page: JsonObject, epoch: Int? = null) = buildJsonObject { put("history", page); epoch?.let { put("epoch", it) } }
    private fun action(fn: String, vararg args: JsonPrimitive) = buildJsonObject { put("nt", fn); put("args", JsonArray(args.toList())) }
    private fun copy(result: JsonObject) = Json.parseToJsonElement(result["copySheet"]!!.jsonObject["raw"]!!.jsonPrimitive.content).jsonObject
    @Test fun `history is inert displayed text while live bytes continue without resets`() {
        val page = page(row("<img src=x>"), row("https://old.example/"))
        val result = run {
            put("actions", buildJsonArray { add(actionPage(page)); add(action("write", JsonPrimitive("bGl2ZSBvdXRwdXQ="))) })
            put("copySheet", true)
        }
        assertFalse(history(result)["hidden"]!!.jsonPrimitive.boolean)
        assertEquals(listOf("<img src=x>", "https://old.example/"), history(result)["rows"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("live output"), result["liveWrites"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(0, result["liveResets"]!!.jsonPrimitive.int)
        assertEquals(listOf("https://old.example/"), copy(result)["links"]!!.jsonArray.map { it.jsonPrimitive.content })
    }
    @Test fun `links and copying use displayed physical wraps and section boundaries`() {
        val page = page(row("https://example.com/a"), row("older", true), row("ALT", true, "alternate"))
        val result = run {
            put("actions", buildJsonArray { add(actionPage(page)) })
            put("taps", buildJsonArray { add(buildJsonObject { put("col", 3); put("row", 1) }) })
            put("copySheet", true)
        }
        assertEquals(listOf("https://example.com/aolder"), result["taps"]!!.jsonArray[0].jsonObject["opened"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("https://example.com/aolder", "ALT"), copy(result)["lines"]!!.jsonArray.map { it.jsonPrimitive.content })
    }
    @Test fun `a response arriving mid drag keeps continuous movement and reversal`() {
        val result = run {
            put("historyResponses", buildJsonArray { add(page(row("older"))) })
            put("taps", buildJsonArray { add(buildJsonObject {
                put("col", 3); put("row", 1)
                put("moves", buildJsonArray {
                    add(buildJsonArray { add(JsonPrimitive(0)); add(JsonPrimitive(200)) })
                    add(buildJsonArray { add(JsonPrimitive(0)); add(JsonPrimitive(-100)) })
                })
                put("moveActions", buildJsonArray { add(buildJsonArray { add(buildJsonObject { put("frame", true) }) }) })
            }) })
        }
        val scrolls = result["taps"]!!.jsonArray[0].jsonObject["scrolls"]!!.jsonArray
        assertEquals(listOf(true to 10, false to 15), scrolls.map { it.jsonArray[0].jsonPrimitive.boolean to it.jsonArray[1].jsonPrimitive.int })
        assertFalse(history(result)["hidden"]!!.jsonPrimitive.boolean)
    }
    @Test fun `old delivered pages cannot reopen after input live exit or lifecycle`() {
        val captured = page(row("old"))
        val barriers = listOf(action("raw", JsonPrimitive("Aw==")), action("key", JsonPrimitive("esc")),
            action("suspendScroll"), buildJsonObject { put("data", "x") }, buildJsonObject { put("live", true) })
        for (barrier in barriers) {
            val result = run { put("actions", buildJsonArray { add(actionPage(captured, 0)); add(barrier); add(actionPage(captured, 0)) }) }
            assertTrue(history(result)["hidden"]!!.jsonPrimitive.boolean, "$barrier must invalidate a page already queued in WebView")
            assertEquals(0, result["liveResets"]!!.jsonPrimitive.int)
        }
    }
    @Test fun `automatic reports leave the displayed history in place`() {
        val result = run { put("actions", buildJsonArray { add(actionPage(page(row("old")))); add(buildJsonObject { put("report", "\u001b[2;3R") }) }) }
        assertFalse(history(result)["hidden"]!!.jsonPrimitive.boolean)
    }
    @Test fun `copied soft wraps preserve physical cell padding`() {
        val result = run {
            put("actions", buildJsonArray { add(actionPage(page(row("x"), row("end", true)))) })
            put("copySheet", true)
        }
        assertEquals(listOf("x" + " ".repeat(19) + "end"), copy(result)["lines"]!!.jsonArray.map { it.jsonPrimitive.content })
    }
}
