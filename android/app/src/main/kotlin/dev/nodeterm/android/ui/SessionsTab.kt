package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.TerminalSink
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.AccountNames
import dev.nodeterm.protocol.model.Agent
import dev.nodeterm.protocol.model.ContextFill
import dev.nodeterm.protocol.model.Launch
import dev.nodeterm.protocol.model.NewSessionChoice
import dev.nodeterm.protocol.host.ManagedSessionChoice
import dev.nodeterm.protocol.host.ManagedSessionCreation
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.SessionBucket
import dev.nodeterm.protocol.model.SessionSearch
import dev.nodeterm.protocol.ssh.PhoneTerminals
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.coroutines.launch

/** A phone-started session waiting for its terminal screen to type the launch line and register it. */
data class LaunchRequest(
    val nodeId: String,
    val projectId: String,
    val title: String,
    val agentId: String?,
    val accountId: String?,
    val command: String?
)

/** Hand-off from the New-session dialog to the terminal screen that performs the launch. */
object PendingLaunches {
    private val byNode = HashMap<String, LaunchRequest>()

    @Synchronized
    fun put(r: LaunchRequest) {
        byNode[r.nodeId] = r
    }

    @Synchronized
    fun take(nodeId: String): LaunchRequest? = byNode.remove(nodeId)

    @Synchronized
    fun peek(nodeId: String): LaunchRequest? = byNode[nodeId]
}

private val BUCKET_ORDER = listOf(SessionBucket.NEEDS_YOU, SessionBucket.RUNNING, SessionBucket.SLEEPING, SessionBucket.UNKNOWN)

private fun bucketTitle(b: SessionBucket) = when (b) {
    SessionBucket.NEEDS_YOU -> "Waiting for your response"
    SessionBucket.RUNNING -> "Running"
    SessionBucket.SLEEPING -> "Sleeping"
    SessionBucket.UNKNOWN -> "Other sessions"
}

/** What a session row is called: the agent's own session name, else the node title, else the agent. */
fun displayTitle(node: NodeInfo, snapshot: ProjectsSnapshot): String =
    SessionSearch.title(node, snapshot)

