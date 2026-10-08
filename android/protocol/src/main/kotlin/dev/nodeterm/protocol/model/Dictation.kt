package dev.nodeterm.protocol.model

/**
 * Dictation into the terminal screen's input bar (audit A59): the phone's own speech recognizer
 * (`android.speech.SpeechRecognizer`) writes what it hears into the draft, and nothing else. It never
 * sends: the draft goes to the pane only when the user taps Send, which is the desktop's rule for its
 * own dictation ("nothing auto-submits").
 *
 * This is the state machine and the text rules; the app's `DictationController` drives the recognizer
 * as [Step.effect] says and shows [Step.draft]. One dictation is one utterance: the recognizer ends by
 * itself once the user stops talking, or when the mic is tapped again.
 *
 * Phases: [Phase.Idle] → (Start) [Phase.Listening] → (words) [Phase.Partial] → (the final result)
 * [Phase.Idle]. A tap on the mic while listening asks the recognizer for its final result
 * ([Phase.Finishing]); a failure ends in [Phase.Error], which the next start or its OK clears. The
 * "final" of the recognizer is an event, not a phase: it fills the draft and returns to idle.
 *
 * How heard text meets the draft: the draft as it was when the dictation started is the [State.base];
 * every partial result shows as `base` + the words heard so far, and the final result replaces them
 * ([join]). So a draft typed before is kept and the dictation appends to it, an empty draft is filled,
 * and a partial result the recognizer then corrects is not left behind. The screen puts the cursor at
 * the end of every draft it writes from a [Step.draft], after the heard words, so typing after a
 * dictation continues there. Any other change to the draft's text while listening (the user types, or
 * Send clears it) ends the dictation ([Event.Edited]): later results would otherwise be joined to the
 * old base and bring back text the user deleted or sent. Moving the cursor changes no text and is not
 * an edit.
 * What the draft shows when a dictation is cancelled or fails stays in it, partial words included:
 * the user saw them there and can edit them.
 */
object Dictation {
    sealed interface Phase {
        /** Nothing is listening. The mic button starts a dictation. */
        data object Idle : Phase

        /** The recognizer was asked to listen and has heard no words yet. */
        data object Listening : Phase

        /** Words heard so far, shown in the draft. The recognizer may still revise them. */
        data class Partial(val text: String) : Phase

        /**
         * The mic was tapped again: the recognizer was told to stop listening and its final result is
         * on its way. Another tap cancels (the recognizer has to end with a result or an error, but a
         * stuck one must not keep the mic button stuck too), keeping what the draft shows.
         */
        data object Finishing : Phase

        /** The dictation ended without a result. [failure] says why, in a short sentence. */
        data class Error(val failure: Failure) : Phase
    }

    data class State(
        val phase: Phase = Phase.Idle,
        /** The draft when this dictation started: heard words are added to it. */
        val base: String = "",
        /** The words of the latest partial result, so a blank final result keeps what the draft shows. */
        val heard: String = "",
        /** The explicit language at Start; null preserves the recognizer's system default. */
        val languageTag: String? = null,
    ) {
        /** The recognizer is running (or finishing): a tap on the mic stops it rather than starting one. */
        val active: Boolean get() = phase == Phase.Listening || phase is Phase.Partial || phase == Phase.Finishing

        /** The sentence to show, while a dictation has failed. */
        val message: String? get() = (phase as? Phase.Error)?.failure?.message
    }

    /** What to do with the recognizer. */
    enum class Effect {
        /** Create a recognizer and start listening (with partial results). */
        START,

        /** `stopListening()`: end the recording and deliver the final result. */
        STOP,

        /** `cancel()` and release it: no result is wanted any more. */
        CANCEL,

        /** It is done (a final result or an error): release it. */
        RELEASE,
    }

    sealed interface Event {
        /** The mic was tapped with nothing listening, and the microphone permission is granted. */
        data class Start(val draft: String, val languageTag: String? = null) : Event

        /** A partial result. */
        data class Heard(val text: String?) : Event

        /** The final result. */
        data class Result(val text: String?) : Event

        /** The mic was tapped while listening. */
        data object Stop : Event

        /** The screen stopped or went away. */
        data object Cancel : Event

        /** The draft changed other than by this dictation: the user typed, or Send cleared it. */
        data object Edited : Event

        /** The recognizer reported an error. */
        data class Failed(val failure: Failure) : Event

        /** The microphone permission was refused. */
        data object Denied : Event

        /** The error's OK. */
        data object Dismiss : Event
    }

