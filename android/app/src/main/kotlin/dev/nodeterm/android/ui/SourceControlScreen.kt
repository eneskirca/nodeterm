package dev.nodeterm.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleStartEffect
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.conn.ConnState
import dev.nodeterm.protocol.git.GitConflict
import dev.nodeterm.protocol.git.GitDiff
import dev.nodeterm.protocol.git.GitFileChange
import dev.nodeterm.protocol.git.GitHistory
import dev.nodeterm.protocol.git.GitResult
import dev.nodeterm.protocol.git.GitStatus
import dev.nodeterm.protocol.git.SourceControl
import dev.nodeterm.protocol.git.SourceControlGate
import dev.nodeterm.protocol.host.Capability
import kotlinx.coroutines.launch

/** Whose diff is open. */
private sealed interface DiffTarget {
    val path: String

    /** A changed file, on one side ([staged]) of it. */
    data class File(val file: GitFileChange, val staged: Boolean) : DiffTarget {
        override val path get() = file.path
    }

    /** An unmerged path: its working tree with the conflict markers, never the untracked form. */
    data class Conflict(val conflict: GitConflict) : DiffTarget {
        override val path get() = conflict.path
    }
}

/**
 * A project's source control (audit A29), over the desktop's typed, jailed git bridge (`git.*`): the
 * status split into conflicts, staged, changed and untracked files, a file's diff, stage and unstage,
 * a commit of what is staged, push and pull, and the recent commits. The folder is the project's own, as
 * `projects.list` names it; there is no free-form git.
 *
 * The shared capability routing uses the open connection when it serves typed Git, including
 * direct SSH in listed local folders, else the relay leg opened on the tap that opens this screen.
 * When neither can, or the project has no folder on the computer
 * ([SourceControlGate]), the screen says why and sends nothing. What the computer answers is shown
 * as it is: git's own message for a command that failed there, and the bridge's own sentence for a
 * request it refused.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourceControlScreen(nav: Navigator, hostId: String, projectId: String) {
    val graph = NodetermApp.graph(LocalContext.current)
    val host = graph.hosts.get(hostId)
    if (host == null) {
        LaunchedEffect(hostId) { nav.pop() }
        return
    }
    val session = remember(hostId) { graph.connections.session(hostId) }
    val state by session.state.collectAsState()
    val snapshot by session.snapshot.collectAsState()
    val relayApproval by session.relayApproval.collectAsState()
    val scope = rememberCoroutineScope()

    // The project and its folder come from the listing, which this keeps current while showing,
    // like every screen of a computer (audit A18).
    LifecycleStartEffect(hostId) {
        session.startWatching()
        onStopOrDispose { session.stopWatching() }
    }

    val listed = snapshot.fetchedAt != 0L
    val project = snapshot.projects.firstOrNull { it.id == projectId }
    val gate = SourceControlGate.of(project, session.route(Capability.GIT))
    val cwd = (gate as? SourceControlGate.Availability.Available)?.cwd

    var status by remember { mutableStateOf<GitStatus?>(null) }
    var history by remember { mutableStateOf<GitHistory?>(null) }
    var historyError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<SourceControl.Outcome?>(null) }
    var message by rememberSaveable { mutableStateOf("") }
    var diffOf by remember { mutableStateOf<DiffTarget?>(null) }
    var diff by remember { mutableStateOf<GitDiff?>(null) }
    var diffError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    /** The leg that serves `git.*` right now (a tap may open the relay leg next to SSH). */
    suspend fun git(dir: String) = SourceControl(session.connectionFor(Capability.GIT), dir)

    suspend fun load(dir: String, withHistory: Boolean) {
        val g = git(dir)
        val st = g.status()
        status = st
        if (withHistory) {
            history = null
            historyError = null
            if (st.hasRepo) {
                try {
                    history = g.history()
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    historyError = e.message ?: "The history could not be read."
                }
            }
        }
    }

    /**
     * One operation at a time. [block] answers what the computer said, and the status is read again
     * afterwards WHATEVER happened ([SourceControl.writeThenReload]): a failed push still tells the
     * truth about ahead/behind, and a commit that got no answer may have landed all the same.
     */
    fun run(label: String, withHistory: Boolean, block: suspend (SourceControl) -> GitResult?) {
        val dir = cwd ?: return
        if (busy != null) return
        busy = label
        notice = null
        scope.launch {
            try {
                notice = SourceControl.writeThenReload(label, { block(git(dir)) }, { load(dir, withHistory) })
            } finally {
                busy = null
            }
        }
    }

    LaunchedEffect(cwd, reload) {
        val dir = cwd ?: return@LaunchedEffect
        busy = "Loading"
        notice = null
        try {
            load(dir, withHistory = true)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            notice = SourceControl.Outcome(error = true, text = e.message ?: "Source control could not be read.")
        } finally {
            busy = null
        }
    }

    LaunchedEffect(diffOf) {
        val target = diffOf ?: return@LaunchedEffect
        val dir = cwd ?: return@LaunchedEffect
        diff = null
        diffError = null
        try {
            diff = when (target) {
                is DiffTarget.File -> git(dir).diff(target.file, target.staged)
                is DiffTarget.Conflict -> git(dir).diff(target.conflict)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            diffError = e.message ?: "The diff could not be read."
        }
    }

    BackHandler(enabled = diffOf != null) { diffOf = null }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(diffOf?.path ?: "Source control", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            diffOf?.let { diffSubtitle(it) }
                                ?: listOfNotNull(project?.name, status?.takeIf { it.hasRepo }?.branch).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { if (diffOf != null) diffOf = null else nav.pop() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
                actions = {
                    if (diffOf == null) {
                        IconButton(onClick = { reload++ }, enabled = cwd != null && busy == null) { Icon(Icons.Filled.Refresh, "Refresh") }
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().aboveKeyboard(padding)) {
            if (state is ConnState.AwaitingApproval) ApprovalCode((state as ConnState.AwaitingApproval).sas)
            // The relay leg opened next to SSH for this screen waits for the computer's approval
            // dialog (its first dial on a desktop that has not pinned this phone).
            relayApproval?.let { if (state !is ConnState.AwaitingApproval) ApprovalCode(it) }
            (state as? ConnState.Failed)?.let { Banner(it.message, error = true) }
            if (busy != null) LinearProgressIndicator(Modifier.fillMaxWidth())
            notice?.let { n -> Banner(n.text, error = n.error, onDismiss = { notice = null }) }

            when {
                !listed -> Centered("Loading the project…")
                gate is SourceControlGate.Availability.Unavailable -> Centered(gate.reason)
                diffOf != null -> DiffView(diff, diffError)
                status == null -> Centered(if (busy != null) "Reading the repository…" else "The repository could not be read.")
                status?.hasRepo == false -> Centered(
                    "The project's folder is not a git repository. Create one in nodeterm on the computer (Source Control → Initialize repository)."
                )
                else -> StatusList(
                    status = status!!,
                    history = history,
                    historyError = historyError,
                    message = message,
                    onMessage = { message = it },
                    busy = busy != null,
                    onOpen = { file, staged -> diffOf = DiffTarget.File(file, staged) },
                    onOpenConflict = { diffOf = DiffTarget.Conflict(it) },
                    onStage = { paths -> run("Stage", withHistory = false) { it.stage(paths) } },
                    onUnstage = { paths -> run("Unstage", withHistory = false) { it.unstage(paths) } },
                    onCommit = {
                        val text = message
                        run("Commit", withHistory = true) { g ->
                            g.commit(text).also { if (it.ok) message = "" }
                        }
                    },
                    onPush = { run("Push", withHistory = true) { it.push() } },
                    onPull = { run("Pull", withHistory = true) { it.pull() } }
                )
            }
        }
    }
}

private fun diffSubtitle(target: DiffTarget): String = when (target) {
    is DiffTarget.Conflict -> "Conflict · ${target.conflict.description}"
    is DiffTarget.File -> if (target.staged) "Staged changes" else if (target.file.untracked) "New file" else "Changes"
}

@Composable
private fun Centered(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Banner(text: String, error: Boolean, onDismiss: (() -> Unit)? = null) {
    Text(
        text,
        Modifier
            .fillMaxWidth()
            .background(if (error) NtColors.attention.copy(alpha = 0.12f) else NtColors.panel2)
            .let { if (onDismiss != null) it.clickable(onClick = onDismiss) else it }
            .padding(12.dp),
        style = MaterialTheme.typography.bodySmall
    )
}

@Composable
private fun StatusList(
    status: GitStatus,
    history: GitHistory?,
    historyError: String?,
    message: String,
    onMessage: (String) -> Unit,
    busy: Boolean,
    onOpen: (GitFileChange, Boolean) -> Unit,
    onOpenConflict: (GitConflict) -> Unit,
    onStage: (List<String>) -> Unit,
    onUnstage: (List<String>) -> Unit,
    onCommit: () -> Unit,
    onPush: () -> Unit,
    onPull: () -> Unit
) {
    val commitBlocker = SourceControl.commitBlocker(status, message)
    val syncBlocker = SourceControl.syncBlocker(status)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item(key = "branch") {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(status.branch, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    val sync = buildList {
                        if (status.ahead > 0) add("↑${status.ahead}")
                        if (status.behind > 0) add("↓${status.behind}")
                        if (status.hasRemote && !status.hasUpstream) add("not pushed yet")
                    }.joinToString(" ")
                    if (sync.isNotEmpty()) Text(sync, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (status.repoName.isNotBlank()) {
                    Text(status.repoName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onPull, enabled = !busy && syncBlocker == null) { Text("Pull") }
                    OutlinedButton(onClick = onPush, enabled = !busy && syncBlocker == null) { Text("Push") }
                }
                syncBlocker?.let { Hint(it) }
            }
        }
        item(key = "commit") {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = message,
                    onValueChange = onMessage,
                    label = { Text("Commit message") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 6
                )
                Button(onClick = onCommit, enabled = !busy && commitBlocker == null) {
                    Text(if (status.staged.isEmpty()) "Commit" else "Commit ${status.staged.size} staged")
                }
                // Says why only once there is something to say it about.
                if (commitBlocker != null && (message.isNotBlank() || status.staged.isNotEmpty() || status.conflicts.isNotEmpty())) {
                    Hint(commitBlocker)
                }
            }
        }
        conflictSection(status.conflicts, onOpenConflict)
        fileSection(
            key = "staged", title = "Staged", files = status.staged, staged = true,
            action = "Unstage", allAction = "Unstage all", busy = busy,
            onOpen = onOpen, onAct = onUnstage
        )
        fileSection(
            key = "changes", title = "Changes", files = status.unstaged, staged = false,
            action = "Stage", allAction = "Stage all", busy = busy,
            onOpen = onOpen, onAct = onStage
        )
        fileSection(
            key = "untracked", title = "Untracked", files = status.untracked, staged = false,
            action = "Stage", allAction = "Stage all", busy = busy,
            onOpen = onOpen, onAct = onStage
        )
        if (status.clean) {
            item(key = "clean") { Hint("No changes.", Modifier.padding(16.dp)) }
        }
        item(key = "history-title") { SectionTitle("Recent commits", null) }
        when {
            historyError != null -> item(key = "history-error") { Hint(historyError, Modifier.padding(horizontal = 16.dp)) }
            history == null -> item(key = "history-loading") { Hint("Loading…", Modifier.padding(horizontal = 16.dp)) }
            history.commits.isEmpty() -> item(key = "history-empty") { Hint("No commits yet.", Modifier.padding(horizontal = 16.dp)) }
            else -> {
                items(history.commits, key = { "c-${it.id}" }) { c ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.shortId, fontFamily = FontFamily.Monospace, color = NtColors.accent, fontSize = 12.sp)
                            Spacer(Modifier.width(8.dp))
                            Text(c.subject, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        val meta = listOfNotNull(
                            c.author,
                            c.timestampMs?.let { relativeAge(it) },
                            c.refs.takeIf { it.isNotEmpty() }?.joinToString(", ")
                        ).joinToString(" · ")
                        if (meta.isNotEmpty()) Hint(meta)
                    }
                }
                if (history.hasMore) item(key = "history-more") { Hint("Older commits are in nodeterm on the computer.", Modifier.padding(16.dp)) }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.fileSection(
    key: String,
    title: String,
    files: List<GitFileChange>,
    staged: Boolean,
    action: String,
    allAction: String,
    busy: Boolean,
    onOpen: (GitFileChange, Boolean) -> Unit,
    onAct: (List<String>) -> Unit
) {
    if (files.isEmpty()) return
    // A row's key is its PATH, which can be any name ("header" included), so rows live under
    // "<section>-file:" and the heading under "<section>-header": a repository-root file named like
    // the heading must not share its key, or the list throws on a duplicate key.
    item(key = "$key-header") {
        SectionTitle("$title (${files.size})") {
            TextButton(onClick = { onAct(files.map { it.path }) }, enabled = !busy) { Text(allAction) }
        }
    }
    items(files, key = { "$key-file:${it.path}" }) { file ->
        Row(
            Modifier.fillMaxWidth().clickable { onOpen(file, staged) }.padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                file.status,
                Modifier.widthIn(min = 18.dp),
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                color = statusColor(file.status)
            )
            Spacer(Modifier.width(8.dp))
            Text(file.path, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (file.added > 0 || file.deleted > 0) {
                Text("+${file.added} −${file.deleted}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = { onAct(listOf(file.path)) }, enabled = !busy) { Text(action) }
        }
    }
}

/**
 * Unmerged paths: opened as their combined diff, and offered no Stage. `git add` on one marks the
 * conflict resolved with whatever the file holds, markers included, and the phone cannot edit it.
 */
private fun androidx.compose.foundation.lazy.LazyListScope.conflictSection(
    conflicts: List<GitConflict>,
    onOpen: (GitConflict) -> Unit
) {
    if (conflicts.isEmpty()) return
    item(key = "conflicts-header") { SectionTitle("Conflicts (${conflicts.size})", null) }
    item(key = "conflicts-hint") {
        Hint(
            "Resolve these on the computer or in a terminal session, then stage them. The phone does not mark a conflict resolved.",
            Modifier.padding(horizontal = 16.dp)
        )
    }
    items(conflicts, key = { "conflicts-file:${it.path}" }) { c ->
        Row(
            Modifier.fillMaxWidth().clickable { onOpen(c) }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(c.code, Modifier.widthIn(min = 26.dp), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = NtColors.attention)
            Spacer(Modifier.width(8.dp))
            Text(c.path, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(c.description, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SectionTitle(text: String, trailing: (@Composable () -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text.uppercase(),
            Modifier.weight(1f),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        trailing?.invoke()
    }
}

@Composable
private fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * The letters the desktop's Source Control colours (`gitStatusColors`): added/new, deleted, the rest.
 * A `U` here is an untracked file: unmerged paths are in their own section ([conflictSection]).
 */
private fun statusColor(status: String): Color = when (status) {
    "A", "U" -> NtColors.success
    "D" -> NtColors.attention
    "R", "C" -> NtColors.accent
    else -> NtColors.warning
}

@Composable
private fun DiffView(diff: GitDiff?, error: String?) {
    when {
        error != null -> Centered(error)
        diff == null -> Centered("Reading the diff…")
        diff.isEmpty -> Centered("No differences to show.")
        else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 4.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
            items(diff.lines.size) { i ->
                val line = diff.lines[i]
                val (bg, fg) = when (line.kind) {
                    GitDiff.Kind.ADD -> NtColors.success.copy(alpha = 0.14f) to MaterialTheme.colorScheme.onSurface
                    GitDiff.Kind.DEL -> NtColors.attention.copy(alpha = 0.14f) to MaterialTheme.colorScheme.onSurface
                    GitDiff.Kind.HUNK -> NtColors.accent.copy(alpha = 0.10f) to NtColors.accent
                    GitDiff.Kind.META, GitDiff.Kind.NOTE -> Color.Transparent to MaterialTheme.colorScheme.onSurfaceVariant
                    GitDiff.Kind.CONTEXT -> Color.Transparent to MaterialTheme.colorScheme.onSurface
                }
                Text(
                    line.text.ifEmpty { " " },
                    Modifier.fillMaxWidth().background(bg, RoundedCornerShape(2.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
                    color = fg,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    lineHeight = 16.sp
                )
            }
            if (diff.omitted > 0) {
                item { Hint("${diff.omitted} more lines are not shown. The whole diff is in nodeterm on the computer.", Modifier.padding(12.dp)) }
            }
        }
    }
}
