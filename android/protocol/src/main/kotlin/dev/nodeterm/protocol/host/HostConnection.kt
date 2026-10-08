package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.KanbanLabel
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.relay.RelaySocket
import dev.nodeterm.protocol.relay.RpcException
import dev.nodeterm.protocol.relay.RpcUnansweredException
import kotlinx.serialization.json.JsonElement
import java.io.Closeable

/** Receives one attached terminal's output. Called on a transport thread, in order. */
interface TerminalSink {
    /** The current screen to paint BEFORE any live output (the attach snapshot). */
    fun onPaint(text: String)
    /** Live terminal bytes (UTF-8; a chunk may end mid code point — decode statefully). */
    fun onOutput(bytes: ByteArray)
    /** The host reports the shared pty's real size (a desktop viewer sized it). */
    fun onResized(cols: Int, rows: Int) {}
    /**
     * This attached stream closed. [code] may describe the viewer or an attach failure, rather than
     * the pane's process; even a nonzero exit does not establish that the host session ended.
     */
    fun onExit(code: Int?)
}

/** One phone view of a node's tmux session. Detaching never ends the session. */
interface TerminalStream {
    /** True when the attach had to CREATE the tmux session (cold start: reboot, or a new node). */
    val fresh: Boolean
    fun write(text: String)
    fun resize(cols: Int, rows: Int)
    /** Scroll tmux's own history (its mouse is on): `lines` wheel notches, clamped host-side. */
    suspend fun scroll(up: Boolean, lines: Int)
    /** Known direct-SSH tmux and explicit test streams retain their original input scroll path. */
    suspend fun scrollView(up: Boolean, lines: Int): TerminalScrollView.Result {
        scroll(up, lines)
        return TerminalScrollView.Result.Input
    }
    /** An explicit input/lifecycle barrier retires this viewer's retained-history token. */
    fun clearScrollView() {}
    /** Explicit input-bar Send to this attested viewer/pane; never silently fall back to raw input. */
    suspend fun submitComposed(input: ComposedInput): ComposedInputResult =
        ComposedInputResult.refused("Send from history is unavailable on this host. Update nodeterm on the computer; the draft was kept.")
    /** Retire unsent composed actions immediately, before a queued raw-I/O detach can run. */
    fun retireComposed() {}
    /** Search all history retained by this terminal's host; a legacy host says unsupported. */
    suspend fun searchHistory(query: String): dev.nodeterm.protocol.model.TerminalHistory.Result =
        throw HostException("History search is unavailable on this host. Update nodeterm on the computer.")
    /** Stop viewing. The session keeps running. */
    suspend fun detach()
    /** Permanently end the session and take the node off its canvas (the desktop ×). */
    suspend fun endSession()
}

enum class TransportKind { RELAY, SSH }

/** What a connection can do beyond browse + attach; the UI hides what is false and says why. */
data class HostCapabilities(
    val boardWrites: Boolean,
    val git: Boolean,
    val nodeActions: Boolean,
    val registerNode: Boolean,
    /** Can answer a held hook-reply approval (docs/hook-reply-approvals.md) without keystrokes. */
    val answerApprovals: Boolean,
    /** Host-owned cold canvas creation followed by receipt-only SSH adoption. Older hosts refuse. */
    val managedCreate: Boolean = false
)

data class NewNode(val id: String, val title: String?, val agentId: String?, val accountId: String?)

/** `projects.editCardLabels` input (`parseCardLabelEdit` host-side). */
data class CardLabelEdit(
    val add: List<String> = emptyList(),
    val remove: List<String> = emptyList(),
    val create: List<Pair<String, String>> = emptyList()
)

data class LabelEditResult(val edited: Boolean, val labels: List<KanbanLabel>, val cardLabelIds: List<String>)

/**
 * What answering a held approval did. [GONE]: the hook's hold had already ended (it deletes its
 * request file when it times out after ~45 s, or someone else answered), so nothing was written —
 * the interactive prompt may be on screen now. [ALREADY_HANDLED]: a desktop that predates the
 * `reason` field said "not answered" without saying why. [FAILED] is never returned: a failed
 * write throws [HostException] so the UI can offer a retry.
 */
enum class ApprovalOutcome { SENT, GONE, ALREADY_HANDLED, UNSUPPORTED }

/**
 * One live connection to a paired computer, over either transport. Every call is honest about
 * failure: a verb the host does not serve throws [HostException] with the host's own message.
 */
