package dev.nodeterm.protocol

import kotlinx.serialization.json.*
import kotlin.test.*

/** Runs the shipped page, with a child DOM event that can actually bubble to the terminal host. */
class TerminalJsLiveTouchTest {
    private fun page(text: String) = buildJsonObject {
        put("status", "history"); put("viewId", "b3b8e879-6449-4c8c-8529-4c02d6885878")
        put("offset", 4); put("totalRows", 49); put("cols", 52)
        put("olderTruncated", false); put("hasOlder", true); put("hasNewer", true)
        putJsonArray("rows") { add(buildJsonObject {
            put("text", text); put("isWrapped", false); put("section", "normal")
        }) }
    }
    private fun checkpoint(label: String) = buildJsonObject { put("checkpoint", label) }
    private fun frames(count: Int) = buildJsonObject { put("frames", count) }
    private fun liveTouch(type: String, y: Int = 20) = buildJsonObject {
        put("liveTouch", buildJsonObject { put("type", type); put("x", 40); put("y", y) })
    }
    private fun currentPage(text: String) = buildJsonObject { put("history", page(text)); put("epoch", 0) }
    private fun run(vararg after: JsonObject) = TerminalJsDriver.run(buildJsonObject {
        put("copyLimit", 8)
        put("screen", buildJsonObject { put("cols", 52); put("rows", 45); put("cellHeight", 20) })
        putJsonArray("historyResponses") { add(page("before")) }
        putJsonArray("taps") { add(buildJsonObject {
            put("col", 2); put("row", 3); put("startTime", 10); put("endTime", 95)
            put("moves", Json.parseToJsonElement("[[0,100,50],[0,200,90]]"))
            putJsonArray("after") {
                add(frames(2)); add(checkpoint("before-live")); after.forEach { add(it) }
            }
        }) }
    })
    private fun tap(result: JsonObject) = result["taps"]!!.jsonArray.single().jsonObject
    private fun at(result: JsonObject, label: String) = tap(result)["checkpoints"]!!.jsonArray
        .map { it.jsonObject }.single { it["label"]!!.jsonPrimitive.content == label }
    private fun int(point: JsonObject, field: String) = point[field]!!.jsonPrimitive.int
    private fun assertStopped(result: JsonObject, label: String) {
        val before = at(result, "before-live")
        val held = at(result, label)
        assertEquals(13, int(before, "notches"), "the control starts with an actual two-frame coast")
        assertEquals(int(before, "requests"), int(held, "requests"), "held Live touch must stop before click")
        assertEquals(int(before, "notches"), int(held, "notches"), "no old coast or parent gesture can send more movement")
        assertTrue(int(held, "stops") > int(before, "stops"), "touch-down must stop native pending movement")
        assertEquals(0, int(held, "framesQueued"))
        assertEquals(0, int(held, "historyCloses"), "a hold is not a Live click")
        assertTrue(held["historyVisible"]!!.jsonPrimitive.boolean, "touch-down preserves the displayed page")
    }

    @Test fun `held Live touch immediately stops a coast without a parent gesture or closing history`() {
        val result = run(liveTouch("touchstart"), checkpoint("touch-down"), frames(32),
            liveTouch("touchmove", 120), frames(4), checkpoint("held"),
            currentPage("same epoch remains current"), checkpoint("current-page"))
        assertStopped(result, "touch-down")
        assertStopped(result, "held")
        assertStopped(result, "current-page")
        val event = tap(result)["domEvents"]!!.jsonArray.first().jsonObject
        assertTrue(event["propagationStopped"]!!.jsonPrimitive.boolean)
        assertEquals(2, int(at(result, "touch-down"), "stops"), "the child cancels once without starting the parent gesture")
        assertEquals(listOf("same epoch remains current"), result["history"]!!.jsonObject["rows"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(0, result["historyCloses"]!!.jsonPrimitive.int)
    }

    @Test fun `ordinary Live click closes once after stopped touch and rejects an old delivered page`() {
        val result = run(liveTouch("touchstart"), checkpoint("touch-down"), frames(32),
            liveTouch("touchend"), buildJsonObject { put("live", true) }, checkpoint("clicked"),
            currentPage("obsolete page"), frames(8), checkpoint("late-page"))
        assertStopped(result, "touch-down")
        for (label in listOf("clicked", "late-page")) {
            val point = at(result, label)
            assertEquals(13, int(point, "notches"))
            assertEquals(0, int(point, "framesQueued"))
            assertFalse(point["historyVisible"]!!.jsonPrimitive.boolean)
            assertEquals(1, int(point, "historyCloses"))
        }
        assertTrue(result["history"]!!.jsonObject["hidden"]!!.jsonPrimitive.boolean)
    }

    @Test fun `a cancelled Live press stops movement and keeps history current without a click`() {
        val result = run(liveTouch("touchstart"), frames(32), liveTouch("touchcancel"),
            currentPage("cancelled press keeps the epoch"), frames(8), checkpoint("cancelled"))
        assertStopped(result, "cancelled")
        assertEquals(listOf("cancelled press keeps the epoch"), result["history"]!!.jsonObject["rows"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(0, result["historyCloses"]!!.jsonPrimitive.int)
        assertEquals(0, result["liveResets"]!!.jsonPrimitive.int)
    }
}
