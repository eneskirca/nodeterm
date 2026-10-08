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

/** Runs the app's real swipe handlers; tmux scrolling itself is exercised by SshTransportTest. */
class TerminalJsScrollTest {
    private fun gesture(vararg moves: Pair<Int, Int>, configure: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("col", 2)
        put("row", 3)
        putJsonArray("moves") {
            for ((dx, dy) in moves) add(buildJsonArray { add(JsonPrimitive(dx)); add(JsonPrimitive(dy)) })
        }
        configure()
    }

    private fun run(vararg gestures: JsonObject, cellHeight: Int = 20, fontSize: Int = 13, originUnavailable: Boolean = false): List<JsonObject> =
        TerminalJsDriver.run(buildJsonObject {
            put("copyLimit", 8)
            put("fontSize", fontSize)
            put("originUnavailable", originUnavailable)
            put("screen", buildJsonObject {
                put("cols", 52)
                put("rows", 45)
                put("cellHeight", cellHeight)
            })
            putJsonArray("taps") { gestures.forEach { add(it) } }
        })["taps"]!!.jsonArray.map { it.jsonObject }

    private fun scrolls(gesture: JsonObject) = gesture["scrolls"]!!.jsonArray.map {
        it.jsonArray[0].jsonPrimitive.boolean to it.jsonArray[1].jsonPrimitive.int
    }

    private fun ntAction(fn: String, vararg args: String) = buildJsonObject {
        put("nt", fn)
        putJsonArray("args") { args.forEach { add(JsonPrimitive(it)) } }
    }

    @Test
    fun `a short swipe requests one wheel notch per rendered row of finger movement`() {
        val gestures = run(gesture(0 to 200), gesture(0 to -200), gesture(200 to 0),
            gesture(0 to 19), gesture(0 to 200) { put("fingers", 2) })
        assertEquals(listOf(true to 10), scrolls(gestures[0]), "downward drag reveals earlier output")
        assertEquals(listOf(false to 10), scrolls(gestures[1]), "upward drag moves toward live output")
        assertTrue(gestures.take(2).all { it["movePrevented"]!!.jsonPrimitive.boolean },
            "the gesture belongs to tmux rather than the browser viewport")
        for (gesture in gestures.drop(2)) assertTrue(scrolls(gesture).isEmpty(),
            "horizontal, sub-notch and multi-touch gestures do not request history")
    }

    @Test
    fun `swipe gain uses the rendered row height with a font fallback before layout`() {
        assertEquals(listOf(true to 5), scrolls(run(gesture(0 to 200), cellHeight = 40).single()))
        assertEquals(listOf(true to 10), scrolls(run(gesture(0 to 280), cellHeight = 0, fontSize = 20).single()))
    }

