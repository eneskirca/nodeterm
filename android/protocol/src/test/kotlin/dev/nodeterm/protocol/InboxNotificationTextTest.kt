package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.InboxNotificationText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A52: approval and finish notifications put the command text and the agent's last message in the
 * notification, and so on the lock screen: Android shows a notification's full content there unless
 * the user hides sensitive content, which is not the default. Now the event's own text is left out
 * unless the user opts in ("Show details in notifications", off by default), and a public version
 * that names only the session and the computer is always set.
 *
 * What the notification says is pure and tested here. The notification itself cannot be built on a
 * JVM, so the wiring (every word comes from [InboxNotificationText], the public version is set, the
 * setting defaults to off) is pinned in the app's source ([AppSourcePins]). How a lock screen shows
 * it is a device check.
 */
class InboxNotificationTextTest {
    private fun event(
        kind: InboxKind,
        title: String,
        detail: String? = null,
        interrupted: Boolean = false
    ) = InboxEvent(
        id = "e1", ts = 1, nodeId = "term-1", agentId = "claude", sessionId = "s", kind = kind,
        title = title, detail = detail, interrupted = interrupted, resolved = false,
        options = emptyList(), multiSelect = false, pendingId = null
    )

    // Shapes the desktop sends (src/core/agent-status-mirror.ts): a Bash approval's summary, a Write,
    // an approval with no summary (its title is the agent's last line), a question, a finished turn.
    private val bash = event(InboxKind.APPROVAL, "Run command", "curl -H 'Authorization: Bearer s3cret' https://api.example.com …")
    private val write = event(InboxKind.APPROVAL, "Write id_rsa", "/home/me/.ssh/id_rsa (27 lines)")
    private val bare = event(InboxKind.APPROVAL, "I'll now delete the customer table in prod.")
    private val question = event(InboxKind.QUESTION, "Which of the leaked keys should I rotate first?")
    private val done = event(InboxKind.DONE, "Finished", "The password for the staging database is hunter2.")
    private val stopped = event(InboxKind.DONE, "Stopped", "Half-way through the migration.", interrupted = true)

    private fun InboxNotificationText.all() = listOfNotNull(title, text, bigText, publicTitle, publicText)

    private fun assertCarriesNothingOf(ev: InboxEvent, words: InboxNotificationText) {
        for (secret in listOfNotNull(ev.title, ev.detail)) {
            // A DONE title is the desktop's own "Finished"/"Stopped"; the kind label may say the same
            // word, which is not the event's text leaking. Everything else must not appear at all.
            if (ev.kind == InboxKind.DONE && secret == ev.title) continue
            for (field in words.all()) assertFalse(field.contains(secret), "`$secret` is in `$field`")
        }
    }

    @Test
    fun `by default an approval says only that the session needs approval`() {
        for (ev in listOf(bash, write, bare)) {
            val words = InboxNotificationText.of(ev, "build-bot", "Studio Mac", showDetails = false)
            assertEquals("Needs you — build-bot", words.title)
            assertEquals("Needs approval", words.text)
            assertNull(words.bigText, "no expanded text: it would carry the command")
            assertCarriesNothingOf(ev, words)
        }
    }

    @Test
    fun `by default a question does not show the question`() {
        val words = InboxNotificationText.of(question, "build-bot", "Studio Mac", showDetails = false)
        assertEquals("Needs you — build-bot", words.title)
        assertEquals("Has a question", words.text)
        assertNull(words.bigText)
        assertCarriesNothingOf(question, words)
    }

    @Test
    fun `by default a finished turn does not show the agent's last message`() {
        val words = InboxNotificationText.of(done, "build-bot", "Studio Mac", showDetails = false)
        assertEquals("Completed — build-bot", words.title)
        assertEquals("Finished", words.text)
        assertNull(words.bigText)
        assertCarriesNothingOf(done, words)

        val interrupted = InboxNotificationText.of(stopped, "build-bot", "Studio Mac", showDetails = false)
        assertEquals("Completed — build-bot", interrupted.title)
        assertEquals("Interrupted", interrupted.text)
        assertCarriesNothingOf(stopped, interrupted)
    }

