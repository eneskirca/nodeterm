package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.J
import dev.nodeterm.protocol.model.J.b
import dev.nodeterm.protocol.model.J.l
import dev.nodeterm.protocol.model.J.objects
import dev.nodeterm.protocol.model.J.s
import dev.nodeterm.protocol.model.J.strings
import dev.nodeterm.protocol.model.KanbanColumn
import dev.nodeterm.protocol.model.KanbanLabel
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.TerminalHistory
import dev.nodeterm.protocol.pairing.RelayPairingProof
import dev.nodeterm.protocol.relay.Frame
import dev.nodeterm.protocol.relay.Framing
import dev.nodeterm.protocol.relay.Op
import dev.nodeterm.protocol.relay.RelaySocket
import dev.nodeterm.protocol.relay.RelaySocketListener
import dev.nodeterm.protocol.relay.RpcException
import dev.nodeterm.protocol.relay.SnapshotReassembler
import dev.nodeterm.protocol.ssh.LanReport
import dev.nodeterm.protocol.ssh.PhoneTerminals
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * [HostConnection] over the standing phone host's relay dialect — `createHostHandlers` in
 * `src/main/remote/host-service.ts` is the other end, verb for verb:
 *
 *  `projects.list` → `{output, lan?}` · `pty.attach {nodeId, cols, rows}` → `{streamId, fresh}` then
 *  Snapshot Start, Chunk…, End and Output frames · `pty.kill|destroy|scroll {streamId…}` ·
 *  `node.wake|refresh|rename {nodeId, title?}` · `projects.ensureBoard|setCardColumn|
 *  editCardLabels|registerNode` · `git.*` · Input/Resize frames up, Output/Resized/Error down.
 *
 * `resizedFrames` is deliberately NOT sent on attach, exactly like the iOS app: a phone is a
 * CEILING on the shared pty (a session never grows wider than its screen). An `OP.Resized` still
 * arrives when a desktop viewer sized the session, and is surfaced so the UI can offer "fit".
 */
class RelayHostConnection private constructor() : HostConnection, RelaySocketListener {
    private lateinit var socket: RelaySocket
    private val streams = ConcurrentHashMap<Long, Stream>()
    @Volatile private var onChanged: (() -> Unit)? = null
    @Volatile private var onClosed: ((String?) -> Unit)? = null
    @Volatile private var readyListener: ((String) -> Unit)? = null

    override val kind = TransportKind.RELAY
    override val capabilities = LegRouting.RELAY_CAPABILITIES
    /** Socket state changes before pending RPCs resume and before the close listener runs. */
    internal val isReady: Boolean get() = socket.isReady

