package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ExternalLink
import dev.nodeterm.protocol.model.TerminalCopy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
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
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * A32: links and copying in the phone's terminal, run in the app's real terminal.js
 * ([TerminalJsDriver]) against a stub xterm buffer.
 *
 * - A URL is matched across the rows it wraps over, both xterm's soft wraps and the full-width rows a
 *   tmux repaint or an agent's fullscreen TUI paints with no wrap flag (the desktop's file-links.ts,
 *   ported). Matched row by row, a long OAuth URL opened only its first row's fragment.
 * - A tap on a link hands it to the bridge's openUrl and cancels the touchend, so the click the tap
 *   would make never reaches tmux (it runs `mouse on`); any other tap is left alone.
 * - Only http(s) reaches the bridge, from every way in: a tap, the link provider, and OSC 8 links
 *   through `options.linkHandler` (without one, xterm asks with confirm(), which the WebView cannot show).
 * - The Copy sheet gets the buffer's lines (soft wraps joined) and its links, in a shape [TerminalCopy]
 *   reads.
 *
 * Whether a tap on a phone produces exactly these events, and the app's Android half (the "Open
 * <host>?" offer, the intent, the sheet), are left to the device checklist. Skips without node.
 */
class TerminalJsLinksTest {
    private data class Line(val text: String, val wrapped: Boolean = false, val links: List<Triple<Int, Int, String>> = emptyList())
    private data class Tap(val col: Int, val row: Int, val move: Pair<Int, Int>? = null, val fingers: Int = 1)
    private data class Tapped(val prevented: Boolean, val opened: List<String>)

    private fun screen(cols: Int, rows: Int, lines: List<Line>, viewportY: Int? = null) = buildJsonObject {
        put("cols", cols)
        put("rows", rows)
        if (viewportY != null) put("viewportY", viewportY)
        putJsonArray("lines") {
            for (l in lines) add(
                buildJsonObject {
                    put("text", l.text)
                    put("wrapped", l.wrapped)
                    putJsonArray("links") {
                        for ((from, to, uri) in l.links) add(buildJsonObject { put("from", from); put("to", to); put("uri", uri) })
                    }
                }
            )
        }
    }

    private fun run(screen: JsonObject, build: JsonObjectBuilder.() -> Unit): JsonObject =
        TerminalJsDriver.run(
            buildJsonObject {
                put("copyLimit", 8)
                put("screen", screen)
                build()
            }
        )

    private fun taps(screen: JsonObject, vararg taps: Tap): List<Tapped> {
        val reply = run(screen) {
            putJsonArray("taps") {
                for (t in taps) add(
                    buildJsonObject {
                        put("col", t.col)
                        put("row", t.row)
                        if (t.move != null) put("move", buildJsonArray { add(JsonPrimitive(t.move.first)); add(JsonPrimitive(t.move.second)) })
                        put("fingers", t.fingers)
                    }
                )
            }
        }
        assertEquals(0, reply["confirmCalls"]!!.jsonPrimitive.int, "terminal.js reached xterm's confirm()")
        return reply["taps"]!!.jsonArray.map { r ->
            val o = r.jsonObject
            Tapped(o["prevented"]!!.jsonPrimitive.boolean, o["opened"]!!.jsonArray.map { it.jsonPrimitive.content })
        }
    }

    private fun opened(url: String) = Tapped(prevented = true, opened = listOf(url))
    private val passedOn = Tapped(prevented = false, opened = emptyList())

    // A 20-column screen holding a URL that a tmux repaint split over three full-width rows: no row
    // carries a wrap flag, each continuing row is full to its last column, and the next starts at 0.
    private val oauth = "https://example.com/oauth/authorize?client=abc"
    private val repainted = screen(
        cols = 20,
        rows = 6,
        lines = listOf(
            Line("Open: https://exampl"), // 20 columns
            Line("e.com/oauth/authoriz"), // 20 columns
            Line("e?client=abc"),
            Line("not a link here"),
        )
    )

    @Test
    fun `a URL repainted over several full-width rows opens whole, from a tap on any of its rows`() {
        // The first row's fragment alone ("https://exampl") is what a row-by-row match opened.
        val results = taps(repainted, Tap(col = 8, row = 0), Tap(col = 3, row = 1), Tap(col = 5, row = 2))
        assertEquals(List(3) { opened(oauth) }, results)
    }

    @Test
    fun `a URL xterm soft-wrapped opens whole`() {
        val soft = screen(
            cols = 20,
            rows = 4,
            lines = listOf(
                // A soft wrap need not fill the row: the flag says the next row continues it.
                Line("x https://example.co"),
                Line("m/a/b/c d", wrapped = true),
            )
        )
        assertEquals(listOf(opened("https://example.com/a/b/c"), opened("https://example.com/a/b/c")), taps(soft, Tap(4, 0), Tap(2, 1)))
    }