interface HostConnection : Closeable {
    val kind: TransportKind
    val capabilities: HostCapabilities

    suspend fun listProjects(): ProjectsSnapshot

    /**
     * Open a terminal stream on [nodeId]'s session. Cancelling the caller while this is in flight
     * leaves nothing attached: a stream the transport opened anyway (the request was already on the
     * wire, or the blocking open finished) is detached, never handed to anyone (audit A40).
     */
    suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint? = null): TerminalStream

    suspend fun wake(nodeId: String)
    suspend fun refresh(nodeId: String)
    suspend fun rename(nodeId: String, title: String)

    suspend fun ensureBoard(projectId: String): List<KanbanColumn>?
    suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean
    suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult?
    suspend fun registerNode(projectId: String, node: NewNode): Boolean

    suspend fun prepareManagedSession(choice: ManagedSessionChoice): PreparedManagedSession =
        throw HostException("Managed session creation is unavailable on this host. Update nodeterm on the computer.")
    suspend fun createManagedSession(request: PreparedManagedSession): ManagedSessionReceipt =
        throw HostException("Managed session creation is unavailable on this host. Update nodeterm on the computer.")
    /** Attach to exactly the confirmed host-created generation. This never creates or launches. */
    suspend fun attachManagedSession(adoption: ManagedSessionAdoption, cols: Int, rows: Int, sink: TerminalSink): TerminalStream =
        throw HostException("Connect over SSH to open this host-created terminal.")

    /**
     * Answer a held hook-reply approval (one that carries a `pendingId`): the relay's
     * `approvals.answer` verb, or the `.answer` file over SSH. [ApprovalOutcome.UNSUPPORTED] means
     * this host cannot (an older desktop, no pendingId) — the caller falls back to keystrokes only
     * when the prompt is actually on screen.
     */
    suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome
    /** Remember only a concrete rule supplied by this exact held approval. No keystroke fallback. */
    suspend fun rememberApproval(event: InboxEvent, suggestionIndex: Int): ApprovalOutcome = ApprovalOutcome.UNSUPPORTED
    /** Answer all held questions atomically, using option indexes from their full schema. */
    suspend fun answerQuestions(event: InboxEvent, selections: List<List<Int>>): ApprovalOutcome = ApprovalOutcome.UNSUPPORTED

    /** Tell the computer this phone READ a finished session (clears its unread, archives the card). */
    suspend fun ackRead(nodeId: String, eventId: String?)

    /** Type raw keys into a node's pane (quick approve / answer fallback). */
    suspend fun sendKeys(nodeId: String, keys: String)

    /**
     * What owns [nodeId]'s pane right now (tmux `#{pane_current_command}`: a shell, or the CLI
     * running in it), or null when it cannot be read. Never throws for a failed read: null is
     * "unknown", and every caller treats unknown as "not a shell". The relay serves no such verb;
     * nothing asks it there, since through the relay the desktop does its own wake ([ResumeOffer]).
     */
    suspend fun paneCommand(nodeId: String): String? = null

    suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement> = emptyMap()): JsonElement?

    /** Fires when the host signals a change worth a re-list (a canvas push, a reconnect). */
    fun setOnChanged(listener: (() -> Unit)?)
    /** Fires once when the connection drops on its own. */
    fun setOnClosed(listener: ((String?) -> Unit)?)
}

/**
 * The typed `git.*` verbs of the desktop's jailed git bridge (host-service.ts `handleGit`), and how
 * long the phone waits for each. The desktop runs every one with no limit of its own, and each WRITE
 * can legitimately take minutes there: push and pull talk to the repository's remote over the
 * network; commit runs the repository's pre-commit and commit-msg hooks (a lint or a test run) and
 * may wait on a signing passphrase; stage runs clean filters (Git LFS) over what it adds. Giving up
 * after the usual RPC wait would report a failure for a command still running there, so the writes
 * wait [GIT_WRITE_TIMEOUT_MS]. The reads keep the usual wait.
 */
enum class GitVerb(val wire: String, val timeoutMs: Long = RelaySocket.RPC_TIMEOUT_MS) {
    STATUS("git.status"), DIFF("git.diff"),
    STAGE("git.stage", GIT_WRITE_TIMEOUT_MS), UNSTAGE("git.unstage", GIT_WRITE_TIMEOUT_MS),
    COMMIT("git.commit", GIT_WRITE_TIMEOUT_MS), PUSH("git.push", GIT_WRITE_TIMEOUT_MS), PULL("git.pull", GIT_WRITE_TIMEOUT_MS),
    HISTORY("git.history")
}

