package androidx.compose.ui.platform
import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
val LocalContext = staticCompositionLocalOf<Context> { error("no context") }