    @Test
    fun `the public version names only the session and the computer, with or without details`() {
        for (ev in listOf(bash, write, bare, question, done, stopped)) {
            for (details in listOf(false, true)) {
                val words = InboxNotificationText.of(ev, "build-bot", "Studio Mac", showDetails = details)
                assertEquals(words.title, words.publicTitle)
                assertEquals("Studio Mac", words.publicText)
                for (secret in listOfNotNull(ev.title, ev.detail).filterNot { ev.kind == InboxKind.DONE && it == ev.title }) {
                    assertFalse(words.publicTitle.contains(secret) || words.publicText.contains(secret), "public carries `$secret`")
                }
            }
        }
        val attention = InboxNotificationText.of(bash, "build-bot", "Studio Mac", showDetails = true)
        assertEquals("Needs you — build-bot", attention.publicTitle)
        assertEquals("Completed — build-bot", InboxNotificationText.of(done, "build-bot", "Studio Mac", true).publicTitle)
    }

    @Test
    fun `with details on, the notification carries the event's text as before`() {
        val words = InboxNotificationText.of(bash, "build-bot", "Studio Mac", showDetails = true)
        assertEquals("Needs you — build-bot", words.title)
        assertEquals("Run command — ${bash.detail}", words.text)
        assertEquals("Run command\n${bash.detail}", words.bigText)

        val q = InboxNotificationText.of(question, "build-bot", "Studio Mac", showDetails = true)
        assertEquals(question.title, q.text)
        assertEquals(question.title, q.bigText)

        val d = InboxNotificationText.of(done, "build-bot", "Studio Mac", showDetails = true)
        assertEquals("Finished — ${done.detail}", d.text)
        assertEquals("Finished\n${done.detail}", d.bigText)
    }

    @Test
    fun `with details on but no text in the event, the kind is said instead of nothing`() {
        val empty = event(InboxKind.APPROVAL, "", "  ")
        val words = InboxNotificationText.of(empty, "build-bot", "Studio Mac", showDetails = true)
        assertEquals("Needs approval", words.text)
        assertNull(words.bigText)
    }

    @Test
    fun `a session with no name is called Session`() {
        for (name in listOf(null, "", "   ")) {
            val words = InboxNotificationText.of(bash, name, "Studio Mac", showDetails = false)
            assertEquals("Needs you — ${InboxNotificationText.FALLBACK_SESSION}", words.title)
            assertEquals(words.title, words.publicTitle)
        }
    }

    private val notifier get() = AppSourcePins.app("notify/InboxNotifier.kt")

    @Test
    fun `the notification takes every word from InboxNotificationText and always sets the public version`() {
        val build = AppSourcePins.blockAfter(notifier, "private fun build(")
        // The pre-fix builder wrote `ev.title + ev.detail` into the text and the BigTextStyle.
        assertFalse(build.contains("ev.title"), "the notification reads the event's title itself:\n$build")
        assertFalse(build.contains("ev.detail"), "the notification reads the event's detail itself:\n$build")
        AppSourcePins.assertInOrder(
            build,
            "val words = InboxNotificationText.of(ev, session, host.name, showDetails)",
            "val publicVersion = NotificationCompat.Builder(context, channel)",
            ".setContentTitle(words.publicTitle)",
            ".setContentText(words.publicText)",
            ".build()",
            ".setContentTitle(words.title)",
            ".setContentText(words.text)",
            ".setVisibility(NotificationCompat.VISIBILITY_PRIVATE)",
            ".setPublicVersion(publicVersion)",
            "words.bigText?.let { builder.setStyle(NotificationCompat.BigTextStyle().bigText(it)) }"
        )
        val announce = AppSourcePins.blockAfter(notifier, "fun announce(")
        AppSourcePins.assertInOrder(
            announce,
            "val showDetails = graph.hosts.notificationDetails",
            "build(context, host, snapshot, ev, showDetails, quiet)"
        )
    }

    @Test
    fun `the details setting is off until the user turns it on in Settings`() {
        val store = AppSourcePins.app("data/HostStore.kt")
        assertTrue(store.contains("""get() = prefs.getBoolean("notifyDetails", false)"""), "the setting does not default to off")
        val settings = AppSourcePins.ui("SettingsScreen.kt")
        assertTrue(settings.contains("var notifyDetails by remember { mutableStateOf(graph.hosts.notificationDetails) }"))
        AppSourcePins.assertInOrder(
            settings,
            "Text(\"Show details in notifications\")",
            "Switch(checked = notifyDetails",
            "graph.hosts.notificationDetails = it"
        )
        // Stored only from the switch.
        assertEquals(1, Regex("""graph\.hosts\.notificationDetails\s*=(?!=)""").findAll(settings).count())
        // Enabled exactly when the Notifications switch reads On (the review of A52): with notifications
        // turned off for the app in the system, the details switch is not offered either.
        assertTrue(settings.contains("Switch(checked = notify && canPost, onCheckedChange = {"))
        assertTrue(settings.contains("Switch(checked = notifyDetails, enabled = notify && canPost, onCheckedChange = {"))
    }
}
