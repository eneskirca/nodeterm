package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Dictation
import dev.nodeterm.protocol.model.Dictation.Effect
import dev.nodeterm.protocol.model.Dictation.Event
import dev.nodeterm.protocol.model.Dictation.Failure
import dev.nodeterm.protocol.model.Dictation.Phase
import org.junit.jupiter.api.Assumptions
import org.w3c.dom.Element
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.util.spi.ToolProvider
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A59: dictation into the terminal's input bar. The rules (the phases, how heard words meet the
 * draft, the message for every recognizer error) are [Dictation]'s and tested here; the app's
 * DictationController and the screen's wiring cannot run on a JVM and are pinned in their source; what
 * the recognizer does on a phone is the device checklist's.
 */
class DictationTest {
    /** Runs [events] the way the screen does: the draft follows each step's `draft`, else stays. */
    private class Bar(var draft: String = "") {
        var state = Dictation.State()
        val effects = mutableListOf<Effect>()

        fun on(event: Event): Dictation.Step {
            val step = Dictation.step(state, event)
            state = step.state
            step.draft?.let { draft = it }
            step.effect?.let { effects += it }
            return step
        }

        /** The user changes the draft by hand, which the screen reports as [Event.Edited]. */
        fun type(text: String) {
            draft = text
            on(Event.Edited)
        }
    }

    @Test
    fun `partial results fill an empty draft, and a revised partial replaces the previous one`() {
        val bar = Bar()
        assertEquals(Effect.START, bar.on(Event.Start(bar.draft)).effect)
        assertEquals(Phase.Listening, bar.state.phase)
        bar.on(Event.Heard("hello wor"))
        assertEquals("hello wor", bar.draft)
        assertEquals(Phase.Partial("hello wor"), bar.state.phase)
        bar.on(Event.Heard("hello world"))
        // Not "hello wor hello world": partial results are the utterance so far, not increments.
        assertEquals("hello world", bar.draft)
        val final = bar.on(Event.Result("Hello world"))
        assertEquals("Hello world", bar.draft)
        assertEquals(Phase.Idle, bar.state.phase)
        assertEquals(Effect.RELEASE, final.effect)
        assertEquals(listOf(Effect.START, Effect.RELEASE), bar.effects)
    }

    @Test
    fun `heard words are appended to a draft typed before, never replacing it`() {
        val bar = Bar("git commit -m")
        bar.on(Event.Start(bar.draft))
        bar.on(Event.Heard("fix the"))
        assertEquals("git commit -m fix the", bar.draft)
        bar.on(Event.Result("fix the build"))
        assertEquals("git commit -m fix the build", bar.draft)

        // A draft that ends in a space or a newline gets no second one.
        assertEquals("a b", Dictation.join("a ", "b"))
        assertEquals("a\nb", Dictation.join("a\n", "b"))
        assertEquals("b", Dictation.join("", "  b  "))
        assertEquals("keep", Dictation.join("keep", "   "))
    }

    @Test
    fun `a blank final result keeps what the partial results showed`() {
        val bar = Bar("ls")
        bar.on(Event.Start(bar.draft))
        bar.on(Event.Heard("minus la"))
        bar.on(Event.Result(""))
        assertEquals("ls minus la", bar.draft)

        val none = Bar("ls")
        none.on(Event.Start(none.draft))
        none.on(Event.Result(null))
        assertEquals("ls", none.draft)
        assertEquals(Phase.Idle, none.state.phase)
    }

