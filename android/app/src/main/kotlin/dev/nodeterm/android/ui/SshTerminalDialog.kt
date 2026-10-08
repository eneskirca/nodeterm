package dev.nodeterm.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.model.SshTerminalCreation
import dev.nodeterm.protocol.model.SshTerminalFolders
import dev.nodeterm.protocol.ssh.PhoneTerminals

@Composable
internal fun SshTerminalDialog(
    snapshot: ProjectsSnapshot,
    state: SshTerminalCreation.State,
    onDismiss: () -> Unit,
    onCreate: (String?) -> Unit,
    onOpen: () -> Unit,
) {
    val request = when (state) {
        is SshTerminalCreation.State.Creating -> state.request
        is SshTerminalCreation.State.Failed -> state.request
        is SshTerminalCreation.State.Ready -> state.request
        SshTerminalCreation.State.Idle -> null
    }
    var folder by remember { mutableStateOf(request?.cwd) }
    var custom by remember { mutableStateOf(request?.cwd ?: "") }
    var editingCustom by remember { mutableStateOf(false) }
    val busy = state is SshTerminalCreation.State.Creating
    val ready = state is SshTerminalCreation.State.Ready
    val editable = state == SshTerminalCreation.State.Idle || (state is SshTerminalCreation.State.Failed && state.canChangeFolder)
    val selected = if (editingCustom) custom else folder
    val valid = selected == null || PhoneTerminals.validCwd(selected)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New terminal") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("A plain shell on this computer. It remains available when you close the app.")
                if (editable) {
                    SshTerminalFolders.choices(snapshot).forEach { choice ->
                        TextButton(onClick = { folder = choice.cwd; editingCustom = false }) {
                            Text((if (!editingCustom && folder == choice.cwd) "✓ " else "") + choice.label)
                        }
                    }
                    OutlinedTextField(
                        value = custom,
                        onValueChange = { custom = it; editingCustom = true },
                        label = { Text("Absolute folder path") },
                        placeholder = { Text("/path/to/folder") },
                        singleLine = true,
                        isError = editingCustom && !valid,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (editingCustom && !valid) Text("Choose an absolute folder without control characters.", color = MaterialTheme.colorScheme.error)
                } else {
                    Text(request?.cwd ?: "Home folder")
                }
                when (state) {
                    is SshTerminalCreation.State.Creating -> Text("Creating… You can close this dialog while it finishes.")
                    is SshTerminalCreation.State.Failed -> {
                        Text(state.message, color = MaterialTheme.colorScheme.error)
                        if (!state.canChangeFolder) Text("Retry checks the same terminal and folder to avoid creating a duplicate.")
                    }
                    is SshTerminalCreation.State.Ready -> Text("Terminal created. Open it when you are ready.")
                    SshTerminalCreation.State.Idle -> Unit
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { if (ready) onOpen() else onCreate(if (editable) selected else request?.cwd) }, enabled = !busy && valid) {
                Text(if (ready) "Open terminal" else if (state is SshTerminalCreation.State.Failed) "Retry" else "Create")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(if (busy) "Close" else "Cancel") } }
    )
}
