package dev.nodeterm.android.data

import android.content.Context
import dev.nodeterm.protocol.model.DictationLanguage

/** Phone-wide speech preference, separate from computer identities and terminal drafts. */
class DictationPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dictation", Context.MODE_PRIVATE)
    var languageTag: String?
        get() = DictationLanguage.canonical(prefs.getString("languageTag", null))
        set(value) {
            require(value == null || DictationLanguage.canonical(value) != null) { "Invalid dictation language" }
            val edit = prefs.edit()
            if (value == null) edit.remove("languageTag")
            else edit.putString("languageTag", DictationLanguage.canonical(value))
            edit.apply()
        }
}
