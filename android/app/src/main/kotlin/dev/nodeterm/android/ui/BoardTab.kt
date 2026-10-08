package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Route
import dev.nodeterm.android.conn.HostSession
import dev.nodeterm.protocol.host.CardLabelEdit
import dev.nodeterm.protocol.model.KanbanLabel
import dev.nodeterm.protocol.model.NodeInfo
import dev.nodeterm.protocol.model.NodeKind
import dev.nodeterm.protocol.model.ProjectInfo
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.launch

/** The board palette (`KANBAN_LABEL_COLORS`, @shared/kanban-labels), for chips and for "create". */
private val LABEL_COLORS = listOf("gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")

private fun labelColor(name: String): Color = when (name) {
    "gray" -> Color(0xFF8E8E93)
    "brown" -> Color(0xFFA2845E)
    "orange" -> Color(0xFFFF9F0A)
    "yellow" -> Color(0xFFFFD60A)
    "green" -> Color(0xFF32D74B)
    "blue" -> Color(0xFF0A84FF)
    "purple" -> Color(0xFFBF5AF2)
    "pink" -> Color(0xFFFF375F)
    "red" -> Color(0xFFFF453A)
    else -> Color(0xFF636366)
}

private const val UNGROUPED = "__ungrouped__"

/**
 * The project's kanban board, as the desktop's `KanbanView` derives it: cards are the session nodes
 * (terminal / sticky / browser — `toKanbanSession`), the virtual Ungrouped column holds every card
 * with no (or a dangling) assignment, and assignment is board metadata only. Moves and labels go
 * through the host's `projects.*` verbs — never a file write from the phone.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BoardTab(nav: Navigator, hostId: String, session: HostSession, snapshot: ProjectsSnapshot) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val projects = snapshot.openProjects()
    // Saveable, so the chosen project is still showing after a terminal opened from a card (audit A43).
    var projectId by rememberSaveable { mutableStateOf<String?>(null) }
    val project = projects.firstOrNull { it.id == projectId } ?: projects.firstOrNull()
    var projectMenu by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf<NodeInfo?>(null) }
    var labeling by remember { mutableStateOf<NodeInfo?>(null) }
    // Board writes are nodeterm the app's (the relay's `projects.*` verbs): on the LAN that is the
    // relay leg opened next to the SSH connection, on a tap (audit A26). Where this phone has no
    // relay leg the controls stay, disabled, and say why; so they do on the board of a project another
    // desktop drives over SSH, which is that desktop's to write (A27).
    // Re-asked on each listing (it says whether the computer advertises its relay right now) and when
    // a late adoption stores the phone's relay leg in the background (the secrets' revision, the host
    // record), which no listing announces. Asking stores nothing and decrypts nothing (audit A47).
    val graph = NodetermApp.graph(context)
    val secretsRevision by graph.secure.revision.collectAsState()
    val hostRecords by graph.hosts.hosts.collectAsState()
    val boardRoute = remember(snapshot, project, secretsRevision, hostRecords) { session.route(Capability.BOARD_WRITES, project) }
    val readOnlyReason = (boardRoute as? LegRouting.Leg.Unavailable)?.reason

    if (project == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("No projects yet.") }
        return
    }

    /** The leg that writes the board: the open connection, or the relay leg next to SSH (a tap). */
    suspend fun boardConnection() = session.connectionFor(Capability.BOARD_WRITES, project = project)

    fun write(label: String, block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                session.refreshNow()
            } catch (e: Exception) {
                Toast.makeText(context, "$label: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box {
                OutlinedButton(onClick = { projectMenu = true }) {
                    ColorDot(parseHex(project.color, NtColors.accent))
                    Spacer(Modifier.width(8.dp))
                    Text(project.name)
                }
                DropdownMenu(expanded = projectMenu, onDismissRequest = { projectMenu = false }) {
                    projects.forEach { p ->
                        DropdownMenuItem(text = { Text(p.name) }, onClick = {
                            projectId = p.id
                            projectMenu = false
                        })
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            // The project's source control (audit A29); the screen says why when it cannot open.
            TextButton(onClick = { nav.push(Route.SourceControl(hostId, project.id)) }) { Text("Source control") }
        }
        if (readOnlyReason != null) {
            Text(
                "Read-only here. $readOnlyReason",
                Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        val cards = project.nodes.filter { it.kind == NodeKind.TERMINAL || it.kind == NodeKind.STICKY || it.kind == NodeKind.BROWSER }
        val board = project.board
        val columns = board?.columns?.map { it.id to it.title } ?: emptyList()
        val known = columns.map { it.first }.toSet()
        val byColumn = cards.groupBy { card -> board?.columnOf(card.id)?.takeIf { it in known } ?: UNGROUPED }
        // Order within a column = the assignments' relative order (Ungrouped keeps canvas order).
        val order = board?.assignments?.map { it.first }?.withIndex()?.associate { it.value to it.index } ?: emptyMap()
        val allColumns = listOf(UNGROUPED to "Ungrouped") +
            (columns.ifEmpty { dev.nodeterm.protocol.model.KanbanBoard.DEFAULT_COLUMN_TITLES.map { "default:$it" to it } })

        Row(Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp)) {
            allColumns.forEach { (colId, title) ->
                val colCards = byColumn[colId].orEmpty().sortedBy { order[it.id] ?: Int.MAX_VALUE }
                Column(
                    Modifier
                        .width(260.dp)
                        .fillMaxHeight()
                        .padding(4.dp)
                        .background(NtColors.panel, RoundedCornerShape(10.dp))
                        .padding(8.dp)
                ) {
                    val color = board?.columns?.firstOrNull { it.id == colId }?.color
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (color != null) {
                            ColorDot(parseHex(color))
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(title, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(6.dp))
                        Text("${colCards.size}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
                        items(colCards, key = { it.id }) { card ->
                            BoardCard(
                                card, project, snapshot,
                                onClick = {
                                    if (card.kind == NodeKind.TERMINAL) nav.push(Route.Terminal(hostId, card.id, displayTitle(card, snapshot)))
                                },
                                // Long-press opens the card's actions even when they cannot run,
                                // so the disabled controls can say why (audit A26).
                                onLongClick = { moving = card }
                            )
                        }
                    }
                }
            }
        }
    }

    moving?.let { card ->
        AlertDialog(
            onDismissRequest = { moving = null },
            title = { Text(displayTitle(card, snapshot)) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    readOnlyReason?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    val writable = readOnlyReason == null
                    Text("Move to", style = MaterialTheme.typography.labelLarge)
                    val cols = project.board?.columns?.map { it.id to it.title }
                    TextButton(enabled = writable, onClick = {
                        moving = null
                        write("Move") { boardConnection().setCardColumn(project.id, card.id, null) }
                    }) { Text("Ungrouped") }
                    if (cols == null) {
                        // No board yet: ask the host to seed the default one, then move into its column.
                        dev.nodeterm.protocol.model.KanbanBoard.DEFAULT_COLUMN_TITLES.forEachIndexed { i, t ->
                            TextButton(enabled = writable, onClick = {
                                moving = null
                                write("Move") {
                                    val conn = boardConnection()
                                    val seeded = conn.ensureBoard(project.id) ?: error("this project can't have a board written")
                                    val target = seeded.firstOrNull { it.title == t } ?: seeded.getOrNull(i) ?: error("no such column")
                                    conn.setCardColumn(project.id, card.id, target.id)
                                }
                            }) { Text(t) }
                        }
                    } else {
                        cols.forEach { (id, t) ->
                            TextButton(enabled = writable, onClick = {
                                moving = null
                                write("Move") { boardConnection().setCardColumn(project.id, card.id, id) }
                            }) { Text(t) }
                        }
                    }
                    TextButton(enabled = writable, onClick = {
                        labeling = card
                        moving = null
                    }) { Text("Labels…") }
                }
            },
            confirmButton = { TextButton(onClick = { moving = null }) { Text("Close") } }
        )
    }

    labeling?.let { card ->
        LabelsDialog(
            card = card,
            project = project,
            onDismiss = { labeling = null },
            onApply = { edit ->
                labeling = null
                write("Labels") { boardConnection().editCardLabels(project.id, card.id, edit) }
            }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BoardCard(card: NodeInfo, project: ProjectInfo, snapshot: ProjectsSnapshot, onClick: () -> Unit, onLongClick: () -> Unit) {
    val meta = project.board?.metaOf(card.id)
    val labels = meta?.labels.orEmpty().mapNotNull { id -> project.board?.labels?.firstOrNull { it.id == id } }
    Column(
        Modifier
            .fillMaxWidth()
            .background(NtColors.panel2, RoundedCornerShape(8.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ColorDot(parseHex(card.color))
            Spacer(Modifier.width(6.dp))
            Text(if (card.kind == NodeKind.STICKY) (card.text ?: card.title).take(80) else displayTitle(card, snapshot), maxLines = 2)
        }
        if (labels.isNotEmpty() || meta?.priority != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                meta?.priority?.let { LabelChip(it, if (it == "urgent" || it == "high") "red" else "gray") }
                labels.forEach { LabelChip(it.name, it.color) }
            }
        }
        StatusBadge(snapshot.statusOf(card.id)?.bucket)
    }
}

@Composable
private fun LabelChip(text: String, color: String) {
    val c = labelColor(color)
    Text(
        text,
        fontSize = 11.sp,
        color = c,
        modifier = Modifier.background(c.copy(alpha = 0.18f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp)
    )
}

@Composable
private fun LabelsDialog(card: NodeInfo, project: ProjectInfo, onDismiss: () -> Unit, onApply: (CardLabelEdit) -> Unit) {
    val palette: List<KanbanLabel> = project.board?.labels.orEmpty()
    val current = project.board?.metaOf(card.id)?.labels.orEmpty().toSet()
    var selected by remember(card.id) { mutableStateOf(current) }
    var newName by remember { mutableStateOf("") }
    var newColor by remember { mutableStateOf("blue") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Labels") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                palette.forEach { l ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = l.id in selected, onCheckedChange = { on -> selected = if (on) selected + l.id else selected - l.id })
                        LabelChip(l.name, l.color)
                    }
                }
                OutlinedTextField(value = newName, onValueChange = { newName = it.take(60) }, label = { Text("New label") }, singleLine = true)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    LABEL_COLORS.forEach { c ->
                        TextButton(onClick = { newColor = c }) {
                            Text(if (c == newColor) "● $c" else c, color = labelColor(c), fontSize = 12.sp)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val add = (selected - current).toList()
                val remove = (current - selected).toList()
                val create = if (newName.isNotBlank()) listOf(newName.trim() to newColor) else emptyList()
                if (add.isEmpty() && remove.isEmpty() && create.isEmpty()) onDismiss()
                else onApply(CardLabelEdit(add = add, remove = remove, create = create))
            }) { Text("Apply") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