    private inner class Stream(val id: Long, override val fresh: Boolean, val sink: TerminalSink, val scrollV1: Boolean) : TerminalStream {
        private val snapshot = SnapshotReassembler()
        private var outSeq = 0L
        @Volatile private var composedRetired = false
        private var scrollViewId: String? = null
        private var scrollViewEpoch = 0L
        override fun clearScrollView() { synchronized(this) { scrollViewId = null; scrollViewEpoch++ } }
        override fun retireComposed() { composedRetired = true }

        fun accept(frame: Frame) {
            when (frame.op) {
                Op.SNAPSHOT_START, Op.SNAPSHOT_CHUNK -> snapshot.accept(frame)
                Op.SNAPSHOT_END -> snapshot.accept(frame)?.let { if (it.isNotEmpty()) sink.onPaint(it) }
                Op.OUTPUT -> sink.onOutput(frame.payload)
                Op.RESIZED -> Framing.readSize(frame.payload)?.let { (c, r) -> sink.onResized(c, r) }
                Op.ERROR -> {
                    streams.remove(id)
                    val code = J.obj(J.parse(String(frame.payload, Charsets.UTF_8)))?.l("exitCode")?.toInt()
                    sink.onExit(code)
                }
            }
        }

        override fun write(text: String) {
            synchronized(this) { socket.sendFrame(Op.INPUT, id, outSeq++, text.toByteArray(Charsets.UTF_8)) }
        }

        override fun resize(cols: Int, rows: Int) {
            synchronized(this) { socket.sendFrame(Op.RESIZE, id, outSeq++, Framing.sizePayload(cols, rows)) }
        }

        override suspend fun scroll(up: Boolean, lines: Int) {
            // Relay backend identity is unknown. Never assume an older host is tmux and inject wheels.
            scrollView(up, lines)
        }

        override suspend fun scrollView(up: Boolean, lines: Int): TerminalScrollView.Result {
            if (lines !in 1..20 || composedRetired || streams[id] !== this)
                return TerminalScrollView.Result.Refused("This terminal is no longer ready to scroll.")
            if (!scrollV1) return TerminalScrollView.Result.Refused("History scrolling needs an updated nodeterm on the computer.")
            val (epoch, viewId) = synchronized(this) { scrollViewEpoch to scrollViewId }
            val body = try {
                call("pty.scrollV1", buildJsonObject {
                    put("streamId", id); put("dir", if (up) "up" else "down"); put("lines", lines)
                    viewId?.let { put("viewId", it) }
                })
            } catch (_: HostUnansweredException) {
                clearScrollView()
                return TerminalScrollView.Result.Uncertain("Scroll could not be confirmed. Check the terminal before scrolling again.")
            } catch (_: HostException) {
                clearScrollView()
                return TerminalScrollView.Result.Uncertain("Scrolling failed without a confirmed result. Scroll was not repeated.")
            }
            val result = TerminalScrollView.parse(body)
                ?: TerminalScrollView.Result.Uncertain("The computer returned an invalid history page. Scroll was not repeated.")
            return synchronized(this) {
                if (composedRetired || streams[id] !== this || epoch != scrollViewEpoch) {
                    // Closing a viewer cannot turn an already-written wheel into a safe refusal.
                    if (result is TerminalScrollView.Result.Input || result is TerminalScrollView.Result.Uncertain)
                        TerminalScrollView.Result.Uncertain("This scroll may have reached the terminal before the view closed. Scroll was not repeated.")
                    else TerminalScrollView.Result.Refused("This history view was closed.")
                }
                else {
                    scrollViewId = (result as? TerminalScrollView.Result.History)?.viewId
                    result
                }
            }
        }

        override suspend fun submitComposed(input: ComposedInput): ComposedInputResult {
            if (!input.valid()) return ComposedInputResult.refused("Send is too large or invalid. The draft was kept.")
            if (composedRetired || streams[id] !== this) return ComposedInputResult.refused()
            val normalized = input.normalized()
            val fields = buildJsonObject {
                put("kind", if (normalized is ComposedInput.Control) "control" else "paste")
                put("text", when (normalized) { is ComposedInput.Paste -> normalized.text; is ComposedInput.Control -> normalized.text })
                put("enter", normalized is ComposedInput.Paste && normalized.enter)
            }
            val answer = try {
                J.obj(call("pty.submitComposed", buildJsonObject { put("streamId", id); put("input", fields) }))
            } catch (error: HostUnansweredException) {
                return ComposedInputResult.uncertain()
            } catch (_: HostException) {
                // A legacy unknown method is an explicit refusal, never raw input or node.sendKeys.
                return ComposedInputResult.refused("Send is unavailable on this host or terminal. Update nodeterm on the computer or use its terminal; the draft was kept.")
            }
            if (composedRetired || streams[id] !== this) return ComposedInputResult.uncertain()
            return when (answer?.s("status")) {
                "delivered" -> ComposedInputResult.DELIVERED
                "refused" -> ComposedInputResult.refused(answer.s("message") ?: "Send was refused. The draft was kept.")
                else -> ComposedInputResult.uncertain()
            }
        }

        override suspend fun searchHistory(query: String): TerminalHistory.Result {
            if (!TerminalHistory.validQuery(query)) throw HostException("Enter a single-line search of 1–256 characters.")
            if (streams[id] !== this) throw HostException("This terminal is no longer attached.")
            val body = call("pty.historySearch", buildJsonObject { put("streamId", id); put("query", query) })
            if (streams[id] !== this) throw HostException("This terminal detached while its history was searched.")
            return TerminalHistory.parseRelay(body, query) ?: throw HostException("The host returned an invalid history search result.")
        }

        override suspend fun detach() {
            clearScrollView()
            streams.remove(id)
            runCatching { call("pty.kill", buildJsonObject { put("streamId", id) }) }
        }

        /**
         * [detach] for a stream nobody was handed: its attach was cancelled while the request was on
         * the wire (audit A40). Non-suspending and quick, since it runs as a continuation's
         * cancellation handler; the host's answer is not waited for.
         */
        fun abandon() {
            clearScrollView()
            streams.remove(id)
            socket.request("pty.kill", buildJsonObject { put("streamId", id) }) {}
        }

        override suspend fun endSession() {
            try {
                call("pty.destroy", buildJsonObject { put("streamId", id) })
            } finally {
                streams.remove(id)
            }
        }
    }

