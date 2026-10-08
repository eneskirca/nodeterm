package dev.nodeterm.protocol.model

import kotlinx.serialization.json.*

data class PermissionSuggestion(val index: Int, val label: String)
data class HookQuestionOption(val label: String, val description: String)
data class HookQuestion(val question: String, val header: String, val options: List<HookQuestionOption>, val multiSelect: Boolean)

/** Mirrors shared/hook-answers.ts. Input is the exact held file; callers never supply hook JSON. */
object HookReplies {
    const val MAX_BYTES = 128 * 1024
    const val MARKER = "nodeterm-hook-reply-v2"
    private fun JsonObject.s(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun valid(s: String?, max: Int) = s != null && s.isNotBlank() && s.length <= max

    fun belongsToNode(nodeId: String, ticket: String): Boolean =
        Regex("^[A-Za-z0-9_-]{1,200}$").matches(nodeId) && ticket.length <= 256 &&
            ticket.startsWith("$nodeId-") && Regex("^[0-9]+-[0-9]+$").matches(ticket.substring(nodeId.length + 1))

    fun questions(value: JsonElement?): List<HookQuestion>? {
        val rows = value as? JsonArray ?: return null
        if (rows.size !in 1..4) return null
        val seen = mutableSetOf<String>()
        return rows.map { raw ->
            val q = raw as? JsonObject ?: return null
            val text = q.s("question") ?: return null
            val header = q.s("header") ?: return null
            if (!valid(text, 4096) || !valid(header, 80) || !seen.add(text)) return null
            val multi = q["multiSelect"]
            if (multi != null && (multi !is JsonPrimitive || multi.isString || multi.booleanOrNull == null)) return null
            val options = q["options"] as? JsonArray ?: return null
            if (options.size !in 2..4) return null
            val labels = mutableSetOf<String>()
            val parsed = options.map { option ->
                val o = option as? JsonObject ?: return null
                val label = o.s("label") ?: return null
                val description = o.s("description") ?: return null
                if (!valid(label, 256) || description.length > 4096 || !labels.add(label)) return null
                HookQuestionOption(label, description)
            }
            HookQuestion(text, header, parsed, (multi as? JsonPrimitive)?.booleanOrNull == true)
        }
    }

    fun permissionSuggestions(value: JsonElement?): List<PermissionSuggestion> =
        (value as? JsonArray)?.takeIf { it.size <= 32 }?.mapNotNull { raw ->
            val row = raw as? JsonObject ?: return@mapNotNull null
            val index = (row["index"] as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
            val label = row.s("label") ?: return@mapNotNull null
            if (index !in 0..31 || !valid(label, 34000)) null else PermissionSuggestion(index, label)
        } ?: emptyList()

    private fun permissionUpdate(request: JsonObject, index: Int): JsonObject? {
        if (request.s("hook_event_name") != "PermissionRequest") return null
        val tool = request.s("tool_name") ?: return null
        if (!valid(tool, 128)) return null
        val suggestions = request["permission_suggestions"] as? JsonArray ?: return null
        if (suggestions.size > 32 || index !in suggestions.indices) return null
        val update = suggestions[index] as? JsonObject ?: return null
        if (update.s("type") != "addRules" || update.s("behavior") != "allow" ||
            update.s("destination") !in listOf("session", "localSettings", "projectSettings", "userSettings")) return null
        val rules = update["rules"] as? JsonArray ?: return null
        if (rules.size !in 1..8) return null
        val checked = rules.map { raw ->
            val rule = raw as? JsonObject ?: return null
            val content = rule.s("ruleContent") ?: return null
            if (rule.s("toolName") != tool || !valid(content, 4096) || content == "*") return null
            buildJsonObject { put("toolName", tool); put("ruleContent", content) }
        }
        return buildJsonObject {
            put("type", "addRules"); put("rules", JsonArray(checked)); put("behavior", "allow")
            put("destination", update.s("destination")!!)
        }
    }

    fun remember(request: JsonObject, suggestionIndex: Int): String? {
        val update = permissionUpdate(request, suggestionIndex) ?: return null
        return reply(buildJsonObject {
            put("hookEventName", "PermissionRequest")
            putJsonObject("decision") { put("behavior", "allow"); put("updatedPermissions", JsonArray(listOf(update))) }
        })
    }

    fun answerQuestions(request: JsonObject, selections: List<List<Int>>): String? {
        if (request.s("hook_event_name") != "PreToolUse" || request.s("tool_name") != "AskUserQuestion" ||
            !request.s("agent_id").isNullOrEmpty()) return null
        val input = request["tool_input"] as? JsonObject ?: return null
        val questions = questions(input["questions"]) ?: return null
        if (!validSelections(questions, selections)) return null
        val answers = buildJsonObject {
            questions.forEachIndexed { i, q ->
                val selected = selections[i]
                put(q.question, selected.sorted().joinToString(", ") { q.options[it].label })
            }
        }
        return reply(buildJsonObject {
            put("hookEventName", "PreToolUse"); put("permissionDecision", "allow")
            put("updatedInput", JsonObject(input + ("answers" to answers)))
        })
    }

    fun validSelections(questions: List<HookQuestion>, selections: List<List<Int>>): Boolean =
        questions.size in 1..4 && questions.size == selections.size && questions.indices.all { i ->
            val q = questions[i]
            val selected = selections[i]
            selected.isNotEmpty() && selected.size <= q.options.size && selected.distinct().size == selected.size &&
                (q.multiSelect || selected.size == 1) && selected.all { it in q.options.indices }
        }

    private fun reply(output: JsonObject): String? {
        val json = buildJsonObject { put("hookSpecificOutput", output) }.toString()
        return if (json.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) "$MARKER\n$json" else null
    }
}
