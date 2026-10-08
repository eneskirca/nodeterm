package dev.nodeterm.android.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier

/**
 * The body of a Scaffold that holds a text field: the Scaffold's padding, plus room for the soft
 * keyboard (audit A77). The one place the app asks for the keyboard's inset.
 *
 * The app targets API 35, so on Android 15 its window is edge-to-edge whether it asks or not: the
 * window is no longer resized for the keyboard (`adjustResize` stops doing it) and the system bars'
 * and the keyboard's insets reach Compose instead. The Scaffold's padding already holds the
 * navigation bar, and the keyboard's inset is measured from the bottom of the screen, navigation bar
 * included, so a bare `imePadding()` after it counted the navigation bar twice. Consuming the padding
 * first leaves `imePadding()` only what the keyboard covers beyond it.
 *
 * On API 26–34 the window is not edge-to-edge (the app does not call `enableEdgeToEdge()`, on
 * purpose: every screen would then depend on its inset handling there too). The window's decor
 * consumes those insets before they reach Compose and makes room for the keyboard itself
 * (`adjustResize`), so this is the Scaffold's padding alone.
 *
 * Apply it before a `verticalScroll`: the keyboard then shrinks the scrolled viewport, which Compose
 * keeps the focused field inside, instead of padding the content's end.
 *
 * Text fields in an `AlertDialog` do not go through here. A dialog is its own window, and a floating
 * one (the theme's `dialogTheme`): the framework drops inset fitting only for a non-floating window,
 * so a dialog stays framed by the system and does not rely on Compose's insets. An `imePadding()`
 * inside one could add the keyboard a second time. How a dialog sits over the keyboard on Android 15
 * has not been checked on a device.
 */
fun Modifier.aboveKeyboard(scaffoldPadding: PaddingValues): Modifier =
    padding(scaffoldPadding).consumeWindowInsets(scaffoldPadding).imePadding()
