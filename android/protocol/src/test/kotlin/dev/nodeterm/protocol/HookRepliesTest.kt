package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.*
import kotlinx.serialization.json.*
import kotlin.test.*

class HookRepliesTest {
    private val j = Json
    private val permission = j.parseToJsonElement("""{"hook_event_name":"PermissionRequest","tool_name":"Bash","permission_suggestions":[{"type":"addRules","behavior":"allow","destination":"localSettings","rules":[{"toolName":"Bash","ruleContent":"npm test"}]}]}""").jsonObject
    private val question = j.parseToJsonElement("""{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"extra":"preserved","questions":[{"question":"Which?","header":"Pick","multiSelect":true,"options":[{"label":"α","description":"First"},{"label":"β","description":"Second"}]},{"question":"__proto__","header":"Other","options":[{"label":"yes","description":""},{"label":"no","description":""}]}]}}""").jsonObject
    private fun output(text: String?) = j.parseToJsonElement(assertNotNull(text).substringAfter('\n')).jsonObject["hookSpecificOutput"]!!.jsonObject
    private fun permissionWith(update: JsonElement) = JsonObject(permission + ("permission_suggestions" to JsonArray(listOf(update))))
    private fun update(changes: Map<String, JsonElement>) = JsonObject(permission["permission_suggestions"]!!.jsonArray[0].jsonObject + changes)

