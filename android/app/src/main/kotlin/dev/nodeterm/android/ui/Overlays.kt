package dev.nodeterm.android.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput

/**
 * Keeps a touch on an overlay from reaching what the overlay is drawn over (review of audit A32).
 * Every bar, card and sheet laid over the terminal carries it, on its root and before its padding,
 * so the whole drawn area counts.
 *
 * Compose hit-tests overlapping siblings from the top down, and where the top one has no
 * pointer-input node under the touch it moves on to the next sibling. `background()` and `Text` are
 * not pointer-input nodes, so only an overlay's buttons and lists stopped a touch: a tap on the link
 * bar's URL, or on the Copy sheet's title, reached the terminal's WebView below it (a tmux click or
 * wheel scroll into the live pane, or a link offer that then replaced the one on screen), and a tap
 * on the sheet's bottom row reached the input bar, whose focus raised the soft keyboard over the sheet.
 *
 * Any pointer-input node ends that search, so this one only has to be there: it reads every event and
 * consumes none. Consuming here would break the overlay itself. A parent sees the Main pass after its
 * children, and a child's tap and drag detection look at the Final pass for a consumed change (Compose
 * foundation's `waitForUpOrCancellation` and its drag slop do): a consumed move, which any finger's
 * jitter produces between down and up, would cancel a tap on the overlay's own buttons and the scroll
 * of its list.
 */
fun Modifier.blockTouchesBelow(): Modifier = pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) awaitPointerEvent()
    }
}
