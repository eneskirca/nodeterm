package dev.nodeterm.protocol.model

/**
 * One paired computer as a merged screen names it (audit A55): its pairing id, and the label its
 * cards and usage sections carry. Built by [AllComputers.labels].
 */
data class ComputerLabel(val hostId: String, val label: String)

/** A computer's latest listing (its session's cached snapshot), with the label it is shown under. */
data class ComputerListing(val computer: ComputerLabel, val snapshot: ProjectsSnapshot)

/**
 * What an Inbox shows (docs/mobile-usage-inbox.md, "Agents tab (feed)"): the open approvals and
 * questions newest first, then the sessions working right now, then the archive (finished turns and
 * resolved cards), newest first.
 *
 * One computer's (its Inbox tab) and every paired computer's merged (the "All computers" screen,
 * audit A55) are built by the same [of], so the merged feed never sorts, splits or counts differently
 * from a computer's own. Every card keeps the computer it came from ([Item.from]): its title, its
 * context ring and its answer all belong to that computer's listing and session, never to another's.
 */
data class InboxFeed(
    val actionable: List<Item>,
    val working: List<Live>,
    val archived: List<Item>
) {
    /** One event, with the listing it came from. */
    data class Item(val from: ComputerListing, val event: InboxEvent) {
        val hostId: String get() = from.computer.hostId

        /** A list key. Two computers can mint the same event id, so it names the computer too. */
        val key: String get() = "$hostId/${event.id}"

        /** The node's context-window fill on its own computer, when known. */
        val contextPercent: Double? get() = from.snapshot.status?.inbox?.nodes?.get(event.nodeId)?.contextPercent
    }

    /** A session working right now that reports what it is doing, from the listing it came from. */
    data class Live(val from: ComputerListing, val nodeId: String, val now: InboxNodeNow) {
        val hostId: String get() = from.computer.hostId

        /** A list key. Two computers can have the same node id (a canvas committed to two repos). */
        val key: String get() = "$hostId/$nodeId"
    }

    val isEmpty: Boolean get() = actionable.isEmpty() && working.isEmpty() && archived.isEmpty()

    companion object {
        /**
         * The feed of [listings], in their order. Events are sorted newest first ACROSS computers; the
         * sort is stable, so events with the same timestamp keep the order of [listings], then each
         * mirror's own order. Working sessions are not sorted by time: their `updatedAt` moves with
         * every tool call, so a time order would reshuffle the live cards on every refresh. They come
         * in [listings] order, each computer's in its mirror's order, which is what a single
         * computer's Inbox always showed.
         */
        fun of(listings: List<ComputerListing>): InboxFeed {
            val events = listings
                .flatMap { l -> l.snapshot.status?.inbox?.events.orEmpty().map { Item(l, it) } }
                .sortedByDescending { it.event.ts }
            val working = listings.flatMap { l ->
                val status = l.snapshot.status ?: return@flatMap emptyList()
                status.nodes.mapNotNull { (nodeId, st) ->
                    val now = status.inbox?.nodes?.get(nodeId)
                    if (st.state == AgentState.WORKING && now?.activity != null) Live(l, nodeId, now) else null
                }
            }
            return InboxFeed(
                actionable = events.filter { it.event.actionable },
                working = working,
                archived = events.filterNot { it.event.actionable }
            )
        }
    }
}

/**
 * The phone's "All computers" screen (audit A55): iOS's Agents and Usages tabs merge every paired
 * connection (docs/mobile-usage-inbox.md "iOS behavior (v1)"), where the app had only one computer's
 * Inbox and Usage, inside that computer's screen. The rules are here, pure; the screen only draws.
 */
object AllComputers {
    /**
     * What a computer needs from you: its open approvals and questions. One definition for the
     * count on its row in the computers list, on its Inbox tab, and on the All computers screen.
     */
    fun needsYou(snapshot: ProjectsSnapshot): Int = snapshot.status?.inbox?.events?.count { it.actionable } ?: 0

    /**
     * Whether the computers list offers the merged screen: once a second computer is paired. With one,
     * that computer's own Inbox and Usage tabs already are all of it.
     */
    fun offered(pairedCount: Int): Boolean = pairedCount > 1

    /**
     * What each computer is called on a merged screen, in [hosts] order. Its pairing name, or
     * "Computer" for a blank one. Two computers paired under the same name (two machines both called
     * "MacBook Pro") would be told apart by nothing, so a shared name gets the address the phone
     * dials (`user@host`), and a label that is still shared (the same computer paired twice) a number
     * in pairing order. Names compare case-insensitively, the way a reader does.
     */
    fun labels(hosts: List<PairedHost>): List<ComputerLabel> {
        val names = hosts.map { it.name.trim().ifEmpty { "Computer" } }
        val withAddress = hosts.mapIndexed { i, h ->
            if (names.count { it.equals(names[i], ignoreCase = true) } > 1) "${names[i]} (${h.user}@${h.host})" else names[i]
        }
        return hosts.mapIndexed { i, h ->
            val same = withAddress.indices.filter { withAddress[it].equals(withAddress[i], ignoreCase = true) }
            ComputerLabel(h.id, if (same.size > 1) "${withAddress[i]} #${same.indexOf(i) + 1}" else withAddress[i])
        }
    }

    /** Every computer's Inbox, merged ([InboxFeed.of]): newest first, each card with its computer. */
    fun feed(listings: List<ComputerListing>): InboxFeed = InboxFeed.of(listings)

    /** One computer's usage on the merged Usage tab: its accounts, under its label and `updatedAt`. */
    data class UsageSection(val computer: ComputerLabel, val usage: MirrorUsage, val status: AgentStatusFile)

    /**
     * One section per computer that reports usage (docs/mobile-usage-inbox.md: "one section per paired
     * connection that reports `usage`"), in [listings] order. A computer reports nothing when its
     * mirror has no `usage` block or no account in it: a computer not listed yet, an older desktop,
     * or one whose usage service has nothing cached. It gets no empty section.
     */
    fun usage(listings: List<ComputerListing>): List<UsageSection> = listings.mapNotNull { l ->
        val status = l.snapshot.status ?: return@mapNotNull null
        val usage = status.usage?.takeIf { it.accounts.isNotEmpty() } ?: return@mapNotNull null
        UsageSection(l.computer, usage, status)
    }
}
