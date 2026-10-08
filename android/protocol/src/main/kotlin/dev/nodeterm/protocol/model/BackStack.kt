package dev.nodeterm.protocol.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * The app's back stack, as a value (audit A43). The app's Navigator holds one of these and is only
 * type-checked; this pins the rules it delegates to.
 *
 * Each entry carries a [Entry.key] that belongs to that ENTRY, not to its destination: the same
 * screen can sit on the stack twice, and the app files each entry's saved UI state (the selected tab,
 * scroll positions, the Board's project) under its key. Only the top entry is composed, so a screen
 * below a terminal keeps its state only because its key outlives its composition.
 *
 * A key whose entry left the stack is RETIRED until the app has dropped the state filed under it
 * ([withoutRetired]); otherwise that state would be kept, and saved with the activity, for the rest of
 * the process. Retired keys are saved and restored with the stack, so an entry that left just before
 * the process died is still cleaned up after it comes back.
 *
 * The stack is never empty: [pop] refuses the root, and every operation that could empty it takes a
 * fallback.
 */
class BackStack<T> private constructor(val entries: List<Entry<T>>, val retired: List<String>) {
    data class Entry<T>(val key: String, val value: T)

    val current: T get() = entries.last().value
    val currentKey: String get() = entries.last().key
    val size: Int get() = entries.size
    val values: List<T> get() = entries.map { it.value }

    /** [value] on top, under a key no entry on this stack (or waiting to be dropped) has. */
    fun push(value: T, newKey: () -> String = ::randomKey): BackStack<T> =
        BackStack(entries + Entry(unusedKey(taken(), newKey), value), retired)

    /** Null when only the root is left: the root is never popped. */
    fun pop(): BackStack<T>? {
        if (entries.size <= 1) return null
        return BackStack(entries.dropLast(1), retired + entries.last().key)
    }

    /** [value] alone. Every entry that was on the stack leaves it, even one showing the same screen. */
    fun replaceAll(value: T, newKey: () -> String = ::randomKey): BackStack<T> =
        BackStack(listOf(Entry(unusedKey(taken(), newKey), value)), retired + entries.map { it.key })

    /**
     * The entries [keep] accepts, each under the key it had, so its saved state survives; [fallback]
     * (under a new key) when none is left.
     */
    fun retain(fallback: T, newKey: () -> String = ::randomKey, keep: (T) -> Boolean): BackStack<T> {
        val (kept, gone) = entries.partition { keep(it.value) }
        if (gone.isEmpty()) return this
        val dropped = retired + gone.map { it.key }
        return BackStack(kept.ifEmpty { listOf(Entry(unusedKey(taken(), newKey), fallback)) }, dropped)
    }

    /** The same stack once the app has dropped the state filed under every [retired] key. */
    fun withoutRetired(): BackStack<T> = if (retired.isEmpty()) this else BackStack(entries, emptyList())

    /** Every key in use: on the stack, or still naming state the app has not dropped. */
    private fun taken(): Set<String> = entries.mapTo(HashSet()) { it.key } + retired

    /**
     * `{"entries":[{"key":…,"route":[…]}],"retired":[…]}`, each value written by [route] as a list of
     * strings. [decode] reads it back.
     */
    fun encode(route: (T) -> List<String>): String = JsonObject(
        mapOf(
            "entries" to JsonArray(entries.map { e ->
                JsonObject(mapOf("key" to JsonPrimitive(e.key), "route" to JsonArray(route(e.value).map { JsonPrimitive(it) })))
            }),
            "retired" to JsonArray(retired.map { JsonPrimitive(it) })
        )
    ).toString()

    companion object {
        fun randomKey(): String = UUID.randomUUID().toString()

        /** [values] bottom first, each under a new key; [fallback] when there are none. */
        fun <T> of(values: List<T>, fallback: T, newKey: () -> String = ::randomKey): BackStack<T> {
            var stack = BackStack<T>(emptyList(), emptyList())
            for (v in values.ifEmpty { listOf(fallback) }) stack = stack.push(v, newKey)
            return stack
        }

        /**
         * Reads what [encode] wrote. An entry whose route no longer decodes ([route] returns null) is
         * dropped, never guessed, and its key is retired so the state filed under it goes too. The
         * format before keys existed (a bare array of routes, audit A22) is read with new keys. Anything
         * unreadable is [fallback] alone.
         */
        fun <T> decode(
            raw: String,
            fallback: T,
            newKey: () -> String = ::randomKey,
            route: (List<String>) -> T?,
        ): BackStack<T> {
            val root = runCatching { Json.parseToJsonElement(raw) }.getOrNull()
            return when (root) {
                is JsonArray -> of(root.mapNotNull { strings(it)?.let(route) }, fallback, newKey)
                is JsonObject -> {
                    val retired = (root["retired"] as? JsonArray)?.mapNotNull(::text).orEmpty().toMutableList()
                    val live = mutableListOf<Entry<T>>()
                    (root["entries"] as? JsonArray)?.forEach { e ->
                        val obj = e as? JsonObject ?: return@forEach
                        val key = obj["key"]?.let(::text)
                        val value = obj["route"]?.let(::strings)?.let(route)
                        when {
                            value == null -> key?.let { retired += it }
                            // A missing key, or one an entry below already has (a corrupted save),
                            // cannot be trusted to name this entry's state.
                            key == null || live.any { it.key == key } ->
                                live += Entry(unusedKey(live.mapTo(HashSet()) { it.key } + retired, newKey), value)
                            else -> live += Entry(key, value)
                        }
                    }
                    val liveKeys = live.mapTo(HashSet()) { it.key }
                    val dropped = retired.filterNot { it in liveKeys }.distinct()
                    if (live.isEmpty()) BackStack<T>(emptyList(), dropped).push(fallback, newKey)
                    else BackStack(live, dropped)
                }
                else -> of(emptyList(), fallback, newKey)
            }
        }

        /** A key from [newKey] that is not in [taken]. A random UUID in practice; a test's source may repeat. */
        private fun unusedKey(taken: Set<String>, newKey: () -> String): String {
            repeat(16) { newKey().let { if (it.isNotBlank() && it !in taken) return it } }
            return generateSequence { randomKey() }.first { it !in taken }
        }

        private fun text(e: JsonElement): String? =
            (e as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

        private fun strings(e: JsonElement): List<String>? =
            (e as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null }
    }
}
