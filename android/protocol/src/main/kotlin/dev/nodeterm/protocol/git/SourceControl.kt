package dev.nodeterm.protocol.git

import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.GitVerb
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.HostUnansweredException
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.model.ProjectInfo
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The project's source control over the desktop's typed, jailed git bridge (audit A29): the `git.*`
 * verbs `createHostHandlers` serves (src/main/remote/host-service.ts), each one handed to the real
 * `GitService` in src/core/git-service.ts. There is no free-form git: the phone can read the status,
 * a file's diff and the recent history, stage and unstage files, commit what is staged, and push or
 * pull the current branch, which is what the bridge serves and nothing more.
 *
 * [cwd] is the project's folder as `projects.list` names it. The desktop refuses any other folder
 * ("cwd is outside the shared project roots."), and a desktop without the bridge refuses every verb
 * ("git is not served on this host."); both arrive as a [HostException] carrying that sentence, for
 * the screen to show as it is.
 *
 * Direct SSH serves the same typed verbs against listed folders on that computer, including
 * projects driven there by another desktop. A third-machine project is still refused.
 */
class SourceControl(private val conn: HostConnection, val cwd: String) {
    suspend fun status(): GitStatus = GitReplies.status(conn.git(GitVerb.STATUS, cwd)) ?: throw unreadable()

    /**
     * The diff of [file] on one side: [staged] = the index against HEAD (`--cached`), else the working
     * tree against the index, or the whole file for an untracked one.
     */
    suspend fun diff(file: GitFileChange, staged: Boolean): GitDiff = diff(file.path, staged, untracked = !staged && file.untracked)

    /**
     * An unmerged path's working tree, as plain `git diff -- <path>` shows it: the combined diff with
     * the conflict markers for a file both sides changed, git's "* Unmerged path" line otherwise.
     * Never the untracked form, which would show the conflicted file as a new one.
     */
    suspend fun diff(conflict: GitConflict): GitDiff = diff(conflict.path, staged = false, untracked = false)

    private suspend fun diff(path: String, staged: Boolean, untracked: Boolean): GitDiff {
        val body = conn.git(
            GitVerb.DIFF, cwd,
            mapOf(
                "path" to JsonPrimitive(path),
                "staged" to JsonPrimitive(staged),
                "untracked" to JsonPrimitive(untracked)
            )
        )
        return GitDiff.parse(GitReplies.diff(body) ?: throw unreadable())
    }

    suspend fun stage(paths: List<String>): GitResult =
        write(GitVerb.STAGE, "Staging", mapOf("paths" to JsonArray(paths.map(::JsonPrimitive))))

    suspend fun unstage(paths: List<String>): GitResult =
        write(GitVerb.UNSTAGE, "Unstaging", mapOf("paths" to JsonArray(paths.map(::JsonPrimitive))))

    /** Commits what is STAGED (the desktop adds nothing on its own). */
    suspend fun commit(message: String): GitResult = write(GitVerb.COMMIT, "The commit", mapOf("message" to JsonPrimitive(message)))

    /** `git push`; a branch with no upstream is pushed to `origin` with `-u` by the desktop. */
    suspend fun push(): GitResult = write(GitVerb.PUSH, "The push")

    suspend fun pull(): GitResult = write(GitVerb.PULL, "The pull")

    suspend fun history(): GitHistory = GitReplies.history(conn.git(GitVerb.HISTORY, cwd)) ?: throw unreadable()

    /**
     * A write whose request went out and got no answer (it timed out, or the connection dropped
     * while it waited) did not necessarily fail: the desktop runs it with no limit, and a commit's
     * hooks or a push to a slow remote may still be running, or may have finished, there. That is
     * said instead of a bare "RPC timed out", and the screen reads the status again to show which.
     */
    private suspend fun write(verb: GitVerb, what: String, args: Map<String, JsonElement> = emptyMap()): GitResult {
        val body = try {
            conn.git(verb, cwd, args)
        } catch (e: HostUnansweredException) {
            throw HostUnansweredException(unanswered(what))
        }
        return GitReplies.result(body) ?: throw unreadable()
    }

    private fun unreadable() = HostException("The computer's answer to a source-control request could not be read.")