    @Test
    fun `terminal replies focus and both mouse encodings preserve queued history`() {
        val reports = listOf("\u001b[I", "\u001b[O", "\u001b[12;3R", "\u001b[?1;2c")
        val mouse = "\u001b[<35;4;12M"
        val legacy = "\u001b[M !!"
        val result = run(gesture(0 to 900) {
            putJsonArray("after") {
                add(buildJsonObject { put("mouse", mouse) }) // xterm marks SGR mouse as user input
                reports.forEach { add(buildJsonObject { put("report", it) }) }
                add(buildJsonObject { put("binary", legacy) })
            }
        }).single()
        assertEquals(listOf(true to 20, true to 20, true to 5), scrolls(result))
        assertTrue(result["inputs"]!!.jsonArray.isEmpty(), "reports must not enter the native input barrier")
        assertEquals(listOf(mouse) + reports + legacy,
            result["reports"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun `missing internal input origin has a guarded public fallback`() {
        val reports = listOf("\u001b[I", "\u001b[O", "\u001b[12;3R", "\u001b[?1;2c")
        val result = run(gesture(0 to 200) {
            putJsonArray("after") { reports.forEach { add(buildJsonObject { put("report", it) }) } }
        }, originUnavailable = true).single()
        assertEquals(listOf(true to 10), scrolls(result))
        assertEquals(reports, result["reports"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertTrue(result["inputs"]!!.jsonArray.isEmpty())
        val typed = run(gesture(0 to 200) {
            putJsonArray("after") { add(buildJsonObject { put("data", "x") }) }
        }, originUnavailable = true).single()
        assertTrue(scrolls(typed).isEmpty())
        assertEquals(listOf("x"), typed["inputs"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun `touch moves in one frame merge into one ordered request`() {
        val result = run(gesture(0 to 10, 0 to 50, 0 to 100, 0 to 200, 0 to 400)).single()
        assertEquals(listOf(true to 20), scrolls(result))
        assertTrue(result["scrollsBeforeFrame"]!!.jsonArray.isEmpty(), "touchmove sends nothing immediately")
        assertEquals(listOf(1), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `direction reversals during a gesture keep their order across frames`() {
        val result = run(gesture(0 to 200, 0 to -100)).single()
        assertEquals(listOf(true to 10, false to 15), scrolls(result))
        assertEquals(listOf(1, 2), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `a fast swipe retains its distance past the transport cap and drains after touchend`() {
        val result = run(gesture(0 to 900)).single()
        assertEquals(listOf(true to 20, true to 20, true to 5), scrolls(result))
        assertTrue(result["scrollsBeforeFrame"]!!.jsonArray.isEmpty())
        assertEquals(listOf(1, 2, 3), result["scrollFrames"]!!.jsonArray.map { it.jsonObject["frame"]!!.jsonPrimitive.int })
    }

    @Test
    fun `reset new input and a hidden page discard an outstanding swipe`() {
        val actions = listOf(ntAction("reset"), ntAction("paint", "eA=="), ntAction("cancelScroll"),
            ntAction("key", "esc"), ntAction("raw", "Aw=="), ntAction("submit", "eA=="),
            buildJsonObject { put("data", "x") }) +
            listOf("blur", "pagehide", "hidden", "touchcancel", "multitouch")
                .map { buildJsonObject { put("event", it) } }
        for (action in actions) {
            val result = run(gesture(0 to 900) { putJsonArray("after") { add(action) } }).single()
            assertTrue(scrolls(result).isEmpty(), "no stale scroll after $action")
            if (action == ntAction("raw", "Aw==")) {
                assertEquals(listOf("\u0003"), result["inputs"]!!.jsonArray.map { it.jsonPrimitive.content },
                    "the raw chip still sends its exact control byte")
            }
        }
    }

    @Test
    fun `cancellation after the first clamped frame drops the remainder`() {
        val cancels = listOf(ntAction("raw", "Gw=="),
            buildJsonObject { put("event", "touchcancel") }, buildJsonObject { put("event", "multitouch") })
        for (cancel in cancels) {
            val result = run(gesture(0 to 900) {
                putJsonArray("after") {
                    add(buildJsonObject { put("frame", true) })
                    add(cancel)
                }
            }).single()
            assertEquals(listOf(true to 20), scrolls(result), "nothing queued after $cancel")
            if (cancel == ntAction("raw", "Gw==")) {
                assertEquals(listOf("\u001b"), result["inputs"]!!.jsonArray.map { it.jsonPrimitive.content })
            }
        }
    }

    @Test
    fun `the delayed submit Enter cancels a swipe begun after the paste`() {
        val result = run(gesture(0 to 900) {
            putJsonArray("before") {
                add(buildJsonObject {
                    put("nt", "submit")
                    put("args", buildJsonArray { add(JsonPrimitive("eA==")); add(JsonPrimitive(true)) })
                })
            }
            putJsonArray("after") { add(buildJsonObject { put("timers", true) }) }
        }).single()
        assertTrue(scrolls(result).isEmpty(), "the delayed Enter is an input barrier too")
        assertEquals(listOf("x", "\r"), result["inputs"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun `suspending scroll cancels pending work and rejects gestures until attach resumes it`() {
        val results = run(
            gesture(0 to 900) { putJsonArray("after") { add(ntAction("suspendScroll")) } },
            gesture(0 to 200),
            gesture(0 to 200) { putJsonArray("before") { add(ntAction("resumeScroll")) } },
        )
        assertTrue(scrolls(results[0]).isEmpty())
        assertTrue(scrolls(results[1]).isEmpty())
        assertEquals(listOf(true to 10), scrolls(results[2]))
    }

    @Test
    fun `a frame delayed by a page suspension drops stale input and the next gesture works`() {
        val results = run(gesture(0 to 200) { put("frameDelay", 251) }, gesture(0 to 200))
        assertTrue(scrolls(results[0]).isEmpty())
        assertEquals(listOf(true to 10), scrolls(results[1]))
    }
}