    // 70 rows of a 20-column screen that each run into the next by the repaint heuristic (full to the
    // last column, the next starting at column 0), as a TUI's bordered box paints them, with a URL on
    // row 40 below 40 such rows. The desktop's paragraphContaining walked up 32 rows and joined only
    // the 32 above row 40, so the paragraph "containing" it did not, and a scan that steps from one
    // paragraph to the next stood still on it.
    private val wall = screen(
        cols = 20,
        rows = 5,
        lines = List(40) { Line("-".repeat(20)) } + Line("https://a.example/b") + List(29) { Line("-".repeat(20)) },
        viewportY = 38
    )

    @Test
    fun `a URL under a wall of continuing rows is still found by a tap`() {
        assertEquals(listOf(opened("https://a.example/b")), taps(wall, Tap(col = 3, row = 2)))
    }

    @Test
    fun `the Copy sheet gets through a wall of continuing rows`() {
        // Without the fix this never returned: the driver times out, and on the phone the page hangs.
        val (json, _) = copySheet(wall)
        assertEquals(70, json["lines"]!!.jsonArray.size)
        assertEquals(listOf("https://a.example/b"), json["links"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun `a tap off a link, a swipe, and a second finger reach tmux untouched`() {
        val results = taps(
            repainted,
            Tap(col = 2, row = 0), // "Open:" before the URL
            Tap(col = 4, row = 3), // plain text
            Tap(col = 15, row = 2), // past the end of the URL
            Tap(col = 8, row = 0, move = 0 to 40), // a swipe that starts on the URL scrolls instead
            Tap(col = 8, row = 0, move = 11 to 0), // just past the slop
            Tap(col = 8, row = 0, fingers = 2),
        )
        assertEquals(List(6) { passedOn }, results)
    }

    @Test
    fun `a tap that wobbles within the slop is still a tap`() {
        assertEquals(listOf(opened(oauth)), taps(repainted, Tap(col = 8, row = 0, move = 6 to -6)))
    }

    @Test
    fun `a tap on an OSC 8 link opens the URL behind its label, and only an http(s) one`() {
        val osc8 = screen(
            cols = 30,
            rows = 3,
            lines = listOf(
                Line("see the docs here", links = listOf(Triple(8, 11, "https://docs.example.com/guide"))),
                Line("run evil now", links = listOf(Triple(4, 7, "javascript:alert(1)"))),
                Line("a local file", links = listOf(Triple(2, 6, "file:///etc/passwd"))),
            )
        )
        val results = taps(osc8, Tap(9, 0), Tap(5, 1), Tap(3, 2), Tap(0, 0))
        assertEquals(listOf(opened("https://docs.example.com/guide"), passedOn, passedOn, passedOn), results)
    }

    @Test
    fun `only http(s) is ever matched in the text`() {
        val other = screen(
            cols = 40,
            rows = 3,
            lines = listOf(Line("ftp://example.com/x javascript:alert(1)"), Line("file:///etc/passwd mailto:a@b.example"))
        )
        val results = taps(other, Tap(3, 0), Tap(25, 0), Tap(3, 1), Tap(25, 1))
        assertEquals(List(4) { passedOn }, results)
    }

    @Test
    fun `the link provider underlines the whole wrapped URL on every row and opens it`() {
        val reply = run(repainted) { putJsonArray("provideLinks") { add(JsonPrimitive(1)); add(JsonPrimitive(3)); add(JsonPrimitive(4)) } }
        val provided = reply["provideLinks"]!!.jsonArray.map { it.jsonObject["links"]!! }
        for (row in 0..1) {
            val link = provided[row].jsonArray.single().jsonObject
            assertEquals(oauth, link["text"]!!.jsonPrimitive.content)
            // 1-based and inclusive: from column 7 of the first row to column 12 of the third.
            val range = link["range"]!!.jsonObject
            assertEquals(listOf(7, 1, 12, 3), listOf("start", "end").flatMap { k -> listOf("x", "y").map { range[k]!!.jsonObject[it]!!.jsonPrimitive.int } })
            assertEquals(listOf(oauth), link["opened"]!!.jsonArray.map { it.jsonPrimitive.content })
        }
        assertEquals(JsonNull, provided[2], "a row with no URL has no links")
    }

    @Test
    fun `OSC 8 links go through options linkHandler, never confirm(), and only http(s) is opened`() {
        val uris = listOf("https://a.example/x", "HTTP://B.Example/y", "javascript:alert(1)", "file:///etc/passwd", "intent://x#Intent;end", "not a url")
        val reply = run(screen(20, 3, emptyList())) { putJsonArray("linkHandler") { uris.forEach { add(JsonPrimitive(it)) } } }
        val opened = reply["linkHandler"]!!.jsonArray.map { r -> r.jsonObject["opened"]!!.jsonArray.map { it.jsonPrimitive.content } }
        // The URL parser's own spelling crosses the bridge: scheme and host lower-cased.
        assertEquals(listOf(listOf("https://a.example/x"), listOf("http://b.example/y"), emptyList(), emptyList(), emptyList(), emptyList()), opened)
        assertEquals(0, reply["confirmCalls"]!!.jsonPrimitive.int)
    }

    @Test
    fun `everything that crosses the bridge is a link the app accepts`() {
        val reply = run(repainted) {
            putJsonArray("linkHandler") { add(JsonPrimitive("https://a.example/x?q=a b")) }
            putJsonArray("taps") { add(buildJsonObject { put("col", 8); put("row", 0) }) }
        }
        val crossed = (reply["linkHandler"]!!.jsonArray + reply["taps"]!!.jsonArray)
            .flatMap { r -> r.jsonObject["opened"]!!.jsonArray.map { it.jsonPrimitive.content } }
        assertEquals(2, crossed.size)
        for (url in crossed) assertNotNull(ExternalLink.parse(url), "ExternalLink refuses what terminal.js sends: $url")
    }

    private fun copySheet(screen: JsonObject): Pair<JsonObject, String> {
        val reply = run(screen) { put("copySheet", true) }
        val sheet = reply["copySheet"]!!.jsonObject
        assertEquals(1, sheet["calls"]!!.jsonPrimitive.int)
        val raw = sheet["raw"]!!.jsonPrimitive.content
        return Json.parseToJsonElement(raw).jsonObject to raw
    }

    @Test
    fun `the Copy sheet gets the lines, soft wraps joined and repainted rows kept apart, and the links`() {
        val buffer = screen(
            cols = 20,
            rows = 8,
            lines = listOf(
                Line("Open: https://exampl"),
                Line("e.com/oauth/authoriz"),
                Line("e?client=abc"),
                Line(""),
                Line("a long line that xte"),
                Line("rm wrapped itself", wrapped = true),
                // The same URI under two link ids (xterm keys OSC 8 links by id): listed once.
                Line("docs", links = listOf(Triple(0, 3, "https://docs.example.com/"), Triple(0, 0, "https://docs.example.com/"))),
                Line("evil", links = listOf(Triple(0, 3, "javascript:alert(1)"))),
            )
        )
        val (json, raw) = copySheet(buffer)
        assertEquals(
            listOf(
                "Open: https://exampl",
                "e.com/oauth/authoriz",
                "e?client=abc",
                "",
                "a long line that xterm wrapped itself",
                "docs",
                "evil"
            ),
            json["lines"]!!.jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(listOf(oauth, "https://docs.example.com/"), json["links"]!!.jsonArray.map { it.jsonPrimitive.content })
        // The app reads what the page sends.
        val parsed = assertNotNull(TerminalCopy.parse(raw))
        assertEquals(listOf(oauth, "https://docs.example.com/"), parsed.links.map { it.url })
        assertEquals(7, parsed.lines.size)
    }

    @Test
    fun `the Copy sheet drops the blank rows under the text and opens at the visible screen`() {
        // 30 rows of scrollback above a 5-row screen (a buffer with scrollback: no tmux).
        val lines = (0 until 33).map { Line("line $it") }
        val (json, raw) = copySheet(screen(cols = 20, rows = 5, lines = lines + Line("") + Line(""), viewportY = 30))
        assertEquals((0 until 33).map { "line $it" }, json["lines"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(30, json["firstVisible"]!!.jsonPrimitive.int)
        assertEquals(30, assertNotNull(TerminalCopy.parse(raw)).firstVisible)
    }

    @Test
    fun `the Copy sheet takes at most the last 500 rows, without a line cut off at the top`() {
        val lines = (0 until 600).map { i -> if (i == 100) Line("cont", wrapped = true) else Line("r$i") }
        val (json, _) = copySheet(screen(cols = 10, rows = 5, lines = lines))
        val got = json["lines"]!!.jsonArray.map { it.jsonPrimitive.content }
        // Row 100 continues row 99, which is outside the 500: it is not offered as a line of its own.
        assertEquals((101 until 600).map { "r$it" }, got)
    }

    @Test
    fun `an empty screen gives an empty sheet`() {
        val (json, raw) = copySheet(screen(cols = 20, rows = 4, lines = emptyList()))
        assertTrue(json["lines"]!!.jsonArray.isEmpty())
        assertTrue(json["links"]!!.jsonArray.isEmpty())
        assertEquals(TerminalCopy.Snapshot(emptyList(), emptyList(), 0), TerminalCopy.parse(raw))
    }
}
