package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.RendererRecovery
import dev.nodeterm.protocol.host.RendererRecovery.Outcome
import dev.nodeterm.protocol.host.RendererRecovery.Showing
import dev.nodeterm.protocol.host.TerminalPage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A45: the terminal WebView's renderer can go away (killed by the system, or crashed), and the
 * screen then builds a new WebView. The screen (TerminalController) is only type-checked; these pin
 * the rules it delegates to: which page's callbacks count, where queued JavaScript goes, who
 * reattaches, and what the screen shows meanwhile. What it passes in, and when it builds the new
 * WebView, is pinned in its source at the end.
 */
class TerminalPageTest {
    // ---- the page generation -----------------------------------------------------------------

    @Test
    fun `JavaScript offered before the page is ready is run in order once it is`() {
        val page = TerminalPage()
        val gen = page.build()
        assertFalse(page.offer("a"))
        assertFalse(page.offer("b"))
        assertEquals(listOf("a", "b"), page.ready(gen))
        assertTrue(page.isReady)
        assertTrue(page.offer("c"), "a ready page runs JavaScript at once")
        assertEquals(emptyList(), page.ready(gen), "a second ready hands nothing over again")
    }

    @Test
    fun `a lost page's late ready neither marks the next page ready nor takes its queue`() {
        val page = TerminalPage()
        val dead = page.build()
        page.lost()
        val next = page.build()
        assertFalse(page.offer("paint"))
        // The dead page's onReady, posted before the loss and run after it.
        assertNull(page.ready(dead))
        assertFalse(page.isReady)
        assertFalse(page.isCurrent(dead))
        assertTrue(page.isCurrent(next))
        assertEquals(listOf("paint"), page.ready(next), "the queue is still there for the page it was meant for")
    }

    @Test
    fun `the renderer going away before the page was ready drops what was queued for it`() {
        val page = TerminalPage()
        val dead = page.build()
        page.offer("nt.write(old output)")
        page.lost()
        assertFalse(page.isCurrent(dead), "the dead page's callbacks no longer count")
        assertTrue(page.isReplacing)
        val next = page.build()
        page.offer("nt.setFontSize(13)")
        assertEquals(listOf("nt.setFontSize(13)"), page.ready(next))
        assertFalse(page.isReplacing)
    }

    @Test
    fun `a ready page that is lost stops running JavaScript until its replacement is ready`() {
        val page = TerminalPage()
        page.ready(page.build())
        assertTrue(page.offer("x"))
        page.lost()
        assertFalse(page.isReady)
        assertFalse(page.offer("y"), "no page to run it on: queued, not evaluated on a destroyed WebView")
    }

    @Test
    fun `JavaScript offered while there is no page at all is kept for the next one`() {
        val page = TerminalPage()
        page.ready(page.build())
        page.lost()
        // A reattach can land and paint before the replacement WebView has been built.
        assertFalse(page.offer("nt.paint(screen)"))
        val next = page.build()
        page.offer("nt.setFontSize(13)")
        assertEquals(listOf("nt.paint(screen)", "nt.setFontSize(13)"), page.ready(next))
    }

    @Test
    fun `only a replacement page is waited for, not the first one`() {
        val page = TerminalPage()
        val first = page.build()
        assertFalse(page.isReplacing, "the first attach is not held back for the first page")
        page.ready(first)
        page.lost()
        val next = page.build()
        assertTrue(page.isReplacing)
        page.ready(next)
        assertFalse(page.isReplacing)
    }

    // ---- who reattaches --------------------------------------------------------------------

    private fun RendererRecovery.gone(didCrash: Boolean, now: Long) = onGone(didCrash, now, Showing.ATTACHED, visible = true)

