package dev.nodeterm.protocol.host

import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.TmuxNames
import dev.nodeterm.protocol.ssh.SshActionsScripts
import kotlinx.serialization.json.*

/** Only choices cross this boundary. The owning host resolves commands, folders and credentials. */
data class ManagedSessionChoice(
    val projectId: String,
    val kind: String,
    val agentId: String? = null,
    val accountId: String? = null,
    val title: String? = null,
    val cols: Int = 80,
    val rows: Int = 24,
) {
    init {
        require(ManagedSessions.validId(projectId)) { "Choose a project on this computer." }
        require(kind in setOf("shell", "agent"))
        require(if (kind == "agent") Agent.of(agentId) != null else agentId == null && accountId == null)
        require(accountId == null || Regex("^[A-Za-z0-9_-]{1,200}$").matches(accountId))
        require(title == null || title.isNotBlank() && title.length <= 120 && ManagedSessions.safeText(title))
        require(cols in 2..500 && rows in 2..500)
    }
    fun params(creationId: String): JsonObject = buildJsonObject {
        put("creationId", creationId); put("projectId", projectId); put("kind", kind)
        agentId?.let { put("agentId", it) }; accountId?.let { put("accountId", it) }
        title?.let { put("title", it) }; put("cols", cols); put("rows", rows)
    }
}

/** Frozen before dispatch; reconnect must never manufacture a replacement nonce or instance. */
data class PreparedManagedSession(
    val profile: String,
    val hostInstance: String,
    val nonce: String,
    val issuedAt: Long,
    val creationId: String,
    val choice: ManagedSessionChoice,
    val advertisement: String,
) {
    init {
        require(SshActionsScripts.validProfile(profile))
        require(ManagedSessions.UUID.matches(hostInstance) && ManagedSessions.UUID.matches(nonce) && ManagedSessions.UUID.matches(creationId))
        require(issuedAt > 0 && advertisement.toByteArray(Charsets.UTF_8).size <= 16 * 1024)
    }
    fun wireRequest(): String = buildJsonObject {
        put("version", 1); put("instance", hostInstance); put("nonce", nonce); put("issuedAt", issuedAt)
        put("method", ManagedSessions.METHOD); put("params", choice.params(creationId))
    }.toString().also { require(it.toByteArray(Charsets.UTF_8).size <= SshActionsScripts.MAX_BYTES) }
    fun toJson(): JsonObject = buildJsonObject {
        put("profile", profile); put("hostInstance", hostInstance); put("nonce", nonce); put("issuedAt", issuedAt)
        put("creationId", creationId); put("params", choice.params(creationId)); put("advertisement", advertisement)
    }
}

/** A host-created, registered generation; possession never authorizes creation or relaunch. */
data class ManagedSessionReceipt(
    val creationId: String,
    val nodeId: String,
    val projectId: String,
    val hostInstance: String,
    val socket: String,
    val session: String,
    val paneId: String,
    val panePid: Int,
    val paneBirth: String,
    val sessionCreated: String,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("version", 1); put("creationId", creationId); put("nodeId", nodeId); put("projectId", projectId)
        put("hostInstance", hostInstance); put("socket", socket); put("session", session)
        put("paneId", paneId); put("panePid", panePid); put("paneBirth", paneBirth); put("sessionCreated", sessionCreated)
    }
}

data class ManagedSessionAdoption(val request: PreparedManagedSession, val receipt: ManagedSessionReceipt) {
    init { ManagedSessions.receipt(receipt.toJson(), request) }
    fun toJson(): JsonObject = buildJsonObject { put("request", request.toJson()); put("receipt", receipt.toJson()) }
}

/** A confirmed refusal before mutation permits a new choice; an unanswered write does not. */
class ManagedSessionRefusedException(message: String) : HostException(message)

object ManagedSessions {
    const val METHOD = "sessions.createManagedV1"
    val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val NODE = Regex("^term-[a-z0-9]+-[a-z0-9]{1,16}$")
    private val PANE = Regex("^%[0-9]{1,12}$")
    private val LINUX_BIRTH = Regex("^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$")
    private val DARWIN_BIRTH = Regex("^darwin:[A-Za-z]{3} [A-Za-z]{3} +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$")
    fun safeText(value: String): Boolean = value.none { it.code < 32 || it.code in 127..159 || it.code in 0x2028..0x2029 }
    fun validId(value: String): Boolean = value.isNotEmpty() && value.length <= 200 && safeText(value)
    private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.also { require(it.isString) }.content
    private fun JsonObject.number(name: String): Long = getValue(name).jsonPrimitive.also { require(!it.isString) }.long
    private fun JsonObject.optional(name: String): String? = get(name)?.let { require(it != JsonNull); it.jsonPrimitive.also { p -> require(p.isString) }.content }
    fun choice(o: JsonObject): ManagedSessionChoice = ManagedSessionChoice(o.string("projectId"), o.string("kind"), o.optional("agentId"), o.optional("accountId"), o.optional("title"), o.number("cols").toIntExact(), o.number("rows").toIntExact())
    fun prepared(o: JsonObject): PreparedManagedSession {
        val creation = o.string("creationId")
        val params = o.getValue("params").jsonObject
        require(params.string("creationId") == creation)
        return PreparedManagedSession(o.string("profile"), o.string("hostInstance"), o.string("nonce"), o.number("issuedAt"), creation, choice(params), o.string("advertisement"))
    }
    fun receipt(element: JsonElement, request: PreparedManagedSession): ManagedSessionReceipt {
        val o = element.jsonObject
        require(o.number("version") == 1L)
        val r = ManagedSessionReceipt(o.string("creationId"), o.string("nodeId"), o.string("projectId"), o.string("hostInstance"), o.string("socket"), o.string("session"), o.string("paneId"), o.number("panePid").toIntExact(), o.string("paneBirth"), o.string("sessionCreated"))
        require(r.creationId == request.creationId && r.projectId == request.choice.projectId && r.hostInstance == request.hostInstance)
        require(NODE.matches(r.nodeId) && !r.nodeId.startsWith("phone-"))
        require(r.socket == TmuxNames.SOCKET && r.session == TmuxNames.sessionName(r.nodeId))
        require(PANE.matches(r.paneId) && r.panePid > 0)
        require(r.paneBirth.length <= 128 && safeText(r.paneBirth) && (LINUX_BIRTH.matches(r.paneBirth) || DARWIN_BIRTH.matches(r.paneBirth)))
        require(Regex("^[1-9][0-9]{0,19}$").matches(r.sessionCreated))
        return r
    }
    fun adoption(o: JsonObject): ManagedSessionAdoption {
        val request = prepared(o.getValue("request").jsonObject)
        return ManagedSessionAdoption(request, receipt(o.getValue("receipt"), request))
    }
    private fun Long.toIntExact(): Int = toInt().also { require(it.toLong() == this) }
}