    companion object {
        /** What a write that got no answer says; [what] names it ("The commit"). */
        fun unanswered(what: String): String =
            "The computer did not answer. $what may still be running there, or may have finished."

        /**
         * Why a commit cannot be made yet, or null when it can. git refuses a commit while a path is
         * unmerged; the desktop commits only what is staged and refuses an empty message ("Commit
         * message is empty."). The button says so first.
         */
        fun commitBlocker(status: GitStatus?, message: String): String? = when {
            status == null || !status.hasRepo -> "There is no repository to commit to."
            status.conflicts.isNotEmpty() -> "Resolve the conflicts on the computer first."
            status.staged.isEmpty() -> "Stage the changes to commit first."
            message.isBlank() -> "Write a commit message."
            else -> null
        }

        /** Why Push and Pull cannot run, or null when they can. */
        fun syncBlocker(status: GitStatus?): String? = when {
            status == null || !status.hasRepo -> "There is no repository."
            !status.hasRemote -> "This repository has no remote to push to or pull from."
            else -> null
        }

        /**
         * What the screen says after a write verb: git's own message as the desktop returned it, as an
         * error when the command failed there. A success that said nothing (staging) says nothing.
         */
        fun outcome(result: GitResult): Outcome? = when {
            !result.ok -> Outcome(error = true, text = result.message.ifBlank { "git failed on the computer." })
            result.message.isBlank() -> null
            else -> Outcome(error = false, text = result.message)
        }

        /**
         * Runs one write, then [reload]s the status WHATEVER happened to it, and answers what the
         * screen says. Reading again after a failure is the point: a push that git refused still
         * moved nothing, but a commit that got no answer ([HostUnansweredException]: its hooks
         * outlasted the wait, the connection dropped) may have landed on the computer all the same,
         * and a screen still showing "N staged" would then say the opposite of what is there. The
         * write's own outcome wins; a failed re-read is said only when the write had nothing to say.
         */
        suspend fun writeThenReload(label: String, write: suspend () -> GitResult?, reload: suspend () -> Unit): Outcome? {
            val said = try {
                write()?.let(::outcome)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Outcome(error = true, text = e.message ?: "$label failed.")
            }
            val reread = try {
                reload()
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Outcome(error = true, text = e.message ?: "The status could not be read again.")
            }
            return said ?: reread
        }
    }

    data class Outcome(val error: Boolean, val text: String)
}

/**
 * Whether a project's source control can be opened from the phone at all, and if not, why — decided
 * before any request, so a control can say it instead of failing on a tap (audit A29).
 */
object SourceControlGate {
    sealed interface Availability {
        /** Open it: [cwd] is the project's folder on the computer. */
        data class Available(val cwd: String) : Availability
        data class Unavailable(val reason: String) : Availability
    }

    /**
     * [leg] is where `git.*` goes right now (`LegRouting.route(Capability.GIT, …)`).
     *
     * An SSH project of the desktop is refused here rather than by the host. The listing does name
     * its folder (`ssh.remoteCwd`), but that is a path on ANOTHER machine, which the desktop's own
     * Source Control reaches over its ControlMaster; the bridge's jail is this computer's local
     * project folders, which normally do not include it, so the request would only be refused.
     */
    fun of(project: ProjectInfo?, leg: LegRouting.Leg): Availability {
        if (project == null) return Availability.Unavailable("This project is no longer on the computer.")
        // Direct SSH can use its folder HERE; this computer's relay cannot own that canvas (A27).
        if (project.drivenRemotely && leg != LegRouting.Leg.Primary) return Availability.Unavailable(LegRouting.drivenElsewhere(Capability.GIT))
        project.sshTarget?.let {
            return Availability.Unavailable(
                "This project's folder is on $it, which the computer reaches over SSH. Source control from the " +
                    "phone covers folders on the computer itself; use Source Control in nodeterm on the computer."
            )
        }
        val cwd = project.cwd?.takeIf { it.isNotBlank() }
            ?: return Availability.Unavailable("This project has no folder on the computer, so it has no repository.")
        return when (leg) {
            is LegRouting.Leg.Unavailable -> Availability.Unavailable(leg.reason)
            LegRouting.Leg.Primary, LegRouting.Leg.Relay -> Availability.Available(cwd)
        }
    }
}