/** How long a git write may take on the computer before the phone stops waiting (see [GitVerb]). */
const val GIT_WRITE_TIMEOUT_MS = 180_000L

open class HostException(message: String) : Exception(message)

/**
 * The request was sent and no answer came back (it timed out, or the connection dropped while it
 * waited), so whatever it asked for may have happened on the computer, or may still be happening.
 * A refusal or a failed command is an answer, never this.
 */
class HostUnansweredException(message: String) : HostException(message)

/** The [HostException] a relay request's failure surfaces as; an unanswered one stays unanswered. */
internal fun hostException(e: RpcException): HostException {
    val message = e.message ?: "Request failed."
    return if (e is RpcUnansweredException) HostUnansweredException(message) else HostException(message)
}

/**
 * The direct-SSH transport will not do this for [nodeId], and the relay should: the node's tmux
 * session is not running (creating it over SSH would give it no hook environment — audit A08), or
 * the node belongs to one of the desktop's SSH projects and lives on another host (audit A09). The
 * app offers to open it through the relay, where the desktop attaches it properly.
 *
 * [message] is that offer's text. [fact] is the same refusal with nothing about the relay, and
 * [action] what the user would do with the session in nodeterm on the computer ("open it", "start
 * it"). When the phone cannot offer the relay, [refusal] says why for the leg it has: remote access
 * not set up (or a computer added by its SSH address, which has no relay at all — audit A27), off
 * right now, not picked up yet, or this computer set to "Only on my network".
 */
class NeedsRelayException(
    val nodeId: String,
    message: String,
    val fact: String = message,
    val action: String = "open it"
) : HostException(message) {
    /** The refusal for a phone with no relay leg at all: remote access isn't set up for this computer. */
    val withoutRelay: String get() = refusal(LegRouting.RelayLeg.NOT_SET_UP)!!

    /**
     * What to say when the relay leg is [leg]; null when it is [LegRouting.RelayLeg.AVAILABLE], where
     * the app offers the relay ([message]) instead. Each text names what is actually in the way, the
     * way [LegRouting.route]'s reasons do: telling a user whose remote access is ON that it isn't set
     * up (the review of A27b) sends them to a setting that is already right.
     */
    fun refusal(leg: LegRouting.RelayLeg): String? = when (leg) {
        LegRouting.RelayLeg.AVAILABLE -> null
        LegRouting.RelayLeg.NOT_SET_UP, LegRouting.RelayLeg.ADDED_OVER_SSH ->
            "$fact Remote access isn't set up for this computer, so $action in nodeterm on the computer."
        LegRouting.RelayLeg.REMOTE_ACCESS_OFF ->
            "$fact Remote access is off on the computer right now: turn it on in nodeterm → Settings → Phone, or " +
                "$action in nodeterm on the computer."
        LegRouting.RelayLeg.NOT_PICKED_UP ->
            "$fact Remote access is on there, but this phone has not picked up its relay connection yet: tap Refresh " +
                "on the computer's screen and try again, or $action in nodeterm on the computer."
        LegRouting.RelayLeg.ROUTE_SSH_ONLY ->
            "$fact This computer is set to \"Only on my network (SSH)\": choose \"Automatic\" or \"Only through the " +
                "relay\" in Settings → How to reach each computer, or $action in nodeterm on the computer."
    }

    companion object {
        /** The sentence a refusal ends with when there is no relay leg to open it through. */
        const val NO_RELAY_TO_OFFER = "Remote access isn't set up for this computer, so open it in nodeterm on the computer."
    }
}

/**
 * The SSH server answered but did not accept this phone's key (or this user). Kept apart from other
 * connect failures because what to do differs: a computer added by its address needs the phone's
 * key in its `authorized_keys` first (audit A27), and a paired one was revoked or re-keyed.
 */
class SshAuthRefusedException(message: String) : HostException(message)

/**
 * For an attach that STARTS a session the phone just created: which project it belongs to, and the
 * account/agent chosen. A current desktop creates the session in that project's folder under that
 * account itself (audit A33 — the phone's `cd`/env launch prefix is POSIX-only and cannot work on a
 * Windows host); an older one ignores it. Direct SSH never creates sessions, so it ignores it too.
 */
data class NewSessionHint(val projectId: String, val accountId: String?, val agentId: String?)
