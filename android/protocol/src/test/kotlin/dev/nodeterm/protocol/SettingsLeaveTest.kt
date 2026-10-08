package dev.nodeterm.protocol

import dev.nodeterm.protocol.relay.ApiBaseSetting
import dev.nodeterm.protocol.relay.ApiBaseSetting.OnLeave
import dev.nodeterm.protocol.relay.RelayApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A44: leaving Settings by the system back (gesture or button) threw away the edited device name
 * and relay address; only the top-bar arrow stored them. And an address that was not https was
 * dropped by that arrow without a word.
 *
 * The address rule and the leave decision are pure and tested here. The wiring (both backs run the
 * one `leave()`, which stores before it pops; a screen taken away without a back stores silently; and
 * nothing stores per keystroke) cannot run on a JVM, so it is pinned in the app's source
 * ([AppSourcePins]); whether the gesture reaches it on a device has not been checked.
 */
class SettingsLeaveTest {
    @Test
    fun `an https address is stored as typed, trimmed and without a trailing slash`() {
        assertEquals(RelayApi.DEFAULT_API_BASE, ApiBaseSetting.accept(RelayApi.DEFAULT_API_BASE))
        assertEquals("https://relay.example.com", ApiBaseSetting.accept("  https://relay.example.com/ "))
        assertEquals("https://relay.example.com:8443/api", ApiBaseSetting.accept("https://relay.example.com:8443/api/"))
        // The scheme is case-insensitive, as it is to OkHttp (a keyboard may capitalize the first letter).
        assertEquals("Https://relay.example.com", ApiBaseSetting.accept("Https://relay.example.com"))
    }

    @Test
    fun `anything that is not an https address is refused`() {
        assertNull(ApiBaseSetting.accept(""))
        assertNull(ApiBaseSetting.accept("http://relay.example.com"))
        assertNull(ApiBaseSetting.accept("relay.example.com"))
        assertNull(ApiBaseSetting.accept("wss://relay.example.com"))
        assertNull(ApiBaseSetting.accept("https:relay.example.com"))
    }

    @Test
    fun `an https prefix without a usable URL behind it is refused`() {
        // All passed the old startsWith("https://") check. "https://" was stored as "https:", which
        // OkHttp read as a host named "v1"; with the next three every relay call threw
        // IllegalArgumentException from Request.Builder.url instead of a RelayApiException.
        assertNull(ApiBaseSetting.accept("https://"))
        assertNull(ApiBaseSetting.accept("https://?x"))
        assertNull(ApiBaseSetting.accept("https://:443"))
        assertNull(ApiBaseSetting.accept("https://relay example.com"))
        // The /v1/... path is appended to the address: a query or fragment would swallow it.
        assertNull(ApiBaseSetting.accept("https://relay.example.com?x=1"))
        assertNull(ApiBaseSetting.accept("https://relay.example.com#top"))
    }

    @Test
    fun `leaving stores an edited address and reports a refused one`() {
        val stored = RelayApi.DEFAULT_API_BASE
        assertEquals(OnLeave.Save("https://relay.example.com"), ApiBaseSetting.onLeave("https://relay.example.com/", stored))
        assertEquals(OnLeave.Save("https://other.example.com"), ApiBaseSetting.onLeave("https://other.example.com", "https://relay.example.com"))
        assertEquals(OnLeave.Rejected, ApiBaseSetting.onLeave("http://relay.example.com", stored))
        assertEquals(OnLeave.Rejected, ApiBaseSetting.onLeave("", stored))
        assertEquals(OnLeave.Rejected, ApiBaseSetting.onLeave("https://", stored))
    }

