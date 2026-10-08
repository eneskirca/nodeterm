package dev.nodeterm.android

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.core.content.ContextCompat
import dev.nodeterm.android.ui.AddSshHostScreen
import dev.nodeterm.android.ui.AllComputersScreen
import dev.nodeterm.android.ui.HostScreen
import dev.nodeterm.android.ui.HostsScreen
import dev.nodeterm.android.ui.NodetermTheme
import dev.nodeterm.android.ui.PairScreen
import dev.nodeterm.android.ui.SettingsScreen
import dev.nodeterm.android.ui.SourceControlScreen
import dev.nodeterm.android.ui.TerminalScreen
import dev.nodeterm.protocol.model.BackStack

/** The screens. A plain back stack: eight destinations, one deep link (the pairing URL). */
sealed interface Route {
    data object Hosts : Route
    data class PairHost(val code: String? = null) : Route
    /** Add a computer by its SSH address, with no pairing code (audit A27). */
    data object AddSshHost : Route
    data object Settings : Route
    data class Host(val hostId: String, val tab: Int = 0) : Route
    data class Terminal(val hostId: String, val nodeId: String, val title: String) : Route
    /** One project's source control on that computer (audit A29). */
    data class SourceControl(val hostId: String, val projectId: String) : Route
    /** Every paired computer's Inbox and Usage, merged (audit A55). Names no computer of its own. */
    data object AllComputers : Route
}

/**
 * The back stack. Each entry has its own key (audit A43): AppContent files the entry's saved UI state
 * (the Host screen's tab, scroll positions, the Board's project, the Inbox's archive toggle) under it,
 * so the screen below a terminal comes back as it was left. The rules live in [BackStack] (protocol,
 * tested); this is its observable holder. Used from the main thread only.
 */
class Navigator(initial: BackStack<Route>) {
    constructor(initial: Route) : this(BackStack.of(listOf(initial), Route.Hosts))

    private var backStack by mutableStateOf(initial)

    val size: Int get() = backStack.size
    val entries: List<BackStack.Entry<Route>> get() = backStack.entries

    /** The showing entry: its route, and the key its saved UI state is filed under. */
    val top: BackStack.Entry<Route> get() = backStack.entries.last()

    fun push(route: Route) {
        backStack = backStack.push(route)
    }

    fun pop(): Boolean {
        backStack = backStack.pop() ?: return false
        return true
    }

    fun replaceAll(route: Route) {
        backStack = backStack.replaceAll(route)
    }

    /** Keeps the entries [keep] accepts, each with its saved state; the computers list when none is left. */
    fun retain(keep: (Route) -> Boolean) {
        backStack = backStack.retain(Route.Hosts, keep = keep)
    }

    /** The keys of the entries that left the stack since the last call. Their saved state is to be dropped. */
    fun takeRetired(): List<String> {
        val keys = backStack.retired
        if (keys.isNotEmpty()) backStack = backStack.withoutRetired()
        return keys
    }

    companion object {
        /**
         * Saves the back stack across activity recreation (a density, font-scale or locale change,
         * or process death) — it used to reset to the computers list (audit A22). Each route is a
         * list of strings, saved with its entry's key (audit A43); an entry that no longer decodes is
         * dropped, never guessed.
         */
        val Saver: Saver<Navigator, String> = Saver(
            save = { nav -> nav.backStack.encode(::encode) },
            restore = { raw -> Navigator(BackStack.decode(raw, Route.Hosts, route = ::decode)) }
        )

        private fun encode(r: Route): List<String> = when (r) {
            Route.Hosts -> listOf("hosts")
            is Route.PairHost -> listOfNotNull("pair", r.code)
            Route.AddSshHost -> listOf("addssh")
            Route.Settings -> listOf("settings")
            is Route.Host -> listOf("host", r.hostId, r.tab.toString())
            is Route.Terminal -> listOf("terminal", r.hostId, r.nodeId, r.title)
            is Route.SourceControl -> listOf("git", r.hostId, r.projectId)
            // A new name, not a new shape: a stack saved before this route existed decodes as before,
            // and a build without it drops the entry (decode answers null) instead of guessing.
            Route.AllComputers -> listOf("all")
        }

        private fun decode(parts: List<String>): Route? = when (parts.firstOrNull()) {
            "hosts" -> Route.Hosts
            // A pairing code is single-use: coming back to it would only fail. Drop it.
            "pair" -> null
            // Unlike a pairing code nothing in it is single-use: the form comes back as it was typed.
            "addssh" -> Route.AddSshHost
            "settings" -> Route.Settings
            "host" -> parts.getOrNull(1)?.let { Route.Host(it, parts.getOrNull(2)?.toIntOrNull() ?: 0) }
            "terminal" -> if (parts.size == 4) Route.Terminal(parts[1], parts[2], parts[3]) else null
            "git" -> if (parts.size == 3) Route.SourceControl(parts[1], parts[2]) else null
            "all" -> Route.AllComputers
            else -> null
        }
    }
}

