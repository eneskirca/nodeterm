package dev.nodeterm.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.conn.ConnState
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.RelayApprovalGate.Trigger
import dev.nodeterm.protocol.model.AllComputers
import dev.nodeterm.protocol.model.ComputerLabel
import dev.nodeterm.protocol.model.ComputerListing
import dev.nodeterm.protocol.model.InboxFeed
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield

/**
 * Every paired computer's Inbox and Usage on one screen (audit A55), like iOS's Agents and Usages tabs
 * (docs/mobile-usage-inbox.md: "merged events across connections, newest first"; "one section per
 * paired connection that reports `usage`"). Each card names its computer, and Open / Approve / Answer
 * go to that computer's own session ([InboxFeedList]). The rules (merge, order, labels, sections) are
 * [AllComputers], pure and tested; this only draws them.
 *
 * While visible, every paired computer is watched through its normal connect path and re-listed
 * every 8 seconds. Leaving or backgrounding the screen cancels its watchers; other visible screens
 * and in-flight background actions keep their own connection ownership.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AllComputersScreen(nav: Navigator) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val hosts by graph.hosts.hosts.collectAsState()
    val listings = rememberListings(hosts)
    val hostIds = remember(hosts) { hosts.map { it.id } }
    val uiScope = rememberCoroutineScope()
    // Saved under this back-stack entry's key, so it survives a terminal opened from a card (A43).
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val tabStates = rememberSaveableStateHolder()

    // Every computer re-listed through its normal connect path, so a relay leg goes through
    // RelayApprovalGate. As the app's own FOREGROUND refresh (Trigger.AUTO), not a tap on that computer:
    // the user is looking, so a computer that has never approved this phone may show its code below,
    // but a computer whose approval was refused or went unanswered keeps that hold (A05/A23). Lifting
    // it would raise the desktop's dialog again on every visit to this screen, on a computer the user
    // did not ask about and may not be at; its own Try again below asks (Trigger.USER).
    fun refreshAll() = hostIds.forEach { graph.connections.session(it).refresh(Trigger.AUTO) }

    // On ON_START, like a computer's own screen starts watching: opening the screen, coming back to the
    // app, and coming back from a terminal re-list. Launched on the UI dispatcher, i.e. after this
    // frame's effects: the Inbox tab registers what it shows (A73) before the first listing is asked for.
    // Key each watcher separately: changing the paired host set leaves the unaffected loops alone.
    for (hostId in hostIds) key(hostId) {
        LifecycleStartEffect(hostId) {
            val session = graph.connections.session(hostId)
            var watching = false
            val starting = uiScope.launch {
                yield() // let this STARTED frame register every visible Inbox first (A73)
                session.startWatching(Trigger.AUTO)
                watching = true
            }
            onStopOrDispose {
                starting.cancel()
                if (watching) session.stopWatching(closeWhenUnused = true)
            }
        }
    }

    val feed = AllComputers.feed(listings)
    val needsYou = feed.actionable.size

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("All computers")
                        Text(
                            "Inbox and usage from ${hosts.size} computer" + (if (hosts.size == 1) "" else "s"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { IconButton(onClick = { refreshAll() }) { Icon(Icons.Filled.Refresh, "Refresh") } }
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // What stands between a computer and its cards: connecting, a code to approve, an error.
            for (l in listings) key(l.computer.hostId) { ComputerStatus(l.computer, graph.connections.session(l.computer.hostId)) }
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(if (needsYou > 0) "Inbox ($needsYou)" else "Inbox") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Usage") })
            }
            tabStates.SaveableStateProvider(tab) {
                when (tab) {
                    0 -> AllInbox(nav, hostIds, feed)
                    else -> AllUsage(AllComputers.usage(listings))
                }
            }
        }
    }
}

/**
 * Each paired computer's cached listing (its session's latest snapshot), labelled ([AllComputers.labels]),
 * in [hosts] order. It reads what the sessions already hold and updates as they re-list: nothing here
 * connects, so the computers list can show its counts without a dial.
 */