/**
 * [newSessionNote] is why New session is unavailable (audit A26), shown as the list's first row while
 * the button below stays disabled: a box of its own beside the button covered the last sessions.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionsTab(nav: Navigator, hostId: String, session: HostSession, snapshot: ProjectsSnapshot, newSessionNote: String? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menuFor by remember { mutableStateOf<NodeInfo?>(null) }
    var renaming by remember { mutableStateOf<NodeInfo?>(null) }
    var ending by remember { mutableStateOf<NodeInfo?>(null) }
    // Stored by the host/tab's A43 saved-state holders, including a terminal pushed above this page.
    var query by rememberSaveable(hostId) { mutableStateOf("") }

    fun act(label: String, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                session.refreshNow()
            } catch (e: Exception) {
                Toast.makeText(context, "$label: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    val projects = SessionSearch.projects(snapshot, query)
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search sessions") },
            singleLine = true,
            trailingIcon = {
                if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("Clear search") }
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
        )
        if (projects.isEmpty()) {
            newSessionNote?.let { NewSessionNote(it) }
            Box(Modifier.weight(1f).fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(
                    when (SessionSearch.emptyState(snapshot, query)) {
                        SessionSearch.EmptyState.LOADING -> "Loading sessions…"
                        SessionSearch.EmptyState.EMPTY -> "No sessions on this computer yet."
                        SessionSearch.EmptyState.NO_MATCHES -> "No sessions match your search."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 96.dp)) {
                if (newSessionNote != null) item(key = "new-session-note") { NewSessionNote(newSessionNote) }
                for (project in projects) {
                    item(key = "p-${project.id}") {
                        ProjectHeader(project, onSourceControl = { nav.push(Route.SourceControl(hostId, project.id)) })
                    }
                    val grouped = project.sessions.groupBy { snapshot.statusOf(it.id)?.bucket ?: SessionBucket.UNKNOWN }
                    for (bucket in BUCKET_ORDER) {
                        val rows = grouped[bucket].orEmpty().sortedByDescending { snapshot.statusOf(it.id)?.updatedAt ?: 0 }
                        if (rows.isEmpty()) continue
                        item(key = "b-${project.id}-$bucket") {
                            Text(
                                bucketTitle(bucket).uppercase(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 16.dp, top = 10.dp, bottom = 4.dp)
                            )
                        }
                        items(rows, key = { "n-${project.id}-${it.id}" }) { node ->
                            Box {
                                SessionRow(
                                    node, snapshot,
                                    onClick = { nav.push(Route.Terminal(hostId, node.id, displayTitle(node, snapshot))) },
                                    onLongClick = { menuFor = node }
                                )
                                DropdownMenu(expanded = menuFor?.id == node.id, onDismissRequest = { menuFor = null }) {
                                    DropdownMenuItem(text = { Text("Open") }, onClick = {
                                        menuFor = null
                                        nav.push(Route.Terminal(hostId, node.id, displayTitle(node, snapshot)))
                                    })
                                    // Wake/refresh/rename are nodeterm the app's (`node.*`): on the LAN that is
                                    // the relay leg opened next to SSH, on a tap. Where this phone has none they
                                    // stay listed, disabled, with the reason (audit A26) — and so they do for a
                                    // project another desktop drives over SSH, whose app is that desktop (A27).
                                    if (!PhoneTerminals.validId(node.id)) {
                                        val blocked = session.route(Capability.NODE_ACTIONS, project) as? LegRouting.Leg.Unavailable
                                        if (snapshot.statusOf(node.id)?.hibernated == true) {
                                            DropdownMenuItem(text = { Text("Wake") }, enabled = blocked == null, onClick = {
                                                menuFor = null
                                                act("Wake") { session.connectionFor(Capability.NODE_ACTIONS, project = project).wake(node.id) }
                                            })
                                        }
                                        DropdownMenuItem(text = { Text("Refresh view on computer") }, enabled = blocked == null, onClick = {
                                            menuFor = null
                                            act("Refresh") { session.connectionFor(Capability.NODE_ACTIONS, project = project).refresh(node.id) }
                                        })
                                        DropdownMenuItem(text = { Text("Rename…") }, enabled = blocked == null, onClick = {
                                            menuFor = null
                                            renaming = node
                                        })
                                        if (blocked != null) {
                                            Text(
                                                blocked.reason,
                                                Modifier.widthIn(max = 280.dp).padding(horizontal = 12.dp, vertical = 6.dp),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                        }
                                    }
                                    DropdownMenuItem(text = { Text("End session…", color = NtColors.attention) }, onClick = {
                                        menuFor = null
                                        ending = node
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    renaming?.let { node ->
        var title by remember(node.id) { mutableStateOf(displayTitle(node, snapshot)) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename session") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = title.isNotBlank(), onClick = {
                    renaming = null
                    act("Rename") {
                        session.connectionFor(Capability.NODE_ACTIONS, project = snapshot.findNode(node.id)?.first).rename(node.id, title.trim())
                    }
                }) { Text("Rename") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } }
        )
    }

    ending?.let { node ->
        val conn = session.connection
        val viaSsh = conn?.kind == TransportKind.SSH
        AlertDialog(
            onDismissRequest = { ending = null },
            title = { Text("End ${displayTitle(node, snapshot)}?") },
            text = {
                Text(
                    if (PhoneTerminals.validId(node.id)) "This stops the shell and everything running in it, and removes it from the phone terminals list."
                    else if (viaSsh) "This stops the session's tmux session on the computer, and everything running in it. " +
                        "The node stays on the canvas until you remove it there."
                    else "This permanently ends the session and removes the node from the canvas — like its × on the computer."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ending = null
                    val c = conn ?: return@TextButton
                    act("End session") {
                        if (PhoneTerminals.validId(node.id) && c !is SshHostConnection) {
                            throw HostException("Connect over SSH to end this phone terminal.")
                        }
                        val quiet = object : TerminalSink {
                            override fun onPaint(text: String) {}
                            override fun onOutput(bytes: ByteArray) {}
                            override fun onExit(code: Int?) {}
                        }
                        if (c is SshHostConnection) {
                            try {
                                c.killSession(node.id)
                            } catch (e: NeedsRelayException) {
                                // A node of an SSH project lives on its host: end it through the
                                // relay, where the desktop reaches that host (audit A09). With no
                                // relay leg to open, say what is in the way for this computer (A27).
                                e.refusal(session.relayLeg())?.let { throw HostException(it) }
                                session.viaRelay().attach(node.id, 80, 24, quiet).endSession()
                            }
                        } else {
                            c.attach(node.id, 80, 24, quiet).endSession()
                        }
                    }
                }) { Text("End session", color = NtColors.attention) }
            },
            dismissButton = { TextButton(onClick = { ending = null }) { Text("Cancel") } }
        )
    }
}

/** Why New session is disabled, said once at the top of the list (audit A26), like the Board's read-only note. */
@Composable
private fun NewSessionNote(reason: String) {
    Text(
        reason,
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

/**
 * A project's heading, with its Source control (audit A29). The entry is offered for every project:
 * the screen itself says why one cannot have it (no folder on the computer, an SSH project, no relay
 * leg), rather than a heading that silently lacks it.
 */
@Composable
private fun ProjectHeader(project: ProjectInfo, onSourceControl: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        ColorDot(parseHex(project.color, NtColors.accent), 12)
        Spacer(Modifier.width(10.dp))
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(
                project.name,
                Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            project.sshTarget?.let {
                Spacer(Modifier.width(8.dp))
                Text("on $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            // Its sessions run on this computer, its canvas is a desktop elsewhere's (A27).
            if (project.drivenRemotely) {
                Spacer(Modifier.width(8.dp))
                Text(
                    "run here over SSH",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
            }
        }
        if (project.id != PhoneTerminals.PROJECT_ID) {
            TextButton(onClick = onSourceControl) { Text("Source control") }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(node: NodeInfo, snapshot: ProjectsSnapshot, onClick: () -> Unit, onLongClick: () -> Unit) {
    val status = snapshot.statusOf(node.id)
    val now = snapshot.status?.inbox?.nodes?.get(node.id)
    val agent = Agent.of(node.agentId ?: status?.agentId)
    val live = snapshot.isLive(node.id)
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (node.iconEmoji != null) Text(node.iconEmoji!!) else ColorDot(parseHex(node.color ?: agent?.color, NtColors.muted), 12)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(displayTitle(node, snapshot), maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = buildList {
                add(SessionSearch.agentLabel(node, snapshot))
                if (PhoneTerminals.validId(node.id)) node.cwd?.let { add(it) }
                now?.activity?.let { add(it) }
                ContextFill.label(now?.contextPercent)?.let { add(it) }
                AccountNames.observed(status?.account, snapshot.status)?.let { add(it) }
                if (!live) add("not running")
            }.joinToString(" · ")
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            StatusBadge(status?.bucket)
            status?.updatedAt?.let {
                Text(relativeAge(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** New session: a project on THIS computer, an agent (or a plain shell), and for Claude an account. */
private fun noManagedAction() = Unit

@Composable
fun NewSessionDialog(snapshot: ProjectsSnapshot, onDismiss: () -> Unit, onCreate: (LaunchRequest) -> Unit,
                     onManagedCreate: ((ManagedSessionChoice) -> Unit)? = null,
                     managedState: ManagedSessionCreation.State? = null,
                     onOpenManaged: () -> Unit = ::noManagedAction, onCheckedManaged: () -> Unit = ::noManagedAction) {
    // Only projects the desktop can register a node in: on this computer, with a folder (A14).
    val projects = NewSessionChoice.offeredProjects(snapshot)
    // The user's taps are remembered, but the listing is re-fetched under the open dialog, so a tap
    // can name a project or account the desktop has since removed. What the dialog draws as selected,
    // and what Start uses, is derived from the CURRENT listing — the same answer for both (A42).
    var projectId by remember { mutableStateOf(projects.firstOrNull()?.id) }
    val selected = NewSessionChoice.project(projects, projectId)
    var agent by remember { mutableStateOf<Agent?>(Agent.CLAUDE) }
    val settings = snapshot.status?.settings
    val accounts = settings?.claudeAccounts.orEmpty()
    // Starts at the selected project's own default account, when this host still has it (A16), and
    // again whenever the selection moves to another project.
    var accountPick by remember(selected?.id) { mutableStateOf(Launch.defaultAccount(settings, selected)) }
    val accountId = NewSessionChoice.account(settings, selected, accountPick)
    val editable = managedState == null || managedState is ManagedSessionCreation.State.Idle || managedState is ManagedSessionCreation.State.Refused

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                when (val current = managedState) {
                    is ManagedSessionCreation.State.Creating -> item { Text("Creating the session on the computer… You can close this dialog; creation will finish there.") }
                    is ManagedSessionCreation.State.Uncertain -> item { Text(current.message + " Refresh the sessions list or inspect the computer before starting another session.") }
                    is ManagedSessionCreation.State.Ready -> item { Text("The computer created the session. Open it to view the existing terminal.") }
                    is ManagedSessionCreation.State.Refused -> item { Text(current.message) }
                    else -> Unit
                }
                if (editable) {
                item { Text("Project", style = MaterialTheme.typography.labelLarge) }
                if (projects.isEmpty()) {
                    item {
                        Text(
                            "No open project on this computer has a folder to start a session in.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                items(projects, key = { "proj-${it.id}" }) { p ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selected?.id == p.id, onClick = { projectId = p.id })
                        Text(p.name)
                    }
                }
                item { Text("Run", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp)) }
                items(listOf<Agent?>(null) + Agent.entries, key = { "agent-${it?.id ?: "shell"}" }) { a ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = agent == a, onClick = { agent = a })
                        Text(a?.label ?: "Terminal (shell)")
                    }
                }
                if (agent == Agent.CLAUDE && accounts.isNotEmpty()) {
                    item { Text("Claude account", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp)) }
                    items(listOf<String?>(null) + accounts.map { it.id }, key = { "acct-${it ?: "system"}" }) { id ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = accountId == id, onClick = { accountPick = id })
                            Text(id?.let { AccountNames.managed(it, snapshot.status) } ?: AccountNames.SYSTEM)
                        }
                    }
                }
                }
            }
        },
        confirmButton = {
            if (managedState is ManagedSessionCreation.State.Ready) {
                TextButton(onClick = onOpenManaged) { Text("Open session") }
            } else if (managedState is ManagedSessionCreation.State.Uncertain) {
                TextButton(onClick = onCheckedManaged) { Text("I checked the computer") }
            } else TextButton(enabled = selected != null && editable, onClick = start@{
                val p = selected ?: return@start
                val a = agent
                val acct = if (a == Agent.CLAUDE) accountId else null
                if (onManagedCreate != null) {
                    onManagedCreate(ManagedSessionChoice(projectId = p.id, kind = if (a == null) "shell" else "agent",
                        agentId = a?.id, accountId = acct, title = a?.label ?: "Terminal"))
                    return@start
                }
                val cmd = if (a != null) Launch.launchCommand(a, settings, acct, p.cwd, p.defaultPermissionMode)
                else p.cwd?.let { if (Regex("^/[^'\\u0000-\\u001f]*$").matches(it)) "cd '$it'" else null }
                onCreate(
                    LaunchRequest(
                        nodeId = Launch.newNodeId(),
                        projectId = p.id,
                        title = a?.label ?: "Terminal",
                        agentId = a?.id,
                        accountId = acct,
                        command = cmd
                    )
                )
            }) { Text("Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
