package dev.nodeterm.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TerminalJsKineticTest {
    private fun run(
        start: Int = 10,
        end: Int = 95,
        moves: List<List<Int>> = listOf(listOf(0, 100, 50), listOf(0, 200, 90)),
        configure: JsonObjectBuilder.() -> Unit = {},
    ): JsonObject = TerminalJsDriver.run(buildJsonObject {
        put("copyLimit", 8)
        put("screen", buildJsonObject { put("cols", 52); put("rows", 45); put("cellHeight", 20) })
        putJsonArray("taps") {
            add(buildJsonObject {
                put("col", 2); put("row", 3); put("startTime", start); put("endTime", end)
                putJsonArray("moves") { moves.forEach { move -> add(buildJsonArray { move.forEach { add(JsonPrimitive(it)) } }) } }
                configure()
            })
        }
    })["taps"]!!.jsonArray.single().jsonObject

    private fun scrolls(result: JsonObject) = result["scrolls"]!!.jsonArray.map {
        it.jsonArray[0].jsonPrimitive.boolean to it.jsonArray[1].jsonPrimitive.int
    }
    private fun distance(result: JsonObject) = scrolls(result).sumOf { it.second }
    private fun stops(result: JsonObject) = result["scrollStops"]!!.jsonArray
    private fun action(fn: String, vararg args: String) = buildJsonObject {
        put("nt", fn); putJsonArray("args") { args.forEach { add(JsonPrimitive(it)) } }
    }

    @Test
    fun `fast release coasts after the finger lifts and slows to a bounded stop`() {
        val result = run()
        assertTrue(distance(result) > 10, "the finger requested ten notches; release keeps moving")
        assertTrue(distance(result) <= 10 + 1200 / 20, "additional distance is bounded")
        assertTrue(result["endedAt"]!!.jsonPrimitive.int - 95 <= 1016, "the fling ends within its lifetime")
        assertTrue(scrolls(result).all { it.first && it.second in 1..20 })
        assertEquals(1, stops(result).size, "natural decay never cancels accepted native movement")
        val frames = result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int }
        assertEquals(frames.distinct(), frames, "one wheel request per frame")
        assertTrue(frames.last() - frames[frames.lastIndex - 1] > frames[2] - frames[1],
            "late wheel notches become further apart as motion decays")
    }

    @Test
    fun `decay follows elapsed time at different frame rates and survives a zero first delta`() {
        val totals = listOf(120, 60, 30).map { hz ->
            distance(run { put("rafInterval", 1000.0 / hz); put("frameDelay", 1000.0 / hz) })
        }
        assertTrue(totals.max() - totals.min() <= 1, "time-based motion keeps distance across frame rates: $totals")
        assertTrue(distance(run { put("frameDelay", 0) }) > 10, "a same-frame release still starts on the next frame")
    }

    @Test
    fun `slow stale untimed and stationary releases do not synthesize a fling`() {
        assertEquals(2, distance(run(end = 215, moves = listOf(listOf(0, 20, 110), listOf(0, 40, 210)))))
        assertEquals(10, distance(run(end = 185)))
        assertEquals(10, distance(run(start = 0, end = 0, moves = listOf(listOf(0, 200, 0)))))
        assertEquals(10, distance(run(end = 10, moves = listOf(listOf(0, 200, 10)))))
        assertEquals(0, distance(run(end = 55, moves = listOf(listOf(0, 8, 50)))))
    }

    @Test
    fun `a reversal coasts in the last direction while preserving earlier queued movement`() {
        val result = run(end = 75, moves = listOf(listOf(0, 100, 50), listOf(0, 60, 70)))
        val requests = scrolls(result)
        assertEquals(true to 5, requests.first())
        assertTrue(requests.drop(1).all { !it.first }, "the release continues the final upward finger motion")
        assertTrue(requests.drop(1).sumOf { it.second } > 2, "the reversal has its own recent velocity")
    }

    @Test
    fun `new touch cancels momentum and native pending movement before starting again`() {
        val result = run {
            putJsonArray("after") {
                add(buildJsonObject { put("frames", 2) })
                add(buildJsonObject { put("event", "touchstart") })
                add(buildJsonObject { put("event", "touchmove"); put("move", buildJsonArray { add(JsonPrimitive(0)); add(JsonPrimitive(-40)) }) })
            }
        }
        assertEquals(15, distance(result), "thirteen emitted old notches plus the two new reverse notches")
        assertEquals(false to 2, scrolls(result).last(), "new movement cannot reawaken the retired fling")
        assertEquals(2, stops(result).size)
        assertEquals(2, stops(result).last().jsonObject["frame"]!!.jsonPrimitive.int,
            "the interruption reaches the native queue immediately")
        assertEquals(3, result["scrollFrames"]!!.jsonArray.last().jsonObject["frame"]!!.jsonPrimitive.int,
            "native stop precedes the fresh gesture's delivery")
    }

    @Test
    fun `input reset font and page barriers stop a coast but reports preserve it`() {
        val barriers = listOf(action("reset"), action("paint", "eA=="), action("key", "esc"),
            action("raw", "Gw=="), action("submit", "eA=="), action("setFontSize", "20"),
            buildJsonObject { put("data", "x") }) + listOf("blur", "pagehide", "hidden", "touchcancel", "multitouch")
            .map { buildJsonObject { put("event", it) } }
        for (barrier in barriers) {
            val result = run {
                putJsonArray("after") { add(buildJsonObject { put("frames", 2) }); add(barrier) }
            }
            assertEquals(13, distance(result), "coast stops after $barrier")
            assertTrue(stops(result).size >= 2, "$barrier clears the native movement too")
        }
        val reported = run {
            putJsonArray("after") {
                add(buildJsonObject { put("frames", 2) })
                add(buildJsonObject { put("report", "\u001b[1;1R") })
                add(buildJsonObject { put("mouse", "\u001b[<35;3;15M") })
            }
        }
        assertEquals(distance(run()), distance(reported))
        assertEquals(1, stops(reported).size, "reports do not stop momentum")
    }

    @Test
    fun `extreme sample speed stays bounded and a suspended animation is discarded`() {
        val fast = run(end = 12, moves = listOf(listOf(0, 200, 11)))
        assertTrue(distance(fast) in 11..46, "the speed clamp limits extra distance to at most 3 px/ms × 240 ms")
        assertTrue(fast["endedAt"]!!.jsonPrimitive.int - 12 <= 1016)
        val suspended = run { put("frameDelay", 251) }
        assertEquals(0, distance(suspended))
        assertEquals(2, stops(suspended).size, "stale animation also clears native movement")
    }
}
