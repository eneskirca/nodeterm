package dev.nodeterm.android.ui

import android.Manifest
import android.widget.Toast
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.protocol.model.ExternalLink
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.TerminalCopy

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(nav: Navigator, entryKey: String, hostId: String, nodeId: String, title: String) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val session = remember(hostId) { graph.connections.session(hostId) }
    val entry = remember(entryKey, hostId) { graph.terminalDrafts.entry(entryKey, hostId) }
    val editor by entry.state.collectAsState()
    val draft = editor.value
    val controller = remember(hostId, nodeId, entry) {
        TerminalController(graph, session, nodeId, entry.state.value.ctrl, entry::setCtrl)
    }
    // The draft with its cursor, not just its text (review of A59): the field's String overload keeps
    // the previous cursor when the text is set from code, so after a dictation the cursor sat where it
    // was before it (at 0 in an empty draft) and the next keystroke went into the middle of the words.
    // The full editor and revision stay with this entry while another screen covers it.
    // The mic (audit A59) writes what it hears into the draft and nothing else: it has no way to send.
    // Its words go at the end of the draft, and so does the cursor, so typing after it continues there.
    val dictation = remember(entry) { DictationController(context.applicationContext) {
        entry.edit(cursorAtEnd(it))
    } }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) dictation.start(entry.state.value.value.text) else dictation.denied()
    }

    // Attached and watching only while the screen is STARTED (audit A18): in the background the
    // relay stream kept the desktop treating the session as watched (Eco shield, and the phone's
    // size as a ceiling) and kept the radio busy. Stop detaches; start reattaches.
    // While the pane shows, this session's Inbox events are in front of the user: the live refresh
    // records them as seen instead of announcing them (A73). Only while it shows (the A73 review):
    // the refresh asks controller.pane each time, so an overlay over the pane, or a terminal still
    // connecting, records nothing. Registered before the watch starts, so its first listing knows.
    LifecycleStartEffect(controller) {
        val showing = session.onScreen.showNode(nodeId) { controller.pane }
        session.startWatching()
        controller.onStart()
        onStopOrDispose {
            controller.onStop()
            session.stopWatching()
            showing.close()
        }
    }
    // The pane just came on screen: what it shows of the latest listing is seen now. That listing
    // arrived while the terminal was connecting and left this session's events waiting (A73 review).
    val pane = controller.pane
    LaunchedEffect(controller, pane) {
        if (pane == OnScreen.Pane.SHOWN) session.notePaneShown(nodeId)
    }
    DisposableEffect(controller) {
        onDispose { controller.dispose() }
    }
    // Nothing listens while the screen is stopped, and the recognizer goes with the screen (A59).
    LifecycleStartEffect(dictation) {
        onStopOrDispose { dictation.cancel() }
    }
    DisposableEffect(dictation) {
        onDispose { dictation.dispose() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1) },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    TextButton(onClick = { controller.setFontSize(graph.hosts.fontSize - 1) }) { Text("A−") }
                    TextButton(onClick = { controller.setFontSize(graph.hosts.fontSize + 1) }) { Text("A+") }
                }
            )
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().aboveKeyboard(padding)) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().background(NtColors.canvas)) {
                    // A new key = a new WebView: the old one was destroyed with its renderer (audit A45).
                    // None at all after a loss until the next attach is asked for (the review of A45).
                    if (controller.hasWebView) {
                        key(controller.webViewKey) {
                            AndroidView(factory = { ctx -> controller.createWebView(ctx) }, modifier = Modifier.fillMaxSize())
                        }
                    }
                    when (val st = controller.state) {
                        TermState.Connecting -> Row(
                            Modifier.align(Alignment.Center).blockTouchesBelow().background(NtColors.panel, RoundedCornerShape(8.dp)).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            CircularProgressIndicator(Modifier.padding(2.dp))
                            Text("Opening terminal…")
                        }
                        is TermState.Ended -> Column(
                            Modifier.align(Alignment.Center).blockTouchesBelow().background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(st.message)
                            Button(onClick = { controller.reattach() }) { Text("Reattach") }
                            if (controller.managedReceiptBlocked) {
                                Text("The created session may still be running. Check it on the computer before discarding its saved attachment receipt.")
                                TextButton(onClick = {
                                    try { if (controller.discardManagedReceipt()) nav.pop() }
                                    catch (e: Exception) { Toast.makeText(context, e.message ?: "Couldn't save the receipt decision.", Toast.LENGTH_LONG).show() }
                                }) { Text("I checked the computer") }
                            }
                        }
                        is TermState.RelayOffer -> Column(
                            Modifier.align(Alignment.Center).blockTouchesBelow().background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(st.message)
                            Button(onClick = { controller.openThroughRelay() }) { Text("Open through the relay") }
                        }
                        is TermState.ViewLost -> Column(
                            Modifier.align(Alignment.Center).blockTouchesBelow().background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(st.message)
                            Button(onClick = { controller.reopenTerminal() }) { Text("Reopen terminal") }
                        }
                        is TermState.AwaitingApproval -> Column(
                            Modifier.align(Alignment.Center).blockTouchesBelow().background(NtColors.panel, RoundedCornerShape(8.dp)).padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text("Approve this phone on your computer")
                            Text(st.sas, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.headlineMedium, color = NtColors.accent)
                            Text(
                                "Approve only if the code on the computer matches this one.",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        TermState.Attached -> Unit
                    }
                    controller.resumeOffer?.let { offer ->
                        Column(
                            Modifier.align(Alignment.TopCenter).blockTouchesBelow().fillMaxWidth().background(NtColors.panel2).padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Text(offer.message)
                            Text(offer.command, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { controller.acceptResume() }, enabled = controller.canResume) { Text(offer.button) }
                                OutlinedButton(onClick = { controller.dismissResume() }) { Text("Not now") }
                            }
                        }
                    }
                    val sendNotice = editor.sendNotice
                    (sendNotice?.message ?: controller.notice)?.let { msg ->
                        Row(
                            Modifier.align(Alignment.TopCenter).blockTouchesBelow().fillMaxWidth().background(NtColors.panel2).padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(msg, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = {
                                if (sendNotice != null) entry.dismissSendNotice(sendNotice)
                                else controller.notice = null
                            }) { Text("OK") }
                        }
                    }
                    Column(Modifier.align(Alignment.BottomCenter).blockTouchesBelow().fillMaxWidth()) {
                        // A tapped link, offered before anything opens (audit A32).
                        controller.linkOffer?.let { link -> LinkOffer(controller, link) }
                        controller.sizedElsewhere?.let { (c, r) ->
                            Row(
                                Modifier.fillMaxWidth().background(NtColors.panel2).padding(horizontal = 12.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Sized to another screen (${c}×$r)", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = { controller.fitHere() }) { Text("Fit this screen") }
                            }
                        }
                        // Why a dictation ended without words (A59).
                        dictation.state.message?.let { msg ->
                            Row(
                                Modifier.fillMaxWidth().background(NtColors.panel2).padding(horizontal = 12.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(msg, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = { dictation.dismiss() }) { Text("OK") }
                            }
                        }
                    }
                }
                KeyRow(controller)
                // The draft is cleared only once it was sent: while nothing is attached (connecting,
                // disconnected, ended) Send is disabled and the keyboard's Send leaves the text in place,
                // with the overlay above saying why (A41). Typing a draft meanwhile stays possible.
                // Any change to the draft's text that is not dictation's ends a dictation (A59): its
                // later results would bring back text that was sent or deleted. Moving the cursor, or the
                // keyboard marking the word it composes, changes no text and ends nothing: the field
                // reports those too, which its String overload did not.
                val send: () -> Unit = {
                    if (controller.attached) {
                        val sent = entry.beginSend()
                        if (sent != null) controller.submit(sent.value.text, enter = true, modifier = sent.ctrl,
                            onCompleted = { result, current -> entry.completeSend(sent.attempt, result, current) }) {
                            if (entry.clearUnchangedDraft(sent.revision)) dictation.edited()
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = {
                            val typed = it.text != entry.state.value.value.text
                            entry.edit(it)
                            if (typed) dictation.edited()
                        },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text(if (dictation.active) "Listening…" else "Type a command or a prompt") },
                        maxLines = 4,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { send() })
                    )
                    // Hidden where the phone has no speech recognizer; the keyboard's own voice typing
                    // (where it has one) works in the field either way. Enabled while nothing is
                    // attached, like typing: a dictated draft waits for Send like a typed one.
                    if (dictation.available) {
                        IconButton(onClick = {
                            when {
                                dictation.active -> dictation.stop()
                                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                                    PackageManager.PERMISSION_GRANTED -> dictation.start(entry.state.value.value.text)
                                // Asked on the first tap; the answer starts the dictation or says why not.
                                else -> askMic.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }) {
                            Icon(
                                MicIcon,
                                if (dictation.active) "Stop dictation" else "Dictate",
                                tint = if (dictation.active) NtColors.attention else LocalContentColor.current
                            )
                        }
                    }
                    IconButton(onClick = send, enabled = controller.attached && editor.pendingSend == null && !controller.submitting) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
                }
            }
            // Over the whole body, key row and input bar included: they have nothing to do while copying,
            // and a touch on the sheet's text stays on the sheet (blockTouchesBelow, the A32 review).
            controller.copySheet?.let { snapshot -> CopySheet(controller, snapshot) }
            if (controller.historyOpen) HistorySheet(controller)
        }
    }
}