    @Test
    fun `leaving without an edit stores nothing`() {
        // The first A44 fix stored the unedited address on every leave. Only the arrow used to, and
        // the system back (what most users press) stored nothing.
        val custom = "https://relay.example.com"
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave(custom, custom))
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave(" $custom/ ", custom))
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave("https://relay.example.com:8443/api", "https://relay.example.com:8443/api/"))
    }

    @Test
    fun `the built-in default is never stored as an address`() {
        // A phone that stores no address reads the default, and follows a later build's default. The
        // first A44 fix stored it on every leave, pinning the phone to this build's default for good.
        // The unedited default: forgetting an address the phone does not have writes nothing, and
        // it unpins a phone an earlier build did store the default on (Keep would leave it pinned).
        val default = RelayApi.DEFAULT_API_BASE
        assertEquals(OnLeave.UseDefault, ApiBaseSetting.onLeave(default, default))
        // "Reset to default" over a custom address forgets it rather than storing the default.
        assertEquals(OnLeave.UseDefault, ApiBaseSetting.onLeave(default, "https://relay.example.com"))
        assertEquals(OnLeave.UseDefault, ApiBaseSetting.onLeave(" $default/ ", "https://relay.example.com"))
    }

    @Test
    fun `a refused address that is already the stored one is left alone without a message`() {
        // Only an older build could have stored it (its check let "https://" through, and HostStore
        // stored that as "https:"); the user did not type it here.
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave("https:", "https:"))
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave(" https:// ", "https:"))
        assertEquals(OnLeave.Rejected, ApiBaseSetting.onLeave("http://relay.example.com", "https:"))
    }

    @Test
    fun `the field flags what it holds now, including an unusable address an older build stored`() {
        val default = RelayApi.DEFAULT_API_BASE
        assertNull(ApiBaseSetting.fieldError(default, default))
        assertNull(ApiBaseSetting.fieldError("https://relay.example.com", default))
        // Typed here: it will not be saved (leaving says so too).
        assertEquals(ApiBaseSetting.NOT_SAVED, ApiBaseSetting.fieldError("http://relay.example.com", default))
        assertEquals(ApiBaseSetting.NOT_SAVED, ApiBaseSetting.fieldError("http://relay.example.com", "https:"))
        // Stored by an older build and not edited: leaving keeps it without a message, but the field
        // flags it (the review of A44), since every relay call uses it. It used to show no error at all.
        assertEquals(ApiBaseSetting.STORED_UNUSABLE, ApiBaseSetting.fieldError("https:", "https:"))
        assertEquals(ApiBaseSetting.STORED_UNUSABLE, ApiBaseSetting.fieldError(" https:// ", "https:"))
        assertEquals(OnLeave.Keep, ApiBaseSetting.onLeave("https:", "https:"))
    }

    private val settings get() = AppSourcePins.ui("SettingsScreen.kt")

    @Test
    fun `the system back runs the same leave as the top-bar arrow`() {
        val src = settings
        assertTrue(src.contains("import androidx.activity.compose.BackHandler"), "SettingsScreen registers no BackHandler")
        // Enabled like AppContent's, so it never swallows the back that should close the app.
        assertEquals("{ leave() }", AppSourcePins.blockAfter(src, "BackHandler(enabled = nav.size > 1)"))
        val arrow = AppSourcePins.blockAfter(src, "navigationIcon =")
        AppSourcePins.assertInOrder(arrow, "IconButton(onClick = { leave() })")
        assertFalse(arrow.contains("nav.pop()"), "the arrow pops without the shared leave():\n$arrow")
    }

    @Test
    fun `leave stores the name and the address, tells about a refused one, then pops`() {
        val save = AppSourcePins.blockAfter(settings, "fun save(onRejected: () -> Unit)")
        AppSourcePins.assertInOrder(
            save,
            // An unedited name is not stored: a phone that stores no name is named after its model.
            "if (name.trim() != graph.hosts.deviceName) graph.hosts.deviceName = name",
            "ApiBaseSetting.onLeave(apiBase, graph.hosts.apiBase)",
            "OnLeave.Save -> graph.hosts.apiBase = edit.value",
            "OnLeave.UseDefault -> graph.hosts.useDefaultApiBase()",
            "OnLeave.Keep -> {}",
            "OnLeave.Rejected -> onRejected()"
        )
        val leave = AppSourcePins.blockAfter(settings, "fun leave()")
        AppSourcePins.assertInOrder(leave, "save(onRejected = {", "Toast.makeText(", ".show()", "nav.pop()")
    }

    @Test
    fun `leaving the screen without a back stores the edits too, without a message`() {
        // A notification tap (replaceAll) or a pairing link (push) takes Settings off the screen
        // without running leave(), and the edits used to be lost silently (the review of A44).
        val effect = AppSourcePins.blockAfter(settings, "DisposableEffect(Unit)")
        assertEquals("{ save(onRejected = {}) }", AppSourcePins.blockAfter(effect, "onDispose"))
        assertFalse(effect.contains("Toast"), "the dispose save shows a message nobody is there to read:\n$effect")
    }

    @Test
    fun `using the default forgets the stored address, so the getter falls back to the default`() {
        val store = AppSourcePins.app("data/HostStore.kt")
        val forget = AppSourcePins.blockAfter(store, "fun useDefaultApiBase()")
        assertEquals("""prefs.edit().remove("apiBase").apply()""", forget.removeSurrounding("{", "}").trim())
        assertTrue(
            store.contains("""get() = prefs.getString("apiBase", null) ?: dev.nodeterm.protocol.relay.RelayApi.DEFAULT_API_BASE"""),
            "HostStore.apiBase no longer answers the built-in default while no address is stored"
        )
    }

    @Test
    fun `nothing else pops or stores the edits`() {
        val src = settings
        // One pop (in leave), and the two stores only in save: never per keystroke, never skipped.
        assertEquals(1, Regex("""nav\.pop\(\)""").findAll(src).count())
        assertEquals(1, Regex("""graph\.hosts\.apiBase\s*=(?!=)""").findAll(src).count())
        assertEquals(1, Regex("""graph\.hosts\.deviceName\s*=(?!=)""").findAll(src).count())
        assertEquals(1, Regex("""graph\.hosts\.useDefaultApiBase\(\)""").findAll(src).count())
        // save() runs from leave() and when the screen is disposed, nowhere else.
        assertEquals(2, Regex("""\bsave\(onRejected = """).findAll(src).count())
        // The field warns by what it holds now (ApiBaseSetting.fieldError), not only about an edit.
        assertTrue(src.contains("val apiBaseError = ApiBaseSetting.fieldError(apiBase, graph.hosts.apiBase)"))
        assertTrue(src.contains("isError = apiBaseError != null"))
        assertTrue(src.contains("supportingText = apiBaseError?.let { error -> { Text(error) } }"))
    }
}
