package dev.nodeterm.android

import android.app.Application
import android.content.Context
import androidx.compose.ui.text.input.TextFieldValue
import dev.nodeterm.protocol.model.TerminalDrafts
import dev.nodeterm.android.conn.ConnectionManager
import dev.nodeterm.android.data.HostStore
import dev.nodeterm.android.data.SecureStore
import dev.nodeterm.android.notify.InboxNotifier
import dev.nodeterm.protocol.crypto.BoxKeyPair
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.ProjectsSnapshot
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.secure.PhoneIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

/** The app's singletons. Constructed once, in [NodetermApp.onCreate]. */
class AppGraph(context: Context) {
    val secure = SecureStore(context)
    val hosts = HostStore(context)

    /**
     * The phone's relay identity: the box key and the relay deviceId, kept together — a new box key
     * always comes with a new deviceId (audit A51). Read the deviceId as `identity.deviceId()`.
     */
    val identity: PhoneIdentity = secure.phoneIdentity(hosts.identityStorage)

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val terminalDrafts = TerminalDrafts(TextFieldValue())
    val connections = ConnectionManager(this)

    /** Who may dial a computer's relay, and when (never a dialog-raising first handshake from the background). */
    val relayGate = RelayApprovalGate(hosts::relayApproved, hosts::setRelayApproved)

    /** The phone's persistent relay identity — the key every paired desktop PINS. */
    val boxKeys: BoxKeyPair by lazy { BoxKeyPair.fromSecretKey(identity.boxSecret()) }

    /** The phone's SSH identity (Ed25519); its public half is in each computer's authorized_keys. */
    val sshIdentity: SshIdentity by lazy { SshIdentity.fromSeed(secure.getOrCreate32(SecureStore.SSH_SEED)) }

    private val appContext: Context = context.applicationContext

    /**
     * A fresh listing of [hostId] arrived (HostSession.refreshNow): notify about its new Inbox events,
     * minus what [onScreen] shows (audit A73). One path for the 8 s refresh of the computer on screen
     * and the background check alike.
     */
    fun announce(hostId: String, snapshot: ProjectsSnapshot, onScreen: OnScreen, quiet: Boolean) {
        val host = hosts.get(hostId) ?: return
        InboxNotifier.announce(appContext, host, snapshot, onScreen, quiet)
    }
}

class NodetermApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        // Android ships a stripped "BC" provider under the same name; sshj asks for the "BC" provider
        // BY NAME for its ciphers and key exchanges, so replace it before any SSH connection is made.
        // Appended, not inserted first: nothing else in the app (TLS, the Keystore) should start
        // resolving algorithms through it.
        Security.removeProvider("BC")
        Security.addProvider(BouncyCastleProvider())
        graph = AppGraph(this)
        InboxNotifier.createChannels(this)
        InboxNotifier.schedule(this, graph.hosts.notificationsEnabled)
    }

    companion object {
        fun graph(context: Context): AppGraph = (context.applicationContext as NodetermApp).graph
    }
}
