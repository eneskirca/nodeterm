package dev.nodeterm.protocol.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

/**
 * The input order for one installed viewer. Relay scrolls await an RPC, so launching one coroutine
 * per gesture can reorder a reversal or let Esc overtake a scroll that later re-enters copy mode.
 * There is one drain, and its lifetime belongs to this stream, never a replacement viewer.
 */
class TerminalActions(
    scope: CoroutineScope,
    private val stream: TerminalStream,
    private val onScrollView: (TerminalScrollView.Result, Long, Int) -> Unit = { _, _, _ -> },
    private val isCurrent: () -> Boolean,
) {
    private sealed interface Action {
        class Scroll(val up: Boolean, var notches: Int, val epoch: Long = 0, val displayEpoch: Int = 0) : Action
        class Input(val data: String) : Action
        class Composed(val input: ComposedInput, val result: CompletableDeferred<ComposedInputResult>, var dispatched: Boolean = false) : Action
    }

    private val lock = Any()
    private val pending = ArrayDeque<Action>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var closed = false
    // Include the currently awaited scroll / write in the budgets.
    private var scrollNotches = 0
    private var inputChars = 0
    private var inFlightComposed: Action.Composed? = null
    private var historyEpoch = 0L
    private var scrollBlocked = false
    val scrollPaused: Boolean get() = synchronized(lock) { scrollBlocked }
    /** Rechecked after a UI runnable reaches the main thread, not only before it is posted. */
    val scrollEpoch: Long get() = synchronized(lock) { historyEpoch }

    private val drain = scope.launch {
        try {
            for (signal in wake) {
                while (true) {
                    coroutineContext.ensureActive()
                    val action = synchronized(lock) {
                        if (closed || !isCurrent()) {
                            retireLocked()
                            null
                        } else when (val head = pending.firstOrNull()) {
                            is Action.Scroll -> {
                                // Leave unsent distance at the front: write() can cancel it even
                                // while this chunk's RPC is suspended. No host receives >20.
                                val chunk = minOf(head.notches, MAX_SCROLL_CALL)
                                head.notches -= chunk
                                if (head.notches == 0) pending.removeFirst()
                                Action.Scroll(head.up, chunk, historyEpoch, head.displayEpoch)
                            }
                            is Action.Input -> pending.removeFirst()
                            is Action.Composed -> pending.removeFirst().also { inFlightComposed = head }
                            null -> null
                        }
                    } ?: break
                    coroutineContext.ensureActive()
                    if (!isCurrent()) {
                        if (action is Action.Composed) action.result.complete(ComposedInputResult.refused())
                        break
                    }
                    try {
                        when (action) {
                            is Action.Scroll -> {
                                val result = stream.scrollView(action.up, action.notches)
                                synchronized(lock) {
                                    if (!closed && isCurrent() && historyEpoch == action.epoch) {
                                        if (result is TerminalScrollView.Result.Refused || result is TerminalScrollView.Result.Uncertain) {
                                            discardScrollLocked(); scrollBlocked = true
                                        }
                                        onScrollView(result, action.epoch, action.displayEpoch)
                                    }
                                }
                            }
                            is Action.Input -> stream.write(action.data)
                            is Action.Composed -> {
                                val admitted = synchronized(lock) {
                                    if (closed || !isCurrent() || action.result.isCompleted) false
                                    else { action.dispatched = true; true }
                                }
                                if (!admitted) {
                                    action.result.complete(ComposedInputResult.refused())
                                } else {
                                    val result = stream.submitComposed(action.input)
                                    action.result.complete(if (isCurrent()) result else ComposedInputResult.uncertain())
                                }
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        // A timed-out/refused relay RPC need not disconnect the transport. Do
                        // not retry uncertain movement, but keep explicit input usable (Esc).
                        synchronized(lock) {
                            if (!closed && action is Action.Scroll && isCurrent() && historyEpoch == action.epoch) {
                                discardScrollLocked()
                                scrollBlocked = true
                                onScrollView(TerminalScrollView.Result.Uncertain("Scroll could not be confirmed. Scroll was not repeated."), action.epoch, action.displayEpoch)
                            }
                        }
                        if (action is Action.Composed) action.result.complete(
                            ComposedInputResult.uncertain())
                    }
                    synchronized(lock) {
                        if (!closed) when (action) {
                            is Action.Scroll -> scrollNotches -= action.notches
                            is Action.Input -> inputChars -= action.data.length
                            is Action.Composed -> { inputChars -= action.input.size; inFlightComposed = null }
                        }
                    }
                }
                if (synchronized(lock) { closed || !isCurrent() }) break
            }
        } finally {
            synchronized(lock) { retireLocked() }
        }
    }

    /** False means the caller must report busy rather than silently discard a gesture. */
    fun scroll(up: Boolean, notches: Int, displayEpoch: Int = 0): Boolean = synchronized(lock) {
        if (closed || !drain.isActive || !isCurrent()) return false
        if (scrollBlocked) return false
        if (notches <= 0) return false
        if (notches > MAX_SCROLL_NOTCHES - scrollNotches) return false
        val tail = pending.lastOrNull()
        if (tail is Action.Scroll && tail.up == up && tail.displayEpoch == displayEpoch) {
            tail.notches += notches
        } else {
            if (pending.size >= MAX_PENDING_RUNS) return false
            pending.addLast(Action.Scroll(up, notches, displayEpoch = displayEpoch))
        }
        scrollNotches += notches
        wake.trySend(Unit)
        true
    }

    /**
     * Input is a scroll barrier: discard unsent gestures, preserving already accepted input and
     * the single in-flight RPC. Esc is then the next operation after that RPC, with no late scroll
     * from this gesture left to put tmux back into copy mode.
     */
    fun write(data: String): Boolean = addInput(data, cancelScroll = true)

    /** Automatic emulator replies (DSR/DA etc.) are ordered writes, never gesture barriers. */
    fun report(data: String): Boolean = addInput(data, cancelScroll = false)

    /** Await one captured-view Send, behind the reserved scroll and ahead of any later gesture. */
    suspend fun submit(input: ComposedInput): ComposedInputResult {
        if (!input.valid()) return ComposedInputResult.refused("Send is too large or invalid. The draft was kept.")
        val result = CompletableDeferred<ComposedInputResult>()
        val action = Action.Composed(input.normalized(), result)
        synchronized(lock) {
            if (closed || !drain.isActive || !isCurrent() ||
                pending.count { it !is Action.Scroll } >= MAX_PENDING_RUNS || input.size > MAX_INPUT_CHARS - inputChars)
                return ComposedInputResult.refused("Terminal input is busy or no longer attached. The draft was kept.")
            discardScrollLocked()
            clearHistoryLocked()
            pending.addLast(action)
            inputChars += action.input.size
            wake.trySend(Unit)
        }
        try { return result.await() }
        catch (cancelled: CancellationException) {
            // A cancelled caller may retire an unsent action. Once dispatched its result is
            // uncertain; stopping the wait never resubmits it or redirects it to another viewer.
            synchronized(lock) {
                if (pending.remove(action)) inputChars -= action.input.size
                action.result.complete(if (action.dispatched) ComposedInputResult.uncertain() else ComposedInputResult.refused())
            }
            throw cancelled
        }
    }

    /**
     * A new touch interrupts old momentum without discarding accepted input or emulator replies.
     * The single already reserved/awaited scroll is allowed to finish; later movement is new work.
     */
    fun cancelScroll(): Boolean = synchronized(lock) {
        if (closed || !drain.isActive || !isCurrent()) return false
        discardScrollLocked()
        scrollBlocked = false
        true
    }

    /** Returning to live, resizing, or explicit Send also invalidates already posted pages. */
    fun closeScrollView() = synchronized(lock) { discardScrollLocked(); clearHistoryLocked() }

    private fun addInput(data: String, cancelScroll: Boolean): Boolean = synchronized(lock) {
        if (closed || !drain.isActive || !isCurrent()) return false
        if (data.isEmpty()) return true
        val retainedRuns = if (cancelScroll) pending.count { it !is Action.Scroll } else pending.size
        if (retainedRuns >= MAX_PENDING_RUNS || data.length > MAX_INPUT_CHARS - inputChars) return false
        if (cancelScroll) { discardScrollLocked(); clearHistoryLocked() }
        pending.addLast(Action.Input(data))
        inputChars += data.length
        wake.trySend(Unit)
        true
    }

    /** Retire before leaving, replacing, or destroying the viewer. Idempotent. */
    fun close() {
        synchronized(lock) { retireLocked() }
        drain.cancel()
    }

    private fun retireLocked() {
        if (!closed) { clearHistoryLocked(); stream.retireComposed() }
        closed = true
        inFlightComposed?.let { it.result.complete(if (it.dispatched) ComposedInputResult.uncertain() else ComposedInputResult.refused()) }
        inFlightComposed = null
        pending.filterIsInstance<Action.Composed>().forEach { it.result.complete(ComposedInputResult.refused()) }
        pending.clear()
        scrollNotches = 0
        inputChars = 0
        wake.close()
    }

    private fun discardScrollLocked() {
        val iterator = pending.iterator()
        while (iterator.hasNext()) {
            val action = iterator.next()
            if (action is Action.Scroll) {
                scrollNotches -= action.notches
                iterator.remove()
            }
        }
    }

    private fun clearHistoryLocked() { historyEpoch++; scrollBlocked = false; stream.clearScrollView() }

    companion object {
        private const val MAX_PENDING_RUNS = 64
        private const val MAX_SCROLL_NOTCHES = 320
        private const val MAX_INPUT_CHARS = 1024 * 1024
        private const val MAX_SCROLL_CALL = 20
    }
}