    @Test
    fun `the mic tapped again asks for the final result, and once more cancels`() {
        val bar = Bar()
        bar.on(Event.Start(""))
        bar.on(Event.Heard("deploy"))
        assertEquals(Effect.STOP, bar.on(Event.Stop).effect)
        assertEquals(Phase.Finishing, bar.state.phase)
        assertTrue(bar.state.active, "still active while the final result is on its way")
        // A partial result can still arrive meanwhile.
        bar.on(Event.Heard("deploy it"))
        assertEquals("deploy it", bar.draft)
        assertEquals(Phase.Finishing, bar.state.phase)
        bar.on(Event.Result("deploy it"))
        assertEquals(Phase.Idle, bar.state.phase)

        // A recognizer that never answers the stop does not keep the button stuck.
        val stuck = Bar()
        stuck.on(Event.Start(""))
        stuck.on(Event.Heard("wait"))
        stuck.on(Event.Stop)
        val again = stuck.on(Event.Stop)
        assertEquals(Effect.CANCEL, again.effect)
        assertNull(again.draft, "a cancel leaves the draft as it is")
        assertEquals("wait", stuck.draft)
        assertEquals(Phase.Idle, stuck.state.phase)
    }

    @Test
    fun `typing or sending while listening ends the dictation, and its late results are dropped`() {
        val bar = Bar("echo")
        bar.on(Event.Start(bar.draft))
        bar.on(Event.Heard("hi"))
        bar.type("echo hi there")
        assertEquals(Effect.CANCEL, bar.effects.last())
        assertEquals(Phase.Idle, bar.state.phase)
        // The cancelled recognizer's late results do not write over what the user typed.
        assertNull(bar.on(Event.Heard("hi the")).draft)
        assertNull(bar.on(Event.Result("hi there")).draft)
        assertEquals("echo hi there", bar.draft)

        // Send clears the draft: a later result must not bring the sent text back.
        val sent = Bar("make")
        sent.on(Event.Start(sent.draft))
        sent.on(Event.Heard("test"))
        sent.type("")
        assertNull(sent.on(Event.Result("test")).draft)
        assertEquals("", sent.draft)
    }

    @Test
    fun `the screen stopping cancels, keeping what the draft shows`() {
        val bar = Bar()
        bar.on(Event.Start(""))
        bar.on(Event.Heard("half a sent"))
        val step = bar.on(Event.Cancel)
        assertEquals(Effect.CANCEL, step.effect)
        assertNull(step.draft)
        assertEquals("half a sent", bar.draft)
        assertFalse(bar.state.active)
        // Nothing to cancel when idle: no effect.
        assertNull(bar.on(Event.Cancel).effect)
    }

    @Test
    fun `an error ends the dictation with its message, and a late error after a cancel is ignored`() {
        val bar = Bar("ls")
        bar.on(Event.Start(bar.draft))
        bar.on(Event.Heard("dash"))
        val failed = bar.on(Event.Failed(Failure.NETWORK))
        assertEquals(Effect.RELEASE, failed.effect)
        assertNull(failed.draft)
        assertEquals("ls dash", bar.draft, "what the draft showed stays")
        assertEquals(Phase.Error(Failure.NETWORK), bar.state.phase)
        assertEquals(Failure.NETWORK.message, bar.state.message)
        assertFalse(bar.state.active)

        // OK clears it; so does the next start.
        bar.on(Event.Dismiss)
        assertEquals(Phase.Idle, bar.state.phase)
        bar.on(Event.Failed(Failure.NO_MATCH)) // idle: a stale callback
        assertEquals(Phase.Idle, bar.state.phase)

        val again = Bar()
        again.on(Event.Start(""))
        again.on(Event.Failed(Failure.SPEECH_TIMEOUT))
        assertEquals(Effect.START, again.on(Event.Start("")).effect)
        assertEquals(Phase.Listening, again.state.phase)
        assertNull(again.state.message)

        // The client error a recognizer reports after its own cancel reaches an idle machine.
        val cancelled = Bar()
        cancelled.on(Event.Start(""))
        cancelled.on(Event.Cancel)
        val stale = cancelled.on(Event.Failed(Failure.CLIENT))
        assertEquals(Phase.Idle, cancelled.state.phase)
        assertNull(stale.effect)
    }