    @Test fun `remember echoes only exact offered concrete rule and scope`() {
        val reply = assertNotNull(HookReplies.remember(permission, 0))
        assertTrue(reply.startsWith(HookReplies.MARKER + "\n"))
        assertEquals(permission["permission_suggestions"], output(reply)["decision"]!!.jsonObject["updatedPermissions"])
        val second = update(mapOf("destination" to JsonPrimitive("session"), "rules" to JsonArray(listOf(buildJsonObject { put("toolName", "Bash"); put("ruleContent", "npm build") }))))
        val several = JsonObject(permission + ("permission_suggestions" to JsonArray(listOf(permission["permission_suggestions"]!!.jsonArray[0], second))))
        assertEquals(JsonArray(listOf(second)), output(HookReplies.remember(several, 1))["decision"]!!.jsonObject["updatedPermissions"])
        for (destination in listOf("session", "projectSettings", "userSettings")) {
            val p = permissionWith(update(mapOf("destination" to JsonPrimitive(destination))))
            assertEquals(destination, output(HookReplies.remember(p, 0))["decision"]!!.jsonObject["updatedPermissions"]!!.jsonArray[0].jsonObject["destination"]!!.jsonPrimitive.content)
        }
    }
    @Test fun `never changes permission mode denies or unknown scope`() {
        for (changes in listOf(mapOf("type" to JsonPrimitive("setMode")), mapOf("behavior" to JsonPrimitive("deny")), mapOf("destination" to JsonPrimitive("anywhere"))))
            assertNull(HookReplies.remember(permissionWith(update(changes)), 0))
        assertNull(HookReplies.remember(permission, -1)); assertNull(HookReplies.remember(permission, 1))
        assertNull(HookReplies.remember(JsonObject(permission + ("hook_event_name" to JsonPrimitive("PreToolUse"))), 0))
    }
    @Test fun `never remembers whole tool wildcard or other tool grant`() {
        for (rule in listOf("""{"toolName":"Bash"}""", """{"toolName":"Bash","ruleContent":"*"}""", """{"toolName":"Write","ruleContent":"npm test"}""")) {
            val p = permissionWith(update(mapOf("rules" to JsonArray(listOf(j.parseToJsonElement(rule))))))
            assertNull(HookReplies.remember(p, 0))
        }
    }
    @Test fun `all question answers use option labels preserve input and follow option order`() {
        val out = output(HookReplies.answerQuestions(question, listOf(listOf(1, 0), listOf(1))))
        assertEquals("PreToolUse", out["hookEventName"]!!.jsonPrimitive.content)
        val input = out["updatedInput"]!!.jsonObject
        assertEquals(question["tool_input"]!!.jsonObject["questions"], input["questions"])
        assertEquals("preserved", input["extra"]!!.jsonPrimitive.content)
        assertEquals("α, β", input["answers"]!!.jsonObject["Which?"]!!.jsonPrimitive.content)
        assertEquals("no", input["answers"]!!.jsonObject["__proto__"]!!.jsonPrimitive.content)
    }
    @Test fun `requires complete nonduplicate valid selections for every question`() {
        for (selection in listOf(emptyList(), listOf(listOf(0)), listOf(listOf(0), listOf(0), listOf(0)), listOf(emptyList(), listOf(0)), listOf(listOf(0, 0), listOf(0)), listOf(listOf(2), listOf(0)), listOf(listOf(0), listOf(0, 1))))
            assertNull(HookReplies.answerQuestions(question, selection))
        assertNull(HookReplies.answerQuestions(permission, listOf(listOf(0))))
        assertNull(HookReplies.answerQuestions(JsonObject(question + ("agent_id" to JsonPrimitive("child"))), listOf(listOf(0), listOf(0))))
    }
    @Test fun `reply size is bounded in UTF8 bytes not character count`() {
        val large = JsonObject(question + ("tool_input" to JsonObject(question["tool_input"]!!.jsonObject + ("extra" to JsonPrimitive("界".repeat(50000))))))
        assertNull(HookReplies.answerQuestions(large, listOf(listOf(0), listOf(0))))
    }
    @Test fun `schema rejects ambiguous clipped and oversized question data`() {
        val rows = question["tool_input"]!!.jsonObject["questions"]!!.jsonArray
        assertNull(HookReplies.questions(JsonArray(listOf(rows[0], rows[0]))))
        assertNull(HookReplies.questions(JsonArray(List(5) { rows[0] })))
        val q = rows[0].jsonObject
        assertNull(HookReplies.questions(JsonArray(listOf(JsonObject(q + ("header" to JsonPrimitive("h".repeat(81))))))))
        assertNull(HookReplies.questions(JsonArray(listOf(JsonObject(q + ("multiSelect" to JsonPrimitive("true")))))))
        val repeated = JsonArray(listOf(q["options"]!!.jsonArray[0], q["options"]!!.jsonArray[0]))
        assertNull(HookReplies.questions(JsonArray(listOf(JsonObject(q + ("options" to repeated))))))
    }
    @Test fun `request ownership is exact and cannot traverse or select a different node`() {
        assertTrue(HookReplies.belongsToNode("term-1", "term-1-1700000000000-42"))
        for ((node, ticket) in listOf("term" to "term-1-1700000000000-42", "other" to "term-1-1-1", "else-1" to "term-1-1-1", "../x" to "../x-1-1", "term" to "term-1", "term" to "term-1-1.answer"))
            assertFalse(HookReplies.belongsToNode(node, ticket))
    }
    @Test fun `parser preserves additive capabilities but legacy held schema cannot become digit buttons`() {
        val questions = question["tool_input"]!!.jsonObject["questions"]!!
        val status = ProjectsParser.parseStatus("""{"nodes":{},"inbox":{"events":[{"id":"q","ts":1,"nodeId":"term-1","kind":"question","title":"Which?","questionPendingId":"term-1-1-1","questions":$questions,"options":["unsafe"]},{"id":"p","ts":1,"nodeId":"term-1","kind":"approval","title":"Approve","pendingId":"term-1-1-2","permissionSuggestions":[{"index":0,"label":"Bash(npm test) — session"}]}]}}""")!!
        val q = status.inbox!!.events[0]
        assertIs<QuestionChoices.Held>(QuestionChoices.of(q))
        assertEquals(2, q.questions.size)
        assertEquals(listOf(PermissionSuggestion(0, "Bash(npm test) — session")), status.inbox!!.events[1].permissionSuggestions)
        assertEquals(QuestionChoices.None, QuestionChoices.of(q.copy(questions = emptyList())))
        assertIs<QuestionChoices.Answer>(QuestionChoices.of(q.copy(questionPendingId = null, questions = emptyList(), multiSelect = false)))
    }
}
