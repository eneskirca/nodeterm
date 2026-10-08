package dev.nodeterm.protocol.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Tolerant field reads. Everything the phone parses comes from files the desktop documents as
 * hand-editable and hostile (project.json is git-shared), so a wrong-typed field degrades to
 * "absent" — it never throws and never takes the whole listing down with it.
 */
object J {
    fun parse(text: String): JsonElement? = try {
        if (text.isBlank()) null else Json.parseToJsonElement(text)
    } catch (_: Exception) {
        null
    }

    fun obj(e: JsonElement?): JsonObject? = e as? JsonObject
    fun arr(e: JsonElement?): JsonArray? = e as? JsonArray
    fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun long(e: JsonElement?): Long? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
    fun double(e: JsonElement?): Double? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    fun bool(e: JsonElement?): Boolean? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    fun JsonObject.s(key: String): String? = str(this[key])
    fun JsonObject.l(key: String): Long? = long(this[key])
    fun JsonObject.d(key: String): Double? = double(this[key])
    fun JsonObject.b(key: String): Boolean? = bool(this[key])
    fun JsonObject.o(key: String): JsonObject? = obj(this[key])
    fun JsonObject.a(key: String): List<JsonElement> = arr(this[key]) ?: emptyList()
    fun JsonObject.objects(key: String): List<JsonObject> = a(key).mapNotNull { it as? JsonObject }
    fun JsonObject.strings(key: String): List<String> = a(key).mapNotNull { str(it) }
}