    @Test
    fun `a refused microphone says so, and a tap while listening never starts a second recognizer`() {
        val bar = Bar()
        val denied = bar.on(Event.Denied)
        assertEquals(Phase.Error(Failure.INSUFFICIENT_PERMISSIONS), denied.state.phase)
        assertNull(denied.effect)

        val listening = Bar()
        listening.on(Event.Start(""))
        val second = listening.on(Event.Start("other"))
        assertNull(second.effect)
        assertEquals("", listening.state.base)
        assertEquals(listOf(Effect.START), listening.effects)
        // A denial arriving while listening (it cannot, but) does not end the dictation.
        assertEquals(Phase.Listening, listening.on(Event.Denied).state.phase)
    }

    @Test
    fun `a blank partial result shows the draft as it was`() {
        val bar = Bar("cd")
        bar.on(Event.Start(bar.draft))
        bar.on(Event.Heard("src"))
        bar.on(Event.Heard("  "))
        assertEquals("cd", bar.draft)
        assertEquals(Phase.Listening, bar.state.phase)
    }

    @Test
    fun `every recognizer error code has its own failure, with a short message`() {
        val coded = Failure.entries.filter { it.code != null }
        assertEquals((1..15).toList(), coded.map { it.code })
        for (f in coded) assertEquals(f, Failure.of(f.code!!))
        for (code in listOf(0, -1, 16, 99)) assertEquals(Failure.UNKNOWN, Failure.of(code))
        for (f in Failure.entries) {
            assertTrue(f.message.isNotBlank() && f.message.endsWith("."), "$f: ${f.message}")
            assertTrue(f.message.length <= 80, "$f's message is not short: ${f.message}")
        }
    }

    @Test
    fun `the failures match SpeechRecognizer's ERROR codes in the android jar the type-check compiles against`() {
        // The codes are platform API (they never change once published), so they are written out; this
        // reads them from the android-all jar tools/typecheck resolves, when that is in the Gradle cache
        // (it is wherever the type-check has run; CI runs only this module, so there it is skipped). A
        // code a newer Android adds shows up here once the type-check's pin is moved to it.
        val typecheck = File(InteropHarness.repoRoot, "android/tools/typecheck/build.gradle.kts").readText()
        val version = Regex("""org\.robolectric:android-all:([^"]+)"""").find(typecheck)?.groupValues?.get(1)
            ?: error("tools/typecheck/build.gradle.kts no longer names its android-all")
        val gradleHome = System.getenv("GRADLE_USER_HOME")?.let(::File) ?: File(System.getProperty("user.home"), ".gradle")
        val jar = File(gradleHome, "caches/modules-2/files-2.1/org.robolectric/android-all/$version")
            .walkTopDown().firstOrNull { it.name == "android-all-$version.jar" }
        Assumptions.assumeTrue(jar != null, "android-all $version is not in the Gradle cache (run the type-check once)")
        val javap = ToolProvider.findFirst("javap").orElse(null)
        Assumptions.assumeTrue(javap != null, "this JDK has no javap")
        val out = StringWriter()
        val rc = javap.run(PrintWriter(out), PrintWriter(StringWriter()), "-cp", jar!!.path, "-constants", "android.speech.SpeechRecognizer")
        assertEquals(0, rc, out.toString())
        val platform = Regex("""public static final int ERROR_(\w+) = (\d+);""").findAll(out.toString())
            .associate { it.groupValues[1] to it.groupValues[2].toInt() }
        assertTrue(platform.size >= 15, "found only $platform in SpeechRecognizer")
        val ours = Failure.entries.filter { it.code != null }.associate { it.name to it.code!! }
        assertEquals(platform, ours, "Dictation.Failure must have one entry per SpeechRecognizer.ERROR_* code, named after it")
    }

    // ---- The app's half, which cannot run on a JVM: pinned in its source. ----

    private val controller = AppSourcePins.ui("DictationController.kt")
    private val screen = AppSourcePins.ui("TerminalScreen.kt")

    /** The source without its comments, for the checks that a call is absent. */
    private fun code(src: String) = src.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "").replace(Regex("""//[^\n]*"""), "")

