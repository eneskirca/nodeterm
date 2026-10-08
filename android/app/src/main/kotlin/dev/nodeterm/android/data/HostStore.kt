package dev.nodeterm.android.data

import android.content.Context
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.PairedHostReplacement
import dev.nodeterm.protocol.model.SeenLog
import dev.nodeterm.protocol.host.ManagedSessionCreation
import dev.nodeterm.protocol.secure.PlainStorage
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.pairing.RelayBlock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** How to reach a computer. Auto = direct SSH on the LAN first, the relay when that fails. */
enum class RoutePreference { AUTO, SSH_ONLY, RELAY_ONLY }

/**
 * The paired computers (public facts only — see [PairedHost]) plus phone-level preferences. Secrets
 * are in [SecureStore].
 */
class HostStore(context: Context) {
    private val prefs = context.getSharedPreferences("nodeterm.hosts", Context.MODE_PRIVATE)
    private val _hosts = MutableStateFlow(load())
    val hosts: StateFlow<List<PairedHost>> = _hosts.asStateFlow()

    private fun load(): List<PairedHost> {
        val raw = prefs.getString("hosts", null) ?: return emptyList()
        return try {
            (Json.parseToJsonElement(raw) as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(PairedHost::fromJson) } ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<PairedHost>, retiredKeys: List<String> = emptyList()) {
        val edit = prefs.edit()
        for (key in retiredKeys) edit.remove(key)
        // Publish record retirement and its local preferences together, before notifying readers.
        edit.putString("hosts", JsonArray(list.map { it.toJson() }).toString()).apply()
        _hosts.value = list
    }

    fun get(id: String): PairedHost? = _hosts.value.firstOrNull { it.id == id }

    /**
     * Re-pairing the same computer (same host + user + name) replaces the old record and retires
     * its route, approval and creation preferences. An update of the same id retains those values.
     * What the phone saw of
     * a replaced record's computer carries over to [host] ([SeenLog.moveHost]): it is the same
     * computer, whose event ids continue.
     */
    @Synchronized
    fun upsert(host: PairedHost) {
        val replacement = PairedHostReplacement.plan(_hosts.value, host)
        val replaced = replacement.replaced
        save(replacement.hosts, replacement.retiredPreferenceKeys)
        for (old in replaced) seenLog.moveHost(old.id, host.id)
    }

    /** Complete re-pairing after its old connections were forgotten. Only local secret writes
     * occur under this monitor, so an already-completed old mint cannot replace the new token. */
    @Synchronized
    fun publishPairing(host: PairedHost, previous: PairedHost?, saveToken: () -> Unit,
                       removeToken: (String) -> Unit) {
        for (old in PairedHostReplacement.retired(_hosts.value, host, previous)) {
            if (old.id != host.id) remove(old.id, successor = host.id) { removeToken(old.id) }
        }
        saveToken()
        upsert(host)
    }

    /**
     * Keep a computer added by its SSH address (audit A27). Unlike [upsert] it replaces nothing: when
     * a computer is already listed under that address (paired or added), that one is returned and
     * nothing is saved. Null when it was added.
     */
    @Synchronized
    fun addManual(host: PairedHost): PairedHost? {
        require(host.manual) { "only a computer added by its SSH address" }
        ManualHost.existing(_hosts.value, ManualHost.Address(host.host, host.port, host.user, host.name))?.let { return it }
        save(_hosts.value + host)
        // [route] answers SSH for it from the record; this is for a build that predates `manual`,
        // which reads only the stored route, so it too never dials a relay for it.
        prefs.edit().putString("route.${host.id}", RoutePreference.SSH_ONLY.name).apply()
        return null
    }

    @Synchronized
    fun update(id: String, change: (PairedHost) -> PairedHost) {
        save(_hosts.value.map { if (it.id == id) change(it) else it })
    }

    /** Exact session guard for asynchronous pin/LAN facts. Its predicate must be nonlocking. */
    @Synchronized
    fun currentHost(id: String, expectedHostKey: String?, current: () -> Boolean): PairedHost? {
        val host = get(id) ?: return null
        return host.takeIf { current() && it.hostKeyB64 == expectedHostKey }
    }

    @Synchronized
    fun updateCurrent(id: String, expectedHostKey: String?, current: () -> Boolean,
                      change: (PairedHost) -> PairedHost): Boolean {
        val host = currentHost(id, expectedHostKey, current) ?: return false
        save(_hosts.value.map { if (it.id == id) change(host) else it })
        return true
    }

    /** Publish a completed mint only while its exact connection and paired identity still exist.
     * The token callback has no network await; retirement cannot interleave with either write. */
    @Synchronized
    fun adoptRelay(hostId: String, expectedHostKey: String?, relay: RelayBlock,
                   currentConnection: () -> Boolean, saveToken: () -> Unit): Boolean {
        val host = get(hostId) ?: return false
        if (!currentConnection() || host.manual || host.hostKeyB64 != expectedHostKey ||
            expectedHostKey != null && relay.hostPublicKeyB64 != expectedHostKey) return false
        saveToken()
        save(_hosts.value.map { if (it.id == hostId) it.copy(relay = relay) else it })
        return true
    }

    /**
     * Forget the computer [id]. Its notification seen log goes with it ([SeenLog.forgetHost]), unless
     * the same computer was just paired again as [successor]: then that record keeps what the phone
     * saw of it ([SeenLog.moveHost]), so pairing again does not announce it all a second time.
     */
    @Synchronized
    fun remove(id: String, successor: String? = null, removeToken: () -> Unit = {}) {
        // Keep the record if secret retirement fails, as the Forget/re-pair callers did before.
        removeToken()
        save(_hosts.value.filterNot { it.id == id })
        prefs.edit().remove("route.$id").remove("relayApproved.$id").remove("managedCreation.$id").apply()
        when (successor) {
            null -> seenLog.forgetHost(id)
            id -> Unit
            else -> seenLog.moveHost(id, successor)
        }
    }

    /**
     * This computer serves this phone over the relay without an approval dialog: a relay connect has
     * succeeded (its standing host pinned our box key), or pairing answered `relayApproved` — it
     * pinned the key, or recorded it for the standing host to pin on this phone's first relay
     * handshake, which may then be the background worker's (audit A07-late). Gates the background
     * worker's relay leg (dev.nodeterm.protocol.host.RelayApprovalGate, audit A05).
     */
    fun relayApproved(id: String): Boolean = prefs.getBoolean("relayApproved.$id", false)

    @Synchronized
    fun setRelayApproved(id: String, approved: Boolean) {
        if (get(id) == null) return
        prefs.edit().putBoolean("relayApproved.$id", approved).apply()
    }

    /** How to reach [id]. A computer added by its SSH address has SSH only (audit A27), whatever is stored. */
    fun route(id: String): RoutePreference {
        if (get(id)?.manual == true) return RoutePreference.SSH_ONLY
        return runCatching { RoutePreference.valueOf(prefs.getString("route.$id", null) ?: "AUTO") }.getOrDefault(RoutePreference.AUTO)
    }

    @Synchronized
    fun setRoute(id: String, route: RoutePreference) {
        val host = get(id) ?: return
        if (host.manual) return
        prefs.edit().putString("route.$id", route.name).apply()
    }

    /**
     * Where the phone's relay deviceId is kept (under `deviceId`, as before). It is read and minted
     * only through dev.nodeterm.protocol.secure.PhoneIdentity (`AppGraph.identity`), which keeps it
     * coupled to the box key it belongs to (audit A51). Durable writes use commit() and throw when it
     * fails: the deviceId must be gone from disk before a new box key is written to the other
     * preferences file, and a failed removal must stop that key from being written.
     */
    val identityStorage: PlainStorage = object : PlainStorage {
        override fun get(name: String): String? = prefs.getString(name, null)
        override fun put(name: String, value: String, durable: Boolean) =
            write(prefs.edit().putString(name, value), durable)
        override fun remove(name: String, durable: Boolean) =
            write(prefs.edit().remove(name), durable)

        private fun write(edit: android.content.SharedPreferences.Editor, durable: Boolean) {
            if (!durable) return edit.apply()
            if (!edit.commit()) throw java.io.IOException("Couldn't save the phone's relay id.")
        }
    }

    /** Public creation identities only, scoped to this exact host record. Commit before dispatch. */
    fun managedCreationStorage(hostId: String, current: () -> Boolean = CURRENT_RECORD): ManagedSessionCreation.Storage = object : ManagedSessionCreation.Storage {
        override fun read(): String? = synchronized(this@HostStore) {
            if (!current() || get(hostId) == null) null else prefs.getString("managedCreation.$hostId", null)
        }
        override fun write(encoded: String) {
            synchronized(this@HostStore) {
                if (!current() || get(hostId) == null) throw java.io.IOException("This computer was forgotten. No creation checkpoint will be saved.")
                if (!prefs.edit().putString("managedCreation.$hostId", encoded).commit()) {
                    throw java.io.IOException("Couldn't save the pending session creation. Nothing new will be sent.")
                }
            }
        }
    }

    var deviceName: String
        get() = prefs.getString("deviceName", null) ?: (android.os.Build.MODEL ?: "Android phone")
        set(value) {
            prefs.edit().putString("deviceName", value.trim().ifEmpty { android.os.Build.MODEL ?: "Android phone" }).apply()
        }

    var apiBase: String
        get() = prefs.getString("apiBase", null) ?: dev.nodeterm.protocol.relay.RelayApi.DEFAULT_API_BASE
        set(value) {
            prefs.edit().putString("apiBase", value.trim().trimEnd('/')).apply()
        }

    /**
     * Forget the stored relay address, so [apiBase] answers the built-in default, a later build's
     * included (dev.nodeterm.protocol.relay.ApiBaseSetting.OnLeave.UseDefault). Removing a key
     * that is not there changes nothing.
     */
    fun useDefaultApiBase() {
        prefs.edit().remove("apiBase").apply()
    }

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean("notify", true)
        set(value) {
            prefs.edit().putBoolean("notify", value).apply()
        }

    /**
     * "Show details in notifications": put the event's own text (the command, file or question and
     * the agent's last message) in its notification. OFF by default, because Android shows a
     * notification's full content on a secure lock screen unless the user hides sensitive content
     * (audit A52; the words are dev.nodeterm.protocol.model.InboxNotificationText's).
     */
    var notificationDetails: Boolean
        get() = prefs.getBoolean("notifyDetails", false)
        set(value) {
            prefs.edit().putBoolean("notifyDetails", value).apply()
        }

    var fontSize: Int
        get() = prefs.getInt("fontSize", 13)
        set(value) {
            prefs.edit().putInt("fontSize", value.coerceIn(8, 24)).apply()
        }

    /**
     * Inbox events this phone has announced, read or had on screen (phone-local, like iOS), per
     * computer, trimmed by age and locked across each update — see [SeenLog] (audit A48 and its
     * per-computer follow-up). Two older formats migrate on first use, and the same edit removes
     * them: the phone-wide id → time map under `seenEvents.v2`, and the pre-A48 bare id set under
     * `seenEvents`.
     */
    private val seenLog: SeenLog = SeenLog(object : SeenLog.Storage {
        override fun read(): String? = prefs.getString(SEEN_LOG_KEY, null)
        override fun readV2(): String? = prefs.getString(V2_SEEN_KEY, null)
        override fun readLegacy(): Set<String>? = prefs.getStringSet(LEGACY_SEEN_KEY, null)
        override fun write(encoded: String) {
            // apply() publishes to the in-memory map before it returns; SeenLog holds the lock.
            prefs.edit().putString(SEEN_LOG_KEY, encoded).remove(V2_SEEN_KEY).remove(LEGACY_SEEN_KEY).apply()
        }
    })

    /**
     * The phone has seen [events] of the computer [hostId]: the user read them here. Nothing is
     * recorded for a computer no longer paired, so a screen still open on a computer just forgotten
     * cannot bring back the entries [remove] dropped.
     */
    @Synchronized
    fun markSeen(hostId: String, events: Collection<InboxEvent>) {
        if (get(hostId) == null) return
        seenLog.markSeen(hostId, events)
    }

    /**
     * The events of a fresh listing of the computer [hostId] to notify about now, recorded as
     * announced in the same locked step; what [onScreen] shows is recorded as seen instead (audit
     * A73) — see [SeenLog.claimLive]. Nothing, and nothing recorded, for a computer no longer paired.
     */
    @Synchronized
    fun claimLive(hostId: String, events: List<InboxEvent>, onScreen: OnScreen, notify: Boolean): List<InboxEvent> {
        if (get(hostId) == null) return emptyList()
        return seenLog.claimLive(hostId, events, onScreen, notify)
    }

    private companion object {
        val CURRENT_RECORD: () -> Boolean = { true }
        const val SEEN_LOG_KEY = "seenEvents.v3"
        const val V2_SEEN_KEY = "seenEvents.v2"
        const val LEGACY_SEEN_KEY = "seenEvents"
    }
}
