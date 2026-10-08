package dev.nodeterm.protocol.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.*

/** Durable admission precedes dispatch. An uncertain creation is never replayed or replaced. */
class ManagedSessionCreation(
    private val scope: CoroutineScope,
    private val storage: Storage,
    private val prepare: suspend (ManagedSessionChoice) -> PreparedManagedSession,
    private val create: suspend (PreparedManagedSession) -> ManagedSessionReceipt,
) {
    interface Storage {
        fun read(): String?
        /** Must commit synchronously and throw on failure, including removal. */
        fun write(encoded: String)
    }
    sealed interface State {
        data object Idle : State
        data class Creating(val choice: ManagedSessionChoice) : State
        data class Refused(val message: String) : State
        data class Uncertain(val message: String) : State
        data class Ready(val adoption: ManagedSessionAdoption) : State
    }
    private val lock = Any()
    private var pending: PreparedManagedSession? = null
    private var receipts = emptyList<ManagedSessionAdoption>()
    private val mutableState = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = mutableState.asStateFlow()
    private var nextTicket = 0L
    private var presentation: Long? = null

    init {
        try {
            storage.read()?.let { encoded ->
                require(encoded.toByteArray(Charsets.UTF_8).size <= 256 * 1024)
                val o = Json.parseToJsonElement(encoded).jsonObject
                require(o.getValue("version").jsonPrimitive.let { !it.isString && it.int == 1 })
                receipts = o.getValue("receipts").jsonArray.map { ManagedSessions.adoption(it.jsonObject) }
                require(receipts.size <= 8 && receipts.map { it.receipt.nodeId }.distinct().size == receipts.size)
                o["pending"]?.takeIf { it != JsonNull }?.jsonObject?.let { p ->
                    pending = ManagedSessions.prepared(p.getValue("request").jsonObject)
                    mutableState.value = when (p.getValue("phase").jsonPrimitive.let { require(it.isString); it.content }) {
                        "sent" -> State.Uncertain(UNCERTAIN)
                        "ready" -> State.Ready(ManagedSessionAdoption(pending!!, ManagedSessions.receipt(p.getValue("receipt"), pending!!)).also { adoption -> require(adoption in receipts) })
                        else -> error("Invalid saved creation")
                    }
                }
            }
        } catch (_: Exception) {
            // A corrupt checkpoint is not permission to send a second creation after process death.
            mutableState.value = State.Uncertain("The saved creation cannot be read. Check sessions on the computer before starting another session.")
        }
    }
    fun show(): Long = synchronized(lock) { (++nextTicket).also { presentation = it } }
    fun hide(ticket: Long) = synchronized(lock) { if (presentation == ticket) presentation = null }
    fun isCurrent(ticket: Long): Boolean = synchronized(lock) { presentation == ticket }

    fun submit(ticket: Long, choice: ManagedSessionChoice, onCreated: suspend () -> Unit): Boolean {
        synchronized(lock) {
            if (!scope.isActive || presentation != ticket || mutableState.value !is State.Idle && mutableState.value !is State.Refused) return false
            if (receipts.size >= 8) {
                mutableState.value = State.Refused("Open or discard the previous host-created terminals before starting another session.")
                return false
            }
            mutableState.value = State.Creating(choice)
        }
        scope.launch {
            var dispatched = false
            try {
                val request = prepare(choice)
                require(request.choice == choice)
                synchronized(lock) {
                    // Write before create() can publish any remote input. A killed process restores
                    // an uncertain state, even if no acknowledgement was received on this phone.
                    persist(request, "sent")
                    pending = request
                    dispatched = true
                }
                val adoption = ManagedSessionAdoption(request, create(request))
                synchronized(lock) {
                    require(receipts.none { it.receipt.nodeId == adoption.receipt.nodeId && it != adoption }) { "The host reused an unverified terminal identity. Check the computer before discarding its receipt." }
                    val next = listOf(adoption) + receipts.filterNot { it.receipt.nodeId == adoption.receipt.nodeId }
                    require(next.size <= 8)
                    persist(request, "ready", adoption.receipt, next)
                    receipts = next
                    mutableState.value = State.Ready(adoption)
                }
            } catch (cancelled: CancellationException) {
                synchronized(lock) { mutableState.value = if (dispatched) State.Uncertain(UNCERTAIN) else State.Refused("Creation was cancelled before it was sent.") }
                throw cancelled
            } catch (error: Exception) {
                synchronized(lock) {
                    if (!dispatched || error is ManagedSessionRefusedException) {
                        try {
                            persist(null, null)
                            pending = null
                            mutableState.value = State.Refused(error.message ?: "The computer refused creation.")
                        } catch (_: Exception) { mutableState.value = State.Uncertain(UNCERTAIN) }
                    } else mutableState.value = State.Uncertain(error.message ?: UNCERTAIN)
                }
                return@launch
            }
            // Presentation failure cannot rewrite an already-confirmed creation outcome.
            if (isCurrent(ticket)) onCreated()
        }
        return true
    }

    /** The receipt remains durable until the first guarded attach has completed. */
    fun takeReady(ticket: Long): ManagedSessionAdoption? = synchronized(lock) {
        if (presentation != ticket) return null
        val ready = mutableState.value as? State.Ready ?: return null
        persist(null, null)
        pending = null
        mutableState.value = State.Idle
        ready.adoption
    }
    fun receiptFor(nodeId: String): ManagedSessionAdoption? = synchronized(lock) {
        receipts.firstOrNull { it.receipt.nodeId == nodeId }
    }
    fun adopted(nodeId: String) = synchronized(lock) {
        val next = receipts.filterNot { it.receipt.nodeId == nodeId }
        val ready = mutableState.value as? State.Ready
        val consumed = ready?.adoption?.receipt?.nodeId == nodeId
        val keepPending = pending.takeUnless { consumed }
        persist(keepPending, if (ready != null && keepPending != null) "ready" else if (keepPending != null) "sent" else null,
            ready?.adoption?.receipt.takeUnless { consumed }, next)
        if (consumed) { pending = null; mutableState.value = State.Idle }
        receipts = next
    }

    /** User starts a genuinely new session after checking the uncertain result; never a retry. */
    fun acknowledgeChecked(ticket: Long): Boolean = synchronized(lock) {
        if (presentation != ticket || mutableState.value !is State.Uncertain) return false
        persist(null, null)
        pending = null
        mutableState.value = State.Idle
        true
    }
    private fun persist(request: PreparedManagedSession?, phase: String?, receipt: ManagedSessionReceipt? = null, retained: List<ManagedSessionAdoption> = receipts) {
        val encoded = buildJsonObject {
            put("version", 1)
            put("receipts", JsonArray(retained.map { it.toJson() }))
            put("pending", request?.let { r -> buildJsonObject {
                put("request", r.toJson()); put("phase", phase!!); receipt?.let { put("receipt", it.toJson()) }
            } } ?: JsonNull)
        }.toString()
        require(encoded.toByteArray(Charsets.UTF_8).size <= 256 * 1024)
        storage.write(encoded)
    }
    companion object {
        const val UNCERTAIN = "No confirmed creation result came back. Check sessions on the computer; this request will not be sent again."
    }
}
