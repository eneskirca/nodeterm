package dev.nodeterm.android.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Route
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.ssh.SshProfilePath
import dev.nodeterm.protocol.ssh.SshPasswordBootstrap
import androidx.lifecycle.compose.LifecycleStartEffect
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Add SSH server" (audit A27, part b): a computer with no pairing code — a headless Server Edition,
 * which has no pairing service, or a macOS / Linux computer the phone reaches only over SSH — added by
 * its address. The user can add the public key manually, or confirm the computer's SSH fingerprint
 * before a one-time password login installs it. Both paths save a host only after the computer
 * accepts the phone's retained key. Protocol rules live in [ManualHost] and [SshPasswordBootstrap].
 *
 * Such a computer is reached over SSH only: no relay, no push.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddSshHostScreen(nav: Navigator) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val scope = rememberCoroutineScope()
    // Saveable, so a rotation or a trip to the share sheet keeps what was typed.
    var name by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf("") }
    var port by rememberSaveable { mutableStateOf(ManualHost.DEFAULT_PORT.toString()) }
    var user by rememberSaveable { mutableStateOf("") }
    var profile by rememberSaveable { mutableStateOf("") }
    var profileError by remember { mutableStateOf<String?>(null) }
    var addedId by rememberSaveable { mutableStateOf<String?>(null) }
    var invalid by remember { mutableStateOf<ManualHost.Check.Invalid?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Passwords and fingerprint approval belong only to this visible setup attempt.
    var password by remember { mutableStateOf("") }
    var inspection by remember { mutableStateOf<SshPasswordBootstrap.Inspection?>(null) }
    var confirmed by remember { mutableStateOf<SshPasswordBootstrap.ConfirmedHost?>(null) }
    var bootstrapJob by remember { mutableStateOf<Job?>(null) }
    val keyLine = remember { ManualHost.authorizedKeysLine(graph.sshIdentity) }
    val install = remember(keyLine) { ManualHost.installCommand(keyLine) }

    fun resetBootstrap() {
        password = ""
        inspection = null
        confirmed = null
    }

    LifecycleStartEffect(Unit) {
        onStopOrDispose {
            resetBootstrap()
            bootstrapJob?.cancel()
        }
    }

    fun checkedAddress(): ManualHost.Address? {
        val checked = ManualHost.check(address, port, user, name)
        invalid = checked as? ManualHost.Check.Invalid
        if (checked !is ManualHost.Check.Ok) return null
        profileError = profile.takeIf { it.isNotBlank() }?.let(SshProfilePath::error)
        if (profileError != null) return null
        ManualHost.existing(graph.hosts.hosts.value, checked.address)?.let {
            error = "${checked.address.user}@${checked.address.host} is already in your list, as ${it.name}."
            return null
        }
        return checked.address
    }

    fun inspectHost() {
        val target = checkedAddress() ?: return
        resetBootstrap()
        busy = true
        error = null
        bootstrapJob = scope.launch {
            try {
                inspection = SshPasswordBootstrap.inspect(target)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn't inspect this computer's SSH host key."
            } finally {
                busy = false
                bootstrapJob = null
            }
        }
    }

    fun installWithPassword() {
        val target = checkedAddress() ?: return
        val approved = confirmed ?: return
        if (inspection?.address != target || password.isEmpty()) return
        val profilePath = SshProfilePath.fromInput(profile)
        val secret = password.toCharArray()
        password = ""
        busy = true
        error = null
        bootstrapJob = scope.launch {
            try {
                val record = SshPasswordBootstrap.install(approved, graph.sshIdentity, secret)
                    .copy(sshProfilePath = profilePath)
                val already = graph.hosts.addManual(record)
                if (already != null) error = "${target.user}@${target.host} is already in your list, as ${already.name}."
                else addedId = record.id
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn't finish SSH key setup."
            } finally {
                secret.fill('\u0000')
                resetBootstrap()
                busy = false
                bootstrapJob = null
            }
        }
    }

    fun connect() {
        resetBootstrap()
        val ok = checkedAddress() ?: return
        val profilePath = SshProfilePath.fromInput(profile)
        busy = true
        error = null
        scope.launch {
            try {
                // Blocking: if the screen goes away meanwhile, the connect still ends (and closes its
                // connection) on the IO thread, and nothing is kept.
                val record = withContext(Dispatchers.IO) { ManualHost.connectFirst(ok, graph.sshIdentity) }
                    .copy(sshProfilePath = profilePath)
                val already = graph.hosts.addManual(record)
                if (already != null) error = "${ok.user}@${ok.host} is already in your list, as ${already.name}."
                else addedId = record.id
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn't connect to ${ok.user}@${ok.host}."
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Add SSH server") },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize().aboveKeyboard(padding).padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            val added = addedId?.let { graph.hosts.get(it) }
            if (added != null) {
                Added(nav, added)
                return@Column
            }
            Text(
                "For a computer with no pairing code: a nodeterm Server Edition, or a macOS or Linux computer you reach " +
                    "over SSH where nodeterm runs sessions. The phone reaches it over SSH only, so not from anywhere " +
                    "unless its SSH is (over a VPN, say), and it gets no push notifications. To use the relay, pair the " +
                    "computer with nodeterm's code instead."
            )
            OutlinedTextField(
                value = address,
                onValueChange = { resetBootstrap(); address = it },
                label = { Text("Address") },
                placeholder = { Text("devbox.local or 192.168.1.20") },
                isError = invalid?.host != null,
                supportingText = invalid?.host?.let { e -> { Text(e) } },
                singleLine = true,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = user,
                    onValueChange = { resetBootstrap(); user = it },
                    label = { Text("User") },
                    isError = invalid?.user != null,
                    supportingText = invalid?.user?.let { e -> { Text(e) } },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.weight(2f)
                )
                OutlinedTextField(
                    value = port,
                    onValueChange = { resetBootstrap(); port = it },
                    label = { Text("Port") },
                    isError = invalid?.port != null,
                    supportingText = invalid?.port?.let { e -> { Text(e) } },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f)
                )
            }
            OutlinedTextField(
                value = name,
                onValueChange = { resetBootstrap(); name = it },
                label = { Text("Name (optional)") },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = profile,
                onValueChange = { resetBootstrap(); profile = it },
                label = { Text("Profile folder (optional)") },
                supportingText = { Text(profileError ?: "Full path on the computer, for a custom Server data directory. Leave blank for automatic discovery.") },
                isError = profileError != null,
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth()
            )

            HorizontalDivider()
            Text("1. Let this phone in", style = MaterialTheme.typography.titleMedium)
            Text(
                "To set up key access manually, add this line to " +
                    "~/.ssh/authorized_keys of that user on the computer:"
            )
            Monospace(keyLine)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { copy(context, keyLine, "Copied the key line") }) { Text("Copy") }
                OutlinedButton(onClick = { share(context, keyLine) }) { Text("Share") }
            }
            Text("Or run this in a terminal on the computer, logged in as that user. Running it twice adds nothing:")
            Monospace(install)
            OutlinedButton(onClick = { copy(context, install, "Copied the command") }) { Text("Copy the command") }

            Text("Or install the phone's key using this SSH user's password. The password is used only for setup; later connections use the phone's key.")
            if (inspection == null) {
                OutlinedButton(onClick = { inspectHost() }, enabled = !busy) { Text("Set up with a password") }
            } else {
                val candidate = inspection!!
                Text("Compare this SSH host fingerprint with the computer before entering its password:")
                Monospace(candidate.fingerprint)
                Monospace(ManualHost.FINGERPRINT_CHECK_COMMAND)
                if (confirmed == null) {
                    OutlinedButton(onClick = { confirmed = candidate.confirm(candidate.fingerprint) }, enabled = !busy) {
                        Text("I compared it — it matches")
                    }
                } else {
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("SSH password") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        singleLine = true,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Button(onClick = { installWithPassword() }, enabled = !busy && password.isNotEmpty()) { Text("Install key and connect") }
                }
                OutlinedButton(onClick = { resetBootstrap() }, enabled = !busy) { Text("Cancel password setup") }
            }

            HorizontalDivider()
            Text("2. Connect", style = MaterialTheme.typography.titleMedium)
            Text(
                "The phone trusts the SSH host key of the first server that accepts its key at this address, and " +
                    "shows it so you can compare it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { connect() }, enabled = !busy) { Text("Connect") }
                if (busy) {
                    Spacer(Modifier.size(12.dp))
                    CircularProgressIndicator(Modifier.size(24.dp))
                }
            }
            error?.let { Text(it, color = NtColors.attention) }
        }
    }
}

