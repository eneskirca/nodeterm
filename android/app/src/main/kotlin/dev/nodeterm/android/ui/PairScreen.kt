package dev.nodeterm.android.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.nodeterm.android.Navigator
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.Route
import dev.nodeterm.android.data.SecureStore
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.PairedHostReplacement
import dev.nodeterm.protocol.pairing.PairingClient
import dev.nodeterm.protocol.pairing.PairingException
import dev.nodeterm.protocol.pairing.PairingPayload
import kotlinx.coroutines.launch

/**
 * The phone side of Settings → Phone → "Pair a phone" on the desktop. Scanning the QR (or pasting
 * its text) gives a one-time token; the phone answers with its Ed25519 public key and its own id,
 * sealed to the host key the QR carries, and gets back a device id plus — when remote access is on
 * — the relay leg. Nothing secret leaves the phone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(nav: Navigator, initialCode: String? = null) {
    val context = LocalContext.current
    val graph = NodetermApp.graph(context)
    val scope = rememberCoroutineScope()
    var raw by remember { mutableStateOf("") }
    var payload by remember { mutableStateOf<PairingPayload?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun accept(text: String) {
        val p = PairingPayload.parse(text)
        if (p == null) {
            error = "That isn't a nodeterm pairing code. On your computer open nodeterm → Settings → Phone → Pair a phone."
        } else {
            error = null
            payload = p
        }
    }

    LaunchedEffect(initialCode) { initialCode?.let { accept(it) } }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { accept(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair a computer") },
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }
            )
        }
    ) { padding ->
        Column(
            Modifier.fillMaxSize().aboveKeyboard(padding).padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            val p = payload
            if (p == null) {
                Text("1. On your computer, open nodeterm → Settings → Phone and choose Pair a phone.")
                Text("2. Scan the code it shows. Your phone must be on the same network as the computer for this one step.")
                Button(onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt("Scan the pairing code on your computer")
                            .setBeepEnabled(false)
                            .setOrientationLocked(false)
                    )
                }, modifier = Modifier.fillMaxWidth()) { Text("Scan the pairing code") }
                Text("Or paste the code's text:", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = raw,
                    onValueChange = { raw = it },
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    placeholder = { Text("{\"v\":1,\"host\":…}") }
                )
                OutlinedButton(onClick = { accept(raw) }, enabled = raw.isNotBlank()) { Text("Use this code") }
                // No code to scan: a Server Edition has no pairing service, and an SSH-only host no
                // nodeterm to show one (audit A27).
                Text(
                    "No pairing code? A nodeterm Server Edition, or a computer you reach over SSH, is added by its address.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                TextButton(onClick = { nav.push(Route.AddSshHost) }) { Text("Add SSH server") }
            } else {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(p.name, style = MaterialTheme.typography.titleLarge)
                        Text("${p.user}@${p.host}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(if (p.hostKey != null) "✓ The pairing exchange is end-to-end encrypted" else "⚠ This computer's nodeterm is too old to encrypt pairing")
                        Text(if (p.sshAvailable) "✓ Direct connection on your network (SSH)" else "Relay-only computer (no SSH)")
                        // Not "reachable from anywhere": that is only true once the computer has
                        // approved this phone for the relay (at the scan on a current desktop, or on
                        // the first relay connect on an older one) — audit A07.
                        Text(if (p.relay != null) "Remote access is on" else "Remote access is off — this phone will only reach the computer on your network")
                    }
                }
                if (!p.sshAvailable && p.relay == null) {
                    Text(
                        "This computer can only be reached through remote access, which is off. Turn it on in nodeterm → Settings → Phone and scan the new code.",
                        color = NtColors.warning
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Button(enabled = !busy, onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            try {
                                // The backend's free-tier re-registration wants the phone's PREVIOUS device
                                // token for this computer (pairing-service.ts `priorDeviceToken`).
                                val previous = graph.hosts.hosts.value.firstOrNull { it.hostKeyB64 != null && it.hostKeyB64 == p.hostKey }
                                val prior = previous?.let { graph.secure.getString(SecureStore.relayTokenKey(it.id)) }
                                val result = PairingClient().pair(
                                    payload = p,
                                    sshPublicKeyLine = graph.sshIdentity.authorizedKeysLine("nodeterm-android"),
                                    deviceName = graph.hosts.deviceName,
                                    deviceId = graph.identity.deviceId(),
                                    priorDeviceToken = prior,
                                    boxPublicKeyB64 = graph.boxKeys.publicKeyB64
                                )
                                val host = PairedHost.from(p, result)
                                // Block factory admission until retirement and local publication
                                // finish. Always retire the incoming id, including a changed box key.
                                val retiredIds = PairedHostReplacement.retired(graph.hosts.hosts.value, host, previous).map { it.id } + host.id
                                graph.connections.retireAndPublish(retiredIds) {
                                    graph.hosts.publishPairing(host, previous,
                                        saveToken = { result.relayDeviceToken?.let { graph.secure.putString(SecureStore.relayTokenKey(host.id), it) } },
                                        removeToken = { id -> graph.secure.remove(SecureStore.relayTokenKey(id)) })
                                }
                                // Also with no relay leg yet (A07-late): the computer approves this phone's
                                // key on its first relay connect, so once a late adoption gives it a leg the
                                // background check may use it without raising a dialog.
                                if (result.relayApproved) graph.hosts.setRelayApproved(host.id, true)
                                Toast.makeText(context, result.pairedNotice(), Toast.LENGTH_LONG).show()
                                nav.replaceAll(Route.Hosts)
                                nav.push(Route.Host(host.id))
                            } catch (e: kotlinx.coroutines.CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                // Always a sentence: a bare exception message can be a lone token
                                // (audit A54 saw "-1").
                                error = PairingException.userMessage(e)
                            } finally {
                                busy = false
                            }
                        }
                    }) { Text("Pair") }
                    Spacer(Modifier.size(12.dp))
                    OutlinedButton(onClick = { payload = null }, enabled = !busy) { Text("Scan again") }
                    if (busy) {
                        Spacer(Modifier.size(12.dp))
                        CircularProgressIndicator(Modifier.size(24.dp))
                    }
                }
            }
            error?.let { Text(it, color = NtColors.attention) }
        }
    }
}
