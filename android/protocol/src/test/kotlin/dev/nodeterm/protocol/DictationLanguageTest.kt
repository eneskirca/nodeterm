package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Dictation
import dev.nodeterm.protocol.model.DictationLanguage
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class DictationLanguageTest {
    @Test
    fun `system default stays unset and language tags are strictly canonicalized`() {
        for (tag in listOf(null, "", "  ")) assertNull(DictationLanguage.canonical(tag))
        assertEquals("en-US", DictationLanguage.canonical(" EN-us "))
        assertEquals("zh-Hant-TW", DictationLanguage.canonical("zh-hant-tw"))
        assertEquals("de-CH", DictationLanguage.canonical("de-CH"))
        for (tag in listOf("en_US", "en-US garbage", "en-US-", "en--US", "und", "x-private", "en\nUS", "en-" + "a".repeat(130))) {
            assertNull(DictationLanguage.canonical(tag), tag)
        }
    }

    @Test
    fun `picker presents human readable regional names and drops duplicates malformed roots and locale extensions`() {
        val choices = DictationLanguage.choices(listOf(Locale.US, Locale.US, Locale.UK, Locale.GERMANY, Locale.forLanguageTag("de-CH-u-ca-gregory"), Locale.ROOT), Locale.ENGLISH)
        assertEquals(4, choices.size)
        assertEquals(setOf("en-US", "en-GB", "de-DE", "de-CH"), choices.map { it.tag }.toSet())
        assertEquals("English (United States)", choices.single { it.tag == "en-US" }.label)
        assertEquals("German (Switzerland)", choices.single { it.tag == "de-CH" }.label)
        assertEquals("System default", DictationLanguage.label(null, Locale.ENGLISH))
        assertEquals("German (Switzerland)", DictationLanguage.label("de-CH", Locale.ENGLISH))
    }

    @Test
    fun `bounded catalog keeps base languages and the retained selected language`() {
        val many = (0..1800).map { Locale.Builder().setLanguage("aa").setRegion((it % 1000).toString().padStart(3, '0')).setScript(if (it < 1000) "Latn" else "Cyrl").build() }
        val choices = DictationLanguage.choices(many + Locale.GERMAN, Locale.ENGLISH, "zu-ZA")
        assertEquals(DictationLanguage.MAX_CHOICES, choices.size)
        assertTrue(choices.any { it.tag == "de" })
        assertTrue(choices.any { it.tag == "zu-ZA" })
        assertEquals(choices.size, choices.map { it.tag }.distinct().size)
    }

    @Test
    fun `language and region search is case insensitive bounded and keeps current selection visible`() {
        val choices = DictationLanguage.choices(listOf(Locale.US, Locale.UK, Locale.GERMAN, Locale.forLanguageTag("de-CH")), Locale.ENGLISH)
        assertEquals(listOf("de-CH"), DictationLanguage.search(choices, "SWITZERLAND").map { it.tag })
        assertEquals(setOf("en-GB", "en-US"), DictationLanguage.search(choices, "english").map { it.tag }.toSet())
        assertTrue(DictationLanguage.search(choices, "missing").isEmpty())
        val many = (0..100).map { DictationLanguage.Choice("en-${it.toString().padStart(3, '0')}", "English $it") }
        val visible = DictationLanguage.search(many, "", many.last().tag)
        assertEquals(DictationLanguage.MAX_VISIBLE, visible.size)
        assertTrue(visible.contains(many.last()))
    }

    @Test
    fun `language is frozen through partial results finishing and repeated starts then refreshed next utterance`() {
        var state = Dictation.step(Dictation.State(), Dictation.Event.Start("draft", "DE-ch")).state
        assertEquals("de-CH", state.languageTag)
        val ignored = Dictation.step(state, Dictation.Event.Start("replacement", "en-US"))
        assertSame(state, ignored.state)
        assertNull(ignored.effect)
        state = Dictation.step(state, Dictation.Event.Heard("Grüezi")).state
        assertEquals("de-CH", state.languageTag)
        state = Dictation.step(state, Dictation.Event.Stop).state
        assertEquals("de-CH", state.languageTag)
        val final = Dictation.step(state, Dictation.Event.Result("Grüezi"))
        assertEquals("draft Grüezi", final.draft)
        assertNull(final.state.languageTag)
        assertEquals(Dictation.Effect.RELEASE, final.effect)
        assertEquals("en-US", Dictation.step(final.state, Dictation.Event.Start("next", "en-US")).state.languageTag)
        assertNull(Dictation.step(final.state, Dictation.Event.Start("next")).state.languageTag)
    }

    @Test
    fun `unsupported language is an actual recognizer failure and leaves a partial draft untouched`() {
        val start = Dictation.step(Dictation.State(), Dictation.Event.Start("keep", "zu-ZA"))
        val heard = Dictation.step(start.state, Dictation.Event.Heard("words"))
        val failed = Dictation.step(heard.state, Dictation.Event.Failed(Dictation.Failure.LANGUAGE_NOT_SUPPORTED))
        assertEquals("keep words", heard.draft)
        assertNull(failed.draft)
        assertEquals(Dictation.Phase.Error(Dictation.Failure.LANGUAGE_NOT_SUPPORTED), failed.state.phase)
        assertEquals(Dictation.Effect.RELEASE, failed.effect)
        assertNull(Dictation.step(failed.state, Dictation.Event.Result("late")).draft)
        assertFalse(failed.state.message!!.contains("phone's language"))
    }

    @Test
    fun `native recognizer gets the frozen preference only as an optional language extra`() {
        val controller = AppSourcePins.ui("DictationController.kt")
        assertTrue("Dictation.Event.Start(draft, preferences.languageTag)" in controller)
        assertTrue("private val preferences = DictationPreferences(context)" in controller)
        val listen = AppSourcePins.blockAfter(controller, "private fun listen()")
        AppSourcePins.assertInOrder(listen, "state.languageTag?.let { intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }", "rec.startListening(intent)")
        assertFalse("preferences.languageTag" in listen, "a listening utterance rereads a changing preference")
        assertFalse("Locale.getDefault" in listen, "default recognition must omit the extra")
    }

    @Test
    fun `preference is phone wide validated and system default removes the saved override`() {
        val prefs = AppSourcePins.app("data/DictationPreferences.kt")
        assertTrue("getSharedPreferences(\"dictation\", Context.MODE_PRIVATE)" in prefs)
        assertTrue("get() = DictationLanguage.canonical(prefs.getString(\"languageTag\", null))" in prefs)
        AppSourcePins.assertInOrder(prefs, "require(value == null || DictationLanguage.canonical(value) != null)", "if (value == null) edit.remove(\"languageTag\")", "else edit.putString(\"languageTag\", DictationLanguage.canonical(value))", "edit.apply()")
        assertFalse("hostId" in prefs)
    }

    @Test
    fun `settings selects readable languages and persists without terminal submission`() {
        val screen = AppSourcePins.ui("SettingsScreen.kt")
        val choose = AppSourcePins.blockAfter(screen, "onChoose = { tag ->")
        AppSourcePins.assertInOrder(choose, "dictationPreferences.languageTag = tag", "dictationLanguage = dictationPreferences.languageTag", "chooseDictationLanguage = false")
        val dialog = AppSourcePins.ui("DictationLanguageDialog.kt")
        assertTrue("Locale.getAvailableLocales()" in dialog)
        assertTrue("DictationLanguage.search(choices, query, selected)" in dialog)
        assertTrue("Search languages" in dialog)
        assertTrue("Availability depends on your phone's speech service and its language models." in dialog)
        assertTrue("onChoose(null)" in dialog)
        assertTrue("onChoose(choice.tag)" in dialog)
        assertTrue("choice.label" in dialog)
        assertFalse("controller.submit" in dialog)
        assertFalse("SpeechRecognizer" in dialog, "choosing a language must not start recording")
    }
}
