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
import dev.nodeterm.protocol.model.DictationLanguage
import java.util.Locale

@Composable
internal fun DictationLanguageDialog(selected: String?, onChoose: (String?) -> Unit, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val choices = remember(selected) { DictationLanguage.choices(Locale.getAvailableLocales().toList(), selected = selected) }
    val matches = DictationLanguage.search(choices, query, selected)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Dictation language") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Availability depends on your phone's speech service and its language models.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = query, onValueChange = { query = it.take(120) },
                    label = { Text("Search languages") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                    TextButton(onClick = { onChoose(null) }) { Text((if (selected == null) "✓ " else "") + "System default") }
                    matches.forEach { choice ->
                        TextButton(onClick = { onChoose(choice.tag) }) {
                            Text((if (selected == choice.tag) "✓ " else "") + choice.label)
                        }
                    }
                    if (matches.isEmpty()) Text("No matching languages.")
                    if (matches.size == DictationLanguage.MAX_VISIBLE) Text("Type a language or region to narrow the list.", style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } }
    )
}
