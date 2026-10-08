package dev.nodeterm.android.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import dev.nodeterm.protocol.model.Dictation
import dev.nodeterm.android.data.DictationPreferences

/**
 * The terminal input bar's mic (audit A59): Android's speech recognizer, driven by [Dictation], the
 * tested state machine. It writes what it hears into the draft through [setDraft], and only that: it
 * cannot send (it has no TerminalController), so the draft reaches the pane only on the user's Send,
 * the desktop's rule for its own dictation.
 *
 * The recognizer is the phone's recognition service (Google's on most phones, which may send the audio
 * to its servers, unlike the desktop's on-device Whisper). System default leaves EXTRA_LANGUAGE out.
 * An explicit Settings language is frozen at Start and sent as the documented BCP47 extra. The picker
 * uses locale display names, not a list of supported speech models; the service can still refuse an
 * unavailable/unsupported language and its actual error is shown without submitting the draft.
 *
 * Everything here runs on the main thread, where SpeechRecognizer must be used: the screen's
 * clicks, the permission result, and the recognizer's callbacks (delivered on the main thread). A
 * recognizer is made per dictation and released when it ends, and its callbacks are dropped once it
 * is no longer the current one, so a late callback of a cancelled recognizer cannot reach the next
 * dictation's draft.
 *
 * None of this has run on a device.
 */
class DictationController(private val context: Context, private val setDraft: (String) -> Unit) {
    /**
     * Whether the phone has a speech recognition service at all. When it has none the mic button is
     * not shown (the keyboard's own voice typing, where it has one, still works in the input bar). On
     * Android 11 and later this sees the service only through the manifest's `<queries>` entry for
     * `android.speech.RecognitionService`.
     */
    val available: Boolean = runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false)

    var state by mutableStateOf(Dictation.State())
        private set

    val active: Boolean get() = state.active

    private var recognizer: SpeechRecognizer? = null
    private val preferences = DictationPreferences(context)

    /** The mic was tapped with the microphone permission granted. */
    fun start(draft: String) = on(Dictation.Event.Start(draft, preferences.languageTag))

    /** The mic was tapped while listening. */
    fun stop() = on(Dictation.Event.Stop)

    /** The microphone permission was refused. */
    fun denied() = on(Dictation.Event.Denied)

    /** The draft changed other than by dictation (the user typed, or Send cleared it). */
    fun edited() = on(Dictation.Event.Edited)

    /** The error's OK. */
    fun dismiss() = on(Dictation.Event.Dismiss)

    /** The screen stopped: nothing listens in the background. What the draft shows stays. */
    fun cancel() = on(Dictation.Event.Cancel)

    /** The screen went away. */
    fun dispose() {
        on(Dictation.Event.Cancel)
        release()
    }

    private fun on(event: Dictation.Event) {
        val step = Dictation.step(state, event)
        state = step.state
        step.draft?.let(setDraft)
        when (step.effect) {
            Dictation.Effect.START -> listen()
            Dictation.Effect.STOP -> recognizer?.let { runCatching { it.stopListening() } }
            Dictation.Effect.CANCEL -> {
                recognizer?.let { runCatching { it.cancel() } }
                release()
            }
            Dictation.Effect.RELEASE -> release()
            null -> Unit
        }
    }

    private fun listen() {
        release()
        val rec = try {
            SpeechRecognizer.createSpeechRecognizer(context)
        } catch (e: Exception) {
            on(Dictation.Event.Failed(Dictation.Failure.UNKNOWN))
            return
        }
        recognizer = rec
        rec.setRecognitionListener(Listener(rec))
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        state.languageTag?.let { intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }
        try {
            rec.startListening(intent)
        } catch (e: Exception) {
            on(Dictation.Event.Failed(Dictation.Failure.UNKNOWN))
        }
    }

    private fun release() {
        val rec = recognizer ?: return
        recognizer = null
        runCatching { rec.destroy() }
    }

    private inner class Listener(private val rec: SpeechRecognizer) : RecognitionListener {
        private fun current() = recognizer === rec

        override fun onPartialResults(partialResults: Bundle?) {
            if (current()) on(Dictation.Event.Heard(firstOf(partialResults)))
        }

        override fun onResults(results: Bundle?) {
            if (current()) on(Dictation.Event.Result(firstOf(results)))
        }

        override fun onError(error: Int) {
            if (current()) on(Dictation.Event.Failed(Dictation.Failure.of(error)))
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun firstOf(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull { it.isNotBlank() }
}

/**
 * Material's "mic" icon. Its path is copied here because material-icons-core, the icon set the app
 * ships, does not have it, and the extended set is several MB of icons for this one.
 */
val MicIcon: ImageVector by lazy {
    materialIcon(name = "Filled.Mic") {
        materialPath {
            moveTo(12.0f, 14.0f)
            curveToRelative(1.66f, 0.0f, 2.99f, -1.34f, 2.99f, -3.0f)
            lineTo(15.0f, 5.0f)
            curveToRelative(0.0f, -1.66f, -1.34f, -3.0f, -3.0f, -3.0f)
            reflectiveCurveTo(9.0f, 3.34f, 9.0f, 5.0f)
            verticalLineToRelative(6.0f)
            curveToRelative(0.0f, 1.66f, 1.34f, 3.0f, 3.0f, 3.0f)
            close()
            moveTo(17.3f, 11.0f)
            curveToRelative(0.0f, 3.0f, -2.54f, 5.1f, -5.3f, 5.1f)
            reflectiveCurveTo(6.7f, 14.0f, 6.7f, 11.0f)
            lineTo(5.0f, 11.0f)
            curveToRelative(0.0f, 3.41f, 2.72f, 6.23f, 6.0f, 6.72f)
            lineTo(11.0f, 21.0f)
            horizontalLineToRelative(2.0f)
            verticalLineToRelative(-3.28f)
            curveToRelative(3.28f, -0.48f, 6.0f, -3.3f, 6.0f, -6.72f)
            horizontalLineToRelative(-1.7f)
            close()
        }
    }
}