/**
 * A draft dictation wrote (review of A59): the cursor after its last character, where the heard words
 * went ([dev.nodeterm.protocol.model.Dictation.join] appends them), and nothing selected or composing.
 */
private fun cursorAtEnd(text: String) = TextFieldValue(text, TextRange(text.length))

/**
 * "Open <host>?" for a link tapped in the terminal (audit A32): the host, a choice, and the URL. The URL
 * shows two lines until All shows the whole of it (review of A32). On a phone two lines are a few dozen
 * characters, which a long OAuth URL fills, and so would one row's fragment of it, the very thing the
 * matcher must never offer: only the whole URL says what Open opens. A long one scrolls inside the bar
 * rather than covering the terminal.
 */
@Composable
private fun LinkOffer(controller: TerminalController, link: ExternalLink) {
    val ctx = LocalContext.current
    var whole by remember(link) { mutableStateOf(false) }
    // Whether two lines cut the URL short, so All is offered only where it shows more.
    var cut by remember(link) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(NtColors.panel2).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Open ${link.host}?",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            TextButton(onClick = { controller.openLink(ctx, link) }) { Text("Open") }
            TextButton(onClick = { controller.copyLink(ctx, link) }) { Text("Copy") }
            IconButton(onClick = { controller.dismissLink() }) { Icon(Icons.Filled.Close, "Dismiss") }
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                link.url,
                Modifier.weight(1f).heightIn(max = 160.dp).verticalScroll(rememberScrollState()),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = NtColors.muted,
                maxLines = if (whole) Int.MAX_VALUE else 2,
                overflow = if (whole) TextOverflow.Clip else TextOverflow.Ellipsis,
                onTextLayout = { if (!whole) cut = it.hasVisualOverflow }
            )
            if (cut || whole) {
                TextButton(onClick = { whole = !whole }) { Text(if (whole) "Less" else "All") }
            }
        }
    }
}