@Composable
internal fun rememberListings(hosts: List<PairedHost>): List<ComputerListing> {
    val graph = NodetermApp.graph(LocalContext.current)
    val labels = remember(hosts) { AllComputers.labels(hosts) }
    val initial = remember(labels) { labels.map { ComputerListing(it, graph.connections.session(it.hostId).snapshot.value) } }
    val flow = remember(labels) {
        val snapshots = labels.map { graph.connections.session(it.hostId).snapshot }
        if (snapshots.isEmpty()) flowOf(emptyList())
        else combine(snapshots) { latest: Array<ProjectsSnapshot> -> labels.mapIndexed { i, l -> ComputerListing(l, latest[i]) } }
    }
    val listings by flow.collectAsState(initial)
    return listings
}

/** The merged Inbox. While it is on screen, so is every computer's Inbox (A73). */
@Composable
private fun AllInbox(nav: Navigator, hostIds: List<String>, feed: InboxFeed) {
    val graph = NodetermApp.graph(LocalContext.current)
    // While this tab is on screen, a listing of ANY computer announces none of its events; it records
    // them as seen, so no later check announces them either, as a computer's own Inbox tab does (A73).
    LifecycleStartEffect(hostIds) {
        val showing = hostIds.map { graph.connections.session(it).onScreen.showInbox() }
        onStopOrDispose { showing.forEach { it.close() } }
    }
    InboxFeedList(nav, feed, showComputer = true, emptyText = "Nothing needs you on any computer.")
}

/** One section per computer that reports usage: its label and when it was measured, then its accounts. */
@Composable
private fun AllUsage(sections: List<AllComputers.UsageSection>) {
    if (sections.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "None of your computers is reporting usage. (Usage is shared by nodeterm on each computer for its local accounts.)",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (section in sections) {
            val hostId = section.computer.hostId
            item(key = "h-$hostId") {
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.Bottom) {
                    Text(
                        section.computer.label,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    updatedAgo(section.usage.updatedAt)?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            // By position: the accounts of one computer are not guaranteed distinct by id and agent.
            itemsIndexed(section.usage.accounts, key = { i, _ -> "u-$hostId-$i" }) { _, account ->
                UsageCard(account, section.status)
            }
        }
    }
}

/**
 * What keeps a computer's cards from this screen, if anything: it is connecting, the computer shows an
 * approval code (the relay's first connect, or the relay leg an answer opened next to SSH), its connect
 * failed, or its last listing did. That last one also when the failure dropped the connection, which
 * leaves the session Idle ([ConnState.showsListError]): nothing re-lists here on its own, so without
 * the strip its cached cards would stay on screen looking current. Nothing while it is listed.
 */
@Composable
private fun ComputerStatus(computer: ComputerLabel, session: HostSession) {
    val state by session.state.collectAsState()
    val listError by session.lastError.collectAsState()
    val relayApproval by session.relayApproval.collectAsState()
    when (val s = state) {
        is ConnState.AwaitingApproval -> ApprovalFor(computer, s.sas)
        is ConnState.Connecting -> Text(
            "${computer.label}: ${s.detail}",
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        // Try again is the user asking about THIS computer (Trigger.USER): it lifts a held approval.
        is ConnState.Failed -> Problem("${computer.label}: ${s.message}") { session.refresh(Trigger.USER) }
        is ConnState.Connected, ConnState.Idle -> Unit
    }
    // Its last listing failed, also when that dropped the connection and left it Idle.
    if (state.showsListError) listError?.let { Problem("${computer.label}: $it") { session.refresh(Trigger.USER) } }
    relayApproval?.let { if (state !is ConnState.AwaitingApproval) ApprovalFor(computer, it) }
}

@Composable
private fun ApprovalFor(computer: ComputerLabel, sas: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            computer.label,
            Modifier.fillMaxWidth().background(NtColors.panel2).padding(start = 16.dp, end = 16.dp, top = 10.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center
        )
        ApprovalCode(sas)
    }
}

@Composable
private fun Problem(text: String, onRetry: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(NtColors.attention.copy(alpha = 0.12f)).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        TextButton(onClick = onRetry) { Text("Try again") }
    }
}