/** After the first connect: the host key it pinned, how to check it, and the way in. */
@Composable
private fun Added(nav: Navigator, host: PairedHost) {
    val context = LocalContext.current
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Added ${host.name}", style = MaterialTheme.typography.titleLarge)
            Text("${host.user}@${host.host}" + if (host.port != ManualHost.DEFAULT_PORT) ":${host.port}" else "", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("The phone pinned this computer's SSH host key:")
            Monospace(host.sshHostKeyFingerprint ?: "")
            Text(
                "To check it, run this on the computer. One of the lines it prints must show the same SHA256 " +
                    "fingerprint; if none does, forget this computer: something else answered at its address.",
                style = MaterialTheme.typography.bodySmall
            )
            Monospace(ManualHost.FINGERPRINT_CHECK_COMMAND)
            OutlinedButton(onClick = { copy(context, ManualHost.FINGERPRINT_CHECK_COMMAND, "Copied the command") }) {
                Text("Copy the command")
            }
            Text(
                "It is reached over SSH only. Without push, the phone checks it for approvals and questions about " +
                    "every 15 minutes in the background, and live while you look at it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
    Button(onClick = {
        nav.replaceAll(Route.Hosts)
        nav.push(Route.Host(host.id))
    }, modifier = Modifier.fillMaxWidth()) { Text("Open ${host.name}") }
}

@Composable
private fun Monospace(text: String) {
    SelectionContainer {
        Text(
            text,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
        )
    }
}

/** A failed clipboard write is a binder call that can throw (as in the terminal's copy, A53): said, not crashed. */
private fun copy(context: Context, text: String, done: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val ok = cm != null && runCatching { cm.setPrimaryClip(ClipData.newPlainText("nodeterm", text)) }.isSuccess
    Toast.makeText(context, if (ok) done else "Couldn't copy. Select the text and copy it instead.", Toast.LENGTH_SHORT).show()
}

/** Hand the key line to another app (a message to yourself, a note) to paste on the computer. */
private fun share(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    try {
        context.startActivity(Intent.createChooser(send, null))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No app can share it. Copy it instead.", Toast.LENGTH_SHORT).show()
    } catch (_: RuntimeException) {
        Toast.makeText(context, "Couldn't share it. Copy it instead.", Toast.LENGTH_SHORT).show()
    }
}