class MainActivity : ComponentActivity() {
    /** A `nodeterm://pair?code=` link that arrived (at launch or while running) and awaits the UI. */
    private var incomingPairCode by mutableStateOf<String?>(null)

    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action == Intent.ACTION_VIEW && data.scheme == "nodeterm" && data.host == "pair") {
            incomingPairCode = data.toString()
        }
    }

    /** A notification tap (at launch or while running) that awaits the UI. */
    private var incomingTap by mutableStateOf<NotificationTap?>(null)

    /** The session a notification names: [EXTRA_HOST_ID], and the node it is about (audit A25). */
    private fun tapOf(intent: Intent?): NotificationTap? {
        val hostId = intent?.getStringExtra(EXTRA_HOST_ID) ?: return null
        val nodeId = intent.getStringExtra(EXTRA_NODE_ID)?.takeIf { it.isNotBlank() }
        return NotificationTap(hostId, nodeId, intent.getStringExtra(EXTRA_NODE_TITLE))
    }

    /**
     * A live activity gets later intents HERE, not in onCreate (it is `singleTask`): a notification
     * tapped while the app sat in the background used to open whatever screen was last showing
     * instead of that computer's Inbox (audit A11/A19), and now its session (audit A25).
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takePairLink(intent)
        tapOf(intent)?.let { incomingTap = it }
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the Settings switch reflects it */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = NodetermApp.graph(this)
        // Asked on a fresh start only — not on every rotation or recreation (audit A21). Later asks
        // come from the Settings switch, which also offers the system settings once Android stops
        // showing the dialog.
        if (savedInstanceState == null && Build.VERSION.SDK_INT >= 33 && graph.hosts.notificationsEnabled &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // The launch intent (a notification tap, a pairing link) is applied on a FRESH start only: on a
        // recreation the saved back stack already reflects it, and re-applying it would push the
        // same screen again (audit A22).
        val fresh = savedInstanceState == null
        val launchTap = if (fresh) tapOf(intent) else null
        if (fresh) takePairLink(intent)
        setContent {
            NodetermTheme {
                val nav = rememberSaveable(saver = Navigator.Saver) {
                    Navigator(Route.Hosts).also { n ->
                        if (launchTap != null && graph.hosts.get(launchTap.hostId) != null) n.openTap(launchTap)
                    }
                }
                // A restored stack may name a computer that was forgotten meanwhile.
                LaunchedEffect(Unit) {
                    nav.retain { r ->
                        when (r) {
                            is Route.Host -> graph.hosts.get(r.hostId) != null
                            is Route.Terminal -> graph.hosts.get(r.hostId) != null
                            is Route.SourceControl -> graph.hosts.get(r.hostId) != null
                            else -> true
                        }
                    }
                }
                val tap = incomingTap
                LaunchedEffect(tap) {
                    if (tap != null) {
                        incomingTap = null
                        if (graph.hosts.get(tap.hostId) != null) {
                            nav.replaceAll(Route.Hosts)
                            nav.openTap(tap)
                        }
                    }
                }
                val code = incomingPairCode
                LaunchedEffect(code) {
                    if (code != null) {
                        incomingPairCode = null
                        nav.push(Route.PairHost(code))
                    }
                }
                AppContent(nav)
            }
        }
    }

    companion object {
        const val EXTRA_HOST_ID = "hostId"
        /** The session a notification is about; its tap opens that terminal (audit A25). */
        const val EXTRA_NODE_ID = "nodeId"
        /** That session's name, for the terminal's title until the listing names it. */
        const val EXTRA_NODE_TITLE = "nodeTitle"
    }
}

/** What a notification's tap opens: [nodeId]'s terminal on [hostId], or that computer's Inbox without one. */
private data class NotificationTap(val hostId: String, val nodeId: String?, val title: String?)

/**
 * Opens what a notification tap names: the session's terminal (audit A25), with that computer's Inbox
 * under it, where the event is listed, so Back lands where the A11/A19 tap used to open.
 */
private fun Navigator.openTap(tap: NotificationTap) {
    push(Route.Host(tap.hostId, tab = 2))
    val node = tap.nodeId ?: return
    push(Route.Terminal(tap.hostId, node, tap.title?.takeIf { it.isNotBlank() } ?: "Session"))
}

@Composable
private fun AppContent(nav: Navigator) {
    // Only the top entry is composed, so without a holder a screen's saved state died the moment
    // another was pushed on it: back from a terminal, the Host screen was on its first tab, scrolled
    // to the top, on the Board's first project (audit A43). Each entry's state is filed under its own
    // key, which the saved back stack keeps across recreation, like the holder keeps the state.
    val saved = rememberSaveableStateHolder()
    // An entry that left the stack never comes back (a new push gets a new key): drop its state.
    val graph = NodetermApp.graph(LocalContext.current)
    SideEffect {
        nav.takeRetired().forEach { saved.removeState(it) }
        graph.terminalDrafts.retain(nav.entries.filter {
            val route = it.value
            route is Route.Terminal && graph.hosts.get(route.hostId) != null
        }.mapTo(mutableSetOf()) { it.key })
    }
    BackHandler(enabled = nav.size > 1) { nav.pop() }
    val top = nav.top
    // Keyed per ENTRY, not per route: a Host screen for another computer, or for the same one opened
    // again (a notification → Inbox), starts from its own route, never from the showing screen's state.
    saved.SaveableStateProvider(top.key) {
        when (val r = top.value) {
            Route.Hosts -> HostsScreen(nav)
            is Route.PairHost -> PairScreen(nav, r.code)
            Route.AddSshHost -> AddSshHostScreen(nav)
            Route.Settings -> SettingsScreen(nav)
            is Route.Host -> HostScreen(nav, r.hostId, r.tab)
            is Route.Terminal -> TerminalScreen(nav, top.key, r.hostId, r.nodeId, r.title)
            is Route.SourceControl -> SourceControlScreen(nav, r.hostId, r.projectId)
            Route.AllComputers -> AllComputersScreen(nav)
        }
    }
}