    /**
     * One transition: the next [state], the text the draft must show (`null` = leave the draft as it
     * is), and what to do with the recognizer (`null` = nothing).
     */
    data class Step(val state: State, val draft: String? = null, val effect: Effect? = null)

    fun step(state: State, event: Event): Step {
        val phase = state.phase
        return when (event) {
            is Event.Start ->
                if (state.active) Step(state)
                else Step(State(Phase.Listening, base = event.draft, languageTag = DictationLanguage.canonical(event.languageTag)), effect = Effect.START)
            is Event.Heard -> {
                // After a cancel, a stop that already ended, or an error: a late callback, ignored.
                if (!state.active) return Step(state)
                val heard = event.text.orEmpty().trim()
                val next = when {
                    phase == Phase.Finishing -> Phase.Finishing
                    heard.isEmpty() -> Phase.Listening
                    else -> Phase.Partial(heard)
                }
                Step(state.copy(phase = next, heard = heard), draft = join(state.base, heard))
            }
            is Event.Result -> {
                if (!state.active) return Step(state)
                // A blank final result does not take back the words a partial result already showed.
                val heard = event.text.orEmpty().trim().ifEmpty { state.heard }
                Step(State(), draft = join(state.base, heard), effect = Effect.RELEASE)
            }
            Event.Stop -> when (phase) {
                Phase.Listening, is Phase.Partial -> Step(state.copy(phase = Phase.Finishing), effect = Effect.STOP)
                Phase.Finishing -> Step(State(), effect = Effect.CANCEL)
                else -> Step(state)
            }
            Event.Cancel, Event.Edited ->
                if (state.active) Step(State(), effect = Effect.CANCEL) else Step(state)
            is Event.Failed ->
                if (state.active) Step(State(Phase.Error(event.failure)), effect = Effect.RELEASE) else Step(state)
            Event.Denied ->
                if (state.active) Step(state) else Step(State(Phase.Error(Failure.INSUFFICIENT_PERMISSIONS)))
            Event.Dismiss ->
                if (phase is Phase.Error) Step(State()) else Step(state)
        }
    }

    /**
     * The draft showing [heard] words added to [base]: the words alone in an empty draft, else after
     * a space unless the draft already ends in whitespace (a space or a newline the user typed). No
     * words leave the draft as it was.
     */
    fun join(base: String, heard: String): String {
        val words = heard.trim()
        return when {
            words.isEmpty() -> base
            base.isEmpty() || base.last().isWhitespace() -> base + words
            else -> "$base $words"
        }
    }

    /**
     * Why a dictation ended without a result: one per `SpeechRecognizer.ERROR_*` code ([code] is the
     * platform's value; the names are the constants' without `ERROR_`), plus [UNKNOWN] for a code this
     * list does not know (a newer Android's) and for a recognizer that could not be started at all.
     * Every one has a short sentence for the input bar.
     */
    enum class Failure(val code: Int?, val message: String) {
        NETWORK_TIMEOUT(1, "Speech recognition timed out on the network."),
        NETWORK(2, "Speech recognition could not reach the network."),
        AUDIO(3, "Could not record from the microphone."),
        SERVER(4, "The speech service reported an error. Try again."),
        CLIENT(5, "Dictation stopped unexpectedly. Try again."),
        SPEECH_TIMEOUT(6, "No speech heard."),
        NO_MATCH(7, "Didn't catch that. Try again."),
        RECOGNIZER_BUSY(8, "The speech recognizer is busy. Try again in a moment."),
        INSUFFICIENT_PERMISSIONS(9, "nodeterm may not use the microphone. Allow it in Android's settings."),
        TOO_MANY_REQUESTS(10, "Too many dictations for now. Try again later."),
        SERVER_DISCONNECTED(11, "The speech service disconnected. Try again."),
        LANGUAGE_NOT_SUPPORTED(12, "The speech recognizer does not support this language."),
        LANGUAGE_UNAVAILABLE(13, "This language is not downloaded for speech recognition yet."),
        CANNOT_CHECK_SUPPORT(14, "Speech recognition is not available."),
        CANNOT_LISTEN_TO_DOWNLOAD_EVENTS(15, "Speech recognition is not available."),
        UNKNOWN(null, "Speech recognition failed. Try again.");

        companion object {
            /** The failure for a `RecognitionListener.onError` code. */
            fun of(code: Int): Failure = entries.firstOrNull { it.code == code } ?: UNKNOWN
        }
    }
}
