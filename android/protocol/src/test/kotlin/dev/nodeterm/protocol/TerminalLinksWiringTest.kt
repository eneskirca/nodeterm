package dev.nodeterm.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A32: the Android half of links and copying, which cannot run on a JVM, pinned in the app's source.
 * The page's half is [TerminalJsLinksTest]; the rules both halves delegate to are [TerminalCopyTest].
 * What it does on a phone is the device checklist's.
 */
class TerminalLinksWiringTest {
    private val controller = AppSourcePins.ui("TerminalController.kt")
    private val screen = AppSourcePins.ui("TerminalScreen.kt")
    private val assets = File(InteropHarness.repoRoot, "android/app/src/main/assets/terminal")

    @Test
    fun `a link from the page is offered only once ExternalLink accepts it, never opened on the tap`() {
        val bridge = AppSourcePins.blockAfter(controller, "fun openUrl(url: String)")
        AppSourcePins.assertInOrder(bridge, "if (!page.isCurrent(gen)) return", "ExternalLink.parse(url) ?: return", "linkOffer = link")
        assertFalse("startActivity" in bridge, "the bridge opened the link on the tap itself:\n$bridge")
        assertEquals(1, Regex("""linkOffer = link\b""").findAll(controller).count(), "linkOffer is set from somewhere else")
    }

    @Test
    fun `opening is a browsable ACTION_VIEW behind a catch, from the user's Open only`() {
        val open = AppSourcePins.blockAfter(controller, "fun openLink(ctx: Context, link: ExternalLink)")
        AppSourcePins.assertInOrder(open, "Intent(Intent.ACTION_VIEW, Uri.parse(link.url))", ".addCategory(Intent.CATEGORY_BROWSABLE)", "start(ctx, view")
        val start = AppSourcePins.blockAfter(controller, "private fun start(ctx: Context, intent: Intent, failed: String)")
        AppSourcePins.assertInOrder(start, "try {", "ctx.startActivity(intent)", "catch (e: ActivityNotFoundException)", "catch (e: Exception)")
        // The only ACTION_VIEW: the WebViewClient no longer opens what the page navigates to.
        assertEquals(1, Regex("""Intent\.ACTION_VIEW""").findAll(controller).count())
        val client = AppSourcePins.blockAfter(controller, "fun createWebView(")
        assertTrue("override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true" in client, client)
        // Both screen surfaces call it with the screen's own context.
        assertEquals(2, Regex("""controller\.openLink\(ctx, link\)""").findAll(screen).count())
    }

    @Test
    fun `copied and shared text keeps to the clipboard cap and a refused write is caught`() {
        for (fn in listOf("fun copyLines(ctx: Context, selection: TerminalCopy.Selection)", "fun shareLines(ctx: Context, selection: TerminalCopy.Selection)")) {
            val body = AppSourcePins.blockAfter(controller, fn)
            AppSourcePins.assertInOrder(body, "TerminalCopy.text(lines, selection)", "is TerminalCopy.Text.Copy ->", "TerminalCopy.Text.TooLarge ->")
        }
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "fun shareLines("), "Intent(Intent.ACTION_SEND)", "start(ctx, Intent.createChooser(send, null)")
        val write = AppSourcePins.blockAfter(controller, "private fun writeClipboard(")
        AppSourcePins.assertInOrder(write, "try {", "cm.setPrimaryClip(", "} catch (e: Exception) {")
    }

    @Test
    fun `the Copy chip opens the sheet, which a page not yet loaded is never asked for`() {
        val chip = AppSourcePins.blockAfter(screen, "KeyChip(\"Copy\")")
        AppSourcePins.assertInOrder(chip, "focusManager.clearFocus()", "controller.openCopySheet()")
        val open = AppSourcePins.blockAfter(controller, "fun openCopySheet()")
        AppSourcePins.assertInOrder(open, "!page.isReady", "return", "evaluateJavascript(\"nt.copySheet()\"")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(controller, "fun onCopySheet(json: String)"), "TerminalCopy.parse(json)", "copySheet = snapshot")
        AppSourcePins.assertInOrder(screen, "controller.copySheet?.let { snapshot -> CopySheet(controller, snapshot) }")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "private fun CopySheet("), "BackHandler { controller.closeCopySheet() }")
    }

    @Test
    fun `a touch on a bar, card or sheet over the terminal stays there`() {
        // Review of A32: Compose hit-tests overlapping siblings from the top down and moves on to the
        // next where the top one has no pointer-input node, and background() and Text have none. A tap
        // on the link bar's URL or the Copy sheet's title reached the WebView (a click or scroll in the
        // pane, or another link offered) and one on the sheet's bottom row the input bar (the keyboard).
        val overlays = screen.lines().filter { "Modifier.align(Alignment." in it }
        // The five state cards, the resume offer, the notice and the bottom bars (the link offer's).
        assertTrue(overlays.size >= 8, "found only ${overlays.size} overlays over the terminal:\n${overlays.joinToString("\n")}")
        for (line in overlays) {
            val blocks = line.indexOf(".blockTouchesBelow()")
            assertTrue(blocks >= 0, "an overlay over the terminal lets a touch on its text through:\n$line")
            val padding = line.indexOf(".padding(")
            assertTrue(padding < 0 || blocks < padding, "the blocker sits inside the overlay's padding, which then lets touches through:\n$line")
        }
        assertTrue("LinkOffer(controller, link)" in AppSourcePins.blockAfter(screen, "Column(Modifier.align(Alignment.BottomCenter)"))
        // The sheet covers the key row and the input bar too.
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "private fun CopySheet("), "Column(Modifier.fillMaxSize().blockTouchesBelow()")
        // It only has to be a pointer-input node, and must consume nothing: a parent sees the Main pass
        // after its children, whose taps and drags check the Final pass for a consumed change, so a
        // consumed move (a finger's jitter) would cancel the overlay's own buttons and the sheet's scroll.
        val overlaysKt = AppSourcePins.ui("Overlays.kt")
        assertTrue("fun Modifier.blockTouchesBelow(): Modifier = pointerInput(Unit) {" in overlaysKt, overlaysKt)
        val blocker = AppSourcePins.blockAfter(overlaysKt, "fun Modifier.blockTouchesBelow()")
        assertTrue("awaitPointerEvent()" in blocker, blocker)
        assertFalse("consume" in blocker, "the blocker consumes events, which cancels the overlay's own taps:\n$blocker")
    }

    @Test
    fun `the link bar can show the whole URL, which two lines cut short on a phone`() {
        // Review of A32: two lines are a few dozen characters on a phone, too few to tell a long URL
        // from one row's fragment of it; the bar now shows all of it on request, scrolling in the bar.
        val offer = AppSourcePins.blockAfter(screen, "private fun LinkOffer(")
        AppSourcePins.assertInOrder(
            offer,
            "link.url",
            ".heightIn(max = ",
            ".verticalScroll(",
            "maxLines = if (whole) Int.MAX_VALUE else 2",
            "TextButton(onClick = { whole = !whole })"
        )
        assertTrue("var whole by remember(link)" in offer, "a new link must start collapsed:\n$offer")
    }

    @Test
    fun `the page loads no web-links addon, which cannot join repainted rows`() {
        val html = File(assets, "index.html").readText()
        val js = File(assets, "terminal.js").readText()
        assertFalse(Regex("""web-?links""", RegexOption.IGNORE_CASE).containsMatchIn(html), html)
        assertFalse("WebLinksAddon" in js)
        assertFalse(File(assets, "addon-web-links.js").exists())
        assertTrue("term.registerLinkProvider(" in js && "term.options.linkHandler = {" in js)
    }
}
