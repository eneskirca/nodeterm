package dev.nodeterm.protocol.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Which Inbox events this phone has already announced, read or had on screen (phone-local, like
 * iOS), so each event raises at most one notification (audit A48), whichever check sees it first.
 *
 * KEYED BY COMPUTER. An event id is the desktop's `${ts}-${seq}`, and `seq` is a per-run counter
 * of that desktop's mirror (src/core/agent-status-mirror.ts), so two computers can mint the same id
 * in the same millisecond. With one phone-wide set, the first computer's event would silently
 * swallow the second one's notification. So every entry belongs to the pairing id
 * ([PairedHost.id]) of the computer whose listing it came from, and forgetting a computer
 * ([forgetHost]) drops its entries; a computer paired again under a new id keeps them ([moveHost]),
 * since its event ids continue.
 *
 * ONE EVENT, TWO PAIRINGS. The same event can reach the phone through two pairings: a desktop's
 * listing carries its whole mirror, the nodes of its SSH projects included, and the SSH host it
 * drives lists the slice the desktop pushes there (audit A27), with the desktop's events and ids
 * unchanged. So an entry also keeps the event's node, and an event counts as seen under its own
 * computer, or wherever another pairing recorded the same id FOR THE SAME NODE ([Entries.seen]);
 * meeting it that way records it under this computer too, so forgetting the other pairing later does
 * not announce it again. A real collision is two computers minting the same id for DIFFERENT nodes,
 * which stays apart. The same id for the same node on two computers needs the same node id on both
 * (a canvas committed to two repositories) and the same millisecond and counter value, which is
 * treated as never happening.
 *
 * The first version kept a bare id set and trimmed it with `(set + ids).toList().takeLast(500)`.
 * The set came back from SharedPreferences as a `HashSet`, whose order is hash order, so past 500
 * entries every new id evicted an ARBITRARY old one — and an evicted id whose event was still
 * unresolved and inside the announce window was announced again. Its read-modify-write was also
 * unlocked while the worker, the terminal screen and the Inbox tab all called it.
 *
 * What is kept instead: id → an ANCHOR time, the latest of when the phone saw the event and the
 * event's own `ts`. An entry is pruned only when its anchor is more than [RETENTION_MS] old — the
 * announce window plus a margin — and an event stops being announceable [ANNOUNCE_WINDOW_MS] after
 * its `ts` on the same (phone) clock. Since the anchor is never earlier than `ts`, an entry cannot
 * be pruned while its event could still be announced, whatever the desktop's clock says; the `ts`
 * is in the anchor precisely for a desktop clock running ahead of the phone's. So nothing is
 * evicted by COUNT on the way to a notification: [maxEntries] is only a memory backstop (for a
 * desktop that keeps minting future-dated events), sized far beyond what a real Inbox reaches —
 * the desktop caps its feed at 50 events — and it drops the OLDEST anchors first, across computers.
 *
 * Older formats migrate on first use and announce nothing again. Neither says which computer an
 * entry came from, so their entries become [Entries.shared]: seen for EVERY computer until they age
 * out, one retention period after their anchor (the pre-A48 set is migrated as "seen now"). Nothing
 * new is ever written there. Attributing them to a computer is not possible, and dropping them would
 * announce again everything the user already saw; the cost of sharing is the old phone-wide
 * behaviour for those ids alone, for at most a day after the upgrade. [forgetHost] cannot drop the
 * shared ones either, which is harmless for the same reason.
 *
 * Every entry point holds this object's lock across the whole read-modify-write, and
 * [claimAnnounceable] and [claimLive] (the app's path since A73) decide and record in one step, so
 * two callers cannot both announce an event.
 */
class SeenLog(
    private val storage: Storage,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxEntries: Int = MAX_ENTRIES
) {
    /** Where the log is kept (one string in the app's preferences on Android). */
    interface Storage {
        /** The log as [encode] wrote it, or null when it has never been written. */
        fun read(): String?

        /** The A48 format, one id → anchor map for every computer ([decodeIds]). Null when there is none. */
        fun readV2(): String?

        /** The pre-A48 format: a bare set of ids with no times. Null when there is none. */
        fun readLegacy(): Set<String>?

        /** Store [encoded] and drop both older formats, in one edit. */
        fun write(encoded: String)
    }

    /**
     * One event recorded under a computer: its [anchor], and the node it belongs to. [nodeId] is null
     * for an entry written before nodes were kept, which then counts under its own computer only.
     */
    data class Seen(val anchor: Long, val nodeId: String?)

    /**
     * What is stored: each computer's entries (event id → [Seen]) under its pairing id, and the
     * [shared] entries (event id → anchor) an older format left, which count for every computer until
     * they age out.
     */
    class Entries(
        val hosts: LinkedHashMap<String, LinkedHashMap<String, Seen>> = LinkedHashMap(),
        val shared: LinkedHashMap<String, Long> = LinkedHashMap()
    ) {
        /** Whether [id] is recorded for the computer [hostId] itself, or left by an older format. */
        fun has(hostId: String, id: String): Boolean = hosts[hostId]?.containsKey(id) == true || id in shared

        /** Whether another pairing recorded [ev]: the same id for the same node (see the class comment). */
        fun elsewhere(hostId: String, ev: InboxEvent): Boolean =
            hosts.any { (other, ids) -> other != hostId && ids[ev.id]?.nodeId == ev.nodeId }

        /** Whether [ev] counts as seen for the computer [hostId]. */
        fun seen(hostId: String, ev: InboxEvent): Boolean = has(hostId, ev.id) || elsewhere(hostId, ev)

        /** The ids recorded under [hostId] alone (not the shared ones). */
        fun ids(hostId: String): Set<String> = hosts[hostId]?.keys.orEmpty()

        /** The anchors recorded under [hostId] alone, by id. */
        fun anchors(hostId: String): Map<String, Long>? = hosts[hostId]?.mapValues { it.value.anchor }

        val size: Int get() = shared.size + hosts.values.sumOf { it.size }
    }

    /** Whether [event] is recorded as announced or read for the computer [hostId] ([Entries.seen]). */
    @Synchronized
    fun isSeen(hostId: String, event: InboxEvent): Boolean = load(clock()).seen(hostId, event)

    /** The phone has seen [events] of the computer [hostId] (the user read them, or they were announced). */
    @Synchronized
    fun markSeen(hostId: String, events: Collection<InboxEvent>) {
        if (events.isEmpty()) return
        val now = clock()
        val entries = load(now)
        for (ev in events) record(entries, hostId, ev, now)
        save(entries, now)
    }

    /**
     * One check of a fresh listing ([events], the feed of the computer [hostId]): the events to
     * notify about now, recorded as announced in the same locked step (audit A73). What [onScreen]
     * shows is recorded as seen and never returned, so no later check (the next refresh, or the
     * background one) announces what the user already looked at; that happens even when [notify] is
     * false (notifications off, or not allowed by the system), so turning them on later does not
     * announce it either. What waits on a terminal still connecting ([OnScreen.Split.waiting]) is
     * left untouched, for a later listing to decide. The rest is [claimAnnounceable]'s answer when
     * [notify], and left untouched otherwise.
     *
     * Only events that could still be announced are recorded, an entry already recorded is left as it
     * is, and nothing is written when nothing is new: the live check runs every 8 s. Leaving an
     * anchor alone is safe, since the first anchor is never earlier than the event's `ts`, so the
     * entry outlives the announce window. An event another pairing recorded ([Entries.elsewhere]) is
     * not announced, and is recorded under [hostId] once. With [OnScreen.NOTHING] and [notify] it
     * returns what [claimAnnounceable] returns.
     */
    @Synchronized
    fun claimLive(hostId: String, events: List<InboxEvent>, onScreen: OnScreen, notify: Boolean): List<InboxEvent> {
        val now = clock()
        val (shown, offScreen) = onScreen.split(events.filter { announceable(it, now) })
        val claim = if (notify) offScreen else emptyList()
        if (shown.isEmpty() && claim.isEmpty()) return emptyList()
        val entries = load(now)
        var changed = false
        for (ev in shown) {
            if (entries.has(hostId, ev.id)) continue
            record(entries, hostId, ev, now)
            changed = true
        }
        val fresh = ArrayList<InboxEvent>()
        for (ev in claim) {
            if (entries.has(hostId, ev.id)) continue
            if (!entries.elsewhere(hostId, ev)) fresh += ev
            record(entries, hostId, ev, now)
            changed = true
        }
        if (changed) save(entries, now)
        return fresh
    }

    /**
     * The events of [events] (the feed of the computer [hostId], oldest → newest) that should raise
     * a notification now — unresolved, inside the announce window and never announced or read, here
     * or through another pairing ([Entries.seen]) — recorded as announced in the same step. Order is
     * kept. One another pairing recorded is recorded under [hostId] too, and not returned.
     */
    @Synchronized
    fun claimAnnounceable(hostId: String, events: List<InboxEvent>): List<InboxEvent> {
        val now = clock()
        val entries = load(now)
        val fresh = ArrayList<InboxEvent>()
        var changed = false
        for (ev in events) {
            if (!announceable(ev, now) || entries.has(hostId, ev.id)) continue
            if (!entries.elsewhere(hostId, ev)) fresh += ev
            record(entries, hostId, ev, now)
            changed = true
        }
        if (changed) save(entries, now)
        return fresh
    }

    /** The phone forgot the computer [hostId]: its entries go with it (the shared ones cannot). */
    @Synchronized
    fun forgetHost(hostId: String) {
        val now = clock()
        val entries = load(now)
        if (entries.hosts.remove(hostId) != null) save(entries, now)
    }

    /**
     * The computer once paired as [from] is now paired as [to] (paired again, which mints a new
     * pairing id): what the phone saw of it carries over, since its event ids continue. Where both
     * hold an id, the later anchor wins (and a node either one knew is kept).
     */
    @Synchronized
    fun moveHost(from: String, to: String) {
        if (from == to) return
        val now = clock()
        val entries = load(now)
        val moved = entries.hosts.remove(from) ?: return
        val target = entries.hosts.getOrPut(to) { LinkedHashMap() }
        for ((id, seen) in moved) {
            val had = target[id]
            target[id] = if (had == null) seen else Seen(maxOf(had.anchor, seen.anchor), had.nodeId ?: seen.nodeId)
        }
        save(entries, now)
    }

    private fun record(entries: Entries, hostId: String, ev: InboxEvent, now: Long) {
        val mine = entries.hosts.getOrPut(hostId) { LinkedHashMap() }
        mine[ev.id] = Seen(maxOf(mine[ev.id]?.anchor ?: Long.MIN_VALUE, now, ev.ts), ev.nodeId)
    }

    /** The stored entries; migrates an older format (and persists that) the first time. */
    private fun load(now: Long): Entries {
        storage.read()?.let { return decode(it, now) }
        val shared = storage.readV2()?.let { decodeIds(it, now) }
            ?: storage.readLegacy()?.associateWithTo(LinkedHashMap()) { now }
            ?: return Entries()
        val migrated = Entries(shared = shared)
        save(migrated, now)
        return migrated
    }

    private fun save(entries: Entries, now: Long) {
        storage.write(encode(prune(entries, now, maxEntries)))
    }

    companion object {
        /** The background check announces only events younger than this (by the phone's clock). */
        const val ANNOUNCE_WINDOW_MS: Long = 6 * 3_600_000L

        /** How long past the window an entry is kept: slack for a desktop clock that runs ahead. */
        const val RETENTION_MARGIN_MS: Long = 18 * 3_600_000L

        /** An entry whose anchor is older than this is dropped. */
        const val RETENTION_MS: Long = ANNOUNCE_WINDOW_MS + RETENTION_MARGIN_MS

        /** Memory backstop only (see the class comment); never reached by a real Inbox. */
        const val MAX_ENTRIES: Int = 5_000

        /** Unresolved and inside the announce window. Written without `now - ts`, which overflows. */
        fun announceable(ev: InboxEvent, now: Long): Boolean = !ev.resolved && ev.ts > now - ANNOUNCE_WINDOW_MS

        /**
         * `{"hosts":{"<hostId>":{"<id>":{"t":anchor,"n":"<nodeId>"}}},"shared":{"<id>":anchor}}`;
         * empty parts, and an unknown node, are left out.
         */
        fun encode(entries: Entries): String {
            val parts = LinkedHashMap<String, JsonElement>()
            val hosts = entries.hosts.filterValues { it.isNotEmpty() }
            if (hosts.isNotEmpty()) parts["hosts"] = JsonObject(hosts.mapValues { (_, ids) -> JsonObject(ids.mapValues { encodeSeen(it.value) }) })
            if (entries.shared.isNotEmpty()) parts["shared"] = encodeIds(entries.shared)
            return JsonObject(parts).toString()
        }

        private fun encodeSeen(seen: Seen): JsonObject = JsonObject(
            buildMap {
                put("t", JsonPrimitive(seen.anchor))
                seen.nodeId?.let { put("n", JsonPrimitive(it)) }
            }
        )

        /**
         * Tolerant: an unreadable log, or an unreadable part of it, is empty; an entry whose time is
         * unreadable counts as seen [now] — an id we once recorded stays recorded rather than being
         * announced again — and one whose node is unreadable has none. A bare time, as the build
         * before nodes were kept wrote a computer's entries, is an entry with no node.
         */
        fun decode(raw: String, now: Long): Entries {
            val obj = J.obj(J.parse(raw)) ?: return Entries()
            val hosts = LinkedHashMap<String, LinkedHashMap<String, Seen>>()
            J.obj(obj["hosts"])?.forEach { (hostId, ids) -> J.obj(ids)?.let { hosts[hostId] = seenOf(it, now) } }
            val shared = J.obj(obj["shared"])?.let { idsOf(it, now) } ?: LinkedHashMap()
            return Entries(hosts, shared)
        }

        private fun seenOf(obj: JsonObject, now: Long): LinkedHashMap<String, Seen> {
            val out = LinkedHashMap<String, Seen>()
            for ((id, v) in obj) {
                val entry = J.obj(v)
                out[id] = if (entry == null) Seen(J.long(v) ?: now, null) else Seen(J.long(entry["t"]) ?: now, J.str(entry["n"]))
            }
            return out
        }

        /** One id → anchor map: the A48 format, and this one's [Entries.shared] part. */
        fun encodeIds(ids: Map<String, Long>): JsonObject = JsonObject(ids.mapValues { JsonPrimitive(it.value) })

        /** [decode]'s rules for one id → anchor map: the A48 format, read once to migrate it. */
        fun decodeIds(raw: String, now: Long): LinkedHashMap<String, Long> =
            J.obj(J.parse(raw))?.let { idsOf(it, now) } ?: LinkedHashMap()

        private fun idsOf(obj: JsonObject, now: Long): LinkedHashMap<String, Long> {
            val out = LinkedHashMap<String, Long>()
            for ((id, v) in obj) out[id] = J.long(v) ?: now
            return out
        }

        /**
         * Drops entries past [RETENTION_MS], and computers left with none; above [maxEntries] in all,
         * keeps the newest anchors, whichever computer they belong to.
         */
        fun prune(entries: Entries, now: Long, maxEntries: Int = MAX_ENTRIES): Entries {
            val cutoff = now - RETENTION_MS
            val hosts = LinkedHashMap<String, LinkedHashMap<String, Seen>>()
            for ((hostId, ids) in entries.hosts) {
                val kept = ids.filterTo(LinkedHashMap()) { it.value.anchor >= cutoff }
                if (kept.isNotEmpty()) hosts[hostId] = kept
            }
            val shared = entries.shared.filterTo(LinkedHashMap()) { it.value >= cutoff }
            val kept = Entries(hosts, shared)
            if (kept.size <= maxEntries) return kept
            // (computer or null for shared, id, anchor), newest first.
            val newest = buildList {
                for ((hostId, ids) in hosts) for ((id, s) in ids) add(Triple<String?, String, Long>(hostId, id, s.anchor))
                for ((id, a) in shared) add(Triple<String?, String, Long>(null, id, a))
            }.sortedByDescending { it.third }.take(maxEntries).mapTo(HashSet()) { it.first to it.second }
            val trimmedHosts = LinkedHashMap<String, LinkedHashMap<String, Seen>>()
            for ((hostId, ids) in hosts) {
                val left = ids.filterTo(LinkedHashMap()) { (hostId to it.key) in newest }
                if (left.isNotEmpty()) trimmedHosts[hostId] = left
            }
            return Entries(trimmedHosts, shared.filterTo(LinkedHashMap()) { (null to it.key) in newest })
        }
    }
}