    @Test
    fun `a crashed renderer is offered to the user, never reattached by itself`() {
        val recovery = RendererRecovery()
        assertIs<Outcome.Offer>(recovery.gone(didCrash = true, now = 0))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = true, now = 3_600_000))
        assertIs<Outcome.Offer>(recovery.onGone(didCrash = true, now = 3_600_001, showing = Showing.OPENING, visible = true))
    }

    @Test
    fun `a renderer the system killed is reattached by itself`() {
        assertEquals(Outcome.Reattach, RendererRecovery().gone(didCrash = false, now = 0))
        assertEquals(Outcome.Reattach, RendererRecovery().onGone(didCrash = false, now = 0, showing = Showing.OPENING, visible = true))
    }

    @Test
    fun `repeated kills fall back to the offer, and recover once the window has passed`() {
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 2)
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 0))
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 10_000))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = false, now = 20_000))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = false, now = 59_999))
        // The first automatic reattach has left the window: one more is allowed.
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 60_000))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = false, now = 60_001))
    }

    @Test
    fun `kills while the screen is not visible are reattached and do not use up the automatic reattaches`() {
        // The renderer's priority is waived while the screen is not visible, so Android reclaiming it
        // then is expected (the review of A45); the screen reattaches when it is started again.
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 2)
        repeat(5) {
            assertEquals(Outcome.Reattach, recovery.onGone(didCrash = false, now = it.toLong(), showing = Showing.OPENING, visible = false))
        }
        // Back in front of the user: the whole bound is still there.
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 10))
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 11))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = false, now = 12))
        // A background kill is not held against the screen once the bound is used up either.
        assertEquals(Outcome.Reattach, recovery.onGone(didCrash = false, now = 13, showing = Showing.OPENING, visible = false))
    }

    @Test
    fun `a crash while the screen is not visible is still not reattached by itself`() {
        // Only a kill is expected in the background; a crash may come from what the pane printed.
        val crashed = assertIs<Outcome.Offer>(RendererRecovery().onGone(didCrash = true, now = 0, showing = Showing.OPENING, visible = false))
        assertEquals("The terminal view crashed.", crashed.message)
    }

    @Test
    fun `an offer is not counted as an automatic reattach`() {
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 1)
        assertIs<Outcome.Offer>(recovery.gone(didCrash = true, now = 0))
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 1))
    }

    // ---- what the screen was showing (A45 review) --------------------------------------------

    @Test
    fun `an answer on screen is kept, whether the renderer was killed or crashed`() {
        // "The session ended (exit 1).", "Disconnected.", the relay offer, or an earlier "Reopen
        // terminal": the screen keeps it and its button. A kill must not turn an ended session into an
        // attach of its own (over the relay that creates a new, empty session), and a kill after a
        // crash offer must not reattach what the user was asked about.
        val recovery = RendererRecovery()
        assertEquals(Outcome.Keep, recovery.onGone(didCrash = false, now = 0, showing = Showing.SETTLED, visible = true))
        assertEquals(Outcome.Keep, recovery.onGone(didCrash = true, now = 1, showing = Showing.SETTLED, visible = true))
    }

    @Test
    fun `a kept answer does not use up the automatic reattaches`() {
        val recovery = RendererRecovery(windowMs = 60_000, maxAutomatic = 2)
        repeat(5) { recovery.onGone(didCrash = false, now = it.toLong(), showing = Showing.SETTLED, visible = true) }
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 10))
        assertEquals(Outcome.Reattach, recovery.gone(didCrash = false, now = 11))
        assertIs<Outcome.Offer>(recovery.gone(didCrash = false, now = 12))
    }

    @Test
    fun `the offer says the session is running only when a stream was attached`() {
        val running = "The session is still running on the computer."
        val crashed = assertIs<Outcome.Offer>(RendererRecovery().gone(didCrash = true, now = 0))
        assertEquals("The terminal view crashed. $running", crashed.message)
        val opening = assertIs<Outcome.Offer>(RendererRecovery().onGone(didCrash = true, now = 0, showing = Showing.OPENING, visible = true))
        assertEquals("The terminal view crashed.", opening.message)
        assertFalse(running in opening.message, "nothing was known about the session while the terminal was opening")

        val loop = RendererRecovery(maxAutomatic = 0)
        val killedAttached = assertIs<Outcome.Offer>(loop.gone(didCrash = false, now = 0))
        assertEquals("Android keeps closing the terminal view to free memory. $running", killedAttached.message)
        val killedOpening = assertIs<Outcome.Offer>(loop.onGone(didCrash = false, now = 1, showing = Showing.OPENING, visible = true))
        assertEquals("Android keeps closing the terminal view to free memory.", killedOpening.message)
    }

    // ---- the screen's side, pinned in the app's source (the review of A45) ----------------------

    private val controller get() = AppSourcePins.ui("TerminalController.kt")

    @Test
    fun `the screen asks on a monotonic clock and says whether it is visible`() {
        val gone = AppSourcePins.blockAfter(controller, "private fun rendererGone(")
        assertTrue(
            gone.contains("recovery.onGone(didCrash, SystemClock.elapsedRealtime(), showing, visible = !stopped)"),
            "rendererGone does not ask RendererRecovery with the monotonic clock and the screen's visibility:\n$gone"
        )
        assertFalse(gone.contains("currentTimeMillis"), "the kill-loop window runs on the wall clock:\n$gone")
    }

    @Test
    fun `a lost page is rebuilt at once only for an automatic reattach of a visible screen`() {
        val src = controller
        val gone = AppSourcePins.blockAfter(src, "private fun rendererGone(")
        AppSourcePins.assertInOrder(gone, "webViewKey++", "recovery.onGone(", "hasWebView = outcome == RendererRecovery.Outcome.Reattach && !stopped")
        // Otherwise the next attach asked for builds it, and only that: an offer (or a kept answer)
        // rebuilt at once let a page that dies as it loads be rebuilt and lost with no bound.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(src, "private fun attachWhenPageReady()"),
            "if (page.isReplacing) {",
            "if (!stopped) hasWebView = true",
            "state = TermState.Connecting"
        )
        assertEquals(2, Regex("""hasWebView\s*=(?!=)""").findAll(src).count(), "hasWebView is set somewhere else")
        // "Reopen terminal" and coming back to the screen are among the attaches that build it.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(src, "fun reopenTerminal()"), "attachWhenPageReady()")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(src, "fun onStart()"), "stopped = false", "attachWhenPageReady()")
        // No WebView at all meanwhile: the dead one left with its key.
        AppSourcePins.assertInOrder(
            AppSourcePins.ui("TerminalScreen.kt"),
            "if (controller.hasWebView) {",
            "key(controller.webViewKey) {",
            "AndroidView(factory = { ctx -> controller.createWebView(ctx) }"
        )
    }

    @Test
    fun `the visible terminal's renderer keeps WebView's default priority`() {
        // RENDERER_PRIORITY_BOUND waived it in the background too, but also bound the renderer of the
        // terminal the user was looking at below the default.
        val create = AppSourcePins.blockAfter(controller, "fun createWebView(")
        assertTrue(create.contains("setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)"), create)
        assertFalse(controller.contains("setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND"))
    }
}