    // ---- RelaySocketListener ------------------------------------------------------------------

    override fun onReady(sas: String) {
        readyListener?.invoke(sas)
    }

    override fun onNotify(method: String, params: JsonElement?) {
        // `canvas:state` is pushed on approval and on every host canvas change: a cheap "re-list".
        if (method == "canvas:state") onChanged?.invoke()
    }

    override fun onFrame(frame: Frame) {
        streams[frame.streamId]?.accept(frame)
    }

    override fun onClosed(reason: String?) {
        val live = streams.values.toList()
        streams.clear()
        for (s in live) s.sink.onExit(null)
        onClosed?.invoke(reason)
    }

    // ---- RPC plumbing ---------------------------------------------------------------------

    private suspend fun call(method: String, params: JsonElement? = null, timeoutMs: Long = RelaySocket.RPC_TIMEOUT_MS): JsonElement? = try {
        socket.call(method, params, timeoutMs)
    } catch (e: RpcException) {
        throw hostException(e)
    }

    override suspend fun listProjects(): ProjectsSnapshot {
        val body = J.obj(call("projects.list")) ?: return ProjectsSnapshot.EMPTY
        // `lan` (A74-refresh) rides beside the blob, never inside it: the computer's current LAN
        // address and SSH host keys, which only this authenticated channel may hand the phone.
        return ProjectsParser.parseBlob(body.s("output") ?: "").copy(lan = LanReport.parse(body["lan"]))
    }

    /** Additive approved-relay migration; never changes this phone's tokens or pairing record. */
    suspend fun proveLegacyPairing(context: RelayPairingProof.Context): RelayPairingProof.Outcome =
        RelayPairingProof.afterApprovedListing(context, rpc = { method, params -> call(method, params, RelayPairingProof.TIMEOUT_MS) })

    override suspend fun attach(nodeId: String, cols: Int, rows: Int, sink: TerminalSink, create: NewSessionHint?): TerminalStream {
        // The relay creates an unknown id on the desktop socket. Phone-owned shells never live
        // there: even reconnect/route fallback must fail before sending a creating RPC.
        if (PhoneTerminals.validId(nodeId)) throw HostException("This phone terminal opens over SSH. Choose your network route to reopen it.")
        return suspendCancellableCoroutine { cont ->
            val params = buildJsonObject {
                put("nodeId", nodeId)
                put("cols", cols)
                put("rows", rows)
                if (create != null) {
                    put("projectId", create.projectId)
                    create.accountId?.let { put("accountId", it) }
                    create.agentId?.let { put("agentId", it) }
                }
            }
            socket.request("pty.attach", params) { r ->
                r.fold(
                    onSuccess = { body ->
                        val o = J.obj(body)
                        val streamId = o?.l("streamId")
                        if (streamId == null) {
                            cont.resumeWithException(HostException("The host did not open a terminal stream."))
                        } else {
                            // Registered HERE, on the reader thread, before the snapshot frames that
                            // follow the response are processed.
                            val s = Stream(streamId, o.b("fresh") == true, sink, (o["scrollV1"] as? JsonPrimitive)?.let { !it.isString && it.content == "true" } == true)
                            streams[streamId] = s
                            // A caller cancelled while the request was on the wire never gets this
                            // stream, and the host has already reserved it (a viewer on the node: an
                            // Eco shield and a size ceiling on the desktop). Let it go, or nothing
                            // ever does (audit A40). Also covers a cancel that lands after this
                            // resume but before the caller runs again.
                            cont.resume(s) { _, stream, _ -> stream.abandon() }
                        }
                    },
                    onFailure = { cont.resumeWithException(HostException(it.message ?: "Attach failed.")) }
                )
            }
        }
    }

    override suspend fun wake(nodeId: String) {
        call("node.wake", buildJsonObject { put("nodeId", nodeId) })
    }

