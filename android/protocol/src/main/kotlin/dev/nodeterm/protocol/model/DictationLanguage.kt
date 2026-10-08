package dev.nodeterm.protocol.model

import java.util.Locale

/** Language choices are locale data, not a claim about a speech service's installed models. */
object DictationLanguage {
    const val MAX_CHOICES = 1024
    const val MAX_VISIBLE = 60
    data class Choice(val tag: String, val label: String)

    /** Strict parsing: forLanguageTag alone silently truncates malformed input. Null means default. */
    fun canonical(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty() || text.length > 128) return null
        return runCatching { Locale.Builder().setLanguageTag(text).build() }
            .getOrNull()?.takeIf { it.language.isNotEmpty() && it.language != "und" }
            ?.toLanguageTag()
    }

    fun label(tag: String?, display: Locale = Locale.getDefault()): String =
        canonical(tag)?.let { Locale.forLanguageTag(it).getDisplayName(display) } ?: "System default"

    /** Keep base languages before regional variants, so bounding a large locale catalog loses no roots. */
    fun choices(locales: List<Locale>, display: Locale = Locale.getDefault(), selected: String? = null): List<Choice> {
        val rows = locales.asSequence().take(8192).map { it.stripExtensions() }
            .mapNotNull { locale -> canonical(locale.toLanguageTag())?.let { Choice(it, locale.getDisplayName(display)) } }
            .filter { it.label.isNotBlank() && it.label.length <= 160 }
            .distinctBy { it.tag }
            .sortedWith(compareBy<Choice>({ it.tag.contains('-') }, { it.label.lowercase(display) }, { it.tag }))
            .take(MAX_CHOICES).toMutableList()
        // A retained explicit choice must remain visible even if locale catalogs change after an update.
        canonical(selected)?.takeIf { tag -> rows.none { it.tag == tag } }?.let { tag ->
            if (rows.size == MAX_CHOICES) rows.removeAt(rows.lastIndex)
            rows += Choice(tag, label(tag, display))
        }
        return rows.sortedWith(compareBy({ it.label.lowercase(display) }, { it.tag }))
    }

    fun search(choices: List<Choice>, query: String, selected: String? = null): List<Choice> {
        val text = query.trim().take(120)
        val rows = choices.filter { text.isEmpty() || it.label.contains(text, ignoreCase = true) || it.tag.contains(text, ignoreCase = true) }
            .take(MAX_VISIBLE).toMutableList()
        if (text.isEmpty()) choices.firstOrNull { it.tag == selected && it !in rows }?.let {
            if (rows.size == MAX_VISIBLE) rows.removeAt(rows.lastIndex)
            rows.add(0, it)
        }
        return rows
    }
}
