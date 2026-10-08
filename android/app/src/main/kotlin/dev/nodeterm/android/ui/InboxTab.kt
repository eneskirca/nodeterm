package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.RadioButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.HostConnection
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.QuickActions
import dev.nodeterm.protocol.model.AccountNames
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.AgentStatusFile
import dev.nodeterm.protocol.model.ComputerLabel
import dev.nodeterm.protocol.model.ComputerListing
import dev.nodeterm.protocol.model.ContextFill
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxFeed
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.QuestionChoices
import dev.nodeterm.protocol.model.UsageAccount
import dev.nodeterm.protocol.model.UsageLimit
import dev.nodeterm.protocol.model.UsagePace
import dev.nodeterm.protocol.ssh.NothingFoundException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Agents feed (docs/mobile-usage-inbox.md): unresolved approvals and questions on top — with
 * deterministic Approve/Deny for a held hook-reply approval — then live activity, then the archive.
 * Read/unread is phone-local, like iOS; `resolved` from the computer only moves cards out of the
 * actionable list. This is one computer's; the All computers screen merges every computer's through
 * the same [InboxFeed] and [InboxFeedList] (audit A55).
 */
@Composable
fun InboxTab(nav: Navigator, hostId: String, session: HostSession, snapshot: ProjectsSnapshot) {
    val graph = NodetermApp.graph(LocalContext.current)
    // While this tab is on screen, the live refresh announces none of this computer's events; it
    // records them as seen, so the background check does not announce them later either (A73).
    LifecycleStartEffect(hostId) {
        val showing = session.onScreen.showInbox()
        onStopOrDispose { showing.close() }
    }
    val name = graph.hosts.get(hostId)?.name ?: "Computer"
    val feed = InboxFeed.of(listOf(ComputerListing(ComputerLabel(hostId, name), snapshot)))
    InboxFeedList(nav, feed, showComputer = false, emptyText = "Nothing needs you right now.")
}

/** What a feed card calls its session: the agent's session name, else the node's title, else "Session". */
internal fun feedTitle(snapshot: ProjectsSnapshot, nodeId: String): String =
    snapshot.findNode(nodeId)?.second?.let { displayTitle(it, snapshot) } ?: snapshot.statusOf(nodeId)?.name ?: "Session"

/**
 * The cards of [feed]: one computer's Inbox tab, or every computer's merged ([showComputer]: each card
 * then names its computer). Every card acts on ITS OWN computer (audit A55): Open opens the session on
 * the computer the card came from, and an answer goes through that computer's session, since
 * [QuickActions] answers over the one connection it is handed, and a merged feed holds cards of
 * several computers.
 */