/**
 * The Copy sheet (audit A32): the lines the terminal's buffer held when it was opened, to select and
 * copy or share, and the links in them. tmux's mouse keeps xterm's own selection from running, and
 * tmux's copy-mode is out of reach of a touch screen, so this is the phone's copy path. A tap selects
 * or deselects a line; a long-press selects every line from the last one tapped. The selection logic is
 * [TerminalCopy] (tested); this drawing is only type-checked.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CopySheet(controller: TerminalController, snapshot: TerminalCopy.Snapshot) {
    val ctx = LocalContext.current
    val focusManager = LocalFocusManager.current
    var selection by remember(snapshot) { mutableStateOf(TerminalCopy.Selection()) }
    var query by remember(snapshot) { mutableStateOf("") }
    var matchIndex by remember(snapshot, query) { mutableStateOf(0) }
    val search = remember(snapshot, query) { TerminalCopy.search(snapshot.lines, query) }
    val matchesByLine = remember(search) { search.matches.groupBy { it.line } }
    val activeMatch = search.matches.getOrNull(matchIndex)
    BackHandler { controller.closeCopySheet() }
    // The links come first in the list: the sheet opens on the screen's top line below them.
    val linkRows = if (snapshot.links.isEmpty()) 0 else snapshot.links.size + 2
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = linkRows + snapshot.firstVisible)
    LaunchedEffect(search, matchIndex) {
        activeMatch?.let { listState.scrollToItem(linkRows + it.line) }
    }
    Column(Modifier.fillMaxSize().blockTouchesBelow().background(NtColors.panel)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Copy from the terminal", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            if (selection.selected.isEmpty()) {
                TextButton(onClick = { selection = selection.all(snapshot.lines.size) }, enabled = snapshot.lines.isNotEmpty()) { Text("Select all") }
            } else {
                TextButton(onClick = { selection = selection.clear() }) { Text("Clear") }
            }
            IconButton(onClick = { controller.closeCopySheet() }) { Icon(Icons.Filled.Close, "Close") }
        }
        Text(
            "Tap lines to select them. Long-press a line to select everything from the last line you tapped.",
            Modifier.padding(horizontal = 12.dp),
            style = MaterialTheme.typography.bodySmall,
            color = NtColors.muted
        )
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search captured output") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            trailingIcon = {
                if (query.isNotEmpty()) IconButton(onClick = { query = "" }) {
                    Icon(Icons.Filled.Close, "Clear search")
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                search.move(matchIndex, forward = true)?.let { matchIndex = it }
                focusManager.clearFocus()
            })
        )
        if (query.isNotBlank()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (search.matches.isEmpty()) "No matches in captured output"
                    else "${matchIndex + 1} of ${search.matches.size}${if (search.truncated) "+" else ""} matches",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = NtColors.muted
                )
                TextButton(onClick = { search.move(matchIndex, forward = false)?.let { matchIndex = it } }, enabled = activeMatch != null) { Text("Previous") }
                TextButton(onClick = { search.move(matchIndex, forward = true)?.let { matchIndex = it } }, enabled = activeMatch != null) { Text("Next") }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
            if (snapshot.links.isNotEmpty()) {
                item(key = "links") { SheetHeading("Links") }
                items(snapshot.links, key = { "link:" + it.url }) { link ->
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(link.host, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                link.url,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = NtColors.muted,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        TextButton(onClick = { controller.openLink(ctx, link) }) { Text("Open") }
                        TextButton(onClick = { controller.copyLink(ctx, link) }) { Text("Copy") }
                    }
                }
                item(key = "text") { SheetHeading("Text") }
            }
            if (snapshot.lines.isEmpty()) {
                item(key = "empty") { SheetHeading("The terminal shows no text.") }
            }
            itemsIndexed(snapshot.lines, key = { i, _ -> "line:$i" }) { i, line ->
                val selected = i in selection.selected
                val highlighted = buildAnnotatedString {
                    append(line.ifEmpty { " " })
                    matchesByLine[i].orEmpty().forEach { match ->
                        addStyle(SpanStyle(background = NtColors.accent.copy(alpha = if (match == activeMatch) 0.65f else 0.25f)), match.start, match.end)
                    }
                }
                Text(
                    highlighted,
                    Modifier
                        .fillMaxWidth()
                        .background(if (selected) NtColors.accent.copy(alpha = 0.3f) else NtColors.canvas)
                        .combinedClickable(onClick = { selection = selection.toggle(i) }, onLongClick = { selection = selection.extendTo(i) })
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    color = NtColors.text
                )
            }
        }
        val count = selection.selected.count { it in snapshot.lines.indices }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (count == 0) "No lines selected" else "$count line${if (count == 1) "" else "s"} selected",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedButton(onClick = { controller.shareLines(ctx, selection) }, enabled = count > 0) { Text("Share") }
            Button(onClick = { controller.copyLines(ctx, selection) }, enabled = count > 0, modifier = Modifier.padding(start = 8.dp)) { Text("Copy") }
        }
    }
}

@Composable
private fun SheetHeading(text: String) {
    Text(
        text,
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelMedium,
        color = NtColors.muted
    )
}

/**
 * The keys a phone keyboard does not have, one tap each. Arrows honour the pane's cursor mode. The
 * sending keys are disabled while nothing is attached (A41): they used to look sent and reach nothing.
 * Copy (the Copy sheet), Ctrl (a modifier for the next key) and ⌨ (opens the keyboard) send nothing
 * themselves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KeyRow(controller: TerminalController) {
    val on = controller.attached
    val focusManager = LocalFocusManager.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        // First, where the row is not scrolled out of sight (audit A32). Reads what the terminal shows,
        // so it works attached or not. The input bar lets go of focus first: its keyboard would sit
        // over the sheet.
        KeyChip("Copy") {
            focusManager.clearFocus()
            controller.openCopySheet()
        }
        KeyChip("Find") {
            focusManager.clearFocus()
            controller.openHistory()
        }
        FilterChip(selected = controller.ctrlArmed, onClick = { controller.ctrlArmed = !controller.ctrlArmed }, label = { Text("Ctrl") })
        KeyChip("Esc", on) { controller.key("esc") }
        KeyChip("Tab", on) { controller.key("tab") }
        KeyChip("⇧Tab", on) { controller.key("stab") }
        KeyChip("↑", on) { controller.key("up") }
        KeyChip("↓", on) { controller.key("down") }
        KeyChip("←", on) { controller.key("left") }
        KeyChip("→", on) { controller.key("right") }
        KeyChip("⏎", on) { controller.key("enter") }
        KeyChip("⇧⏎", on) { controller.key("nl") }
        KeyChip("^C", on) { controller.raw("\u0003") }
        KeyChip("^D", on) { controller.raw("\u0004") }
        KeyChip("^R", on) { controller.raw("\u0012") }
        KeyChip("^L", on) { controller.raw("\u000c") }
        KeyChip("Home", on) { controller.key("home") }
        KeyChip("End", on) { controller.key("end") }
        KeyChip("PgUp", on) { controller.key("pgup") }
        KeyChip("PgDn", on) { controller.key("pgdn") }
        // The input bar's field lets go of focus first, or it keeps the keyboard (audit A46).
        KeyChip("⌨") {
            focusManager.clearFocus()
            controller.showKeyboard()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KeyChip(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    FilterChip(selected = false, onClick = onClick, enabled = enabled, label = { Text(label, fontFamily = FontFamily.Monospace) })
}
