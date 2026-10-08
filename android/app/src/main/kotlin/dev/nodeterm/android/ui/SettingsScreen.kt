package dev.nodeterm.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.data.RoutePreference
import dev.nodeterm.android.data.DictationPreferences
import dev.nodeterm.protocol.model.DictationLanguage
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.ssh.SshProfilePath
import dev.nodeterm.android.notify.InboxNotifier
import dev.nodeterm.protocol.crypto.B64
import dev.nodeterm.protocol.relay.ApiBaseSetting
import dev.nodeterm.protocol.relay.RelayApi
import java.security.MessageDigest

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: Navigator) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val hosts by graph.hosts.hosts.collectAsState()
    var name by remember { mutableStateOf(graph.hosts.deviceName) }
    var apiBase by remember { mutableStateOf(graph.hosts.apiBase) }
    var notify by remember { mutableStateOf(graph.hosts.notificationsEnabled) }
    var notifyDetails by remember { mutableStateOf(graph.hosts.notificationDetails) }
    val dictationPreferences = remember { DictationPreferences(context.applicationContext) }
    var dictationLanguage by remember { mutableStateOf(dictationPreferences.languageTag) }
    var chooseDictationLanguage by remember { mutableStateOf(false) }
    // Whether the phone will actually SHOW them, re-read whenever the screen starts (the user may
    // have come back from the system settings). The switch used to read On while nothing could
    // arrive (audit A21).
    var canPost by remember { mutableStateOf(InboxNotifier.canPost(context)) }
    LifecycleStartEffect(Unit) {
        canPost = InboxNotifier.canPost(context)
        onStopOrDispose { }
    }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        canPost = InboxNotifier.canPost(context)
    }
    fun openNotificationSettings() {
        runCatching {
            context.startActivity(
                Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
            )
        }
    }
    var routes by remember { mutableStateOf(hosts.associate { it.id to graph.hosts.route(it.id) }) }

    // The name and the relay address are stored when the screen is left, by the top-bar arrow AND
    // by the system back (gesture or button), which used to pop without saving (audit A44). Not per
    // keystroke: a half-typed address would be the one the relay calls used. An address that is not
    // https is not stored, and the user is told so rather than finding the old one still in place.
    // Leaving without an edit stores nothing. While nothing is stored, the name follows the phone's
    // model and the address the build's default relay; storing either would pin it.
    fun save(onRejected: () -> Unit) {
        if (name.trim() != graph.hosts.deviceName) graph.hosts.deviceName = name
        when (val edit = ApiBaseSetting.onLeave(apiBase, graph.hosts.apiBase)) {
            is ApiBaseSetting.OnLeave.Save -> graph.hosts.apiBase = edit.value
            ApiBaseSetting.OnLeave.UseDefault -> graph.hosts.useDefaultApiBase()
            ApiBaseSetting.OnLeave.Keep -> {}
            ApiBaseSetting.OnLeave.Rejected -> onRejected()
        }
    }
    fun leave() {
        save(onRejected = {
            Toast.makeText(
                context,
                "Relay API not saved: it must be a full https:// address.",
                Toast.LENGTH_LONG
            ).show()
        })
        nav.pop()
    }
    // Registered after AppContent's, so it runs instead of that plain pop while Settings shows.
    BackHandler(enabled = nav.size > 1) { leave() }
    // Settings also leaves the screen without a back (the review of A44): a notification tap replaces
    // the whole stack, and a pairing link pushes its screen on top. The edits are stored then too, but
    // silently: a refused address is not stored, and the user is not on this screen to be told. After
    // leave() this finds nothing left to change, and no second message. A recreation of the
    // activity (a rotation) stores what is typed by then as well; the new screen reads it back.
    DisposableEffect(Unit) {
        onDispose { save(onRejected = {}) }
    }

    if (chooseDictationLanguage) {
        DictationLanguageDialog(
            selected = dictationLanguage,
            onChoose = { tag ->
                dictationPreferences.languageTag = tag
                dictationLanguage = dictationPreferences.languageTag
                chooseDictationLanguage = false
            },
            onDismiss = { chooseDictationLanguage = false }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = { leave() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize().aboveKeyboard(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("This phone", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60) },
                label = { Text("Name shown on your computer") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Notifications")
                    Text(
                        "Checked about every 15 minutes in the background, and live while this computer or All computers is on screen.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(checked = notify && canPost, onCheckedChange = {
                    notify = it
                    graph.hosts.notificationsEnabled = it
                    InboxNotifier.schedule(context, it)
                    if (it && !canPost) {
                        // Ask once through the system dialog; once Android stops showing it (after
                        // two denials) only the system settings can turn them back on.
                        if (Build.VERSION.SDK_INT >= 33 &&
                            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        ) {
                            askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            openNotificationSettings()
                        }
                    }
                })
            }
            if (notify && !canPost) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Notifications are turned off for nodeterm on this phone.",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    TextButton(onClick = { openNotificationSettings() }) { Text("Open settings") }
                }
            }
            // Off by default: the event's own text reaches the lock screen under Android's default
            // setting, and a public version does not change that (audit A52).
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Show details in notifications")
                    Text(
                        "Adds the command, file or question and the agent's last message. Android then shows them " +
                            "on the lock screen too, unless you hide sensitive notification content there.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                // Enabled like the Notifications switch reads: on only while notifications can show.
                Switch(checked = notifyDetails, enabled = notify && canPost, onCheckedChange = {
                    notifyDetails = it
                    graph.hosts.notificationDetails = it
                })
            }

            HorizontalDivider()
            Text("Dictation", style = MaterialTheme.typography.titleMedium)
            Text("Language: " + DictationLanguage.label(dictationLanguage))
            TextButton(onClick = { chooseDictationLanguage = true }) { Text("Choose language") }
            Text("Dictation fills the terminal draft. Tap Send when it is ready.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

            if (hosts.isNotEmpty()) {
                HorizontalDivider()
                Text("How to reach each computer", style = MaterialTheme.typography.titleMedium)
                hosts.forEach { host ->
                    Text(host.name, style = MaterialTheme.typography.labelLarge)
                    SshProfileField(host) { path -> graph.connections.session(host.id).changeSshProfile(path) }
                    // Added by its SSH address (audit A27): SSH is its only route, so there is no choice.
                    if (host.manual) {
                        Text(
                            "Over SSH only: this computer was added by its SSH address, so it has no relay.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        return@forEach
                    }
                    listOf(
                        RoutePreference.AUTO to "Automatic (network first, then relay)",
                        RoutePreference.SSH_ONLY to "Only on my network (SSH)",
                        RoutePreference.RELAY_ONLY to "Only through the relay"
                    ).forEach { (route, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = routes[host.id] == route, onClick = {
                                graph.hosts.setRoute(host.id, route)
                                graph.connections.session(host.id).disconnect()
                                routes = routes + (host.id to route)
                            })
                            Text(label)
                        }
                    }
                }
            }

            HorizontalDivider()
            Text("Identity", style = MaterialTheme.typography.titleMedium)
            Text(
                "SSH key: SHA256:" + B64.encode(MessageDigest.getInstance("SHA-256").digest(graph.sshIdentity.publicKeyBlob)).trimEnd('='),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                "Relay key: " + graph.boxKeys.publicKeyB64.take(16) + "…",
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                "Both keys were made on this phone and never leave it. Your computer keeps only their public halves.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            HorizontalDivider()
            Text("Advanced", style = MaterialTheme.typography.titleMedium)
            // By what the field holds now, so an unusable address an older build stored is flagged too.
            val apiBaseError = ApiBaseSetting.fieldError(apiBase, graph.hosts.apiBase)
            OutlinedTextField(
                value = apiBase,
                onValueChange = { apiBase = it.trim() },
                label = { Text("Relay API (https)") },
                isError = apiBaseError != null,
                supportingText = apiBaseError?.let { error -> { Text(error) } },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            TextButton(onClick = { apiBase = RelayApi.DEFAULT_API_BASE }) { Text("Reset to default") }

            HorizontalDivider()
            Text("About", style = MaterialTheme.typography.titleMedium)
            Text(
                "nodeterm for Android · open source components: xterm.js (MIT), ZXing (Apache-2.0), sshj (Apache-2.0), " +
                    "BouncyCastle (MIT), EdDSA-Java (CC0), OkHttp (Apache-2.0), kotlinx (Apache-2.0), AndroidX (Apache-2.0).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun SshProfileField(host: PairedHost, save: (String?) -> Unit) {
    var input by remember(host.id, host.sshProfilePath) { mutableStateOf(host.sshProfilePath ?: "") }
    var error by remember(host.id, host.sshProfilePath) { mutableStateOf<String?>(null) }
    OutlinedTextField(
        value = input,
        onValueChange = { input = it; error = null },
        label = { Text("SSH profile folder") },
        supportingText = { Text(error ?: "Full path on this computer. Leave blank for automatic discovery. Saving disconnects its current session.") },
        isError = error != null,
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )
    TextButton(onClick = {
        error = input.takeIf { it.isNotBlank() }?.let(SshProfilePath::error)
        if (error == null) save(SshProfilePath.fromInput(input))
    }, enabled = input != (host.sshProfilePath ?: "")) { Text("Save profile folder") }
}
