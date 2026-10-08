package dev.nodeterm.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.nodeterm.android.MainActivity
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.R
import dev.nodeterm.android.ui.displayTitle
import dev.nodeterm.protocol.host.InboxNotificationActions
import dev.nodeterm.protocol.host.InboxNotificationActions.Outcome
import dev.nodeterm.protocol.host.InboxNotificationActions.Request
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.InboxNotificationText
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * Notifications for "an agent needs you" / "an agent finished".
 *
 * The iOS app gets these as APNs pushes fanned out by the nodeterm backend (src/core/push-notify.ts).
 * That backend has no Android (FCM) leg, so this app cannot be woken the same way. What it does
 * instead, honestly: checked about every 15 minutes in the background, and live while the computer
 * or All computers is on screen. Both are the same [announce], run on every fresh listing of a computer
 * (HostSession.refreshNow): the periodic WorkManager check (Android's floor is 15 minutes) lists
 * each paired computer. A computer's own screen watches that host; All computers watches every
 * paired host while STARTED. Both re-list every 8 s and on that host's change (audit A73). Unwatched
 * computers do not poll or re-list pushes over a connection retained for a quick return. What the
 * user is looking at ([OnScreen]; on the merged Inbox, every computer's Inbox) is recorded as seen
 * instead of announced. A real push leg is backend work.
 *
 * A notification's tap opens that session's terminal, and an approval or a question carries the
 * answers the Inbox card offers (audit A25): which ones is [InboxNotificationActions.plan], and an
 * answer runs in [InboxActionReceiver] / [InboxActionWorker], which update the notification here
 * ([sending], [settle]).
 */
object InboxNotifier {
    private const val CH_ATTENTION = "attention"
    private const val CH_DONE = "done"
    private const val CH_SENDING = "sending"
    private const val WORK = "nodeterm.inbox"

    /** The [Request] an answering action carries to [InboxActionReceiver]. */
    const val EXTRA_REQUEST = "dev.nodeterm.android.notify.REQUEST"

    /** The notification an answer runs under on Android 11 and lower, where expedited work is a foreground service. */
    private const val SENDING_ID = 0x4e54_0025

    /** This phone will actually SHOW our notifications: the app-level switch in system settings,
     *  which on Android 13+ also reflects the runtime POST_NOTIFICATIONS permission (audit A21). */
    fun canPost(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CH_ATTENTION, context.getString(R.string.channel_attention), NotificationManager.IMPORTANCE_HIGH)
                .apply { description = context.getString(R.string.channel_attention_desc) }
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_DONE, context.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = context.getString(R.string.channel_done_desc) }
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_SENDING, context.getString(R.string.channel_sending), NotificationManager.IMPORTANCE_LOW)
                .apply { description = context.getString(R.string.channel_sending_desc) }
        )
    }

    fun schedule(context: Context, enabled: Boolean) {
        val wm = WorkManager.getInstance(context)
        if (!enabled) {
            wm.cancelUniqueWork(WORK)
            return
        }
        val req = PeriodicWorkRequestBuilder<InboxWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /**
     * Announce the events of a fresh listing of [host] not announced before, except what [onScreen]
     * says the user is looking at: those are recorded as seen (audit A73). Returns how many were
     * posted.
     */
    fun announce(context: Context, host: PairedHost, snapshot: ProjectsSnapshot, onScreen: OnScreen, quiet: Boolean): Int {
        val graph = NodetermApp.graph(context)
        // The switch, and whether the system will show it (A21): with either off nothing is claimed,
        // but what is on screen is still recorded as seen, so turning them on later does not
        // announce what the user already looked at.
        val permitted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val notify = graph.hosts.notificationsEnabled && canPost(context) && permitted
        // Decided and recorded in one locked step (SeenLog, audits A48/A73): unresolved, younger than
        // the announce window, not on screen, and never announced, read or shown on this phone FOR
        // THIS COMPUTER — two computers can mint the same event id, so the log is kept per computer —
        // nor under another pairing for the same node: the SSH host a paired desktop drives lists
        // that desktop's events too (A27), and one event raises one notification.
        val fresh = graph.hosts.claimLive(host.id, snapshot.status?.inbox?.events.orEmpty(), onScreen, notify)
        if (fresh.isEmpty()) return 0
        val nm = NotificationManagerCompat.from(context)
        val showDetails = graph.hosts.notificationDetails
        for (ev in fresh.takeLast(5)) {
            nm.notify(InboxNotificationActions.notificationId(host.id, ev.id), build(context, host, snapshot, ev, showDetails, quiet))
        }
        return fresh.size
    }

    /**
     * The event's own text (the command, file or question, the agent's last message) is left out
     * unless the user opted in: Android shows a notification's full content on a secure lock screen
     * under its default setting, and a public version changes that only for users who hide sensitive
     * content (audit A52). The words are [InboxNotificationText]'s; the public version is always set.
     *
     * The tap opens that session's terminal, and the actions are the Inbox card's answers as far as a
     * notification can carry them (audit A25, [InboxNotificationActions.plan]).
     */
    private fun build(
        context: Context,
        host: PairedHost,
        snapshot: ProjectsSnapshot,
        ev: InboxEvent,
        showDetails: Boolean,
        quiet: Boolean
    ): android.app.Notification {
        val node = snapshot.findNode(ev.nodeId)?.second
        val session = snapshot.statusOf(ev.nodeId)?.name?.takeIf { it.isNotBlank() } ?: node?.title
        val words = InboxNotificationText.of(ev, session, host.name, showDetails)
        val channel = if (ev.kind == InboxKind.DONE) CH_DONE else CH_ATTENTION
        val id = InboxNotificationActions.notificationId(host.id, ev.id)
        // The terminal's title as the Inbox card names the session, so the screen the tap opens reads the same.
        val title = node?.let { displayTitle(it, snapshot) }
            ?: snapshot.statusOf(ev.nodeId)?.name?.takeIf { it.isNotBlank() }
            ?: InboxNotificationText.FALLBACK_SESSION
        val open = openSession(context, id, host.id, ev.nodeId, title)
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(words.publicTitle)
            .setContentText(words.publicText)
            .setWhen(ev.ts)
            .build()
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(words.title)
            .setContentText(words.text)
            .setSubText(host.name)
            .setWhen(ev.ts)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
        words.bigText?.let { builder.setStyle(NotificationCompat.BigTextStyle().bigText(it)) }
        // An answer from here never makes a first relay handshake (nobody is at the app to compare the
        // desktop's code): a computer reachable only that way gets Open instead of answers.
        // The listing's exact HostSession supplies this fact; a manager lookup here would invert
        // ConnectionManager.forget's lock order while lifetime-gated notifications publish.
        for (action in InboxNotificationActions.plan(ev, showDetails, quiet)) {
            val intent = if (action.answers) answerIntent(context, Request(host.id, host.name, id, words.title, title, action, ev))
                else open
            // An answer needs an unlocked phone: Android 12 and later ask for the unlock before they
            // send the action; below that the receiver refuses a locked phone itself.
            builder.addAction(
                NotificationCompat.Action.Builder(R.drawable.ic_launcher_foreground, action.label, intent)
                    .setAuthenticationRequired(action.answers)
                    .build()
            )
        }
        return builder.build()
    }

    /**
     * What a notification's tap (and its Open action) opens: that session's terminal, with its
     * computer's Inbox one Back away (audit A25, MainActivity.openTap). One PendingIntent per
     * notification ([notificationId] is its request code): PendingIntents are told apart by their
     * Intent WITHOUT its extras, so with one request code per computer FLAG_UPDATE_CURRENT would hand
     * every notification of that computer the session of the last one posted.
     */
    private fun openSession(context: Context, notificationId: Int, hostId: String, nodeId: String, title: String): PendingIntent =
        PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_HOST_ID, hostId)
                .putExtra(MainActivity.EXTRA_NODE_ID, nodeId)
                .putExtra(MainActivity.EXTRA_NODE_TITLE, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /**
     * An answering action: an explicit broadcast to the app's own unexported [InboxActionReceiver],
     * immutable, carrying the [Request]. Its data names the notification and the action, so each
     * action of each notification is a PendingIntent of its own.
     */
    private fun answerIntent(context: Context, request: Request): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            request.notificationId,
            Intent(context, InboxActionReceiver::class.java)
                .setData(Uri.fromParts("nodeterm-answer", "${request.notificationId}/${request.action.key}", null))
                .putExtra(EXTRA_REQUEST, request.encode()),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /** The answer is on its way. The actions go with this update, so a second tap cannot send another. */
    fun sending(context: Context, request: Request) {
        post(
            context, request.notificationId,
            reposted(context, request)
                .setContentText(InboxNotificationActions.sendingText(request.action))
                .setProgress(0, 0, true)
                .build()
        )
    }

    /** The answer settled as [outcome]: say so, keeping the tap that opens the session. */
    fun settle(context: Context, request: Request, outcome: Outcome) {
        val settled = InboxNotificationActions.settled(outcome, request.action, request.computerName)
        val builder = reposted(context, request)
            .setContentText(settled.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(settled.text))
        settled.dismissAfterMs?.let { builder.setTimeoutAfter(it) }
        post(context, request.notificationId, builder.build())
    }

    /**
     * The notification an answer's work shows while it runs as a foreground service: Android 11 and
     * lower run expedited work that way. Android 12 and later never ask for it.
     */
    fun sendingForeground(context: Context): ForegroundInfo =
        ForegroundInfo(
            SENDING_ID,
            NotificationCompat.Builder(context, CH_SENDING)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Sending your answer…")
                .setSilent(true)
                .build()
        )

    /**
     * The event's notification again, under its id and on its channel, without actions and silent (an
     * update must not alert a second time). Only words that carry no event text: its title is
     * [InboxNotificationText]'s headline, and the rest is the computer and the outcome (audit A52).
     */
    private fun reposted(context: Context, request: Request): NotificationCompat.Builder {
        val open = openSession(context, request.notificationId, request.hostId, request.event.nodeId, request.sessionTitle)
        val publicVersion = NotificationCompat.Builder(context, CH_ATTENTION)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(request.headline)
            .setContentText(request.computerName)
            .setWhen(request.event.ts)
            .build()
        return NotificationCompat.Builder(context, CH_ATTENTION)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(request.headline)
            .setSubText(request.computerName)
            .setWhen(request.event.ts)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
    }

    private fun post(context: Context, id: Int, notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
    }
}

class InboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = NodetermApp.graph(applicationContext)
        // Nothing could be shown: do not dial every computer every 15 minutes for it (audit A21).
        if (!graph.hosts.notificationsEnabled || !InboxNotifier.canPost(applicationContext)) return Result.success()
        for (host in graph.hosts.hosts.value) {
            val session = graph.connections.session(host.id)
            // BACKGROUND: never a first relay handshake — that would raise the desktop's approval
            // dialog with nobody at the phone to compare the code (audit A05). A listing that arrives
            // announces its new events itself (HostSession.refreshNow → InboxNotifier.announce, the
            // path the live refresh takes too, audit A73); a failed one has nothing new to announce.
            // As a background user: the connection is closed afterwards unless a screen or an answer
            // from a notification still uses it (the review of A25).
            session.inBackground { withTimeoutOrNull(45_000) { session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND) } }
        }
        return Result.success()
    }
}