    @Test
    fun `dictation writes the draft and cannot send it`() {
        val code = code(controller)
        // It has no terminal at all: no controller, no stream, no page.
        for (send in listOf("submit(", "TerminalController", "TerminalStream", ".write(", "js(", "\"nt.", "raw(", "key(")) {
            assertFalse(send in code, "DictationController reaches the pane through `$send`")
        }
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "private fun on(event: Dictation.Event)"),
            "Dictation.step(state, event)", "state = step.state", "step.draft?.let(setDraft)")
        // The screen hands it the draft's setter and nothing else.
        val setter = AppSourcePins.blockAfter(screen, "DictationController(context.applicationContext)")
        assertTrue("entry.edit(cursorAtEnd(it))" in setter, setter)
        for (send in listOf("submit(", ".write(", "raw(", "key(", "js("))
            assertFalse(send in setter, "Dictation's setter must not send: $setter")
        assertEquals(1, Regex("""DictationController\(""").findAll(screen).count())
    }

    @Test
    fun `the recognizer keeps partial results and applies only an explicit utterance language`() {
        val listen = AppSourcePins.blockAfter(controller, "private fun listen()")
        AppSourcePins.assertInOrder(listen,
            "SpeechRecognizer.createSpeechRecognizer(context)", "setRecognitionListener(Listener(rec))",
            "RecognizerIntent.ACTION_RECOGNIZE_SPEECH", "RecognizerIntent.LANGUAGE_MODEL_FREE_FORM",
            "RecognizerIntent.EXTRA_PARTIAL_RESULTS, true",
            "state.languageTag?.let { intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }",
            "rec.startListening(intent)")
        assertFalse("EXTRA_PREFER_OFFLINE" in code(controller), "an offline-only request fails where no offline model is installed")
    }

    @Test
    fun `the recognizer's callbacks are the machine's events, and only the current recognizer's`() {
        val listener = AppSourcePins.blockAfter(controller, "private inner class Listener(")
        AppSourcePins.assertInOrder(listener, "if (current()) on(Dictation.Event.Heard(firstOf(partialResults)))")
        AppSourcePins.assertInOrder(listener, "if (current()) on(Dictation.Event.Result(firstOf(results)))")
        AppSourcePins.assertInOrder(listener, "if (current()) on(Dictation.Event.Failed(Dictation.Failure.of(error)))")
        assertTrue("private fun current() = recognizer === rec" in listener, listener)
        val on = AppSourcePins.blockAfter(controller, "private fun on(event: Dictation.Event)")
        AppSourcePins.assertInOrder(on, "Dictation.Effect.START -> listen()")
        AppSourcePins.assertInOrder(on, "Dictation.Effect.STOP ->", "stopListening()")
        AppSourcePins.assertInOrder(on, "Dictation.Effect.CANCEL ->", "it.cancel()", "release()")
        AppSourcePins.assertInOrder(on, "Dictation.Effect.RELEASE -> release()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "private fun release()"), "recognizer = null", "rec.destroy()")
        assertTrue("SpeechRecognizer.isRecognitionAvailable(context)" in controller)
    }

    @Test
    fun `the screen asks for the microphone on the first tap, hides the mic without a recognizer, and cancels on stop`() {
        AppSourcePins.assertInOrder(screen,
            "rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->",
            "if (granted) dictation.start(entry.state.value.value.text) else dictation.denied()")
        val mic = AppSourcePins.blockAfter(screen, "if (dictation.available) {")
        AppSourcePins.assertInOrder(mic,
            "dictation.active -> dictation.stop()",
            "ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)",
            "PackageManager.PERMISSION_GRANTED -> dictation.start(entry.state.value.value.text)",
            "else -> askMic.launch(Manifest.permission.RECORD_AUDIO)")
        assertFalse("submit" in mic, "the mic sends nothing:\n$mic")
        // Any other change to the draft ends a dictation: typing, and Send's clear.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "onValueChange = {"), "entry.edit(it)", "dictation.edited()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "val send: () -> Unit = {"),
            "controller.submit(sent.value.text, enter = true,", "entry.clearUnchangedDraft(sent.revision)", "dictation.edited()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "LifecycleStartEffect(dictation)"), "onStopOrDispose { dictation.cancel() }")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "DisposableEffect(dictation)"), "onDispose { dictation.dispose() }")
        AppSourcePins.assertInOrder(screen, "dictation.state.message?.let { msg ->", "dictation.dismiss()")
    }

    /**
     * Review of A59: the draft was a String, and the field's String overload rebuilds its value as the
     * previous one with only the text replaced, keeping the previous cursor (clamped to the new length).
     * Dictation sets the text from code, so after it the cursor stayed where it was before (at 0 in an
     * empty draft, or mid-draft) and the next keystroke went into the middle of the dictated words:
     * typing " -s" after dictating "git status" into an empty draft gave " -sgit status". Holding the
     * draft as a TextFieldValue lets the screen say where the cursor goes. How the field and the
     * keyboard then behave is the device checklist's (item 61).
     */
    @Test
    fun `a dictated draft puts the cursor at its end, and only a change to the text ends a dictation`() {
        val code = code(screen)
        // The field gets the draft with its cursor, so the TextFieldValue overload, not the String one.
        AppSourcePins.assertInOrder(code, "entry.state.collectAsState()", "val draft = editor.value")
        AppSourcePins.assertInOrder(screen, "OutlinedTextField(", "value = draft,", "onValueChange = {")
        // Where dictation's words go (Dictation.join appends them), the cursor goes: after the last
        // character, with nothing selected or composing.
        assertTrue("private fun cursorAtEnd(text: String) = TextFieldValue(text, TextRange(text.length))" in code, screen)
        // Every write of the draft is one of these: dictation's (cursor at the end), Send's clear, or
        // the field's own report (the user's cursor). A write that keeps an old cursor, such as
        // `draft.copy(text = …)`, would bring the bug back.
        val writes = Regex("""\bentry\.(edit|clearUnchangedDraft)\(([^\n]+)""").findAll(code).map { it.groupValues[0].trim() }.toList()
        assertEquals(listOf("entry.edit(cursorAtEnd(it))", "entry.clearUnchangedDraft(sent.revision)) dictation.edited()", "entry.edit(it)"), writes, code)
        // The TextFieldValue overload also reports changes that only move the cursor or mark the word
        // the keyboard composes; those change no text and must not end a dictation (the String overload
        // reported text changes only). The comparison is with the draft before this change.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "onValueChange = {"),
            "val typed = it.text != entry.state.value.value.text", "entry.edit(it)", "if (typed) dictation.edited()")
        assertEquals(2, Regex("""dictation\.edited\(\)""").findAll(code).count(), "only typing and Send's clear end a dictation")
    }

    @Test
    fun `the manifest asks for the microphone, does not require one, and can see the recognition service`() {
        val manifest = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
            .parse(File(InteropHarness.repoRoot, "android/app/src/main/AndroidManifest.xml")).documentElement
        val ns = "http://schemas.android.com/apk/res/android"
        fun Element.kids(tag: String) = (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { it.tagName == tag }
        assertTrue(manifest.kids("uses-permission").any { it.getAttributeNS(ns, "name") == "android.permission.RECORD_AUDIO" })
        val mic = manifest.kids("uses-feature").singleOrNull { it.getAttributeNS(ns, "name") == "android.hardware.microphone" }
        assertEquals("false", mic?.getAttributeNS(ns, "required"), "RECORD_AUDIO implies a required microphone unless this says otherwise")
        // Android 11+ package visibility: without it isRecognitionAvailable is false and the mic never shows.
        val actions = manifest.kids("queries").flatMap { it.kids("intent") }.flatMap { it.kids("action") }.map { it.getAttributeNS(ns, "name") }
        assertTrue("android.speech.RecognitionService" in actions, "found: $actions")
    }
}
