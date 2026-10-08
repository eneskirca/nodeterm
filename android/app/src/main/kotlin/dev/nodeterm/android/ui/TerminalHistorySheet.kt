package dev.nodeterm.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.nodeterm.protocol.model.TerminalCopy
import dev.nodeterm.protocol.model.TerminalHistory
import kotlinx.coroutines.CancellationException

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun HistorySheet(controller: TerminalController) {
    val ctx = LocalContext.current
    val focus = LocalFocusManager.current
    var query by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf("") }
    var request by remember { mutableStateOf(0) }
    var result by remember { mutableStateOf<TerminalHistory.Result?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var searching by remember { mutableStateOf(false) }
    var selection by remember { mutableStateOf(TerminalCopy.Selection()) }
    var cursor by remember { mutableStateOf(0) }
    val list = rememberLazyListState()
    fun submit() { if (TerminalHistory.validQuery(query)) { submitted = query; request++; focus.clearFocus() } }
    LaunchedEffect(request) {
        if (request == 0) return@LaunchedEffect
        val ticket = request
        val literal = submitted
        searching = true; error = null; result = null; selection = TerminalCopy.Selection(); cursor = 0
        try { val answer = controller.searchHistory(literal); if (request == ticket) result = answer }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failed: Exception) { if (request == ticket) error = failed.message ?: "History search failed. Try again." }
        finally { if (request == ticket) searching = false }
    }
    LaunchedEffect(result, cursor) { if (!result?.rows.isNullOrEmpty()) list.scrollToItem(cursor) }
    BackHandler { controller.closeHistory() }
    Column(Modifier.fillMaxSize().blockTouchesBelow().background(NtColors.panel).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Find in terminal history", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { controller.closeHistory() }) { Text("Close") }
        }
        Text("Search all output the computer still retains. Match case; spaces are significant.", style = MaterialTheme.typography.bodySmall, color = NtColors.muted)
        OutlinedTextField(query, onValueChange = { query = it }, label = { Text("Search history") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { submit() }))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { submit() }, enabled = TerminalHistory.validQuery(query) && !searching) { Text("Search") }
            if (searching) Text("Searching on the computer…", Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodySmall)
        }
        error?.let { Text(it, color = NtColors.attention, style = MaterialTheme.typography.bodySmall) }
        val found = result
        if (found != null) {
            Text("${found.rows.size} matching lines in ${found.searchedLines} retained lines for “$submitted”", style = MaterialTheme.typography.bodySmall)
            if (found.truncated) Text("Some matches are omitted. Use a more specific search.", style = MaterialTheme.typography.bodySmall, color = NtColors.attention)
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { cursor = (cursor + found.rows.size - 1) % found.rows.size }, enabled = found.rows.isNotEmpty()) { Text("Previous") }
                TextButton(onClick = { cursor = (cursor + 1) % found.rows.size }, enabled = found.rows.isNotEmpty()) { Text("Next") }
                TextButton(onClick = { selection = selection.all(found.rows.size) }, enabled = found.rows.isNotEmpty()) { Text("Select all") }
                TextButton(onClick = { selection = selection.clear() }) { Text("Clear") }
            }
            Text("Tap matching lines to select them; long-press to extend the selection.", style = MaterialTheme.typography.bodySmall, color = NtColors.muted)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
            itemsIndexed(found?.rows.orEmpty(), key = { _, row -> row.line }) { index, row ->
                val text = buildAnnotatedString {
                    append(row.text)
                    var start = row.text.indexOf(submitted)
                    var count = 0
                    while (start >= 0 && count++ < TerminalCopy.MAX_SEARCH_MATCHES) {
                        addStyle(SpanStyle(background = NtColors.accent.copy(alpha = 0.4f)), start, start + submitted.length)
                        start = row.text.indexOf(submitted, start + submitted.length)
                    }
                }
                Column(Modifier.fillMaxWidth().background(if (index in selection.selected) NtColors.accent.copy(alpha = 0.25f) else NtColors.canvas)
                    .combinedClickable(onClick = { selection = selection.toggle(index); cursor = index }, onLongClick = { selection = selection.extendTo(index) }).padding(6.dp)) {
                    Text("Line ${row.line + 1}", style = MaterialTheme.typography.labelSmall, color = NtColors.muted)
                    Text(text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Button(onClick = { controller.copyHistory(ctx, found?.rows.orEmpty().map { it.text }, selection) }, enabled = selection.selected.isNotEmpty()) { Text("Copy selected lines") }
    }
}
