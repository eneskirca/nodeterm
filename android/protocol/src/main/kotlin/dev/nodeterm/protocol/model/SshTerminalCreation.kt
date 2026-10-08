package dev.nodeterm.protocol.model

import dev.nodeterm.protocol.ssh.PhoneTerminals
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/** A host-owned creation survives its dialog; a presentation ticket never survives dismissal. */
class SshTerminalCreation(
    private val scope: CoroutineScope,
    private val attempt: suspend (Request) -> Unit,
    private val definitiveFailure: (Exception) -> Boolean = { it is IllegalArgumentException },
    private val newId: () -> String = { "phone-${UUID.randomUUID()}" },
) {
    data class Request(val nodeId: String, val cwd: String?)
    sealed interface State {
        data object Idle : State
        data class Creating(val request: Request) : State
        data class Failed(val request: Request, val message: String, val canChangeFolder: Boolean) : State
        data class Ready(val request: Request) : State
    }

    private val lock = Any()
    private val mutableState = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = mutableState.asStateFlow()
    private var nextTicket = 0L
    private var presentation: Long? = null

    fun show(): Long = synchronized(lock) { (++nextTicket).also { presentation = it } }
    fun hide(ticket: Long) = synchronized(lock) { if (presentation == ticket) presentation = null }
    fun isCurrent(ticket: Long): Boolean = synchronized(lock) { presentation == ticket }

    /** Admission is synchronous: rapid taps cannot launch two jobs, even on a background scope. */
    fun submit(ticket: Long, cwd: String?, onCreated: suspend (Request) -> Unit): Boolean {
        val request = synchronized(lock) {
            if (presentation != ticket || mutableState.value is State.Creating || mutableState.value is State.Ready) return false
            if (cwd != null && !PhoneTerminals.validCwd(cwd)) return false
            val failed = mutableState.value as? State.Failed
            if (failed != null && !failed.canChangeFolder && failed.request.cwd != cwd) return false
            val next = if (failed != null && failed.request.cwd == cwd) failed.request else Request(newId(), cwd)
            mutableState.value = State.Creating(next)
            next
        }
        scope.launch {
            try {
                attempt(request)
            } catch (cancelled: CancellationException) {
                synchronized(lock) {
                    mutableState.value = State.Failed(request, "Creation was interrupted. Retry to check the same terminal.", false)
                }
                throw cancelled
            } catch (error: Exception) {
                synchronized(lock) {
                    mutableState.value = State.Failed(request, error.message ?: "Could not create the terminal.", definitiveFailure(error))
                }
                return@launch
            }
            synchronized(lock) { mutableState.value = State.Ready(request) }
            // The UI switches to Main and checks this ticket again before consuming/navigating.
            if (isCurrent(ticket)) onCreated(request)
        }
        return true
    }

    /** Consume only when the original visible screen is still allowed to navigate. */
    fun takeReady(ticket: Long): Request? = synchronized(lock) {
        if (presentation != ticket) return null
        val ready = mutableState.value as? State.Ready ?: return null
        mutableState.value = State.Idle
        ready.request
    }
}

object SshTerminalFolders {
    data class Choice(val label: String, val cwd: String?)

    /** A driven-remotely project runs here; an sshTarget project runs on another computer. */
    fun choices(snapshot: ProjectsSnapshot): List<Choice> = listOf(Choice("Home folder", null)) +
        snapshot.projects.filter { it.sshTarget == null && it.cwd?.let(PhoneTerminals::validCwd) == true }
            .distinctBy { it.cwd }.map { Choice(it.name, it.cwd) }
}