    override suspend fun refresh(nodeId: String) {
        call("node.refresh", buildJsonObject { put("nodeId", nodeId) })
    }

    override suspend fun rename(nodeId: String, title: String) {
        call("node.rename", buildJsonObject {
            put("nodeId", nodeId)
            put("title", title)
        })
    }

    override suspend fun ensureBoard(projectId: String): List<KanbanColumn>? {
        val o = J.obj(call("projects.ensureBoard", buildJsonObject { put("projectId", projectId) })) ?: return null
        val cols = o["columns"] as? JsonArray ?: return null
        return cols.mapNotNull { J.obj(it) }.mapNotNull { c ->
            val id = c.s("id") ?: return@mapNotNull null
            KanbanColumn(id, c.s("title") ?: "", c.s("color"))
        }
    }

    override suspend fun setCardColumn(projectId: String, nodeId: String, columnId: String?): Boolean {
        val o = J.obj(call("projects.setCardColumn", buildJsonObject {
            put("projectId", projectId)
            put("nodeId", nodeId)
            // null is REAL here: the virtual Ungrouped column.
            put("columnId", columnId?.let(::JsonPrimitive) ?: JsonNull)
        }))
        return o?.b("moved") == true
    }

    override suspend fun editCardLabels(projectId: String, nodeId: String, edit: CardLabelEdit): LabelEditResult? {
        val o = J.obj(call("projects.editCardLabels", buildJsonObject {
            put("projectId", projectId)
            put("nodeId", nodeId)
            if (edit.add.isNotEmpty()) put("add", JsonArray(edit.add.map(::JsonPrimitive)))
            if (edit.remove.isNotEmpty()) put("remove", JsonArray(edit.remove.map(::JsonPrimitive)))
            if (edit.create.isNotEmpty()) put("create", JsonArray(edit.create.map { (name, color) ->
                buildJsonObject {
                    put("name", name)
                    put("color", color)
                }
            }))
        })) ?: return null
        if (o["labels"] !is JsonArray) return null
        return LabelEditResult(
            edited = o.b("edited") == true,
            labels = o.objects("labels").mapNotNull { l ->
                val id = l.s("id") ?: return@mapNotNull null
                KanbanLabel(id, l.s("name") ?: "", l.s("color") ?: "default")
            },
            cardLabelIds = o.strings("cardLabelIds")
        )
    }

    override suspend fun registerNode(projectId: String, node: NewNode): Boolean {
        val o = J.obj(call("projects.registerNode", buildJsonObject {
            put("projectId", projectId)
            put("node", buildJsonObject {
                put("id", node.id)
                node.title?.let { put("title", it) }
                node.agentId?.let { put("agentId", it) }
                node.accountId?.let { put("accountId", it) }
            })
        }))
        return o?.b("registered") == true
    }

    /** `approvals.answer` (host-service.ts `HostInboxOps`). A desktop that predates the verb answers
     *  "not served", which is [ApprovalOutcome.UNSUPPORTED] — never a guess. */
    override suspend fun answerApproval(event: InboxEvent, allow: Boolean): ApprovalOutcome {
        val pendingId = event.pendingId ?: return ApprovalOutcome.UNSUPPORTED
        val body = try {
            J.obj(call("approvals.answer", buildJsonObject {
                put("nodeId", event.nodeId)
                put("pendingId", pendingId)
                put("decision", if (allow) "allow" else "deny")
            }))
        } catch (e: HostException) {
            if (e.message?.contains("not served") == true || e.message?.startsWith("Unknown method") == true) {
                return ApprovalOutcome.UNSUPPORTED
            }
            throw e
        }
        if (body?.b("answered") == true) return ApprovalOutcome.SENT
        // `reason` (additive, audit A35): `gone` = the hold ended; `failed` = the host could not write.
        return when (body?.s("reason")) {
            "gone" -> ApprovalOutcome.GONE
            "failed" -> throw HostException("The computer couldn't write the answer. Try again, or open the session.")
            else -> ApprovalOutcome.ALREADY_HANDLED
        }
    }

    override suspend fun rememberApproval(event: InboxEvent, suggestionIndex: Int): ApprovalOutcome {
        val ticket = event.pendingId ?: return ApprovalOutcome.UNSUPPORTED
        return answerHook("approvals.answer", buildJsonObject {
            put("nodeId", event.nodeId); put("pendingId", ticket)
            put("decision", "allow-always"); put("suggestionIndex", suggestionIndex)
        })
    }

