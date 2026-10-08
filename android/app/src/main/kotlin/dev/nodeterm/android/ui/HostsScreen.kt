package dev.nodeterm.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.ConnState
import dev.nodeterm.android.data.SecureStore
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.AllComputers
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.ssh.ManualHost

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HostsScreen(nav: Navigator) {
    val graph = NodetermApp.graph(LocalContext.current)
    val hosts by graph.hosts.hosts.collectAsState()
    // Re-asks each row's relay-token check when a token is stored or removed (a late relay
    // adoption can mint one without changing the host record; a forget drops one).
    val secretsRevision by graph.secure.revision.collectAsState()
    var removing by remember { mutableStateOf<PairedHost?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("nodeterm") },
                actions = {
                    // A computer with no pairing code (a Server Edition, an SSH-only host): audit A27.
                    if (hosts.isNotEmpty()) TextButton(onClick = { nav.push(Route.AddSshHost) }) { Text("Add SSH server") }
                    IconButton(onClick = { nav.push(Route.Settings) }) { Icon(Icons.Filled.Settings, "Settings") }
                }
            )
        },
        floatingActionButton = {
            if (hosts.isNotEmpty()) {
                ExtendedFloatingActionButton(
                    onClick = { nav.push(Route.PairHost()) },
                    icon = { Icon(Icons.Filled.Add, null) },
                    text = { Text("Pair a computer") }
                )
            }
        }
    ) { padding ->
        if (hosts.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(padding).padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("Your terminals, in your pocket", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                Spacer(Modifier.padding(8.dp))
                Text(
                    "Pair this phone with nodeterm on your computer to watch your agents, answer their questions and " +
                        "open any terminal on the canvas — on your network, or from anywhere through the end-to-end " +
                        "encrypted relay.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.padding(12.dp))
                Button(onClick = { nav.push(Route.PairHost()) }) { Text("Pair a computer") }
                Spacer(Modifier.padding(8.dp))
                Text(
                    "No pairing code? A nodeterm Server Edition, or a computer you reach over SSH, is added by its address.",
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                TextButton(onClick = { nav.push(Route.AddSshHost) }) { Text("Add SSH server") }
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
                // Every computer's Inbox and Usage on one screen (audit A55), once a second one is paired.
                if (AllComputers.offered(hosts.size)) {
                    item(key = "all-computers") {
                        // From what each session already holds: listing the computers list dials nothing.
                        val total = rememberListings(hosts).sumOf { AllComputers.needsYou(it.snapshot) }
                        Card(
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 6.dp)
                                .clickable { nav.push(Route.AllComputers) }
                        ) {
                            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("All computers", style = MaterialTheme.typography.titleMedium)
                                    Text(
                                        "Inbox and usage from every computer",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                NeedsYouBadge(total)
                            }
                        }
                    }
                }
                items(hosts, key = { it.id }) { host ->
                    val session = graph.connections.session(host.id)
                    val state by session.state.collectAsState()
                    // The needs-you count on the row (audit A55): from the listing this session already
                    // holds (an open screen's, the background check's), never a dial of its own.
                    val snapshot by session.snapshot.collectAsState()
                    val needsYou = AllComputers.needsYou(snapshot)
                    // Whether a token is STORED, never its value: decrypting it here was a Keystore
                    // round trip on the main thread per row per recomposition, and it waited on
                    // SecureStore's lock behind any connection decrypting meanwhile (audit A47).
                    val relayTokenStored = remember(host.id, secretsRevision) { graph.secure.hasRelayToken(host.id) }
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp)
                            .combinedClickable(
                                onClick = { nav.push(Route.Host(host.id)) },
                                onLongClick = { removing = host }
                            )
                    ) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                ColorDot(stateColor(state))
                                Spacer(Modifier.width(10.dp))
                                Text(host.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                NeedsYouBadge(needsYou)
                            }
                            Text(
                                "${host.user}@${host.host}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                routeSummary(host, relayTokenStored) +
                                    stateSuffix(state, host),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    }

    removing?.let { host ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Forget ${host.name}?") },
            text = {
                Text(
                    if (host.manual) {
                        // Added by address (audit A27): no Paired devices entry on the computer, only a key line.
                        "This phone forgets this computer and its pinned host key. " + ManualHost.revokeHint(host.user)
                    } else {
                        "This phone forgets the pairing and its keys for this computer. To revoke the phone's access on " +
                            "the computer too, remove it under nodeterm → Settings → Phone → Paired devices."
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    graph.connections.retireAndPublish(listOf(host.id)) {
                        graph.hosts.remove(host.id) { graph.secure.remove(SecureStore.relayTokenKey(host.id)) }
                    }
                    removing = null
                }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } }
        )
    }
}

/** "2 need you", in the NEEDS YOU badge's colours; nothing for 0. */
@Composable
private fun NeedsYouBadge(count: Int) {
    if (count <= 0) return
    Text(
        if (count == 1) "1 needs you" else "$count need you",
        color = NtColors.attention,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(NtColors.attention.copy(alpha = 0.16f))
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

fun routeSummary(host: PairedHost, hasRelayToken: Boolean): String {
    // Added by its SSH address (audit A27): SSH is its only route, and it has no relay to add.
    if (host.manual) return "Over SSH only"
    val legs = buildList {
        if (host.sshAvailable) add(host.sshLegName)
        if (host.relay != null && hasRelayToken) add("From anywhere")
    }
    return if (legs.isEmpty()) "No route configured" else legs.joinToString(" · ")
}

private fun stateSuffix(state: ConnState, host: PairedHost): String = when (state) {
    is ConnState.Connected -> if (state.kind == TransportKind.SSH) {
        if (host.manual) " — connected (SSH)" else " — connected (network)"
    } else " — connected (relay)"
    is ConnState.Connecting -> " — connecting…"
    is ConnState.AwaitingApproval -> " — waiting for approval"
    is ConnState.Failed -> " — offline"
    ConnState.Idle -> ""
}

fun stateColor(state: ConnState) = when (state) {
    is ConnState.Connected -> NtColors.success
    is ConnState.Connecting, is ConnState.AwaitingApproval -> NtColors.warning
    is ConnState.Failed -> NtColors.attention
    ConnState.Idle -> NtColors.muted
}
