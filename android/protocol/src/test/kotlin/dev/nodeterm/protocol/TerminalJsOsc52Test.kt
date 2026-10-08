package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Osc52
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
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

/**
 * A53: the app's real terminal.js, run in node against stub xterm/bridge objects ([TerminalJsDriver]).
 * It must apply the size cap it reads from the bridge BEFORE a copy crosses it, and otherwise hand
 * over the WHOLE sequence so [Osc52.parse] can apply the desktop's rules (the `;` separator, the `?`
 * refusal). Skips without node.
 */
class TerminalJsOsc52Test {
    private data class Call(val name: String, val length: Int? = null, val sameAsInput: Boolean? = null)
    private data class Outcome(val returned: Boolean, val calls: List<Call>)

    private fun run(copyLimit: Int, sequences: List<String>): Pair<Int, List<Outcome>> {
        val reply = TerminalJsDriver.run(
            buildJsonObject {
                put("copyLimit", copyLimit)
                putJsonArray("osc52") { sequences.forEach { add(JsonPrimitive(it)) } }
            }
        )
        val outcomes = reply["osc52"]!!.jsonArray.map { r ->
            val o = r.jsonObject
            Outcome(
                o["returned"]!!.jsonPrimitive.boolean,
                o["calls"]!!.jsonArray.map { c ->
                    val call = c.jsonArray
                    val arg = call.getOrNull(1) as? JsonObject
                    Call(
                        call[0].jsonPrimitive.content,
                        arg?.get("length")?.jsonPrimitive?.int,
                        arg?.get("sameAsInput")?.jsonPrimitive?.boolean
                    )
                }
            )
        }
        return reply["copyLimitCalls"]!!.jsonPrimitive.int to outcomes
    }

    private fun copied(data: String) = Call("onCopy", data.length, true)
    private val tooLarge = Call("onCopyTooLarge")

    @Test
    fun `the cap comes from the bridge and is applied before anything crosses it`() {
        val atLimit = "c;" + "A".repeat(8)
        val overLimit = "c;" + "A".repeat(9)
        val (limitCalls, results) = run(copyLimit = 8, listOf(atLimit, overLimit))
        assertTrue(limitCalls >= 1, "terminal.js must read the cap from the bridge, not keep its own")
        assertEquals(Outcome(true, listOf(copied(atLimit))), results[0])
        assertEquals(Outcome(true, listOf(tooLarge)), results[1])
    }

    @Test
    fun `the whole sequence crosses, so Kotlin sees the selection and the separator`() {
        val normal = "c;SGVsbG8="
        val query = "c;?"
        val noSeparator = "SGVsbG8="
        val (_, results) = run(copyLimit = Osc52.MAX_BASE64, listOf(normal, query, noSeparator))
        assertEquals(Outcome(true, listOf(copied(normal))), results[0])
        assertEquals(Outcome(true, listOf(copied(query))), results[1]) // Osc52.parse refuses it
        assertEquals(Outcome(true, emptyList()), results[2]) // no ';': nothing to parse
    }

    @Test
    fun `a long selection field never crosses the bridge, whatever the payload`() {
        val atMax = "c".repeat(Osc52.MAX_SELECTION) + ";SGVsbG8="
        val tooLong = "c".repeat(2_000_000) + ";SGVsbG8="
        val (_, results) = run(copyLimit = Osc52.MAX_BASE64, listOf(atMax, tooLong))
        assertEquals(Outcome(true, listOf(copied(atMax))), results[0])
        assertEquals(Outcome(true, emptyList()), results[1])
    }

    @Test
    fun `the payload tmux forwards under the desktop's cap never reaches onCopy`() {
        // 986,675 base64 characters: what the audit's verifier measured tmux 3.4 forwarding.
        val huge = "c;" + "A".repeat(986_675)
        val atCap = "c;" + "A".repeat(Osc52.MAX_BASE64)
        val (_, results) = run(copyLimit = Osc52.MAX_BASE64, listOf(huge, atCap))
        assertEquals(Outcome(true, listOf(tooLarge)), results[0])
        assertEquals(Outcome(true, listOf(copied(atCap))), results[1])
    }
}