    override suspend fun answerQuestions(event: InboxEvent, selections: List<List<Int>>): ApprovalOutcome {
        val ticket = event.questionPendingId ?: return ApprovalOutcome.UNSUPPORTED
        return answerHook("questions.answer", buildJsonObject {
            put("nodeId", event.nodeId); put("pendingId", ticket)
            put("selections", JsonArray(selections.map { row -> JsonArray(row.map(::JsonPrimitive)) }))
        })
    }

    private suspend fun answerHook(verb: String, params: JsonObject): ApprovalOutcome {
        val body = try { J.obj(call(verb, params)) } catch (e: HostException) {
            if (e.message?.contains("not served") == true || e.message?.startsWith("Unknown method") == true) return ApprovalOutcome.UNSUPPORTED
            throw e
        }
        if (body?.b("answered") == true) return ApprovalOutcome.SENT
        return when (body?.s("reason")) {
            "gone" -> ApprovalOutcome.GONE
            "failed" -> throw HostException("The computer couldn't write the answer. Try again, or open the session.")
            else -> ApprovalOutcome.ALREADY_HANDLED
        }
    }

    override suspend fun ackRead(nodeId: String, eventId: String?) {
        try {
            call("inbox.ack", buildJsonObject { put("nodeId", nodeId) })
        } catch (_: HostException) {
            // An older desktop: the read stays phone-local, exactly as before the verb existed.
        }
    }

    /**
     * Type a quick answer. `node.sendKeys` types through the node's EXISTING session on the desktop
     * (audit A12); `sent:false` means it could not be delivered, which is a [HostException] so the
     * caller opens the session instead. A desktop that predates the verb gets the old
     * attach-and-write, made less lossy: the keys go only after the pane has painted (proof the
     * desktop has attached its client), and the stream stays open well past tmux's escape-time so a
     * lone ESC is not killed with the client.
     */
    override suspend fun sendKeys(nodeId: String, keys: String) {
        val body = try {
            J.obj(call("node.sendKeys", buildJsonObject {
                put("nodeId", nodeId)
                put("keys", keys)
            }))
        } catch (e: HostException) {
            if (e.message?.contains("not served") == true || e.message?.startsWith("Unknown method") == true) {
                legacySendKeys(nodeId, keys)
                return
            }
            throw e
        }
        if (body?.b("sent") != true) throw HostException("The answer couldn't be typed into the session. Open it to answer there.")
    }

    private suspend fun legacySendKeys(nodeId: String, keys: String) {
        val painted = CompletableDeferred<Unit>()
        val sink = object : TerminalSink {
            override fun onPaint(text: String) {}
            override fun onOutput(bytes: ByteArray) {
                painted.complete(Unit)
            }
            override fun onExit(code: Int?) {
                painted.complete(Unit)
            }
        }
        val stream = attach(nodeId, 80, 24, sink)
        try {
            withTimeoutOrNull(3_000) { painted.await() }
            stream.write(keys)
            delay(400)
        } finally {
            stream.detach()
        }
    }

    /** `git.*` with `{cwd, …args}`; the host's refusal ("git is not served on this host.", "cwd is
     *  outside the shared project roots.") arrives as a [HostException] carrying that sentence. */
    override suspend fun git(verb: GitVerb, cwd: String, args: Map<String, JsonElement>): JsonElement? =
        call(verb.wire, JsonObject(args + ("cwd" to JsonPrimitive(cwd))), verb.timeoutMs)

    override fun setOnChanged(listener: (() -> Unit)?) {
        onChanged = listener
    }

    override fun setOnClosed(listener: ((String?) -> Unit)?) {
        onClosed = listener
    }

    override fun close() {
        streams.clear()
        socket.close()
    }

    companion object {
        /**
         * Open the socket and wire this connection as its listener. [onReady] fires with the SAS once
         * the E2EE handshake completes; APPROVAL is separate (the desktop human, or a pin) — see
         * [RelayConnector].
         */
        fun open(build: (RelaySocketListener) -> RelaySocket, onReady: (String) -> Unit): RelayHostConnection {
            val conn = RelayHostConnection()
            conn.readyListener = onReady
            conn.socket = build(conn)
            return conn
        }
    }
}
