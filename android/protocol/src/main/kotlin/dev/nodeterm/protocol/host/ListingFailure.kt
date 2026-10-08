package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.ssh.NothingFoundException
import kotlinx.coroutines.CancellationException

/** Which cached listing survives a failed refresh, independently of its error message or route. */
object ListingFailure {
    fun snapshot(previous: ProjectsSnapshot, error: Exception, now: Long = System.currentTimeMillis()): ProjectsSnapshot {
        if (error is CancellationException) throw error
        // SSH found no workspace, driven nodes or phone shells. This is an empty answer, even
        // though A02 still reports where it looked. Other failures cannot prove cached nodes ended.
        // The initial EMPTY has fetchedAt=0: the UI is still waiting for its first answer. This
        // authoritative empty answer completed a listing, so it must leave that loading state.
        return if (error is NothingFoundException) ProjectsSnapshot.EMPTY.copy(fetchedAt = now) else previous
    }
}