@Composable
internal fun InboxFeedList(nav: Navigator, feed: InboxFeed, showComputer: Boolean, emptyText: String) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val scope = rememberCoroutineScope()
    // Saveable, so an open archive stays open after a terminal opened from it (audit A43).
    var showArchive by rememberSaveable { mutableStateOf(false) }
    var pendingActions by remember { mutableStateOf(emptySet<Pair<String, String>>()) }

    // Each card under ITS computer: a merged feed holds several, and two can mint the same event id.
    LaunchedEffect(feed.actionable.map { it.key }) {
        feed.actionable.groupBy({ it.hostId }, { it.event }).forEach { (hostId, events) -> graph.hosts.markSeen(hostId, events) }
    }

    fun openOn(from: ComputerListing, nodeId: String) =
        nav.push(Route.Terminal(from.computer.hostId, nodeId, feedTitle(from.snapshot, nodeId)))

    fun runOn(from: ComputerListing, label: String, block: suspend (HostConnection) -> QuickActions.Result, nodeId: String, eventId: String) {
        val actionKey = from.computer.hostId to eventId
        if (actionKey in pendingActions) return
        pendingActions = pendingActions + actionKey
        // The card's own computer, whichever screen shows it.
        val session = graph.connections.session(from.computer.hostId)
        scope.launch {
            try {
                val result = try {
                    block(session.ensureConnected())
                } catch (e: NeedsRelayException) {
                    // Direct SSH reaches only this computer; a node of one of its SSH projects is
                    // answered where it lives, through the relay (audit A09). With no relay leg to
                    // open, say what is in the way for this computer instead (A27 and its review).
                    e.refusal(session.relayLeg())?.let { throw HostException(it) }
                    block(session.viaRelay())
                }
                when (result) {
                    QuickActions.Result.SENT -> Toast.makeText(context, label, Toast.LENGTH_SHORT).show()
                    QuickActions.Result.ALREADY_HANDLED -> Toast.makeText(context, "Already handled.", Toast.LENGTH_SHORT).show()
                    QuickActions.Result.OPEN_SESSION -> openOn(from, nodeId)
                    QuickActions.Result.EXPIRED -> {
                        Toast.makeText(context, "The request timed out on the computer. Answer it in the session.", Toast.LENGTH_LONG).show()
                        openOn(from, nodeId)
                    }
                }
                session.refreshNow()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val text = (e as? NothingFoundException)?.said(session.relayLeg()) ?: e.message ?: "Couldn't reach ${from.computer.label}."
                Toast.makeText(context, text, Toast.LENGTH_LONG).show()
            } finally {
                pendingActions = pendingActions - actionKey
            }
        }
    }

    if (feed.isEmpty) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(emptyText, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(feed.actionable, key = { "a-${it.key}" }) { item ->
            val ev = item.event
            EventCard(
                ev, feedTitle(item.from.snapshot, ev.nodeId), item.from.snapshot, item.contextPercent,
                computer = item.from.computer.label.takeIf { showComputer },
                highlight = true,
                onOpen = { openOn(item.from, ev.nodeId) }
            ) {
                EventActions(
                    ev,
                    busy = (item.from.computer.hostId to ev.id) in pendingActions,
                    open = { nodeId -> openOn(item.from, nodeId) },
                    run = { label, block, nodeId -> runOn(item.from, label, block, nodeId, ev.id) }
                )
            }
        }
        items(feed.working, key = { "w-${it.key}" }) { live ->
            val now = live.now
            val nodeId = live.nodeId
            Column(
                Modifier.fillMaxWidth().background(NtColors.panel, RoundedCornerShape(10.dp)).clickable { openOn(live.from, nodeId) }.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                if (showComputer) ComputerLine(live.from.computer.label)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(dev.nodeterm.protocol.model.SessionBucket.RUNNING)
                    Spacer(Modifier.width(8.dp))
                    Text(feedTitle(live.from.snapshot, nodeId), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                now.prompt?.let { Text("You: $it", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                now.activity?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                ContextIndicator(now.contextPercent)
            }
        }
        if (feed.archived.isNotEmpty()) {
            item(key = "archive-toggle") {
                TextButton(onClick = { showArchive = !showArchive }) {
                    Text(if (showArchive) "Hide archive" else "Archive (${feed.archived.size})")
                }
            }
            if (showArchive) {
                items(feed.archived, key = { "r-${it.key}" }) { item ->
                    val ev = item.event
                    EventCard(
                        ev, feedTitle(item.from.snapshot, ev.nodeId), item.from.snapshot, item.contextPercent,
                        computer = item.from.computer.label.takeIf { showComputer },
                        highlight = false,
                        onOpen = { openOn(item.from, ev.nodeId) }
                    ) {}
                }
            }
        }
    }
}

/**
 * What an open card offers. [open] and [run] are bound to the card's own computer by [InboxFeedList].
 */
@Composable
private fun EventActions(
    ev: InboxEvent,
    busy: Boolean,
    open: (nodeId: String) -> Unit,
    run: (label: String, block: suspend (HostConnection) -> QuickActions.Result, nodeId: String) -> Unit
) {
    if (ev.kind == InboxKind.APPROVAL) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = !busy, onClick = {
                run("Approved.", { c -> QuickActions.answerApproval(c, ev, allow = true) }, ev.nodeId)
            }) { Text("Approve") }
            OutlinedButton(enabled = !busy, onClick = {
                run("Denied.", { c -> QuickActions.answerApproval(c, ev, allow = false) }, ev.nodeId)
            }) { Text("Deny") }
            TextButton(onClick = { open(ev.nodeId) }) { Text("Open") }
        }
        if (ev.pendingId != null && ev.permissionSuggestions.isNotEmpty()) {
            var rememberDialog by remember(ev.id, ev.pendingId) { mutableStateOf(false) }
            var selectedRule by remember(ev.id, ev.pendingId) { mutableStateOf<Int?>(null) }
            TextButton(enabled = !busy, onClick = { rememberDialog = true }) { Text("Always allow…") }
            if (rememberDialog) AlertDialog(
                onDismissRequest = { rememberDialog = false },
                title = { Text("Allow and remember a rule") },
                text = {
                    Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                        Text("Choose the rule and where it applies. This does not change the session's permission mode.")
                        ev.permissionSuggestions.forEach { suggestion ->
                            Row(Modifier.fillMaxWidth().clickable { selectedRule = suggestion.index }, verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(selected = selectedRule == suggestion.index, onClick = { selectedRule = suggestion.index })
                                Text(suggestion.label)
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(enabled = !busy && selectedRule != null, onClick = {
                        val index = selectedRule ?: return@TextButton
                        rememberDialog = false
                        run("Approval sent.", { c -> QuickActions.rememberApproval(c, ev, index) }, ev.nodeId)
                    }) { Text("Allow and remember") }
                },
                dismissButton = { TextButton(onClick = { rememberDialog = false }) { Text("Cancel") } }
            )
        }
    } else {
        // One rule for what the card offers and what the answer path accepts (audit A57).
        when (val choices = QuestionChoices.of(ev)) {
            is QuestionChoices.Held -> {
                var selected by remember(ev.id, choices.ticket) { mutableStateOf(List(choices.questions.size) { emptySet<Int>() }) }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    choices.questions.forEachIndexed { qi, question ->
                        Text(question.question, fontWeight = FontWeight.SemiBold)
                        if (question.multiSelect) Text("Choose one or more", style = MaterialTheme.typography.labelSmall)
                        question.options.forEachIndexed { oi, option ->
                            fun toggle() {
                                selected = selected.mapIndexed { i, set ->
                                    if (i != qi) set else if (!question.multiSelect) setOf(oi)
                                    else if (oi in set) set - oi else set + oi
                                }
                            }
                            Row(Modifier.fillMaxWidth().clickable { toggle() }, verticalAlignment = Alignment.CenterVertically) {
                                if (question.multiSelect) Checkbox(checked = oi in selected[qi], onCheckedChange = { toggle() })
                                else RadioButton(selected = oi in selected[qi], onClick = { toggle() })
                                Column {
                                    Text(option.label)
                                    if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                    Button(enabled = !busy && selected.all { it.isNotEmpty() }, onClick = {
                        val answer = selected.map { it.sorted() }
                        run("Answered.", { c -> QuickActions.answerQuestions(c, ev, answer) }, ev.nodeId)
                    }) { Text("Send answers") }
                    TextButton(onClick = { open(ev.nodeId) }) { Text("Open session") }
                }
            }
            is QuestionChoices.Answer -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                choices.rows.forEachIndexed { i, row ->
                    OutlinedButton(enabled = !busy, onClick = {
                        run("Answered.", { c -> QuickActions.answerQuestion(c, ev, i) }, ev.nodeId)
                    }, modifier = Modifier.fillMaxWidth()) { Text(row, maxLines = 2) }
                }
            }
            // Multi-select: shown so the card says what is asked, but plain text, not
            // buttons. The picker's toggle/submit keys are unmeasured, so it is answered
            // in the session (QuestionChoices says why).
            is QuestionChoices.ReadOnly -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    QuestionChoices.SEVERAL_NOTE,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                choices.rows.forEach { row ->
                    Text(
                        row,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }
                TextButton(onClick = { open(ev.nodeId) }) { Text("Open session") }
            }
            QuestionChoices.None -> TextButton(onClick = { open(ev.nodeId) }) { Text("Open session") }
        }
    }
}

/** The computer a card on a merged screen came from (audit A55). */
@Composable
private fun ComputerLine(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}

@Composable
private fun EventCard(
    ev: InboxEvent,
    title: String,
    snapshot: ProjectsSnapshot,
    /** The node's context-window fill (`inbox.nodes[nodeId].contextPercent`), when known. */
    contextPercent: Double?,
    /** The card's computer, on a merged screen (audit A55); null on a computer's own Inbox. */
    computer: String?,
    highlight: Boolean,
    onOpen: () -> Unit,
    actions: @Composable () -> Unit
) {
    val accent = when (ev.kind) {
        InboxKind.APPROVAL -> NtColors.attention
        InboxKind.QUESTION -> NtColors.warning
        InboxKind.DONE -> NtColors.success
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (highlight) accent.copy(alpha = 0.10f) else NtColors.panel, RoundedCornerShape(10.dp))
            .clickable(onClick = onOpen)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        computer?.let { ComputerLine(it) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when (ev.kind) {
                    InboxKind.APPROVAL -> "NEEDS APPROVAL"
                    InboxKind.QUESTION -> "QUESTION"
                    InboxKind.DONE -> if (ev.interrupted) "INTERRUPTED" else "FINISHED"
                },
                color = accent,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.width(8.dp))
            Text(title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(relativeAge(ev.ts), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(ev.title, fontWeight = FontWeight.SemiBold)
        ev.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4) }
        val agent = Agent.of(ev.agentId ?: snapshot.statusOf(ev.nodeId)?.agentId)
        if (agent != null || ContextFill.percent(contextPercent) != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                agent?.let { Text(it.label, style = MaterialTheme.typography.labelSmall, color = parseHex(it.color)) }
                ContextIndicator(contextPercent)
            }
        }
        actions()
    }
}

/**
 * A node's context-window fill as a small ring and "42% context" (docs/mobile-usage-inbox.md: cards
 * show the node's `contextPercent` ring when known). Nothing at all when it is unknown. The ring's
 * colour follows the desktop context meter's bands ([ContextFill.level]).
 */
@Composable
private fun ContextIndicator(contextPercent: Double?) {
    val raw = contextPercent ?: return
    val pct = ContextFill.percent(raw) ?: return
    val label = ContextFill.label(raw) ?: return
    val color = when (ContextFill.level(raw)) {
        ContextFill.Level.CRITICAL -> NtColors.attention
        ContextFill.Level.HIGH -> NtColors.warning
        ContextFill.Level.OK -> NtColors.success
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        CircularProgressIndicator(
            progress = { pct / 100f },
            modifier = Modifier.size(12.dp),
            color = color,
            strokeWidth = 2.dp,
            trackColor = NtColors.panel2
        )
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Usages (docs/mobile-usage-inbox.md): per account, each limit's consumption and reset. Colour is
 * the provider's severity when given, else derived (≥90 red, ≥70 amber, else green).
 */
@Composable
fun UsageTab(snapshot: ProjectsSnapshot) {
    val usage = snapshot.status?.usage
    if (usage == null || usage.accounts.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "This computer isn't reporting usage. (Usage is shared by nodeterm on the computer for its local accounts.)",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(usage.accounts, key = { it.accountId ?: "system" }) { account -> UsageCard(account, snapshot.status) }
        updatedAgo(usage.updatedAt)?.let { item { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
    }
}

/** "Updated 5m ago" for a usage snapshot taken at [ts]; "Updated just now" for a fresh one; null for no time. */
internal fun updatedAgo(ts: Long, now: Long = System.currentTimeMillis()): String? = when (val age = relativeAge(ts, now)) {
    "" -> null
    "now" -> "Updated just now"
    else -> "Updated $age ago"
}

/** One account's usage. Also drawn, per computer, by the All computers screen (audit A55). */
@Composable
internal fun UsageCard(account: UsageAccount, status: AgentStatusFile?) {
    // The same resolver the sessions list uses, so a managed account is never titled by its UUID.
    val title = account.accountId?.let { AccountNames.managed(it, status) }
        ?: account.label ?: account.email ?: AccountNames.SYSTEM
    Column(
        Modifier.fillMaxWidth().background(NtColors.panel, RoundedCornerShape(10.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(title, fontWeight = FontWeight.SemiBold)
        account.email?.takeIf { it != title }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        if (account.status != "ok" && account.limits.isEmpty()) {
            Text(if (account.status == "error") "Could not read usage." else "Usage unavailable.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        account.limits.forEach { UsageBar(it, measuredAt = account.updatedAt) }
    }
}

@Composable
private fun UsageBar(limit: UsageLimit, measuredAt: Long, now: Long = System.currentTimeMillis()) {
    val pct = limit.usedPercent.coerceIn(0.0, 100.0)
    val color: Color = when (limit.severity) {
        "critical", "error", "red" -> NtColors.attention
        "warning", "amber", "yellow" -> NtColors.warning
        "ok", "normal", "green" -> NtColors.success
        else -> if (pct >= 90) NtColors.attention else if (pct >= 70) NtColors.warning else NtColors.success
    }
    val name = when (limit.kind) {
        "session" -> "Session window"
        "weekly_all" -> "Weekly (all models)"
        "weekly_scoped" -> "Weekly · ${limit.scopeLabel ?: "model"}"
        else -> limit.scopeLabel ?: limit.kind
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row {
            Text(name, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            Text("${pct.toInt()}%" + (limit.resetsAt?.let { " · resets ${resetLabel(it, now)}" } ?: ""), style = MaterialTheme.typography.bodySmall)
        }
        LinearProgressIndicator(
            progress = { (pct / 100.0).toFloat() },
            color = color,
            trackColor = NtColors.panel2,
            modifier = Modifier.fillMaxWidth().height(6.dp)
        )
        // Only when the window's end and length are known (UsagePace says why it would refuse),
        // judged at the time the percentage was measured, not now (UsagePace says why).
        UsagePace.of(limit, measuredAt = measuredAt, now = now)?.let { reading ->
            Text(
                reading.line,
                style = MaterialTheme.typography.labelSmall,
                color = if (reading.pace == UsagePace.Pace.FASTER) NtColors.warning else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** `<24h → "16:40"` clock time, else `"3d 16h"` — the iOS usage tab's reset label. */
private fun resetLabel(resetsAt: Long, now: Long = System.currentTimeMillis()): String {
    val left = resetsAt - now
    if (left <= 0) return "now"
    return if (left < 86_400_000L) SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(resetsAt))
    else "${left / 86_400_000L}d ${(left % 86_400_000L) / 3_600_000L}h"
}
